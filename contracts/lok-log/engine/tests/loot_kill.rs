//! A loot drop cites a prior mob kill on that character's log.
//!
//! `MobKill` records the death and credits nothing. `PvpKill` settles a chain bounty
//! and does not justify the drop. `ItemDrop` stays `ClosedMint`.

use lok_engine::{load_world, Engine, EngineError, Input, Key, U256, World, PVP_BOUNTY_WEI};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn loot(token: u64, kill_seq: u64) -> Input {
    Input::LootDrop {
        token_id: n(token),
        item_id: n(7),
        amount: n(1),
        kill_seq,
    }
}

#[test]
fn loot_requires_a_prior_mob_kill_on_that_character() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world.append_spawn(n(2), 1).unwrap();
    let len = world.len();
    let head = world.head();

    assert_eq!(world.apply(loot(1, 0)).unwrap_err(), EngineError::NotAKill);
    assert_eq!(world.apply(loot(1, 1)).unwrap_err(), EngineError::MissingKill);
    assert_eq!(world.apply(loot(1, 2)).unwrap_err(), EngineError::FutureKill);
    assert_eq!(world.len(), len);
    assert_eq!(world.head(), head);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(1)), Some(U256::ZERO));

    let gathered = world
        .apply(Input::Harvest {
            token_id: n(1),
            material_id: "ore".into(),
            amount: n(1),
        })
        .unwrap();
    assert_eq!(world.apply(loot(1, gathered.seq)).unwrap_err(), EngineError::NotAKill);

    let kill = world.apply(Input::MobKill { token_id: n(1) }).unwrap();
    assert_eq!(world.level(&n(1)), Some(1));
    assert_eq!(world.gold_balance(&n(1)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.dropped(&n(1), &n(7)), Some(U256::ZERO));

    world
        .apply(Input::LootDrop {
            token_id: n(1),
            item_id: n(7),
            amount: n(2),
            kill_seq: kill.seq,
        })
        .unwrap();
    world.apply(loot(1, kill.seq)).unwrap();
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(3)));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(1)), Some(U256::ZERO));
    assert_eq!(world.apply(loot(2, kill.seq)).unwrap_err(), EngineError::MissingKill);
    assert_eq!(
        world.apply(Input::ItemDrop { token_id: n(1), item_id: n(7), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );

    let again = load_world(&world.to_document()).expect("kill and loot replay");
    assert_eq!(again.head(), world.head());
    assert_eq!(again.dropped(&n(1), &n(7)), Some(n(3)));
    assert_eq!(again.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(again.gold_balance(&n(1)), Some(U256::ZERO));
}

#[test]
fn pvp_kill_does_not_justify_mob_loot() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world.append_spawn(n(2), 0).unwrap();
    let amount = U256::from_u64(PVP_BOUNTY_WEI);
    world
        .append_pvp_bounty_open(n(1), amount, "pit".into(), [1u8; 32], 0)
        .unwrap();
    let slay = world
        .append_pvp_kill(n(1), n(2), "pit".into(), amount, [2u8; 32], 1)
        .unwrap();
    let len = world.len();
    assert_eq!(world.apply(loot(2, slay.seq)).unwrap_err(), EngineError::NotAKill);
    assert_eq!(world.len(), len);
    assert_eq!(world.dropped(&n(2), &n(7)), Some(U256::ZERO));
    assert_eq!(world.item_balance(&n(2), &n(7)), Some(U256::ZERO));
    assert_eq!(world.gold_balance(&n(2)), Some(U256::ZERO));
}

#[test]
fn lone_engine_cites_the_mob_kill_seq_and_credits_nothing_else() {
    let mut engine = Engine::open(n(1), 0);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 0 }).unwrap();
    assert_eq!(engine.apply(loot(1, 0)).unwrap_err(), EngineError::NotAKill);
    assert_eq!(engine.apply(loot(1, 1)).unwrap_err(), EngineError::FutureKill);
    assert_eq!(engine.len(), 1);

    engine.replay_logged(Input::MobKill { token_id: n(1) }, 4).unwrap();
    assert_eq!(engine.state().get(&Key::Gold), U256::ZERO);
    assert_eq!(engine.state().get(&Key::JobXp), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Item(n(7))), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Drop(n(7))), U256::ZERO);
    assert_eq!(engine.replay_logged(loot(1, 2), 5).unwrap_err(), EngineError::MissingKill);
    assert_eq!(engine.replay_logged(loot(1, 5), 5).unwrap_err(), EngineError::FutureKill);
    assert_eq!(engine.len(), 2);
    engine.replay_logged(loot(1, 4), 6).unwrap();
    assert_eq!(engine.state().get(&Key::Drop(n(7))), n(1));
    assert_eq!(engine.state().get(&Key::Item(n(7))), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Gold), U256::ZERO);
    assert_eq!(
        engine.replay_logged(Input::ItemDrop { token_id: n(1), item_id: n(7), amount: n(1) }, 99).unwrap_err(),
        EngineError::ClosedMint
    );
}
