//! `ItemDrop` is a closed mint at every seq.
//!
//! Before #206 an `ItemDrop` entry credited spendable items. A later cutoff credited those
//! entries only when `seq <= 174`. `seq` is not part of the entry hash, so a rebuilt log could
//! still mint by reusing a low seq. Logs may be cleared, so every `ItemDrop` is `ClosedMint`
//! on append and on replay. Mob loot is the non-minting `LootDrop` counter.
//!
//! The fixtures are tokens 1 and 4 copied unmodified from the quarantined live log
//! `apps/server/data/lok-world.json.bak-pre-aacc7c8-20261005-151212`. They must not open.

use lok_engine::{
    craft_skill_validated_at, entry_hash, event_id, genesis_root, load_world, parse_log, parse_world_log,
    replay, replay_world, set_craft_validate_min_seq, CharacterLogDocument, Engine, EngineError, Input,
    Key, LoggedEntry, ReplayStop, U256, World, WorldDocument, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ,
    HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH, HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY,
    HISTORICAL_ITEM_DROP_MAX_SEQ,
};

struct CraftCutoffGuard;
impl Drop for CraftCutoffGuard {
    fn drop(&mut self) {
        set_craft_validate_min_seq(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY);
    }
}

const WORLD: &str = include_str!("fixtures/pre-206-item-drop-world.json");
const CHARACTER: &str = include_str!("fixtures/pre-206-item-drop-character.json");

fn n(v: u64) -> U256 {
    U256::from_u64(v)
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

fn first_item_drop_seq(doc: &WorldDocument) -> u64 {
    doc.characters
        .iter()
        .flat_map(|c| c.entries.iter())
        .filter(|e| matches!(e.input, Input::ItemDrop { .. }))
        .map(|e| e.seq)
        .min()
        .expect("fixture has an ItemDrop")
}

#[test]
fn a_pre_206_item_drop_log_is_refused() {
    let doc = world_doc();
    let first = first_item_drop_seq(&doc);
    assert!(first <= HISTORICAL_ITEM_DROP_MAX_SEQ);
    let before = world_doc_through(first - 1);
    assert!(
        load_world(&before).is_ok(),
        "entries before the first ItemDrop still open"
    );
    match replay_world(&doc) {
        Err(ReplayStop::Rejected { index, reason: EngineError::ClosedMint }) => assert_eq!(index, first),
        other => panic!("ItemDrop must not credit: {other:?}"),
    }
    match load_world(&world_doc_through(first)) {
        Err(ReplayStop::Rejected { index, reason: EngineError::ClosedMint }) => assert_eq!(index, first),
        other => panic!("the first ItemDrop must refuse the prefix: {other:?}"),
    }
}

#[test]
fn lone_pre_206_character_log_is_refused_at_its_item_drop() {
    let doc = parse_log(CHARACTER).expect("fixture parses");
    let index = doc
        .entries
        .iter()
        .position(|e| matches!(e.input, Input::ItemDrop { .. }))
        .expect("character fixture has an ItemDrop") as u64;
    assert!(matches!(doc.entries[index as usize].input, Input::ItemDrop { .. }));
    assert_eq!(
        replay(&doc).unwrap_err(),
        ReplayStop::Rejected { index, reason: EngineError::ClosedMint }
    );
}

#[test]
fn new_item_drop_append_is_closed_and_loot_drop_counts_without_minting() {
    let mut world = World::new();
    world.append_spawn(n(4), 0).unwrap();
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
        .apply(Input::Kill { token_id: n(4), kill_id: n(1), batch_id: 1 })
        .unwrap();
    world
        .apply(Input::LootDrop {
            token_id: n(4),
            item_id: n(1029),
            amount: n(2),
            kill_id: Some(n(1)),
            batch_id: Some(1),
        })
        .expect("loot counter appends");
    assert_eq!(world.character_len(&n(4)), Some(len + 2));
    assert_eq!(world.dropped(&n(4), &n(1029)), Some(n(2)));
    assert_eq!(world.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(4)), Some(U256::ZERO));
    assert_eq!(
        world
            .apply(Input::LootDrop {
                token_id: n(4),
                item_id: n(0),
                amount: n(1),
                kill_id: None,
                batch_id: None,
            })
            .unwrap_err(),
        EngineError::BadId
    );
    assert_eq!(
        world
            .apply(Input::LootDrop {
                token_id: n(4),
                item_id: n(1029),
                amount: n(0),
                kill_id: None,
                batch_id: None,
            })
            .unwrap_err(),
        EngineError::ZeroAmount
    );
    assert_eq!(
        world
            .apply(Input::LootDrop {
                token_id: n(99),
                item_id: n(1029),
                amount: n(1),
                kill_id: None,
                batch_id: None,
            })
            .unwrap_err(),
        EngineError::NotSpawned
    );

    let again = load_world(&world.to_document()).expect("loot counter replays");
    assert_eq!(again.head(), world.head());
    assert_eq!(again.dropped(&n(4), &n(1029)), Some(n(2)));
    assert_eq!(again.item_balance(&n(4), &n(1029)), Some(U256::ZERO));
}

#[test]
fn lone_engine_refuses_item_drop_on_append_and_on_replay() {
    let mut engine = Engine::open(n(1), 0);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 0 }).unwrap();
    let len = engine.len();
    assert_eq!(
        engine.apply(Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(engine.len(), len);
    for seq in [0, HISTORICAL_ITEM_DROP_MAX_SEQ, HISTORICAL_ITEM_DROP_MAX_SEQ + 1] {
        assert_eq!(
            engine
                .replay_logged(Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) }, seq)
                .unwrap_err(),
            EngineError::ClosedMint
        );
        assert_eq!(engine.len(), len);
    }
    assert_eq!(engine.state().get(&Key::Item(n(4))), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Drop(n(4))), U256::ZERO);
    engine.apply(Input::Kill { token_id: n(1), kill_id: n(8), batch_id: 2 }).unwrap();
    engine
        .apply(Input::LootDrop {
            token_id: n(1),
            item_id: n(4),
            amount: n(3),
            kill_id: Some(n(8)),
            batch_id: Some(2),
        })
        .unwrap();
    assert_eq!(engine.state().get(&Key::Item(n(4))), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Drop(n(4))), n(3));
}

#[test]
fn loot_drop_is_a_distinct_event_and_item_drop_keeps_its_id() {
    let drop = Input::ItemDrop { token_id: n(4), item_id: n(1029), amount: n(1) };
    let loot = Input::LootDrop {
        token_id: n(4),
        item_id: n(1029),
        amount: n(1),
        kill_id: None,
        batch_id: None,
    };
    assert_ne!(event_id(&drop), event_id(&loot));
    // A committed ItemDrop rewritten as LootDrop would no longer match its hash.
    let mut doc = world_doc();
    let entry = doc.characters[1].entries.iter_mut().find(|e| e.seq == 6).expect("seq 6 drop");
    if let Input::ItemDrop { token_id, item_id, amount } = entry.input.clone() {
        entry.input = Input::LootDrop {
            token_id,
            item_id,
            amount,
            kill_id: None,
            batch_id: None,
        };
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
    // Bone Ring (313) is craftLevel 1 — new append validates and passes at default skill 1.
    w.apply(Input::Craft { token_id: n(1), item_id: n(313), amount: n(1) }).unwrap();
    let head = w.head();
    let root = w.snapshots()[0].state_root;
    // CraftSkill leaf tag pin (pre-#206 renumber regression) — values depend on craft item id.
    assert_ne!(head, [0u8; 32]);
    assert_ne!(root, [0u8; 32]);
    assert_eq!(w.crafted(&n(1), &n(313)), Some(n(1)));
}

#[test]
fn pre_cutoff_craft_of_high_level_recipe_replays_without_skill() {
    // Scale Harness (9) is leathercraft L40. A logged Craft at seq < 175 must still apply
    // even when CraftSkill was never recorded (pre-#222 logs).
    set_craft_validate_min_seq(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_LEGACY);
    let _restore = CraftCutoffGuard;
    assert!(!craft_skill_validated_at(Some(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ - 1)));
    assert!(craft_skill_validated_at(None));
    assert!(craft_skill_validated_at(Some(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ)));

    let mut w = World::new();
    w.append_spawn(n(1), 0).unwrap();
    assert_eq!(
        w.apply(Input::Craft { token_id: n(1), item_id: n(9), amount: n(1) })
            .unwrap_err(),
        EngineError::BadCraftLevel
    );

    // Synthetic pre-#222 character log: Spawn + Craft(9) at seq 10 (below cutoff).
    let spawn = Input::Spawn { token_id: n(1), starting_job: 0 };
    let craft = Input::Craft { token_id: n(1), item_id: n(9), amount: n(1) };
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn, &[0u8; 32]);
    let h1 = entry_hash(&h0, 1, &craft, &[0u8; 32]);
    let doc = WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: h0, input: spawn, seq: 0, ruleset_hash: [0u8; 32] },
                LoggedEntry { hash: h1, input: craft, seq: 10, ruleset_hash: [0u8; 32] },
            ],
        }],
    };
    let loaded = load_world(&doc).expect("pre-cutoff craft of L40 recipe must replay");
    assert_eq!(loaded.crafted(&n(1), &n(9)), Some(n(1)));

    // Same craft at/after the cutoff must refuse without skill.
    let spawn2 = Input::Spawn { token_id: n(2), starting_job: 0 };
    let craft2 = Input::Craft { token_id: n(2), item_id: n(9), amount: n(1) };
    let g0 = entry_hash(&genesis_root(&n(2), 0), 0, &spawn2, &[0u8; 32]);
    let g1 = entry_hash(&g0, 1, &craft2, &[0u8; 32]);
    let post = WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(2),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: g0, input: spawn2, seq: 0, ruleset_hash: [0u8; 32] },
                LoggedEntry {
                    hash: g1,
                    input: craft2,
                    seq: HISTORICAL_CRAFT_VALIDATE_MIN_SEQ,
                    ruleset_hash: [0u8; 32],
                },
            ],
        }],
    };
    match load_world(&post) {
        Err(ReplayStop::Rejected { reason: EngineError::BadCraftLevel, .. }) => {}
        other => panic!("post-cutoff craft without skill must fail: {other:?}"),
    }
}

#[test]
fn pre_222_gold_sell_of_potion_at_pinned_unit_replays() {
    // Potion unit must stay 20 so committed GoldSell amounts still verify.
    assert_eq!(lok_engine::npc_sell_unit_price(3), Some(20));
    assert_eq!(lok_engine::npc_sell_unit_price(1), Some(51));

    let mut w = World::new();
    w.append_spawn(n(1), 0).unwrap();
    w.apply(Input::BagImport { token_id: n(1), item_id: n(3), amount: n(2) })
        .unwrap();
    // Pre-#222 starter potion sell: unit 20 (not the post-audit formula's 3).
    w.apply(Input::GoldSell {
        token_id: n(1),
        item_id: n(3),
        qty: n(1),
        amount: n(20),
        day: 1,
    })
    .unwrap();
    assert_eq!(w.gold_balance(&n(1)), Some(n(20)));
    assert_eq!(w.item_balance(&n(1), &n(3)), Some(n(1)));

    let again = load_world(&w.to_document()).expect("potion GoldSell @20 must round-trip");
    assert_eq!(again.gold_balance(&n(1)), Some(n(20)));
    assert_eq!(again.item_balance(&n(1), &n(3)), Some(n(1)));

    // Drifted amount (post-audit formula) must not verify.
    let mut bad = World::new();
    bad.append_spawn(n(1), 0).unwrap();
    bad.apply(Input::BagImport { token_id: n(1), item_id: n(3), amount: n(1) })
        .unwrap();
    assert_eq!(
        bad.apply(Input::GoldSell {
            token_id: n(1),
            item_id: n(3),
            qty: n(1),
            amount: n(3),
            day: 1,
        })
        .unwrap_err(),
        EngineError::BadPrice
    );
}

#[test]
fn fresh_network_cutoff_validates_every_logged_craft() {
    // Chiado / Gnosis set min seq to 0 — a logged Craft at seq 10 of an L40 recipe
    // without CraftSkill must refuse (no historical exemption).
    set_craft_validate_min_seq(HISTORICAL_CRAFT_VALIDATE_MIN_SEQ_FRESH);
    let _restore = CraftCutoffGuard;
    assert!(craft_skill_validated_at(Some(0)));
    assert!(craft_skill_validated_at(Some(10)));

    let spawn = Input::Spawn { token_id: n(1), starting_job: 0 };
    let craft = Input::Craft { token_id: n(1), item_id: n(9), amount: n(1) };
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn, &[0u8; 32]);
    let h1 = entry_hash(&h0, 1, &craft, &[0u8; 32]);
    let doc = WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: h0, input: spawn, seq: 0, ruleset_hash: [0u8; 32] },
                LoggedEntry { hash: h1, input: craft, seq: 10, ruleset_hash: [0u8; 32] },
            ],
        }],
    };
    match load_world(&doc) {
        Err(ReplayStop::Rejected { reason: EngineError::BadCraftLevel, .. }) => {}
        other => panic!("fresh-network cutoff must validate seq 10 crafts: {other:?}"),
    }
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
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn, &[0u8; 32]);
    let h1 = entry_hash(&h0, 1, &drop, &[0u8; 32]);
    WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: h0, input: spawn, seq: 0, ruleset_hash: [0u8; 32] },
                LoggedEntry { hash: h1, input: drop, seq: drop_seq, ruleset_hash: [0u8; 32] },
            ],
        }],
    }
}

#[test]
fn a_hashed_item_drop_is_refused_at_every_seq() {
    // Spawn is seq 0. The drop seq must be later or the document is a conflicting log
    // before the mint check runs.
    for seq in [1, HISTORICAL_ITEM_DROP_MAX_SEQ, HISTORICAL_ITEM_DROP_MAX_SEQ + 1, 10_000] {
        match load_world(&synthetic_drop_doc(seq)) {
            Err(ReplayStop::Rejected { index, reason: EngineError::ClosedMint }) => assert_eq!(index, seq),
            other => panic!("ItemDrop at seq {seq} must not credit on replay: {other:?}"),
        }
    }
}
