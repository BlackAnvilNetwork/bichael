//! A new drop names a kill in the same batch. An already-logged drop does not.

use lok_engine::{
    drop_kill_min_seq, drop_kill_required_at, entry_hash, genesis_root, gold_source_cap, load_world,
    set_drop_kill_min_seq, CharacterLogDocument, EngineError, Input, LoggedEntry, ReplayStop, U256, World,
    GOLD_DAILY_TOTAL_CAP, HISTORICAL_DROP_KILL_MIN_SEQ,
};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn bare(token: u64, item: u64, amount: u64) -> Input {
    Input::LootDrop {
        token_id: n(token),
        item_id: n(item),
        amount: n(amount),
        kill_id: None,
        batch_id: None,
    }
}

fn named(token: u64, item: u64, amount: u64, kill: u64, batch: u64) -> Input {
    Input::LootDrop {
        token_id: n(token),
        item_id: n(item),
        amount: n(amount),
        kill_id: Some(n(kill)),
        batch_id: Some(batch),
    }
}

struct RestoreMin(u64);

impl Drop for RestoreMin {
    fn drop(&mut self) {
        set_drop_kill_min_seq(self.0);
    }
}

#[test]
fn world_apply_keeps_the_daily_gold_ceilings() {
    assert_eq!(GOLD_DAILY_TOTAL_CAP, 50_000);
    assert_eq!(gold_source_cap("quest"), 20_000);
    assert_eq!(gold_source_cap("drop"), 15_000);
    assert_eq!(gold_source_cap("harvest"), 15_000);
    assert_eq!(gold_source_cap("npc_sell"), 10_000);
    assert_eq!(gold_source_cap("other"), 5_000);

    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world
        .apply(Input::GoldEarn {
            token_id: n(1),
            source: "drop".into(),
            amount: n(15_000),
            day: 1,
        })
        .unwrap();
    assert_eq!(
        world
            .apply(Input::GoldEarn {
                token_id: n(1),
                source: "drop".into(),
                amount: n(1),
                day: 1,
            })
            .unwrap_err(),
        EngineError::EarnCap
    );
    assert_eq!(world.gold_balance(&n(1)), Some(n(15_000)));
    assert_eq!(
        world.apply(Input::ItemDrop { token_id: n(1), item_id: n(7), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
}

#[test]
fn a_new_drop_requires_a_kill_in_the_same_batch() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    let len = world.len();
    assert_eq!(world.apply(bare(1, 7, 1)).unwrap_err(), EngineError::DropWithoutKill);
    assert_eq!(world.len(), len);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));

    world.apply(Input::Kill { token_id: n(1), kill_id: n(4), batch_id: 1 }).unwrap();
    world.apply(named(1, 7, 3, 4, 1)).unwrap();
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(3)));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(1)), Some(U256::ZERO));

    world.begin_batch(2);
    assert_eq!(world.apply(named(1, 7, 1, 4, 1)).unwrap_err(), EngineError::DropWithoutKill);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(3)));
    world.apply(Input::Kill { token_id: n(1), kill_id: n(5), batch_id: 2 }).unwrap();
    world.apply(named(1, 7, 1, 5, 2)).unwrap();
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(4)));

    let mut again = load_world(&world.to_document()).expect("kill and drop replay");
    assert_eq!(again.head(), world.head());
    assert_eq!(again.dropped(&n(1), &n(7)), Some(n(4)));
    assert_eq!(again.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    again.begin_batch(3);
    assert_eq!(again.apply(named(1, 7, 1, 5, 2)).unwrap_err(), EngineError::DropWithoutKill);
}

#[test]
fn an_already_logged_loot_drop_replays_without_a_kill() {
    assert_eq!(HISTORICAL_DROP_KILL_MIN_SEQ, u64::MAX);
    assert!(!drop_kill_required_at(Some(174)));
    assert!(drop_kill_required_at(None));

    let spawn = Input::Spawn { token_id: n(1), starting_job: 0 };
    let drop = bare(1, 7, 2);
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn, &[0u8; 32]);
    let h1 = entry_hash(&h0, 1, &drop, &[0u8; 32]);
    let doc = lok_engine::WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry { hash: h0, input: spawn, seq: 0, ruleset_hash: [0u8; 32] },
                LoggedEntry { hash: h1, input: drop, seq: 9, ruleset_hash: [0u8; 32] },
            ],
        }],
    };
    let world = load_world(&doc).expect("old loot drop replays");
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));

    let _restore = RestoreMin(drop_kill_min_seq());
    set_drop_kill_min_seq(9);
    assert!(drop_kill_required_at(Some(9)));
    match load_world(&doc) {
        Err(ReplayStop::Rejected { index, reason: EngineError::DropWithoutKill }) => assert_eq!(index, 9),
        other => panic!("a drop at the cutoff must name a kill: {other:?}"),
    }
}
