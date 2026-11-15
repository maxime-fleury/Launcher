// A small Windows-compatible port termination tool bundled with the launcher.
use std::{collections::BTreeSet, env, process::{Command, ExitCode}};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
fn main() -> ExitCode {
    let port = env::args().nth(1).and_then(|s| s.parse::<u16>().ok()).filter(|n| *n > 0);
    let Some(port) = port else { eprintln!("Usage: kpport <port>"); return ExitCode::FAILURE; };
    let output = match Command::new("netstat").arg("-ano").creation_flags(0x08000000).output() { Ok(out) if out.status.success() => out, _ => { eprintln!("Could not inspect ports"); return ExitCode::FAILURE; } };
    let text = String::from_utf8_lossy(&output.stdout);
    let pids: BTreeSet<u32> = text.lines().filter_map(|line| {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 5 || !parts[3].eq_ignore_ascii_case("LISTENING") || parts[1].rsplit(':').next()?.parse::<u16>().ok()? != port { return None; }
        parts[4].parse::<u32>().ok().filter(|pid| *pid > 0)
    }).collect();
    let approved: Vec<String> = env::args().skip(2).collect();
    if !approved.is_empty() {
        let parsed: Option<BTreeSet<u32>> = approved.iter().map(|p| p.parse::<u32>().ok()).collect();
        if parsed.as_ref() != Some(&pids) { eprintln!("Port listeners changed; no processes were stopped. Please retry."); return ExitCode::FAILURE; }
    }
    let mut ok = true;
    for pid in pids {
        match Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x08000000).output() {
            Ok(result) if result.status.success() => println!("Stopped PID {pid} on port {port}"),
            Ok(result) => { eprintln!("Failed to stop PID {pid}: {}", String::from_utf8_lossy(&result.stderr)); ok = false; },
            Err(error) => { eprintln!("Failed to stop PID {pid}: {error}"); ok = false; }
        }
    }
    if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
