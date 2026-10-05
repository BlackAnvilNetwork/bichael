//! Regression: committed logs written before #206 must replay exactly as they were written.
//!
//! Before #206 an `ItemDrop` entry credited spendable items. #206 reinterpreted it as a
//! non-minting counter, so the live log stopped replaying at seq 21 (`list` of 6 x item 1029)
//! with `insufficient item`. Committed entries are never reinterpreted: a historical `ItemDrop`
//! still credits on replay, a NEW `ItemDrop` append is refused (`ClosedMint`), and mob loot is
//! logged as the non-minting `LootDrop` counter.
//!
//! Only `ItemDrop` entries at `seq <= HISTORICAL_ITEM_DROP_MAX_SEQ` (174, the last seq of the
//! quarantined log) credit. A later `ItemDrop` is refused even on replay, so a forged entry with a
//! valid hash chain cannot mint.
//!
//! The fixtures are tokens 1 and 4 copied unmodified (same hashes, same seq) from the quarantined
//! live log `apps/server/data/lok-world.json.bak-pre-aacc7c8-20261005-151212`. The pinned heads and
//! state roots were produced by the engine at 7da6228 (before #206) and, for the lone-character
//! log, by the engine before 04da65a.

use lok_engine::{
    entry_hash, event_id, genesis_root, load_world, parse_b256, parse_log, parse_world_log, replay, replay_world,
    CharacterLogDocument, Engine, EngineError, Input, Key, LogDocument, LoggedEntry, ReplayStop, U256, World,
    WorldDocument, HISTORICAL_ITEM_DROP_MAX_SEQ,
};

const WORLD: &str = include_str!("fixtures/pre-206-item-drop-world.json");
const CHARACTER: &str = include_str!("fixtures/pre-206-item-drop-character.json");

const WORLD_HEAD: &str = "0xa0de5916755575b556b10c639881f7ff28c2ce18c43ff931991df900bf0f7e0c";
const TOKEN1_ROOT: &str = "0x176684f027b419d00afb19609ac2ae33b0da801738589b051674a93c4b4b44ab";
const TOKEN4_ROOT: &str = "0x6aa8b05dac2f3e8806945751f791ec133ab8ede3ff9861a8afd36e1891738d21";
const TOKEN1_HEAD: &str = "0xc3531a6c414c92a856f91f0c5e412ec257f4176c9aa0dcd3abf51a036d5909c6";

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn b(hex: &str) -> [u8; 32] {
    parse_b256(hex).expect("pinned hash")
}

fn world_doc() -> WorldDocument {
    parse_world_log(WORLD).expect("fixture parses")
}

/// The fixture truncated to entries with `seq <= last` (chains are only ever truncated, so hashes stay valid).
fn world_doc_through(last: u64) -> WorldDocument {
    let mut doc = world_doc();
    for character in &mut doc.characters {
        character.entries.retain(|e| e.seq <= last);
    }
    doc
}

#[test]
fn committed_pre_206_world_log_replays_with_its_original_head_and_roots() {
    let doc = world_doc();
    let has_item_drop = doc
        .characters
        .iter()
        .flat_map(|c| c.entries.iter())
        .any(|e| matches!(e.input, Input::ItemDrop { .. }));
    assert!(has_item_drop, "fixture must carry minting ItemDrop entries");

    let report = match replay_world(&doc) {
        Ok(report) => report,
        Err(stop) => panic!("pre-#206 log must replay; #206 semantics stop at seq 21 (insufficient item): {stop:?}"),
    };
    assert_eq!(report.entries, 42);
    assert_eq!(report.head, b(WORLD_HEAD));
    let root_of = |token: u64| {
        report
            .characters
            .iter()
            .find(|s| s.token_id == n(token))
            .map(|s| s.state_root)
            .expect("character replayed")
    };
    assert_eq!(root_of(1), b(TOKEN1_ROOT));
    assert_eq!(root_of(4), b(TOKEN4_ROOT));
}

#[test]
fn historical_item_drop_credits_the_stack_the_seq_21_list_spends() {
    // Through seq 20: six 1029 drops and five 1057 drops, all still spendable.
    let world = load_world(&world_doc_through(20)).expect("prefix replays");
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(n(6)));
    assert_eq!(world.item_balance(&n(4), &n(1057)), Some(n(5)));
    // A historical credit is not a LootDrop counter.
    assert_eq!(world.dropped(&n(4), &n(1029)), Some(U256::ZERO));
    assert_eq!(world.kek_balance(&n(4)), Some(U256::ZERO));

    // Seq 21 lists all six. This is the entry #206 rejected with `insufficient item`.
    let world = load_world(&world_doc_through(21)).expect("seq 21 list replays");
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
    assert!(world.listing(&n(1)).is_some());

    // Full fixture: every credited drop was later exported, so nothing is left over.
    let world = load_world(&world_doc()).expect("full fixture replays");
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(4), &n(1057)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(1057)), Some(U256::ZERO));
}

#[test]
fn lone_engine_replays_a_historical_item_drop_then_its_export() {
    let doc = parse_log(CHARACTER).expect("fixture parses");
    assert!(matches!(doc.entries[3].input, Input::ItemDrop { .. }));
    assert!(matches!(doc.entries[4].input, Input::ExportItem { .. }));
    let report = match replay(&doc) {
        Ok(report) => report,
        Err(stop) => panic!("lone replay of a pre-#206 character log must succeed: {stop:?}"),
    };
    assert_eq!(report.entries, 9);
    assert_eq!(report.head, b(TOKEN1_HEAD));
    assert_eq!(report.state_root, b(TOKEN1_ROOT));
}

#[test]
fn new_item_drop_append_is_closed_and_loot_drop_counts_without_minting() {
    let mut world = load_world(&world_doc()).expect("fixture replays");
    let len = world.character_len(&n(4)).unwrap();
    let head = world.character_head(&n(4)).unwrap();

    assert_eq!(
        world.apply(Input::ItemDrop { token_id: n(4), item_id: n(1029), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(world.character_len(&n(4)), Some(len));
    assert_eq!(world.character_head(&n(4)), Some(head));
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(U256::ZERO));

    world
        .apply(Input::LootDrop { token_id: n(4), item_id: n(1029), amount: n(2) })
        .expect("loot counter appends");
    assert_eq!(world.character_len(&n(4)), Some(len + 1));
    assert_eq!(world.dropped(&n(4), &n(1029)), Some(n(2)));
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
    assert_eq!(world.kek_balance(&n(4)), Some(U256::ZERO));
    assert_eq!(
        world.apply(Input::LootDrop { token_id: n(4), item_id: n(0), amount: n(1) }).unwrap_err(),
        EngineError::BadId
    );
    assert_eq!(
        world.apply(Input::LootDrop { token_id: n(4), item_id: n(1029), amount: n(0) }).unwrap_err(),
        EngineError::ZeroAmount
    );
    assert_eq!(
        world.apply(Input::LootDrop { token_id: n(99), item_id: n(1029), amount: n(1) }).unwrap_err(),
        EngineError::NotSpawned
    );

    // Old entries and the new counter replay together.
    let again = load_world(&world.to_document()).expect("mixed log replays");
    assert_eq!(again.head(), world.head());
    assert_eq!(again.dropped(&n(4), &n(1029)), Some(n(2)));
    assert_eq!(again.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
}

#[test]
fn lone_engine_refuses_a_new_item_drop_but_replays_a_logged_one() {
    let mut engine = Engine::open(n(1), 0);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 0 }).unwrap();
    let len = engine.len();
    assert_eq!(
        engine.apply(Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(engine.len(), len);
    engine
        .replay_logged(Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) }, HISTORICAL_ITEM_DROP_MAX_SEQ)
        .expect("a logged ItemDrop at the historical bound replays as its credit");
    let len = engine.len();
    assert_eq!(
        engine
            .replay_logged(
                Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) },
                HISTORICAL_ITEM_DROP_MAX_SEQ + 1
            )
            .unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(engine.len(), len);
    assert_eq!(engine.state().get(&Key::Item(n(4))), n(1));
    assert_eq!(engine.state().get(&Key::Drop(n(4))), U256::ZERO);
    engine.apply(Input::LootDrop { token_id: n(1), item_id: n(4), amount: n(3) }).unwrap();
    assert_eq!(engine.state().get(&Key::Item(n(4))), n(1));
    assert_eq!(engine.state().get(&Key::Drop(n(4))), n(3));
}

#[test]
fn loot_drop_is_a_distinct_event_and_item_drop_keeps_its_id() {
    let drop = Input::ItemDrop { token_id: n(4), item_id: n(1029), amount: n(1) };
    let loot = Input::LootDrop { token_id: n(4), item_id: n(1029), amount: n(1) };
    assert_ne!(event_id(&drop), event_id(&loot));
    // A committed ItemDrop rewritten as LootDrop would no longer match its hash.
    let mut doc = world_doc();
    let entry = doc.characters[1].entries.iter_mut().find(|e| e.seq == 6).expect("seq 6 drop");
    if let Input::ItemDrop { token_id, item_id, amount } = entry.input.clone() {
        entry.input = Input::LootDrop { token_id, item_id, amount };
    } else {
        panic!("seq 6 is an ItemDrop");
    }
    assert!(matches!(load_world(&doc), Err(ReplayStop::BadHash { .. })));
}

#[test]
fn craft_skill_state_root_matches_the_pre_206_engine() {
    // #206 renumbered the CraftSkill leaf tag (13 -> 14) to fit the drop counter, which moved the
    // state root of every character with a craft skill. Pinned from 7da6228.
    let mut w = World::new();
    w.append_spawn(n(1), 0).unwrap();
    w.apply(Input::CraftSkill { token_id: n(1), skill_id: "weaving".into(), level: 3 }).unwrap();
    w.apply(Input::Harvest { token_id: n(1), material_id: "dustgrain".into(), amount: n(2) }).unwrap();
    w.apply(Input::Craft { token_id: n(1), item_id: n(9), amount: n(1) }).unwrap();
    assert_eq!(w.head(), b("0x6a888b68bdddbcb31e2ed1cfcd798bb688c3871344b2901d66d4f1d49dfbd15a"));
    assert_eq!(
        w.snapshots()[0].state_root,
        b("0xcd65eadb4fa5702f24e6cc4d5cafccf7631122f9e15dcc7c23799e1bc80e8444")
    );
}

#[test]
fn historical_bound_is_the_last_seq_of_the_quarantined_log() {
    assert_eq!(HISTORICAL_ITEM_DROP_MAX_SEQ, 174);
    let max_drop_seq = world_doc()
        .characters
        .iter()
        .flat_map(|c| c.entries.iter())
        .filter(|e| matches!(e.input, Input::ItemDrop { .. }))
        .map(|e| e.seq)
        .max()
        .unwrap();
    assert!(max_drop_seq <= HISTORICAL_ITEM_DROP_MAX_SEQ);
}

/// Spawn at seq 0, then one `ItemDrop` at `drop_seq`, with a valid hash chain.
fn synthetic_drop_doc(drop_seq: u64) -> WorldDocument {
    let spawn = Input::Spawn { token_id: n(1), starting_job: 0 };
    let drop = Input::ItemDrop { token_id: n(1), item_id: n(7), amount: n(5) };
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn);
    let h1 = entry_hash(&h0, 1, &drop);
    WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: h0, input: spawn, seq: 0 },
                LoggedEntry { hash: h1, input: drop, seq: drop_seq },
            ],
        }],
    }
}

#[test]
fn logged_item_drop_credits_at_the_bound_and_is_refused_past_it_on_replay() {
    let at = load_world(&synthetic_drop_doc(HISTORICAL_ITEM_DROP_MAX_SEQ)).expect("seq 174 is historical");
    assert_eq!(at.item_balance(&n(1), &n(7)), Some(n(5)));

    for seq in [HISTORICAL_ITEM_DROP_MAX_SEQ + 1, 10_000] {
        match load_world(&synthetic_drop_doc(seq)) {
            Err(ReplayStop::Rejected { index, reason: EngineError::ClosedMint }) => assert_eq!(index, seq),
            other => panic!("ItemDrop at seq {seq} must not credit on replay: {other:?}"),
        }
    }
}

#[test]
fn forged_item_drop_appended_to_the_real_log_with_a_valid_hash_is_refused() {
    let world = load_world(&world_doc()).expect("fixture replays");
    let head = world.character_head(&n(4)).unwrap();
    let index = world.character_len(&n(4)).unwrap();
    let forged = Input::ItemDrop { token_id: n(4), item_id: n(1029), amount: n(1_000_000) };
    let mut doc = world_doc();
    doc.characters[1].entries.push(LoggedEntry {
        hash: entry_hash(&head, index, &forged),
        input: forged,
        seq: HISTORICAL_ITEM_DROP_MAX_SEQ + 1,
    });
    match load_world(&doc) {
        Err(ReplayStop::Rejected { index, reason: EngineError::ClosedMint }) => {
            assert_eq!(index, HISTORICAL_ITEM_DROP_MAX_SEQ + 1)
        }
        other => panic!("forged ItemDrop must not mint: {other:?}"),
    }
}

#[test]
fn lone_replay_refuses_an_item_drop_past_the_bound() {
    let mut doc: LogDocument = parse_log(CHARACTER).expect("fixture parses");
    let head = replay(&doc).expect("fixture replays").head;
    let forged = Input::ItemDrop { token_id: n(1), item_id: n(1057), amount: n(9) };
    let index = doc.entries.len() as u64;
    doc.entries.push(LoggedEntry {
        hash: entry_hash(&head, index, &forged),
        input: forged,
        seq: HISTORICAL_ITEM_DROP_MAX_SEQ + 1,
    });
    assert_eq!(
        replay(&doc).unwrap_err(),
        ReplayStop::Rejected { index, reason: EngineError::ClosedMint }
    );
}
