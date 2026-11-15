use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{HashMap, HashSet, VecDeque}, fs, path::{Path, PathBuf}, sync::{Arc, OnceLock, RwLock}};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub script: String,
    pub port: Option<u16>,
    pub description: String,
    pub framework: Option<String>,
    #[serde(default)] pub favicon_url: Option<String>,
    #[serde(default)] pub port_overridden: bool,
    #[serde(default = "stopped")] pub status: String,
    #[serde(default)] pub started_at: Option<u128>,
}
fn stopped() -> String { "stopped".into() }
const SCRIPTS: &[&str] = &["dev", "start", "serve", "preview", "run", "start:dev", "dev:start", "build"];
const EXTS: &[&str] = &["js", "ts", "mjs", "cjs", "jsx", "tsx"];
// Patterns are constant across projects; compile each once instead of once per file.
fn regex(pattern: &'static str) -> Arc<Regex> {
    static CACHE: OnceLock<RwLock<HashMap<&'static str, Arc<Regex>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Some(compiled) = cache.read().unwrap().get(pattern) { return Arc::clone(compiled); }
    let mut cache = cache.write().unwrap();
    Arc::clone(cache.entry(pattern).or_insert_with(|| Arc::new(Regex::new(pattern).expect("valid regex"))))
}
fn port_patterns(text: &str, patterns: &[&'static str]) -> Option<u16> {
    for pattern in patterns {
        if let Some(n) = regex(pattern).captures(text).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse::<u16>().ok()).filter(|n| *n > 0) { return Some(n); }
    }
    None
}
fn favicon(dir: &Path) -> Option<String> {
    for sub in ["", "public", "static", "assets", "src/assets", "client", "src"] {
        let mut entries: Vec<_> = fs::read_dir(dir.join(sub)).ok().into_iter().flatten().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for prefix in ["favicon.", "apple-touch-icon.png", "icon."] {
            for entry in &entries {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !name.starts_with(prefix) { continue; }
                let mime = match entry.path().extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase().as_str() {
                    "png" => "image/png", "ico" => "image/x-icon", "svg" => "image/svg+xml", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", _ => continue,
                };
                if let Ok(data) = fs::read(entry.path()) { return Some(format!("data:{mime};base64,{}", STANDARD.encode(data))); }
            }
        }
    }
    None
}
fn source_port(dir: &Path, scripts: &serde_json::Map<String, Value>, framework: Option<&str>) -> Option<u16> {
    let entry = regex(r#"(?i)\bbun(?:\s+run)?\s+(?:(?:--\w+|-[a-z])\s+)*([^\s&|;"']+\.(?:[cm]?[jt]sx?))\b"#);
    let imports = regex(r#"(?:import\s+[^"']*?from\s*|require\s*\(\s*)["'](\.[^"']+)["']"#);
    let mut queue = VecDeque::new();
    for name in SCRIPTS { if let Some(s) = scripts.get(*name).and_then(Value::as_str) { for c in entry.captures_iter(s) { queue.push_back(dir.join(&c[1])); } } }
    for name in ["vite.config.ts", "vite.config.js", "vite.config.mjs"] { if dir.join(name).is_file() { queue.push_back(dir.join(name)); } }
    let initial = queue.clone();
    let mut seen = HashSet::new();
    let mut followed = 0;
    while let Some(file) = queue.pop_front() {
        if !seen.insert(file.clone()) { continue; }
        let Ok(text) = fs::read_to_string(&file) else { continue };
        if let Some(port) = port_patterns(&text, &[
            r#"(?i)\bport\s*:\s*["']?(\d{1,5})"#,
            r#"(?i)(?:process|Bun|Deno)\.env\.\w*PORT\w*\s*(?:\|\|?|\?\?)\s*["']?(\d{1,5})"#,
            r#"(?i)(?:const|let|var)\s+PORT\w*\s*=\s*["']?(\d{1,5})"#,
            r"(?i)findAvailablePort\(\s*(\d{1,5})", r#"(?i)\.listen\(\s*["']?(\d{1,5})"#,
        ]) { return Some(port); }
        for cap in imports.captures_iter(&text) {
            if followed >= 12 { break; }
            let base = file.parent().unwrap_or(dir).join(&cap[1]);
            let mut candidates = vec![base.clone()];
            for ext in EXTS { candidates.push(PathBuf::from(format!("{}.{}", base.display(), ext))); candidates.push(base.join(format!("index.{ext}"))); }
            if let Some(p) = candidates.into_iter().find(|p| p.is_file()) { queue.push_back(p); followed += 1; }
        }
    }
    match framework { Some("vite" | "svelte" | "solid") => return Some(5173), Some("next" | "nuxt") => return Some(3000), _ => {} }
    if scripts.values().filter_map(Value::as_str).any(|s| regex(r"\bvite\b").is_match(s)) { return Some(5173); }
    for file in initial { if let Ok(text) = fs::read_to_string(file) {
        if regex(r"\b(?:[Pp]ort|PORT)\b").is_match(&text) {
            if let Some(p) = port_patterns(&text, &[r#"(?:return|=>)\s+["']?(\d{1,5})["']?\s*[;,\n]"#, r"(?im)\bport\b[^\n]*?\b([1-6]\d{3,4})\b"]) { return Some(p); }
        }
    } }
    None
}
pub fn describe(dir: &Path) -> Option<Project> {
    let raw = fs::read_to_string(dir.join("package.json")).ok()?;
    let pkg: Value = serde_json::from_str(&raw).ok()?;
    let empty = serde_json::Map::new();
    let scripts = pkg.get("scripts").and_then(Value::as_object).unwrap_or(&empty);
    let bun = regex(r"(?:^|[\s;&|])(?:bun|bunx)\s+");
    if !["bun.lock", "bun.lockb", "bunfig.toml"].iter().any(|x| dir.join(x).exists()) && !pkg.get("packageManager").and_then(Value::as_str).unwrap_or("").starts_with("bun@") && !scripts.values().filter_map(Value::as_str).any(|s| bun.is_match(s)) { return None; }
    let framework = [("next", &["next"][..]), ("hono", &["hono"]), ("express", &["express"]), ("fastify", &["fastify"]), ("nuxt", &["nuxt"]), ("svelte", &["svelte", "@sveltejs/kit"]), ("solid", &["solid-js"]), ("vue", &["vue"]), ("vite", &["vite"]), ("react", &["react"])].into_iter().find(|(_, keys)| keys.iter().any(|k| pkg.get("dependencies").and_then(|v| v.get(k)).is_some() || pkg.get("devDependencies").and_then(|v| v.get(k)).is_some())).map(|(s, _)| s.to_string());
    let mut names: Vec<&str> = SCRIPTS.to_vec();
    let mut rest: Vec<&str> = scripts.keys().map(String::as_str).collect(); rest.sort(); names.extend(rest);
    let port = names.iter().filter_map(|n| scripts.get(*n).and_then(Value::as_str)).find_map(|s| port_patterns(s, &[
        r"(?i)(?:^|[\s&|;])--?(?:port|server\.port)\s*(?:[=:]|\s)\s*(\d{1,5})",
        r"(?i)(?:^|[\s&|;])-p\s+(\d{1,5})\b", r"(?i)(?:^|[\s;])PORT\s*=\s*(\d{1,5})", r"(?i)(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:/](\d{1,5})\b", r"(?i)listen\s*\(\s*(\d{1,5})",
    ])).or_else(|| source_port(dir, scripts, framework.as_deref()));
    Some(Project { path: dir.to_string_lossy().into_owned(), name: pkg.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or_else(|| dir.file_name().and_then(|s| s.to_str()).unwrap_or("")).into(), script: SCRIPTS.iter().find(|n| scripts.get(**n).and_then(Value::as_str).is_some()).unwrap_or(&"dev").to_string(), port, description: pkg.get("description").and_then(Value::as_str).unwrap_or("").into(), framework, favicon_url: favicon(dir), port_overridden: false, status: stopped(), started_at: None })
}
pub fn scan<F: FnMut(usize, usize, &str)>(roots: &[String], ignored: &[String], mut progress: F) -> Vec<Project> {
    let ignored: HashSet<String> = ignored.iter().map(|s| s.to_lowercase()).collect();
    let mut queue: VecDeque<PathBuf> = roots.iter().map(PathBuf::from).collect();
    let mut projects = Vec::new(); let mut scanned = 0;
    let mut last = std::time::Instant::now();
    // Depth-first traversal keeps fewer pending directories on broad trees than BFS.
    while let Some(dir) = queue.pop_back() {
        let Ok(entries) = fs::read_dir(&dir) else { continue }; scanned += 1;
        let mut package = false;
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            if ty.is_symlink() { continue; }
            if ty.is_dir() && !ignored.contains(&entry.file_name().to_string_lossy().to_lowercase()) { queue.push_back(entry.path()); }
            else if ty.is_file() && entry.file_name() == "package.json" { package = true; }
        }
        if package { if let Some(p) = describe(&dir) { projects.push(p); } }
        if last.elapsed().as_millis() >= 200 { progress(scanned, projects.len(), &dir.to_string_lossy()); last = std::time::Instant::now(); }
    }
    progress(scanned, projects.len(), "");
    projects.sort_by_key(|p| p.name.to_lowercase()); projects
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scans_bun_projects_and_ignores_dependencies() {
        let root = PathBuf::from("target/scanner-test");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("app/src")).unwrap();
        fs::create_dir_all(root.join("node_modules/hidden")).unwrap();
        fs::write(root.join("app/package.json"), r#"{"name":"example","scripts":{"dev":"bun run --watch src/index.ts"},"dependencies":{"hono":"1"}}"#).unwrap();
        fs::write(root.join("app/src/index.ts"), "Bun.serve({ port: 4321 })").unwrap();
        fs::write(root.join("node_modules/hidden/package.json"), r#"{"packageManager":"bun@1"}"#).unwrap();
        let projects = scan(&[root.to_string_lossy().into_owned()], &["node_modules".into()], |_,_,_| {});
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "example");
        assert_eq!(projects[0].port, Some(4321));
        assert_eq!(projects[0].framework.as_deref(), Some("hono"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detects_script_port_and_framework_default() {
        assert_eq!(port_patterns("vite --port 8080", &[r"--port\s+(\d{1,5})"]), Some(8080));
        assert_eq!(source_port(Path::new("."), &serde_json::Map::new(), Some("next")), Some(3000));
    }
}
