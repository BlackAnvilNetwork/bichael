//! Per-character checkpoints and item conservation. KEK custody is retired.

use lok_engine::{
    entry_hash, event_id, genesis_root, keccak256, load_world, parse_world_log, Engine, EngineError,
    Gate, Input, Key, LoggedEntry, ReplayStop, U256, World, WorldDocument,
};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn next_inbound(world: &World, token: U256) -> u64 {
    world.inbound_applied(&token).unwrap_or(0).saturating_add(1)
}

fn import_item(world: &mut World, token: U256, item: U256, amount: U256) -> Result<lok_engine::AppliedEvent, EngineError> {
    let nonce = next_inbound(world, token);
    world.append_import_item(token, item, amount, nonce)
}


fn spawn_pair() -> World {
    let mut world = World::new();
    world.append_spawn(n(1), 3).unwrap();
    world.append_spawn(n(2), 1).unwrap();
    world
}

#[test]
fn transfer_is_on_both_logs_and_each_checkpoint_is_independent() {
    let mut world = spawn_pair();
    let ore = lok_engine::fungible_id("iron_ore");
    import_item(&mut world, n(1), ore, n(10)).unwrap();
    world.append_send_item(n(1), n(2), ore, n(4)).unwrap();

    let (a_at, b_at, a_send, b_send, a_deposit_hash) = {
        let a_entries = world.character_entries(&n(1)).unwrap();
        let b_entries = world.character_entries(&n(2)).unwrap();
        let a_at = a_entries.iter().position(|e| matches!(e.input, Input::SendItem { .. })).unwrap();
        let b_at = b_entries.iter().position(|e| matches!(e.input, Input::SendItem { .. })).unwrap();
        assert_ne!(a_at, b_at, "each log advances its own index");
        assert_eq!(a_entries[a_at].input, b_entries[b_at].input);
        assert_eq!(event_id(&a_entries[a_at].input), event_id(&b_entries[b_at].input));
        assert_eq!(a_entries[a_at].seq, b_entries[b_at].seq);
        assert_ne!(a_entries[a_at].hash, b_entries[b_at].hash);
        (
            a_at,
            b_at,
            a_entries[a_at].input.clone(),
            b_entries[b_at].clone(),
            a_entries[1].hash,
        )
    };
    assert_eq!(a_at, 2);
    assert_eq!(b_at, 1);
    let _ = a_send;

    let draft_a = world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap();
    let draft_b = world.checkpoint_span(&n(2), world.character_len(&n(2)).unwrap()).unwrap();
    assert_eq!(draft_a.from_index, 0);
    assert_eq!(draft_a.to_index, 3);
    assert_eq!(draft_b.to_index, 2);
    assert_ne!(draft_a.to_index, draft_b.to_index);
    assert_eq!(draft_a.prev_root, genesis_root(&n(1), 3));
    assert_eq!(draft_b.prev_root, genesis_root(&n(2), 1));
    assert_eq!(draft_a.log_hash, world.character_head(&n(1)).unwrap());
    assert_eq!(draft_b.log_hash, world.character_head(&n(2)).unwrap());
    assert_ne!(draft_a.log_hash, draft_b.log_hash);
    assert_ne!(draft_a.new_root, draft_b.new_root);

    // Commit A only through the import. The send stays an uncommitted tail.
    let committed_a = world.commit_span(n(1), 2).unwrap();
    assert_eq!(committed_a.to_index, 2);
    assert_eq!(committed_a.log_hash, a_deposit_hash);
    world.commit_span(n(2), 2).unwrap();

    // B committed its copy of the send, so the send is pinned: dropping A's debit while B keeps the
    // credit would create items from nothing. A's rebase keeps it as an uncommitted tail.
    world.rebase(n(1)).unwrap();
    let b_after = world.character_entries(&n(2)).unwrap();
    assert!(b_after.iter().any(|e| e.input == b_send.input && e.hash == b_send.hash));
    assert!(world.character_entries(&n(1)).unwrap().iter().any(|e| matches!(e.input, Input::SendItem { .. })));
    assert_eq!(world.item_balance(&n(1), &ore), Some(n(6)), "A's debit is pinned by B's committed credit");
    assert_eq!(world.item_balance(&n(2), &ore), Some(n(4)), "B's committed credit stays");
    assert_eq!(world.committed_index(&n(2)), Some(2));
    assert_eq!(world.character_len(&n(1)), Some(3));
}

#[test]
fn item_overspend_does_not_append_and_auction_ops_stay_on_the_world() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(10)).unwrap();
    let len = world.character_len(&n(1)).unwrap();
    let head = world.character_head(&n(1)).unwrap();
    assert_eq!(
        world.append_send_item(n(1), n(2), ore, n(11)).unwrap_err(),
        EngineError::InsufficientItem
    );
    assert_eq!(world.character_len(&n(1)), Some(len));
    assert_eq!(world.character_head(&n(1)), Some(head));
    assert_eq!(world.append_bid(n(1), n(2), n(6)).unwrap_err(), EngineError::KekRetired);

    let mut engine = Engine::open(n(1), 3);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 3 }).unwrap();
    assert_eq!(
        engine.apply(Input::List { listing_id: n(1), seller: n(1), item_id: ore, amount: n(1) }).unwrap_err(),
        EngineError::NotOnCharacterLog
    );
    assert_eq!(
        engine
            .apply(Input::SendItem { from: n(1), to: n(2), item_id: ore, amount: n(1) })
            .unwrap_err(),
        EngineError::InsufficientItem
    );
}

#[test]
fn import_nonce_rejects_replay_and_credits_two_nonces() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    world.append_import_item(n(1), ore, n(4), 1).unwrap();
    assert_eq!(
        world.append_import_item(n(1), ore, n(4), 1).unwrap_err(),
        EngineError::ReplayInbound
    );
    assert_eq!(world.item_balance(&n(1), &ore), Some(n(4)));
    let len = world.character_len(&n(1)).unwrap();
    assert_eq!(
        world.append_import_item(n(1), ore, n(1), 3).unwrap_err(),
        EngineError::OutOfOrderInbound,
        "a gap is not the next inbound"
    );
    assert_eq!(world.character_len(&n(1)), Some(len));
    world.append_import_item(n(1), ore, n(6), 2).unwrap();
    assert_eq!(world.item_balance(&n(1), &ore), Some(n(10)));
    let cp = world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap();
    assert_eq!(cp.inbound_consumed, 2, "checkpoint counts consumed inbounds, not a new set");
    world.append_import_item(n(2), ore, n(1), 1).unwrap();
    let cp2 = world.checkpoint_span(&n(2), world.character_len(&n(2)).unwrap()).unwrap();
    assert_eq!(cp2.inbound_consumed, 1);
    assert_eq!(world.inbound_applied(&n(1)), Some(2));
    assert_eq!(world.inbound_applied(&n(2)), Some(1));

    let mut engine = Engine::open(n(1), 3);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 3 }).unwrap();
    engine
        .apply(Input::ImportItem { token_id: n(1), item_id: ore, amount: n(2), nonce: 1 })
        .unwrap();
    assert_eq!(
        engine
            .apply(Input::ImportItem { token_id: n(1), item_id: ore, amount: n(2), nonce: 1 })
            .unwrap_err(),
        EngineError::ReplayInbound
    );
    engine
        .apply(Input::ImportItem { token_id: n(1), item_id: ore, amount: n(3), nonce: 2 })
        .unwrap();
    assert_eq!(engine.state().get(&Key::Item(ore)), n(5));
}

#[test]
fn rebase_never_creates_items_after_a_one_sided_commit() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut w = spawn_pair();
    import_item(&mut w, n(1), ore, n(10)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.append_send_item(n(1), n(2), ore, n(4)).unwrap();
    w.commit_span(n(2), 2).unwrap();
    w.rebase(n(1)).unwrap();
    assert_eq!(total_ore(&w, ore), n(10));
}

#[test]
fn rebase_cascades_to_uncommitted_dependents_and_does_not_wedge() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut w = spawn_pair();
    import_item(&mut w, n(1), ore, n(1)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.append_list(n(1), n(1), ore, n(1)).unwrap();
    // Nobody committed the list: seller rebases and the escrow returns.
    w.rebase(n(1)).unwrap();
    assert!(w.listing(&n(1)).is_none());
    assert_eq!(w.item_balance(&n(1), &ore), Some(n(1)));
}

#[test]
fn rebase_keeps_a_committed_list() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut w = spawn_pair();
    import_item(&mut w, n(1), ore, n(1)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.append_list(n(1), n(1), ore, n(1)).unwrap();
    w.commit_span(n(1), 3).unwrap();
    w.rebase(n(1)).unwrap();
    assert!(w.listing(&n(1)).is_some(), "a committed list stays");
    assert_eq!(w.item_balance(&n(1), &ore), Some(n(0)));
}

/// Deterministic fuzz: random ops, one-sided commits and rebases never break conservation or wedge.
#[test]
fn random_ops_commits_and_rebases_conserve_items() {
    let ore = lok_engine::fungible_id("iron_ore");
    for seed in 1u64..=40 {
        let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut next = move |m: u64| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x % m
        };
        let mut w = World::new();
        for t in 1..=3u64 {
            w.append_spawn(n(t), 1).unwrap();
        }
        let mut listing = 0u64;
        for _ in 0..60 {
            let a = 1 + next(3);
            let mut b = 1 + next(3);
            if b == a {
                b = 1 + (b % 3);
            }
            let amt = 1 + next(5);
            match next(8) {
                0 | 1 => { let _ = import_item(&mut w, n(a), ore, n(amt)); }
                2 | 3 => { let _ = w.append_send_item(n(a), n(b), ore, n(amt)); }
                4 => { listing += 1; let _ = w.append_list(n(listing), n(a), ore, n(amt)); }
                5 => { let _ = w.append_cancel(n(1 + next(listing.max(1))), n(a)); }
                6 => {
                    let len = w.character_len(&n(a)).unwrap();
                    let c = w.committed_index(&n(a)).unwrap();
                    if len > c { let _ = w.commit_span(n(a), c + 1 + next(len - c)); }
                }
                _ => { w.rebase(n(a)).unwrap_or_else(|e| panic!("seed {seed}: rebase wedged: {e:?}")); }
            }
            assert_eq!(total_ore(&w, ore), expected_ore(&w), "seed {seed}: items not conserved");
        }
    }
}

fn total_ore(w: &World, ore: U256) -> U256 {
    let mut t = U256::ZERO;
    for s in w.snapshots() {
        t = t.checked_add(w.item_balance(&s.token_id, &ore).unwrap()).unwrap();
    }
    for l in w.listings() {
        if l.item_id == ore {
            t = t.checked_add(l.amount).unwrap();
        }
    }
    t
}

fn push_forged(doc: &mut WorldDocument, token: U256, input: Input, seq: u64) {
    let ch = doc.characters.iter_mut().find(|c| c.token_id == token).unwrap();
    let prev = ch
        .entries
        .last()
        .map(|e| e.hash)
        .unwrap_or_else(|| genesis_root(&token, ch.starting_job));
    let index = ch.entries.len() as u64;
    let hash = entry_hash(&prev, index, &input, &[0u8; 32]);
    ch.entries.push(LoggedEntry { hash, input, seq, ruleset_hash: [0u8; 32] });
}

#[test]
fn load_rejects_a_one_sided_send_that_would_mint() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(5)).unwrap();
    world.append_send_item(n(1), n(2), ore, n(2)).unwrap();
    let honest = load_world(&world.to_document()).unwrap();
    assert_eq!(honest.item_balance(&n(2), &ore), Some(n(2)));

    let mut forged = world.to_document();
    let sender = forged.characters.iter_mut().find(|c| c.token_id == n(1)).unwrap();
    assert!(matches!(sender.entries.pop().unwrap().input, Input::SendItem { .. }));
    assert!(matches!(
        load_world(&forged).unwrap_err(),
        ReplayStop::Rejected { reason: EngineError::ConflictingLog, .. }
    ));
}

#[test]
fn load_rejects_an_ask_recorded_only_on_another_chain() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(4)).unwrap();
    let mut doc = world.to_document();
    let seq = doc.characters.iter().flat_map(|c| c.entries.iter().map(|e| e.seq)).max().unwrap() + 1;
    push_forged(
        &mut doc,
        n(2),
        Input::Ask {
            listing_id: n(7),
            seller: n(1),
            item_id: ore,
            amount: n(1),
            min_price: n(10),
            listed_at: 1_700_000_000,
        },
        seq,
    );
    assert!(matches!(
        load_world(&doc).unwrap_err(),
        ReplayStop::Rejected { reason: EngineError::ConflictingLog, .. }
    ));
}

#[test]
fn load_rejects_a_chain_fill_missing_the_seller() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(1)).unwrap();
    world
        .append_ask(n(10), n(1), ore, n(1), n(100), 1_700_000_000)
        .unwrap();
    world
        .append_chain_fill(n(10), n(2), n(100), ore, n(1), n(1), [9u8; 32], 0)
        .unwrap();
    let honest = load_world(&world.to_document()).unwrap();
    assert_eq!(honest.inbox_balance(&n(2), &ore), Some(n(1)));

    let mut forged = world.to_document();
    let seller = forged.characters.iter_mut().find(|c| c.token_id == n(1)).unwrap();
    assert!(matches!(seller.entries.pop().unwrap().input, Input::ChainFill { .. }));
    assert!(matches!(
        load_world(&forged).unwrap_err(),
        ReplayStop::Rejected { reason: EngineError::ConflictingLog, .. }
    ));
}

#[test]
fn load_rejects_spawn_of_another_token_without_panicking() {
    let mut doc = WorldDocument {
        characters: vec![lok_engine::CharacterLogDocument {
            token_id: n(9),
            starting_job: 1,
            entries: vec![],
        }],
    };
    push_forged(
        &mut doc,
        n(9),
        Input::Spawn { token_id: n(1), starting_job: 1 },
        0,
    );
    assert!(matches!(
        load_world(&doc).unwrap_err(),
        ReplayStop::Rejected { reason: EngineError::ConflictingLog, .. }
    ));
}

#[test]
fn load_rejects_seq_overflow_without_panicking() {
    let mut world = World::new();
    world.append_spawn(n(1), 1).unwrap();
    world.append_gold_earn(n(1), "quest".into(), n(10), 1).unwrap();
    let mut doc = world.to_document();
    let entry = doc.characters[0].entries.last_mut().unwrap();
    assert!(matches!(entry.input, Input::GoldEarn { .. }));
    entry.seq = u64::MAX;
    assert!(matches!(
        load_world(&doc).unwrap_err(),
        ReplayStop::Rejected {
            index,
            reason: EngineError::Overflow,
        } if index == u64::MAX
    ));
}

#[test]
fn honest_log_reloads_including_a_craft_refund() {
    let mut world = World::new();
    world.append_spawn(n(1), 1).unwrap();
    world.append_gold_earn(n(1), "quest".into(), n(1_000), 1).unwrap();
    world.append_gold_spend(n(1), "craft".into(), n(400)).unwrap();
    world
        .append_gold_earn(n(1), "craft_refund".into(), n(400), 1)
        .unwrap();
    let loaded = load_world(&world.to_document()).unwrap();
    assert_eq!(loaded.gold_balance(&n(1)), Some(n(1_000)));
    assert_eq!(
        world.append_gold_earn(n(1), "craft_refund".into(), n(1), 1).unwrap_err(),
        EngineError::EarnCap
    );
}

#[test]
fn legacy_cancel_does_not_return_a_book_ask() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(1)).unwrap();
    world.append_ask(n(10), n(1), ore, n(1), n(50), 1_700_000_000).unwrap();
    assert_eq!(
        world.append_cancel(n(10), n(1)).unwrap_err(),
        EngineError::UnknownListing
    );
    assert!(world.listing(&n(10)).is_some());
    assert_eq!(world.item_balance(&n(1), &ore), Some(n(0)));
    assert_eq!(world.inbox_balance(&n(1), &ore), Some(n(0)));
    world.append_cancel_ask(n(10), n(1)).unwrap();
    assert!(world.listing(&n(10)).is_none());
    assert_eq!(world.inbox_balance(&n(1), &ore), Some(n(1)));
}

#[test]
fn a_failed_earn_rolls_back_only_the_touched_character() {
    let mut world = spawn_pair();
    world.append_gold_earn(n(2), "quest".into(), n(500), 3).unwrap();
    let other_gold = world.gold_balance(&n(2));
    let other_len = world.character_entries(&n(2)).unwrap().len();
    let other_head = world.character_head(&n(2));
    world.append_gold_earn(n(1), "quest".into(), n(20_000), 4).unwrap();
    let capped_len = world.character_entries(&n(1)).unwrap().len();
    let capped_head = world.character_head(&n(1));
    let err = world.append_gold_earn(n(1), "quest".into(), n(1), 4).unwrap_err();
    assert_eq!(err, EngineError::EarnCap);
    assert_eq!(world.gold_balance(&n(1)), Some(n(20_000)));
    assert_eq!(world.character_entries(&n(1)).unwrap().len(), capped_len);
    assert_eq!(world.character_head(&n(1)), capped_head);
    assert_eq!(world.gold_balance(&n(2)), other_gold);
    assert_eq!(world.character_entries(&n(2)).unwrap().len(), other_len);
    assert_eq!(world.character_head(&n(2)), other_head);
}

#[test]
fn a_mid_log_checkpoint_reads_the_stored_projection() {
    let mut world = spawn_pair();
    world.append_gold_earn(n(1), "quest".into(), n(100), 4).unwrap();
    let mid = world.checkpoint_covering(&n(1), 1, 2).unwrap();

    let mut prefix = World::new();
    prefix.append_spawn(n(1), 3).unwrap();
    let spawned = prefix.character_state(&n(1)).unwrap();
    assert_eq!(mid.prev_root, spawned.root());
    prefix.append_gold_earn(n(1), "quest".into(), n(100), 4).unwrap();
    let earned = prefix.character_state(&n(1)).unwrap();
    assert_eq!(mid.new_root, earned.root());
    assert_eq!(mid.summary, earned.summary());

    world.append_gold_earn(n(2), "quest".into(), n(500), 5).unwrap();
    world.append_gold_earn(n(1), "quest".into(), n(50), 6).unwrap();
    let again = world.checkpoint_covering(&n(1), 1, 2).unwrap();
    assert_eq!(again.prev_root, mid.prev_root);
    assert_eq!(again.new_root, mid.new_root);
    assert_eq!(again.summary, mid.summary);

    let tail = world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap();
    let live = world.character_state(&n(1)).unwrap();
    assert_eq!(tail.new_root, live.root());
    assert_eq!(tail.summary, live.summary());
    assert_ne!(tail.new_root, mid.new_root);

    let ore = lok_engine::fungible_id("iron_ore");
    import_item(&mut world, n(1), ore, n(10)).unwrap();
    let before_send = world.character_len(&n(1)).unwrap();
    world.append_send_item(n(1), n(2), ore, n(4)).unwrap();
    let send = world.checkpoint_covering(&n(1), before_send, before_send + 1).unwrap();
    world.append_gold_earn(n(1), "quest".into(), n(1), 7).unwrap();
    let send_again = world.checkpoint_covering(&n(1), before_send, before_send + 1).unwrap();
    assert_eq!(send_again.prev_root, send.prev_root);
    assert_eq!(send_again.new_root, send.new_root);

    let loaded = load_world(&world.to_document()).unwrap();
    let loaded_mid = loaded.checkpoint_covering(&n(1), 1, 2).unwrap();
    assert_eq!(loaded_mid.prev_root, mid.prev_root);
    assert_eq!(loaded_mid.new_root, mid.new_root);
    assert_eq!(loaded_mid.summary, mid.summary);
    let loaded_send = loaded.checkpoint_covering(&n(1), before_send, before_send + 1).unwrap();
    assert_eq!(loaded_send.new_root, send.new_root);
    let loaded_live = loaded.character_state(&n(1)).unwrap();
    let loaded_tail = loaded.checkpoint_span(&n(1), loaded.character_len(&n(1)).unwrap()).unwrap();
    assert_eq!(loaded_tail.new_root, loaded_live.root());
}

#[test]
fn a_rebase_keeps_the_ruleset_hash_stamped_on_checkpoints() {
    let mut world = World::new();
    world.append_spawn(n(1), 3).unwrap();
    assert_eq!(world.checkpoint_span(&n(1), 1).unwrap().ruleset_hash, [0u8; 32]);
    let hash = [0x11u8; 32];
    world.set_ruleset_hash(hash);
    world.rebase(n(1)).unwrap();
    let draft = world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap();
    assert_eq!(draft.ruleset_hash, hash);
    assert_eq!(world.ruleset_hash(), hash);
}

/// The three-field preimage from before a ruleset word could be appended.
fn legacy_entry_hash(prev: &[u8; 32], index: u64, input: &Input) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(96);
    bytes.extend_from_slice(prev);
    let mut word = [0u8; 32];
    word[24..].copy_from_slice(&index.to_be_bytes());
    bytes.extend_from_slice(&word);
    bytes.extend_from_slice(&event_id(input));
    keccak256(&bytes)
}

#[test]
fn a_zero_ruleset_keeps_the_old_entry_hash_and_a_set_ruleset_is_inside_it() {
    let mut gate = Gate::open("").unwrap();
    let spawned: serde_json::Value =
        serde_json::from_str(&gate.apply_command(r#"{"op":"spawn","tokenId":"1","startingJob":3}"#)).unwrap();
    assert_eq!(spawned["ok"], true);

    let zero_doc = gate.document_json();
    let zero_raw: serde_json::Value = serde_json::from_str(&zero_doc).unwrap();
    assert!(zero_raw["characters"][0]["entries"][0].get("rulesetHash").is_none());
    let zero_parsed = parse_world_log(&zero_doc).unwrap();
    let spawn = &zero_parsed.characters[0].entries[0];
    let prev = genesis_root(&n(1), 3);
    let old = legacy_entry_hash(&prev, 0, &spawn.input);
    assert_eq!(spawn.hash, old);
    assert_eq!(spawn.ruleset_hash, [0u8; 32]);
    assert_eq!(entry_hash(&prev, 0, &spawn.input, &[0u8; 32]), old);
    assert_ne!(entry_hash(&prev, 0, &spawn.input, &[0xabu8; 32]), spawn.hash);

    let ruleset = [0xabu8; 32];
    let ruleset_hex = format!("0x{}", hex::encode(ruleset));
    let set: serde_json::Value = serde_json::from_str(
        &gate.apply_command(&format!(r#"{{"op":"setRuleset","rulesetHash":"{ruleset_hex}"}}"#)),
    )
    .unwrap();
    assert_eq!(set["ok"], true);
    let earned: serde_json::Value = serde_json::from_str(&gate.apply_command(
        r#"{"op":"goldEarn","tokenId":"1","source":"quest","amount":"1","day":"1"}"#,
    ))
    .unwrap();
    assert_eq!(earned["ok"], true, "{earned}");

    let later = [0x55u8; 32];
    let later_hex = format!("0x{}", hex::encode(later));
    let moved: serde_json::Value = serde_json::from_str(
        &gate.apply_command(&format!(r#"{{"op":"setRuleset","rulesetHash":"{later_hex}"}}"#)),
    )
    .unwrap();
    assert_eq!(moved["ok"], true);

    let doc = gate.document_json();
    let raw: serde_json::Value = serde_json::from_str(&doc).unwrap();
    let rows = raw["characters"][0]["entries"].as_array().unwrap();
    assert!(rows[0].get("rulesetHash").is_none());
    assert_eq!(rows[1]["rulesetHash"], ruleset_hex);

    let parsed = parse_world_log(&doc).unwrap();
    let logged = &parsed.characters[0].entries;
    assert_eq!(logged[0].hash, old);
    assert_eq!(logged[0].hash, entry_hash(&prev, 0, &logged[0].input, &[0u8; 32]));
    assert_eq!(logged[0].ruleset_hash, [0u8; 32]);
    assert_eq!(logged[1].ruleset_hash, ruleset);
    let link0 = logged[0].hash;
    assert_ne!(logged[1].hash, legacy_entry_hash(&link0, 1, &logged[1].input));
    assert_ne!(logged[1].hash, entry_hash(&link0, 1, &logged[1].input, &[0u8; 32]));
    assert_ne!(logged[1].hash, entry_hash(&link0, 1, &logged[1].input, &later));
    assert_eq!(logged[1].hash, entry_hash(&link0, 1, &logged[1].input, &ruleset));

    let loaded = load_world(&parsed).unwrap();
    let kept = loaded.character_entries(&n(1)).unwrap();
    assert_eq!(kept[0].hash, link0);
    assert_eq!(kept[1].hash, logged[1].hash);
    assert_eq!(kept[1].ruleset_hash, ruleset);
    assert_eq!(loaded.ruleset_hash(), [0u8; 32]);

    let mut stripped = raw.clone();
    stripped["characters"][0]["entries"][1].as_object_mut().unwrap().remove("rulesetHash");
    assert!(matches!(
        load_world(&parse_world_log(&stripped.to_string()).unwrap()).unwrap_err(),
        ReplayStop::BadHash { index: 1, .. }
    ));

    let mut replaced = raw;
    replaced["characters"][0]["entries"][1]["rulesetHash"] = serde_json::Value::String(later_hex);
    assert!(matches!(
        load_world(&parse_world_log(&replaced.to_string()).unwrap()).unwrap_err(),
        ReplayStop::BadHash { index: 1, .. }
    ));
}

fn expected_ore(w: &World) -> U256 {
    let mut seen = std::collections::BTreeSet::new();
    let mut inn = U256::ZERO;
    let mut out = U256::ZERO;
    for s in w.snapshots() {
        for e in w.character_entries(&s.token_id).unwrap() {
            if !seen.insert(e.seq) {
                continue;
            }
            match &e.input {
                Input::ImportItem { amount, .. } | Input::BagImport { amount, .. } => {
                    inn = inn.checked_add(*amount).unwrap()
                }
                Input::ExportItem { amount, .. } | Input::BagExport { amount, .. } => {
                    out = out.checked_add(*amount).unwrap()
                }
                _ => {}
            }
        }
    }
    inn.checked_sub(out).unwrap()
}
