//! A new loot drop names a kill in the same batch.
//! A kill already on the log from an earlier batch does not count.
//! ItemDrop stays ClosedMint. A logged drop below the sequence cutoff still replays.

use lok_engine::{
    entry_hash, genesis_root, load_world, set_drop_kill_min_seq, CharacterLogDocument, EngineError,
    Input, LoggedEntry, ReplayStop, U256, World, WorldDocument, HISTORICAL_DROP_KILL_MIN_SEQ,
};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

struct DropCutoffGuard;
impl Drop for DropCutoffGuard {
    fn drop(&mut self) {
        set_drop_kill_min_seq(HISTORICAL_DROP_KILL_MIN_SEQ);
    }
}

#[test]
fn a_kill_from_an_earlier_batch_does_not_justify_a_drop() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world.begin_batch(1);
    world
        .apply(Input::Kill {
            token_id: n(1),
            kill_id: n(4),
            batch_id: 1,
        })
        .unwrap();
    world.begin_batch(2);
    let len = world.len();
    assert_eq!(
        world
            .apply(Input::LootDrop {
                token_id: n(1),
                item_id: n(7),
                amount: n(2),
                kill_id: Some(n(4)),
                batch_id: Some(1),
            })
            .unwrap_err(),
        EngineError::DropWithoutKill
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));

    world
        .apply(Input::Kill {
            token_id: n(1),
            kill_id: n(5),
            batch_id: 2,
        })
        .unwrap();
    world
        .apply(Input::LootDrop {
            token_id: n(1),
            item_id: n(7),
            amount: n(2),
            kill_id: Some(n(5)),
            batch_id: Some(2),
        })
        .unwrap();
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(1)), Some(U256::ZERO));

    let again = load_world(&world.to_document()).expect("same-batch kill and drop replay");
    assert_eq!(again.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(again.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(again.head(), world.head());
}

#[test]
fn a_new_drop_without_a_kill_is_refused() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    let len = world.len();
    let head = world.head();
    assert_eq!(
        world
            .apply(Input::LootDrop {
                token_id: n(1),
                item_id: n(7),
                amount: n(1),
                kill_id: None,
                batch_id: None,
            })
            .unwrap_err(),
        EngineError::DropWithoutKill
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.head(), head);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
}

#[test]
fn item_drop_stays_closed_mint() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world.begin_batch(1);
    world
        .apply(Input::Kill {
            token_id: n(1),
            kill_id: n(4),
            batch_id: 1,
        })
        .unwrap();
    let len = world.len();
    assert_eq!(
        world
            .apply(Input::ItemDrop {
                token_id: n(1),
                item_id: n(7),
                amount: n(1),
            })
            .unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));
}

#[test]
fn an_old_log_line_without_a_kill_still_replays() {
    assert_eq!(HISTORICAL_DROP_KILL_MIN_SEQ, u64::MAX);

    let spawn = Input::Spawn {
        token_id: n(1),
        starting_job: 0,
    };
    let drop = Input::LootDrop {
        token_id: n(1),
        item_id: n(7),
        amount: n(2),
        kill_id: None,
        batch_id: None,
    };
    let h0 = entry_hash(&genesis_root(&n(1), 0), 0, &spawn, &[0u8; 32]);
    let h1 = entry_hash(&h0, 1, &drop, &[0u8; 32]);
    let doc = WorldDocument {
        characters: vec![CharacterLogDocument {
            token_id: n(1),
            starting_job: 0,
            entries: vec![
                LoggedEntry {
                    hash: h0,
                    input: spawn,
                    seq: 0,
                    ruleset_hash: [0u8; 32],
                },
                LoggedEntry {
                    hash: h1,
                    input: drop.clone(),
                    seq: 175,
                    ruleset_hash: [0u8; 32],
                },
            ],
        }],
    };
    let loaded = load_world(&doc).expect("logged loot drop without a kill still replays");
    assert_eq!(loaded.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(loaded.item_balance(&n(1), &n(7)), Some(U256::ZERO));

    set_drop_kill_min_seq(175);
    let _restore = DropCutoffGuard;
    match load_world(&doc) {
        Err(ReplayStop::Rejected {
            reason: EngineError::DropWithoutKill,
            ..
        }) => {}
        other => panic!("a logged drop at the lowered cutoff must name a kill: {other:?}"),
    }
}
