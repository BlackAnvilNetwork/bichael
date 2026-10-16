//! Execution the SP1 guest commits.
//!
//! `state_roots` replays a lok-engine log and returns each character's
//! `State::root`. That root is the keccak256 Merkle tree the contracts already
//! use. An empty world is `keccak256("")`. The guest commits those bytes.
//! It does not hash with Poseidon. The verifying key is pinned beside the
//! wasm digest, not in this crate.

use lok_engine::{
    commit_entries, parse_any_log, replay, replay_world, AnyLog, Key, ReplayStop, U256,
};

/// Replay `text` with the lok engine and return the keccak state hash of each character.
///
/// A character log yields that character's `State::root`. A world document yields
/// one root per character, in replay order. An empty world yields `keccak256("")`.
pub fn state_roots(text: &str) -> Result<Vec<[u8; 32]>, String> {
    match parse_any_log(text).map_err(|err| err)? {
        AnyLog::Character(doc) => {
            let report = replay(&doc).map_err(stop_message)?;
            Ok(vec![report.state_root])
        }
        AnyLog::World(doc) => {
            let report = replay_world(&doc).map_err(stop_message)?;
            if report.characters.is_empty() {
                Ok(vec![commit_entries(Vec::<(Key, U256)>::new())])
            } else {
                Ok(report
                    .characters
                    .into_iter()
                    .map(|character| character.state_root)
                    .collect())
            }
        }
    }
}

/// True when an SP1 execution report counted a keccak syscall.
///
/// The report prints each syscall as `2 keccak_permute`, and some builds use
/// `keccak_permute: 2`. Either form means the guest used the keccak precompile.
pub fn report_uses_keccak_precompile(report: &str) -> bool {
    report.lines().any(|line| {
        let line = line.trim();
        if let Some((name, count)) = line.split_once(':') {
            return keccak_count(name, count);
        }
        let mut parts = line.split_whitespace();
        let Some(count) = parts.next() else {
            return false;
        };
        let Some(name) = parts.next() else {
            return false;
        };
        parts.next().is_none() && keccak_count(name, count)
    })
}

fn keccak_count(name: &str, count: &str) -> bool {
    name.to_ascii_uppercase().contains("KECCAK")
        && count
            .trim()
            .parse::<u64>()
            .ok()
            .is_some_and(|count| count > 0)
}

fn stop_message(stop: ReplayStop) -> String {
    match stop {
        ReplayStop::BadHash { index, .. } => format!("bad hash at {index}"),
        ReplayStop::Rejected { index, reason } => format!("rejected at {index}: {reason}"),
    }
}
