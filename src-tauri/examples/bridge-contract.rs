// Test transport for the production Rust bridge. Never included in application bundles.
use cachekeeper_lib::bridge::{now, BridgeRepository};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--echo-args") {
        println!("{}", json!(std::env::args().skip(2).collect::<Vec<_>>()));
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--wait") {
        std::thread::sleep(std::time::Duration::from_secs(60));
        return;
    }
    let mut args = std::env::args().skip(1);
    let roots: Vec<std::path::PathBuf> =
        serde_json::from_str(&args.next().expect("isolated roots")).unwrap();
    let transcripts = args.next().expect("isolated transcripts").into();
    let mut repo = BridgeRepository::new(roots, transcripts);
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let request: Value = serde_json::from_str(&line).unwrap();
        let result = match request["method"].as_str() {
            Some("validateCatalog") => {
                cachekeeper_lib::release::catalog(&request["catalog"]).map(|_| json!(true))
            }
            Some("validateBundle") => {
                cachekeeper_lib::release::bundle(&request["bundle"], Some(&request["expected"]))
                    .map(|files| json!(files.len()))
            }
            Some("refresh") => repo
                .refresh(now())
                .map(|rows| json!({"rows":rows,"warnings":repo.warnings})),
            Some("save") => repo.save(
                request["id"].as_str().unwrap_or(""),
                &request["control"],
                now(),
            ),
            Some("stopAll") => repo
                .stop_all(request["legacyOnly"] == true, now())
                .map(|_| Value::Null),
            _ => Err("unknown contract operation".into()),
        };
        println!(
            "{}",
            match result {
                Ok(value) => json!({"seq":request["seq"],"value":value}),
                Err(error) => json!({"seq":request["seq"],"error":error}),
            }
        );
        io::stdout().flush().unwrap();
    }
}
