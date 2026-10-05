//! Level, ability, craft, harvest, and loot. None of these mint KEK.

use lok_engine::{load_world, Engine, EngineError, Input, Key, U256, World};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

#[test]
fn game_state_events_replay_and_a_bad_event_does_not_append() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    assert_eq!(world.level(&n(1)), Some(1));
    assert_eq!(world.kek_balance(&n(1)), Some(U256::ZERO));

    world.apply(Input::LevelUp { token_id: n(1), level: 2 }).unwrap();
    assert_eq!(world.level(&n(1)), Some(2));
    let len = world.len();
    let head = world.head();
    assert_eq!(
        world.apply(Input::LevelUp { token_id: n(1), level: 4 }).unwrap_err(),
        EngineError::BadLevel
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.head(), head);
    assert_eq!(world.level(&n(1)), Some(2));

    world
        .apply(Input::LearnAbility { token_id: n(1), ability_id: "fire".into() })
        .unwrap();
    assert!(world.knows(&n(1), "fire"));
    let len = world.len();
    assert_eq!(
        world
            .apply(Input::LearnAbility { token_id: n(1), ability_id: "fire".into() })
            .unwrap_err(),
        EngineError::AlreadyKnown
    );
    assert_eq!(world.len(), len);

    world
        .apply(Input::Craft { token_id: n(1), item_id: n(9), amount: n(1) })
        .unwrap();
    world
        .apply(Input::Craft { token_id: n(1), item_id: n(9), amount: n(2) })
        .unwrap();
    assert_eq!(world.crafted(&n(1), &n(9)), Some(n(3)));
    assert_eq!(world.item_balance(&n(1), &n(9)), Some(n(0)));
    assert_eq!(
        world.apply(Input::Craft { token_id: n(1), item_id: n(0), amount: n(1) }).unwrap_err(),
        EngineError::BadId
    );

    world
        .apply(Input::Harvest {
            token_id: n(1),
            material_id: "dustgrain".into(),
            amount: n(1),
        })
        .unwrap();
    assert_eq!(world.harvested(&n(1), "dustgrain"), Some(n(1)));
    let len = world.len();
    assert_eq!(
        world
            .apply(Input::Harvest { token_id: n(1), material_id: "".into(), amount: n(1) })
            .unwrap_err(),
        EngineError::BadId
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.harvested(&n(1), "dustgrain"), Some(n(1)));

    // A new ItemDrop append is closed. Mob loot is a LootDrop counter.
    let len = world.len();
    let head = world.head();
    assert_eq!(
        world.apply(Input::ItemDrop { token_id: n(1), item_id: n(7), amount: n(2) }).unwrap_err(),
        EngineError::ClosedMint
    );
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.len(), len);
    assert_eq!(world.head(), head);

    world
        .apply(Input::LootDrop { token_id: n(1), item_id: n(7), amount: n(2) })
        .unwrap();
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(world.kek_balance(&n(1)), Some(U256::ZERO));
    let len = world.len();
    assert_eq!(
        world.apply(Input::LootDrop { token_id: n(1), item_id: n(0), amount: n(1) }).unwrap_err(),
        EngineError::BadId
    );
    assert_eq!(world.len(), len);
    assert_eq!(world.dropped(&n(1), &n(7)), Some(n(2)));

    let again = load_world(&world.to_document()).expect("replay");
    assert_eq!(again.level(&n(1)), Some(2));
    assert!(again.knows(&n(1), "fire"));
    assert_eq!(again.crafted(&n(1), &n(9)), Some(n(3)));
    assert_eq!(again.harvested(&n(1), "dustgrain"), Some(n(1)));
    assert_eq!(again.dropped(&n(1), &n(7)), Some(n(2)));
    assert_eq!(again.item_balance(&n(1), &n(7)), Some(U256::ZERO));
    assert_eq!(again.kek_balance(&n(1)), Some(U256::ZERO));
    assert_eq!(again.head(), world.head());
    assert_eq!(again.len(), world.len());
}

#[test]
fn lone_engine_records_level_and_drop_without_minting_kek() {
    let mut engine = Engine::open(n(1), 0);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 0 }).unwrap();
    engine.apply(Input::LevelUp { token_id: n(1), level: 2 }).unwrap();
    assert_eq!(
        engine.apply(Input::ItemDrop { token_id: n(1), item_id: n(4), amount: n(1) }).unwrap_err(),
        EngineError::ClosedMint
    );
    engine
        .apply(Input::LootDrop { token_id: n(1), item_id: n(4), amount: n(1) })
        .unwrap();
    engine
        .apply(Input::LearnAbility { token_id: n(1), ability_id: "hub".into() })
        .unwrap();
    engine
        .apply(Input::Craft { token_id: n(1), item_id: n(8), amount: n(1) })
        .unwrap();
    engine
        .apply(Input::Harvest { token_id: n(1), material_id: "ore".into(), amount: n(3) })
        .unwrap();
    assert_eq!(engine.state().level_u32(), 2);
    assert_eq!(engine.state().get(&Key::Item(n(4))), U256::ZERO);
    assert_eq!(engine.state().get(&Key::Drop(n(4))), n(1));
    assert_eq!(engine.state().get(&Key::Craft(n(8))), n(1));
    assert_eq!(engine.state().get(&Key::Kek), U256::ZERO);
    let before = engine.len();
    assert_eq!(
        engine.apply(Input::LevelUp { token_id: n(1), level: 9 }).unwrap_err(),
        EngineError::BadLevel
    );
    assert_eq!(
        engine
            .apply(Input::LearnAbility { token_id: n(1), ability_id: "hub".into() })
            .unwrap_err(),
        EngineError::AlreadyKnown
    );
    assert_eq!(engine.len(), before);
    assert_eq!(engine.state().get(&Key::Kek), U256::ZERO);
}


#[test]
fn paid_respec_debits_kek_and_drops_nodes_atomically() {
    let mut w = World::new();
    w.append_spawn(n(1), 0).unwrap();
    w.append_deposit_kek(n(1), n(15_000), 1).unwrap();
    w.apply(Input::LearnAbility {
        token_id: n(1),
        ability_id: "node_a".into(),
    })
    .unwrap();
    assert_eq!(w.kek_balance(&n(1)), Some(n(15_000)));
    assert!(w.knows(&n(1), "node_a"));

    assert_eq!(
        w.append_paid_respec_skills(n(1), n(20_000), vec!["node_a".into()])
            .unwrap_err(),
        EngineError::InsufficientKek
    );
    assert_eq!(w.kek_balance(&n(1)), Some(n(15_000)));
    assert!(w.knows(&n(1), "node_a"));

    assert_eq!(
        w.append_paid_respec_skills(n(1), n(10_000), vec![])
            .unwrap_err(),
        EngineError::BadId
    );
    assert_eq!(w.kek_balance(&n(1)), Some(n(15_000)));
    assert!(w.knows(&n(1), "node_a"));

    w.append_paid_respec_skills(n(1), n(10_000), vec!["node_a".into()])
        .unwrap();
    assert_eq!(w.kek_balance(&n(1)), Some(n(5_000)));
    assert!(!w.knows(&n(1), "node_a"));
}


#[test]
fn bag_import_credits_without_consuming_inbound_nonce() {
    let mut world = World::new();
    world.append_spawn(n(1), 0).unwrap();
    world
        .apply(Input::BagImport {
            token_id: n(1),
            item_id: n(7),
            amount: n(2),
        })
        .unwrap();
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(n(2)));
    assert_eq!(world.inbound_applied(&n(1)), Some(0));

    world.append_deposit_kek(n(1), n(100), 1).unwrap();
    assert_eq!(world.kek_balance(&n(1)), Some(n(100)));
    assert_eq!(world.inbound_applied(&n(1)), Some(1));
    assert_eq!(world.item_balance(&n(1), &n(7)), Some(n(2)));

    // A gap (nonce 3 when next is 2) must not look like a silent replay.
    assert_eq!(
        world.append_deposit_kek(n(1), n(1), 3).unwrap_err(),
        EngineError::OutOfOrderInbound
    );
    assert_eq!(world.inbound_applied(&n(1)), Some(1));

    // An already-consumed nonce is a replay, not a gap.
    assert_eq!(
        world.append_deposit_kek(n(1), n(1), 1).unwrap_err(),
        EngineError::ReplayInbound
    );
}
