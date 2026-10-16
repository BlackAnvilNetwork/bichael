//! The SP1 guest commits `state_roots`. These checks run the same function on
//! the host. They do not invent a proof. The verifying key is pinned in the
//! ruleset record.

use lok_engine::{commit_entries, keccak256, Engine, Input, Key, Outcome, State, U256};
use lok_sp1_executor::state_roots;

/// Ethereum `keccak256("")`. An empty character sheet hashes to this.
const KECCAK_EMPTY: &str = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

#[test]
fn program_state_hash_is_keccak() {
    assert_eq!(hex::encode(keccak256(&[])), KECCAK_EMPTY);
    assert_eq!(State::new().root(), keccak256(&[]));

    let empty = state_roots(r#"{"type":"characters","characters":[]}"#).expect("empty world");
    assert_eq!(empty, vec![keccak256(&[])]);

    let token = U256::from_u64(1);
    let starting_job = 3u8;
    let mut engine = Engine::open(token, starting_job);
    let Outcome::Applied { entry_hash, state_root, .. } = engine
        .apply(Input::Spawn {
            token_id: token,
            starting_job,
        })
        .expect("spawn");
    let log = format!(
        r#"{{"tokenId":"1","startingJob":3,"entries":[{{"hash":"0x{}","input":{{"type":"spawn","tokenId":"1","startingJob":3}}}}]}}"#,
        hex::encode(entry_hash)
    );
    let roots = state_roots(&log).expect("spawn replay");
    assert_eq!(roots, vec![state_root]);
    assert_eq!(roots, vec![engine.state().root()]);
    assert_eq!(
        roots[0],
        commit_entries([
            (Key::TokenId, token),
            (Key::Level, U256::from_u64(1)),
            (Key::Job, U256::from_u64(u64::from(starting_job))),
            (Key::Subjob, U256::ZERO),
            (Key::JobXp, U256::ZERO),
            (Key::SubjobXp, U256::ZERO),
            (Key::Location, U256::ZERO),
            (Key::UnspentPoints, U256::ZERO),
        ])
    );
    assert_ne!(roots[0], keccak256(&[]));

    let guest = include_str!("../../program/src/main.rs");
    assert!(guest.contains("lok_sp1_executor::state_roots"));
    assert!(guest.contains("sp1_zkvm::io::commit_slice"));
    assert!(!guest.contains("poseidon"));
}

#[test]
fn this_genesis_does_not_depend_on_risc_zero() {
    let manifests = [
        include_str!("../Cargo.toml"),
        include_str!("../../Cargo.toml"),
        include_str!("../../program/Cargo.toml"),
        include_str!("../../script/Cargo.toml"),
    ];
    for manifest in manifests {
        let lower = manifest.to_ascii_lowercase();
        assert!(!lower.contains("risc0"), "{manifest}");
        assert!(!lower.contains("risc-zero"), "{manifest}");
        assert!(!lower.contains("risczero"), "{manifest}");
    }
    assert!(include_str!("../../program/Cargo.toml").contains("sp1-zkvm"));
    let host = include_str!("../../script/src/main.rs");
    assert!(host.contains(".execute("));
    assert!(host.contains("is not accepted on this genesis"));
    assert!(!host.contains(".setup("));
    assert!(!host.contains(".prove("));
    assert!(!host.contains("verifying_key"));
    assert!(!host.contains("risc0-zkvm"));
    assert!(!host.to_ascii_lowercase().contains("poseidon"));
    assert!(include_str!("../../Cargo.toml").contains("patch-2.0.2-sp1-6.0.0"));
    assert!(include_str!("../../Cargo.toml").contains("tiny-keccak"));
    assert!(host.contains("report_uses_keccak_precompile"));
}

#[test]
fn execution_report_counts_keccak_permute() {
    let report = "\
gas: 22432
syscall counts (2 total syscall instructions):
    2 keccak_permute
";
    assert!(lok_sp1_executor::report_uses_keccak_precompile(report));
    assert!(lok_sp1_executor::report_uses_keccak_precompile("keccak_permute: 2"));
    assert!(!lok_sp1_executor::report_uses_keccak_precompile("2 poseidon_permute"));
    assert!(!lok_sp1_executor::report_uses_keccak_precompile("0 keccak_permute"));
}
