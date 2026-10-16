//! Pins copied from Golden.t.sol and verify.mjs. A drift fails this test.

use std::process::Command;

use lok_engine::{
    checkpoint_body_hash, commit_entries, eip712_digest, entry_hash, fungible_id, genesis_root,
    genesis_tag, parse_address, parse_b256, parse_log, replay, unique_id, Checkpoint, Engine,
    Export, Input, Key, Outcome, ReplayStop, U256, World,
};

const GENESIS_TAG: &str = "0x8a8d1f348a2311fc4d6271c76e697ff6d99152a86984976269678b04ab4eb413";
const BODY_HASH: &str = "0x0da4d29fd8c0892590468c9b2f8fa5e402388553fa6912e3f72a8cc671ee6d19";
const DIGEST: &str = "0x468f094a906981db2314b95d81ecf4461999c90bd877993fc3ff24828d6bdfed";
const GENESIS_ROOT: &str = "0x0c0d7ba0dd69dcda2fe24de603679f65ae5dbdaec43f4ba9f3dfa8c6b444761c";
const UNIQUE_ID: &str = "16326979768789847505458237212507241523594462770995321419559994427250918491098";
const FUNGIBLE_ID: &str = "89658009947691115780873220689577698189678099276092329480841579491160997392175";

/// Same spawn under ruleset `0x44` repeated.
const ENTRY_HASH_RULESET_44: &str = "0x4132b63228fa0c81a553514ecb448d615ebf2488ae7730ab623b78076327066b";
/// `keccak256(abi.encode(prev, index, eventId))` with no ruleset word. A zero ruleset must match this.
const ENTRY_HASH_OLD_PREIMAGE: &str = "0x1a3d2f6b7b0bca1def24adc542d497b42e5cd4df1e320d81598724289dd4eaca";

fn word(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn golden_summary() -> U256 {
    U256::from_u64(42)
        .bitor(U256::from_u64(3).shl(16))
        .bitor(U256::from_u64(1).shl(24))
        .bitor(U256::from_u64(123_456).shl(32))
        .bitor(U256::from_u64(17).shl(96))
}

fn golden_checkpoint() -> Checkpoint {
    Checkpoint {
        prev_root: word(0x11),
        new_root: word(0x22),
        from_index: 100,
        to_index: 137,
        log_hash: word(0x33),
        ruleset_hash: word(0x44),
        summary: golden_summary(),
        inbound_consumed: 9,
        exports: vec![
            Export { item_id: U256::from_u64(0xabc), amount: 1 },
            Export { item_id: U256::from_u64(0xdef), amount: 40 },
        ],
    }
}

#[test]
fn golden_vectors_match_solidity() {
    let tag = genesis_tag();
    assert_eq!(hex::encode(tag), GENESIS_TAG.trim_start_matches("0x"));

    let root = genesis_root(&U256::from_u64(1), 3);
    assert_eq!(hex::encode(root), GENESIS_ROOT.trim_start_matches("0x"), "genesis root drifted");

    let unique = unique_id("iron_sword", 42);
    assert_eq!(unique.to_dec(), UNIQUE_ID, "unique item id drifted");
    let fungible = fungible_id("iron_ore");
    assert_eq!(fungible.to_dec(), FUNGIBLE_ID, "fungible item id drifted");

    let body = checkpoint_body_hash(&golden_checkpoint());
    assert_eq!(hex::encode(body), BODY_HASH.trim_start_matches("0x"), "checkpoint encoding drifted");

    let digest = eip712_digest(
        &U256::from_u64(31337),
        &parse_address("0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9").unwrap(),
        &U256::from_u64(1),
        &parse_address("0x000000000000000000000000000000000000dEaD").unwrap(),
        3,
        &U256::from_u64(1_900_000_000),
        &body,
    );
    assert_eq!(hex::encode(digest), DIGEST.trim_start_matches("0x"), "eip712 digest drifted");
}

#[test]
fn spawn_chains_from_the_genesis_anchor() {
    let token = U256::from_u64(1);
    let mut engine = Engine::open(token, 3);
    assert_eq!(hex::encode(engine.genesis()), GENESIS_ROOT.trim_start_matches("0x"));
    assert_eq!(engine.head(), engine.genesis());
    assert!(engine.state().is_empty());

    let outcome = engine
        .apply(Input::Spawn { token_id: token, starting_job: 3 })
        .expect("spawn");
    match outcome {
        Outcome::Applied { index, prev_hash, entry_hash, state_root, summary } => {
            assert_eq!(index, 0);
            assert_eq!(prev_hash, engine.genesis());
            assert_eq!(entry_hash, engine.head());
            assert_ne!(state_root, prev_hash);
            assert_eq!(summary, U256::from_u64(1).bitor(U256::from_u64(3).shl(16)));
            assert_eq!(engine.state().get(&Key::Level), U256::from_u64(1));
            assert_eq!(engine.state().root(), state_root);
        }
    }
}

#[test]
fn state_root_ignores_insertion_order() {
    let item = unique_id("iron_sword", 42);
    let a = vec![
        (Key::Level, U256::from_u64(1)),
        (Key::Item(item), U256::from_u64(1)),
        (Key::Gold, U256::ZERO),
    ];
    let b = vec![
        (Key::Gold, U256::ZERO),
        (Key::Item(item), U256::from_u64(1)),
        (Key::Level, U256::from_u64(1)),
    ];
    assert_eq!(commit_entries(a), commit_entries(b));
}


#[test]
fn the_same_spawn_under_two_rulesets_has_two_entry_hashes() {
    let token = U256::from_u64(1);
    let spawn = Input::Spawn { token_id: token, starting_job: 3 };
    let prev = genesis_root(&token, 3);
    let zero = [0u8; 32];
    let marked = word(0x44);
    let zero_link = entry_hash(&prev, 0, &spawn, &zero);
    let marked_link = entry_hash(&prev, 0, &spawn, &marked);
    assert_ne!(zero_link, marked_link);
    assert_eq!(hex::encode(zero_link), ENTRY_HASH_OLD_PREIMAGE.trim_start_matches("0x"), "a zero ruleset must keep the old three-field digest");
    assert_eq!(hex::encode(marked_link), ENTRY_HASH_RULESET_44.trim_start_matches("0x"), "marked-ruleset entry hash drifted");

    let mut engine_zero = Engine::open(token, 3);
    assert_eq!(engine_zero.ruleset_hash(), zero);
    engine_zero.apply(spawn.clone()).expect("spawn");
    let mut engine_marked = Engine::open(token, 3);
    engine_marked.set_ruleset_hash(marked);
    engine_marked.apply(spawn.clone()).expect("spawn");
    assert_eq!(engine_zero.head(), zero_link);
    assert_eq!(engine_marked.head(), marked_link);

    let mut world_zero = World::new();
    world_zero.append_spawn(token, 3).expect("spawn");
    let mut world_marked = World::new();
    world_marked.set_ruleset_hash(marked);
    world_marked.append_spawn(token, 3).expect("spawn");
    assert_eq!(world_zero.character_head(&token).unwrap(), zero_link);
    assert_eq!(world_marked.character_head(&token).unwrap(), marked_link);
}

#[test]
fn replay_stops_at_the_first_bad_hash() {
    let token = U256::from_u64(1);
    let spawn = Input::Spawn { token_id: token, starting_job: 3 };
    let mut engine = Engine::open(token, 3);
    let Outcome::Applied { entry_hash: first, .. } = engine.apply(spawn.clone()).unwrap();
    let second = entry_hash(&engine.head(), 1, &spawn, &[0u8; 32]);
    let mut bad = second;
    bad[31] ^= 0x01;

    let doc = lok_engine::LogDocument {
        token_id: token,
        starting_job: 3,
        entries: vec![
            lok_engine::LoggedEntry { hash: first, input: spawn.clone(), seq: 0, ruleset_hash: [0u8; 32] },
            lok_engine::LoggedEntry { hash: bad, input: spawn.clone(), seq: 1, ruleset_hash: [0u8; 32] },
            lok_engine::LoggedEntry { hash: [0u8; 32], input: spawn, seq: 2, ruleset_hash: [0u8; 32] },
        ],
    };
    match replay(&doc).unwrap_err() {
        ReplayStop::BadHash { index, expected, computed } => {
            assert_eq!(index, 1, "must stop on the first bad link, not a later one");
            assert_eq!(expected, bad);
            assert_eq!(computed, second);
        }
        other => panic!("expected bad hash, got {other:?}"),
    }
}

#[test]
fn replay_cli_stops_at_the_first_bad_hash() {
    let token = U256::from_u64(1);
    let spawn = Input::Spawn { token_id: token, starting_job: 3 };
    let mut engine = Engine::open(token, 3);
    let Outcome::Applied { entry_hash, state_root, summary, .. } = engine.apply(spawn).unwrap();

    let good = serde_json::json!({
        "tokenId": "1",
        "startingJob": 3,
        "entries": [{
            "hash": format!("0x{}", hex::encode(entry_hash)),
            "input": { "type": "spawn", "tokenId": "1", "startingJob": 3 }
        }]
    });
    let good_path = std::env::temp_dir().join(format!("lok-good-{}.json", std::process::id()));
    std::fs::write(&good_path, good.to_string()).unwrap();
    let ok = Command::new(env!("CARGO_BIN_EXE_lok-replay"))
        .arg(&good_path)
        .output()
        .expect("run lok-replay");
    assert!(ok.status.success(), "stderr {}", String::from_utf8_lossy(&ok.stderr));
    let stdout = String::from_utf8(ok.stdout).unwrap();
    assert!(stdout.contains(&format!("0x{}", hex::encode(state_root))));
    assert!(stdout.contains(&summary.to_hex()));

    let bad_hash = {
        let mut h = entry_hash;
        h[0] ^= 0xff;
        format!("0x{}", hex::encode(h))
    };
    let bad = serde_json::json!({
        "tokenId": "1",
        "startingJob": 3,
        "entries": [{
            "hash": bad_hash,
            "input": { "type": "spawn", "tokenId": "1", "startingJob": 3 }
        }]
    });
    let bad_path = std::env::temp_dir().join(format!("lok-bad-{}.json", std::process::id()));
    std::fs::write(&bad_path, bad.to_string()).unwrap();
    let stopped = Command::new(env!("CARGO_BIN_EXE_lok-replay"))
        .arg(&bad_path)
        .output()
        .expect("run lok-replay");
    assert_eq!(stopped.status.code(), Some(1));
    let stderr = String::from_utf8(stopped.stderr).unwrap();
    assert!(stderr.contains("bad hash at index 0"), "{stderr}");
    let _ = parse_b256(GENESIS_ROOT);
    let _ = parse_log(&good.to_string());
}
