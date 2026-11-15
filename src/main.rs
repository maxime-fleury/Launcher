#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod scanner;
use scanner::Project;
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, fs, io::{Read, Write}, net::TcpListener, path::{Component, Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Emitter, Manager};

struct Running { child: Child, project: Project, started_at: u128 }
struct Data { config: Value, running: HashMap<String, Running>, logs: HashMap<String, String>, log_order: VecDeque<String> }
struct State { dir: PathBuf, data: Mutex<Data> }
fn now() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }
fn defaults() -> Value { json!({"scanRoots":["D:\\"],"kpportPath":"C:\\tools\\kpport.cmd","bunPath":"bun","ignoredDirs":["node_modules",".git",".hg",".svn","venv",".venv","env","dist","build","out","target","__pycache__",".cache",".next",".nuxt",".turbo",".idea",".vscode","coverage",".parcel-cache",".svelte-kit","bin","obj","$RECYCLE.BIN","System Volume Information"],"createFolders":["AI","Dev","gen"],"portOverrides":{},"customNames":{},"customOrder":[]}) }
fn load_config(dir: &Path) -> Value {
    let mut d = defaults();
    if let Ok(Value::Object(raw)) = fs::read_to_string(dir.join("config.json")).map(|s| serde_json::from_str::<Value>(&s).unwrap_or(Value::Null)) { d.as_object_mut().unwrap().extend(raw); }
    d
}
fn save_config(dir: &Path, config: &Value) -> Result<(), String> { fs::write(dir.join("config.json"), serde_json::to_string_pretty(config).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }
fn strings(v: &Value) -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default() }
fn emit(app: &tauri::AppHandle, name: &str, value: Value) { let _ = app.emit(name, value); }
fn log(app: &tauri::AppHandle, state: &State, path: &str, text: &str) {
    let mut d = state.data.lock().unwrap();
    // Keep recent stopped-project logs, without accumulating one buffer per project forever.
    d.log_order.retain(|p| p != path);
    d.log_order.push_back(path.to_string());
    while d.log_order.len() > 30 {
        if let Some(index) = d.log_order.iter().position(|p| p != path && !d.running.contains_key(p)) {
            let oldest = d.log_order.remove(index).unwrap();
            d.logs.remove(&oldest);
        } else { break; }
    }
    let buf = d.logs.entry(path.into()).or_default(); buf.push_str(text);
    if buf.len() > 1_000_000 { let start = buf.len() - 1_000_000; let boundary = (start..buf.len()).find(|i| buf.is_char_boundary(*i)).unwrap_or(buf.len()); buf.drain(..boundary); }
    drop(d); emit(app, "project-log", json!({"path":path,"chunk":text}));
}
#[cfg(windows)] fn hide(c: &mut Command) { use std::os::windows::process::CommandExt; c.creation_flags(0x08000000); }
#[cfg(not(windows))] fn hide(_: &mut Command) {}
fn output(mut c: Command) -> Result<std::process::Output, String> { hide(&mut c); c.output().map_err(|e| e.to_string()) }
fn bun(config: &Value) -> String {
    if output({ let mut c = Command::new("bun"); c.arg("--version"); c }).is_ok_and(|o| o.status.success()) { "bun".into() } else { config["bunPath"].as_str().unwrap_or("bun").into() }
}
fn port_users(port: u16) -> Result<Vec<Value>, String> {
    let out = output({ let mut c=Command::new("netstat"); c.arg("-ano"); c })?;
    if !out.status.success() { return Err("Could not check port usage with netstat".into()); }
    let text = String::from_utf8_lossy(&out.stdout); let mut users = Vec::new();
    for line in text.lines() {
        let a: Vec<_> = line.split_whitespace().collect();
        if a.len() < 5 || !a[1].rsplit(':').next().is_some_and(|p| p == port.to_string()) || !a[3].eq_ignore_ascii_case("LISTENING") { continue; }
        if users.iter().any(|v: &Value| v["pid"].as_str() == Some(a[4])) { continue; }
        let name = output({ let mut c=Command::new("tasklist"); c.args(["/FI", &format!("PID eq {}", a[4]), "/FO", "CSV", "/NH"]); c }).ok().and_then(|o| String::from_utf8(o.stdout).ok()).and_then(|s| s.split('"').nth(1).map(str::to_string)).unwrap_or_default();
        users.push(json!({"pid":a[4],"name":name}));
    } Ok(users)
}
fn approved_users(users: &[Value], approved: &Value) -> bool {
    let Some(approved) = approved.as_array() else { return false; };
    let mut expected: Vec<&str> = users.iter().filter_map(|u| u["pid"].as_str()).collect();
    let mut actual: Vec<&str> = approved.iter().filter_map(Value::as_str).collect();
    expected.sort_unstable(); actual.sort_unstable();
    expected.len() == users.len() && actual.len() == approved.len() && expected == actual
}
fn kill_port(config: &Value, port: u16) -> Result<String, String> {
    let tool = config["kpportPath"].as_str().filter(|s| !s.is_empty()).ok_or("kpportPath is not configured")?;
    let out = output({ let mut c=Command::new("cmd.exe"); c.args(["/c", tool, &port.to_string()]); c })?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() { return Err(format!("kpport failed: {}", text.trim())); }
    Ok(text.trim().into())
}
fn start(app: &tauri::AppHandle, state: &Arc<State>, path: &str, approved: &Value) -> Value {
    let Some(mut project) = scanner::describe(Path::new(path)) else { return json!({"ok":false,"message":"project not found"}) };
    let config = { let d=state.data.lock().unwrap(); if d.running.contains_key(path) { return json!({"ok":true,"alreadyRunning":true}); } d.config.clone() };
    project.port = config["portOverrides"][path].as_u64().and_then(|n| u16::try_from(n).ok()).or(project.port);
    if let Some(port) = project.port {
        let users = match port_users(port) { Ok(users) => users, Err(e) => return json!({"ok":false,"message":e}) };
        if !users.is_empty() {
            if !approved_users(&users, approved) { return json!({"ok":false,"conflict":true,"port":port,"users":users}); }
            log(app,state,path,&format!("[launcher] freeing port {port} (kpport)...\n"));
            if let Err(e) = kill_port(&config, port) { log(app,state,path,&format!("[launcher] {e}\n")); return json!({"ok":false,"message":e}); }
        }
    }
    emit(app,"project-status",json!({"path":path,"status":"starting","port":project.port}));
    let mut command=Command::new(bun(&config)); command.args(["run", &project.script]).current_dir(path).stdout(Stdio::piped()).stderr(Stdio::piped()); hide(&mut command);
    let mut child=match command.spawn() { Ok(c)=>c, Err(e)=> { log(app,state,path,&format!("[launcher] failed to start: {e}\n")); emit(app,"project-status",json!({"path":path,"status":"error"})); return json!({"ok":false,"message":e.to_string()}) } };
    let stdout=child.stdout.take(); let stderr=child.stderr.take(); let pid=child.id(); let started_at=now();
    { let mut d=state.data.lock().unwrap(); d.running.insert(path.into(), Running { child, project:project.clone(), started_at }); }
    emit(app,"project-status",json!({"path":path,"status":"running","port":project.port,"script":project.script,"startedAt":started_at}));
    for mut stream in [stdout.map(|s| Box::new(s) as Box<dyn Read + Send>), stderr.map(|s| Box::new(s) as Box<dyn Read + Send>)].into_iter().flatten() {
        let app=app.clone(); let state=state.clone(); let path=path.to_string(); thread::spawn(move || { let mut bytes=[0;4096]; while let Ok(n)=stream.read(&mut bytes) { if n==0 { break; } log(&app,&state,&path,&String::from_utf8_lossy(&bytes[..n])); } });
    }
    let app=app.clone(); let state=state.clone(); let path=path.to_string();
    thread::spawn(move || loop { thread::sleep(Duration::from_millis(250)); let exit = { let mut d=state.data.lock().unwrap(); match d.running.get_mut(&path) { Some(r) if r.child.id()==pid => match r.child.try_wait() { Ok(Some(status)) => { d.running.remove(&path); Some(status.to_string()) }, Ok(None)=>None, Err(e)=> { d.running.remove(&path); Some(e.to_string()) } }, _=>return } }; if let Some(exit)=exit { log(&app,&state,&path,&format!("\n[process exited] {exit}\n")); emit(&app,"project-status",json!({"path":path,"status":"stopped"})); return; } });
    json!({"ok":true})
}
fn stop(app: &tauri::AppHandle, state: &State, path: &str) -> Value {
    let entry=state.data.lock().unwrap().running.remove(path);
    if let Some(mut entry)=entry {
        #[cfg(windows)] { let _=output({let mut c=Command::new("taskkill"); c.args(["/pid", &entry.child.id().to_string(), "/T", "/F"]); c}); }
        let _=entry.child.kill(); let _=entry.child.wait(); log(app,state,path,"\n[launcher] stopping...\n"); emit(app,"project-status",json!({"path":path,"status":"stopped"})); json!({"ok":true})
    } else { json!({"ok":false,"message":"not running"}) }
}
fn merge(state: &State, projects: &mut [Project]) { let d=state.data.lock().unwrap(); for p in projects { if let Some(port)=d.config["portOverrides"][&p.path].as_u64().and_then(|n| u16::try_from(n).ok()) { p.port=Some(port); p.port_overridden=true; } if let Some(r)=d.running.get(&p.path) { p.status="running".into(); p.started_at=Some(r.started_at); } } }
fn create(app: &tauri::AppHandle, state: &Arc<State>, arg: &Value) -> Result<Value,String> {
    let name=arg["name"].as_str().unwrap_or("").trim(); let folder=arg["folder"].as_str().unwrap_or("");
    if name.is_empty() || name.chars().count()>60 || name.ends_with(['.', ' ']) || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c)) || ["CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"].contains(&name.to_uppercase().as_str()) { return Err("Invalid project name.".into()); }
    if Path::new(folder).components().any(|c| !matches!(c,Component::Normal(_))) { return Err("Invalid folder.".into()); }
    let config=state.data.lock().unwrap().config.clone();
    if !strings(&config["createFolders"]).contains(&folder.to_string()) { return Err("Invalid folder.".into()); }
    let roots=strings(&config["scanRoots"]); let root=roots.first().ok_or("No scan root configured")?;
    let path=Path::new(root).join(folder).join(name); if path.exists() { return Err(format!("{} already exists",path.display())); }
    let port=(3000..=3600).find(|p| TcpListener::bind(("127.0.0.1",*p)).is_ok()).ok_or("No free port between 3000 and 3600")?;
    let pkg_name=regex::Regex::new("[^a-z0-9]+").unwrap().replace_all(&name.to_lowercase(), "-").trim_matches('-').to_string();
    fs::create_dir_all(path.join("src")).map_err(|e| e.to_string())?;
    fs::write(path.join("package.json"),serde_json::to_string_pretty(&json!({"name":pkg_name,"version":"0.1.0","private":true,"description":"","scripts":{"dev":"bun run --watch src/index.ts"},"devDependencies":{"@types/bun":"latest"}})).unwrap()).map_err(|e| e.to_string())?;
    fs::write(path.join("src/index.ts"),format!("const NAME = {};\nlet server;\nfor (let port = 3000; port <= 3600; port++) {{\n  try {{ server = Bun.serve({{ port, fetch: () => new Response(`Hello from ${{NAME}}!`) }}); break; }} catch {{}}\n}}\nif (!server) throw new Error('No free port between 3000 and 3600');\nconsole.log(`🟤 ${{NAME}} running → http://localhost:${{server.port}}`);\n",serde_json::to_string(&pkg_name).unwrap())).map_err(|e| e.to_string())?;
    fs::write(path.join(".gitignore"),"node_modules\ndist\n.env\n").map_err(|e| e.to_string())?;
    let p=path.to_string_lossy().into_owned(); { let mut d=state.data.lock().unwrap(); if !d.config["portOverrides"].is_object() { d.config["portOverrides"]=json!({}); } d.config["portOverrides"][&p]=json!(port); save_config(&state.dir,&d.config)?; }
    let _=output({let mut c=Command::new(bun(&config)); c.arg("install").current_dir(&path); c});
    let result=start(app,state,&p,&Value::Null); if result["ok"] != true { return Err(result["message"].as_str().unwrap_or("Failed to start project").to_string()); }
    Ok(json!({"ok":true,"path":p,"port":port,"folder":folder,"name":name}))
}
fn dispatch(app: &tauri::AppHandle, state: &Arc<State>, action: &str, arg: Value) -> Result<Value,String> {
    match action {
        "scan" => { let config=state.data.lock().unwrap().config.clone(); let roots=strings(&config["scanRoots"]); let cache_path=state.dir.join("cache.json");
            if arg["useCache"] != false { if let Ok(raw)=fs::read_to_string(&cache_path) { if let Ok(cache)=serde_json::from_str::<Value>(&raw) { if strings(&cache["roots"])==roots { if let Ok(mut projects)=serde_json::from_value::<Vec<Project>>(cache["projects"].clone()) { merge(state,&mut projects); emit(app,"scan-cached",json!({"projects":projects,"roots":roots,"scannedAt":cache["scannedAt"]})); } } } } }
            let mut projects=scanner::scan(&roots,&strings(&config["ignoredDirs"]),|scanned,found,current| emit(app,"scan-progress",json!({"scanned":scanned,"found":found,"currentDir":current})));
            let cache=json!({"scannedAt":now(),"roots":roots,"projects":projects}); let _=fs::write(cache_path,serde_json::to_string(&cache).unwrap_or_default()); merge(state,&mut projects); let result=json!({"projects":projects,"roots":roots}); emit(app,"scan-done",result.clone()); Ok(result) },
        "startProject" => Ok(start(app,state,arg["path"].as_str().unwrap_or(""),&arg["approvedPids"])),
        "stopProject" => Ok(stop(app,state,arg.as_str().unwrap_or(""))),
        "restartProject" => { let p=arg["path"].as_str().unwrap_or(""); stop(app,state,p); Ok(start(app,state,p,&Value::Null)) },
        "stopAll" => { let paths:Vec<_>=state.data.lock().unwrap().running.keys().cloned().collect(); for p in &paths { stop(app,state,p); } Ok(json!({"ok":true,"stopped":paths.len()})) },
        "createProject" => Ok(create(app,state,&arg).unwrap_or_else(|e| json!({"ok":false,"message":e}))),
        "getConfig" => Ok(state.data.lock().unwrap().config.clone()),
        "reloadConfig" => { let cfg=load_config(&state.dir); state.data.lock().unwrap().config=cfg.clone(); Ok(cfg) },
        "updateConfig" => { let mut d=state.data.lock().unwrap(); if let Some(map)=arg.as_object() { d.config.as_object_mut().unwrap().extend(map.clone()); } save_config(&state.dir,&d.config)?; Ok(d.config.clone()) },
        "getRunning" => { let d=state.data.lock().unwrap(); Ok(Value::Array(d.running.iter().map(|(p,r)| json!({"path":p,"name":r.project.name,"port":r.project.port,"script":r.project.script,"status":"running","startedAt":r.started_at})).collect())) },
        "getLog" => Ok(json!(state.data.lock().unwrap().logs.get(arg.as_str().unwrap_or("")).cloned().unwrap_or_default())),
        "clearLog" => { let mut d=state.data.lock().unwrap(); let path=arg.as_str().unwrap_or(""); d.logs.remove(path); d.log_order.retain(|p| p != path); Ok(json!({"ok":true})) },
        "portStatus" => { let port=arg.as_u64().and_then(|n| u16::try_from(n).ok()).filter(|n| *n>0).ok_or("Invalid port")?; let users=port_users(port)?; Ok(json!({"inUse":!users.is_empty(),"users":users})) },
        "killPort" => { let port=arg["port"].as_u64().and_then(|n| u16::try_from(n).ok()).filter(|n| *n>0).ok_or("Invalid port")?; let users=port_users(port)?; if users.is_empty() { return Ok(json!({"ok":true,"port":port,"users":[],"output":""})); } if !approved_users(&users,&arg["approvedPids"]) { return Ok(json!({"ok":false,"conflict":true,"port":port,"users":users})); } let cfg=state.data.lock().unwrap().config.clone(); Ok(match kill_port(&cfg,port) { Ok(text)=>json!({"ok":true,"port":port,"users":users,"output":text}), Err(e)=>json!({"ok":false,"message":e}) }) },
        "openConfig" | "openProjectFolder" => { let path=if action=="openConfig" { state.dir.to_string_lossy().into_owned() } else { arg.as_str().unwrap_or("").into() }; Command::new("explorer.exe").arg(path).spawn().map_err(|e| e.to_string())?; Ok(Value::Null) },
        "openUrl" => { let url=arg.as_str().unwrap_or(""); if !(url.starts_with("http://") || url.starts_with("https://")) { return Err("Invalid URL".into()); } Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler",url]).spawn().map_err(|e| e.to_string())?; Ok(Value::Null) },
        "copyText" => { let mut child=Command::new("clip").stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?; child.stdin.take().unwrap().write_all(arg.as_str().unwrap_or("").as_bytes()).map_err(|e| e.to_string())?; child.wait().map_err(|e| e.to_string())?; Ok(Value::Null) },
        _ => Err(format!("Unknown action: {action}")),
    }
}
#[tauri::command]
async fn bridge(app: tauri::AppHandle, action: String, arg: Option<Value>) -> Result<Value,String> {
    let state=app.state::<Arc<State>>().inner().clone(); tauri::async_runtime::spawn_blocking(move || dispatch(&app,&state,&action,arg.unwrap_or(Value::Null))).await.map_err(|e| e.to_string())?
}
#[cfg(test)]
mod port_tests {
    use super::*;
    #[test]
    fn approval_matches_exact_current_listener_set() {
        let users = vec![json!({"pid":"41","name":"bun.exe"}), json!({"pid":"52","name":"node.exe"})];
        assert!(!approved_users(&users, &Value::Null));
        assert!(!approved_users(&users, &json!(["41"])));
        assert!(!approved_users(&users, &json!(["41", "53"])));
        assert!(approved_users(&users, &json!(["52", "41"])));
    }
}
fn main() {
    let dir=std::env::current_dir().expect("current directory"); let config=load_config(&dir);
    let state=Arc::new(State { dir, data:Mutex::new(Data { config, running:HashMap::new(), logs:HashMap::new(), log_order:VecDeque::new() }) });
    tauri::Builder::default().manage(state).invoke_handler(tauri::generate_handler![bridge]).build(tauri::generate_context!()).expect("failed to create app").run(|app,event| { if matches!(event,tauri::RunEvent::Exit) { let state=app.state::<Arc<State>>(); let paths: Vec<_>=state.data.lock().unwrap().running.keys().cloned().collect(); for p in paths { stop(app,&state,&p); } } });
}
