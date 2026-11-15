mod scanner;
use std::{env, fs};
fn main() {
    let config = fs::read_to_string("config.json").ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).unwrap_or_default();
    let args: Vec<String> = env::args().skip(1).collect();
    let roots = if args.is_empty() { config["scanRoots"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default() } else { args };
    let ignored: Vec<String> = config["ignoredDirs"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
    eprintln!("Scanning {} ...", roots.join(", "));
    let projects = scanner::scan(&roots, &ignored, |scanned, found, _| eprint!("\r{scanned} dirs scanned, {found} projects found"));
    eprintln!("\nFound {} bun projects:", projects.len());
    for p in projects { println!("{:<28} port={:<6} {:<6} {}", p.name, p.port.map(|v| v.to_string()).unwrap_or_else(|| "n/a".into()), p.script, p.path); }
}
