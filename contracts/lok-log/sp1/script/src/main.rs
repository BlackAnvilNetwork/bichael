//! Run the lok-engine crate inside SP1 and print the keccak state roots.
//!
//! Each stdin line is `{"prover":"sp1","log":"<engine log json>"}`. Any other
//! prover, including RISC Zero, is refused and is not executed. This process
//! calls `execute` only. It does not set up a verifying key, it does not prove,
//! and it does not decide whether a batch is valid.

use sp1_sdk::{include_elf, Elf, Prover, ProverClient, SP1Stdin};

const ELF: Elf = include_elf!("lok-sp1-program");

#[tokio::main]
async fn main() {
    let client = ProverClient::builder().cpu().build().await;
    let stdin = std::io::stdin();
    for line in stdin.lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                emit(&serde_json::json!({
                    "ok": false,
                    "prover": "sp1",
                    "error": err.to_string(),
                }));
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        emit(&handle_line(&client, &line).await);
    }
}

async fn handle_line(client: &(impl Prover + Sync), line: &str) -> serde_json::Value {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return serde_json::json!({
                "ok": false,
                "prover": "sp1",
                "error": err.to_string(),
            });
        }
    };
    let prover = value.get("prover").and_then(|item| item.as_str()).unwrap_or("");
    if !prover.eq_ignore_ascii_case("sp1") {
        let named = prover_name(prover);
        return serde_json::json!({
            "ok": false,
            "prover": named,
            "error": format!("{named} is not accepted on this genesis"),
        });
    }
    let log = match value.get("log").and_then(|item| item.as_str()) {
        Some(log) => log.to_string(),
        None => {
            return serde_json::json!({
                "ok": false,
                "prover": "sp1",
                "error": "missing log",
            });
        }
    };

    let mut stdin = SP1Stdin::new();
    stdin.write(&log);
    let executed = client.execute(ELF, stdin).await;
    let (public_values, report) = match executed {
        Ok(pair) => pair,
        Err(err) => {
            return serde_json::json!({
                "ok": false,
                "prover": "sp1",
                "error": err.to_string(),
            });
        }
    };
    let report_text = report.to_string();
    eprintln!("{report_text}");
    let bytes = public_values.as_slice();
    if bytes.is_empty() || bytes.len() % 32 != 0 {
        return serde_json::json!({
            "ok": false,
            "prover": "sp1",
            "error": format!("public values are {} bytes", bytes.len()),
        });
    }
    let state_roots: Vec<String> = bytes.chunks(32).map(|chunk| format!("0x{}", hex::encode(chunk))).collect();
    serde_json::json!({
        "ok": true,
        "prover": "sp1",
        "stateRoots": state_roots,
        "keccakPrecompile": lok_sp1_executor::report_uses_keccak_precompile(&report_text),
    })
}

fn prover_name(prover: &str) -> String {
    let folded = prover.trim().to_ascii_lowercase().replace(['_', '-'], "");
    if folded == "risc0" || folded == "risczero" {
        "RISC Zero".to_string()
    } else if prover.is_empty() {
        "that prover".to_string()
    } else {
        prover.to_string()
    }
}

fn emit(value: &serde_json::Value) {
    println!("{value}");
    let _ = std::io::Write::flush(&mut std::io::stdout());
}
