//! Per-character checkpoints, WithdrawKek, and solvency snapshots.

use lok_engine::{event_id, genesis_root, Engine, EngineError, Input, Key, U256, World};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn next_inbound(world: &World, token: U256) -> u64 {
    world.inbound_applied(&token).unwrap_or(0).saturating_add(1)
}

fn deposit(world: &mut World, token: U256, amount: U256) -> Result<lok_engine::AppliedEvent, EngineError> {
    let nonce = next_inbound(world, token);
    world.append_deposit_kek(token, amount, nonce)
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
    deposit(&mut world, n(1), n(10)).unwrap();
    world.append_send_kek(n(1), n(2), n(4)).unwrap();

    let (a_at, b_at, a_send, b_send, a_deposit_hash) = {
        let a_entries = world.character_entries(&n(1)).unwrap();
        let b_entries = world.character_entries(&n(2)).unwrap();
        let a_at = a_entries.iter().position(|e| matches!(e.input, Input::SendKek { .. })).unwrap();
        let b_at = b_entries.iter().position(|e| matches!(e.input, Input::SendKek { .. })).unwrap();
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
    assert_eq!(draft_a.kek_out, U256::ZERO);

    // Commit A only through the deposit. The send stays an uncommitted tail.
    let committed_a = world.commit_span(n(1), 2).unwrap();
    assert_eq!(committed_a.to_index, 2);
    assert_eq!(committed_a.log_hash, a_deposit_hash);
    world.commit_span(n(2), 2).unwrap();

    // B committed its copy of the send, so the send is pinned: dropping A's debit while B keeps the
    // credit would create 4 KEK from nothing. A's rebase keeps it as an uncommitted tail.
    world.rebase(n(1)).unwrap();
    let b_after = world.character_entries(&n(2)).unwrap();
    assert!(b_after.iter().any(|e| e.input == b_send.input && e.hash == b_send.hash));
    assert!(world.character_entries(&n(1)).unwrap().iter().any(|e| matches!(e.input, Input::SendKek { .. })));
    assert_eq!(world.kek_balance(&n(1)), Some(n(6)), "A's debit is pinned by B's committed credit");
    assert_eq!(world.kek_balance(&n(2)), Some(n(4)), "B's committed credit stays");
    assert_eq!(world.committed_index(&n(2)), Some(2));
    assert_eq!(world.character_len(&n(1)), Some(3));
}

#[test]
fn withdraw_kek_reduces_balance_and_rejects_overspend() {
    let mut world = spawn_pair();
    deposit(&mut world, n(1), n(10)).unwrap();
    let drafted = {
        world.append_withdraw_kek(n(1), n(4)).unwrap();
        world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap()
    };
    assert_eq!(drafted.kek_out, n(4));
    assert_eq!(world.kek_balance(&n(1)), Some(n(6)));
    assert_eq!(world.solvency_kek(&n(1)), Some(n(6)));
    let len = world.character_len(&n(1)).unwrap();
    let head = world.character_head(&n(1)).unwrap();
    assert_eq!(world.append_withdraw_kek(n(1), n(7)).unwrap_err(), EngineError::InsufficientKek);
    assert_eq!(world.character_len(&n(1)), Some(len));
    assert_eq!(world.character_head(&n(1)), Some(head));
    assert_eq!(world.kek_balance(&n(1)), Some(n(6)));

    let mut engine = Engine::open(n(1), 3);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 3 }).unwrap();
    engine.apply(Input::DepositKek { token_id: n(1), amount: n(5), nonce: 1 }).unwrap();
    engine.apply(Input::WithdrawKek { token_id: n(1), amount: n(2) }).unwrap();
    assert_eq!(engine.state().get(&Key::Kek), n(3));
    assert_eq!(
        engine.apply(Input::WithdrawKek { token_id: n(1), amount: n(4) }).unwrap_err(),
        EngineError::InsufficientKek
    );
    let mut outsider = Engine::open(n(9), 0);
    outsider.apply(Input::Spawn { token_id: n(9), starting_job: 0 }).unwrap();
    assert_eq!(
        outsider.apply(Input::SendKek { from: n(1), to: n(2), amount: n(1) }).unwrap_err(),
        EngineError::NotOnCharacterLog
    );
    assert_eq!(
        engine.apply(Input::List { listing_id: n(1), seller: n(1), item_id: n(1), amount: n(1) }).unwrap_err(),
        EngineError::NotOnCharacterLog
    );
    engine.apply(Input::SendKek { from: n(1), to: n(2), amount: n(1) }).unwrap();
    assert_eq!(engine.state().get(&Key::Kek), n(2));
}

#[test]
fn spend_kek_debits_spendable_only_and_is_not_kek_out() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(1)).unwrap();
    deposit(&mut world, n(2), n(10)).unwrap();
    world.append_list(n(1), n(1), ore, n(1)).unwrap();
    world.append_bid(n(1), n(2), n(6)).unwrap();
    assert_eq!(world.kek_balance(&n(2)), Some(n(4)));
    assert_eq!(world.append_spend_kek(n(2), n(5)).unwrap_err(), EngineError::InsufficientKek);
    assert_eq!(world.kek_balance(&n(2)), Some(n(4)), "a short spend does not append");
    assert_eq!(world.solvency_kek(&n(2)), Some(n(10)), "escrowed bid stays locked");
    world.append_spend_kek(n(2), n(4)).unwrap();
    assert_eq!(world.kek_balance(&n(2)), Some(n(0)));
    assert_eq!(world.solvency_kek(&n(2)), Some(n(6)));
    let drafted = world.checkpoint_span(&n(2), world.character_len(&n(2)).unwrap()).unwrap();
    assert_eq!(drafted.kek_out, U256::ZERO, "spend is not a withdrawal");
    assert_eq!(total_solvency(&world), expected_total(&world));

    let mut engine = Engine::open(n(1), 3);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 3 }).unwrap();
    engine.apply(Input::DepositKek { token_id: n(1), amount: n(5), nonce: 1 }).unwrap();
    engine.apply(Input::SpendKek { token_id: n(1), amount: n(2) }).unwrap();
    assert_eq!(engine.state().get(&Key::Kek), n(3));
    assert_eq!(
        engine.apply(Input::SpendKek { token_id: n(1), amount: n(4) }).unwrap_err(),
        EngineError::InsufficientKek
    );
    assert_eq!(engine.state().get(&Key::Kek), n(3));
}

#[test]
fn escrowed_bid_counts_in_the_solvency_snapshot() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut world = spawn_pair();
    import_item(&mut world, n(1), ore, n(1)).unwrap();
    deposit(&mut world, n(2), n(10)).unwrap();
    world.append_list(n(1), n(1), ore, n(1)).unwrap();
    world.append_bid(n(1), n(2), n(6)).unwrap();
    assert_eq!(world.kek_balance(&n(2)), Some(n(4)));
    assert_eq!(world.solvency_kek(&n(2)), Some(n(10)));
    let snap = world.snapshots().into_iter().find(|s| s.token_id == n(2)).unwrap();
    assert_eq!(snap.kek, n(4));
    assert_eq!(snap.solvency_kek, n(10));

    assert_eq!(world.append_withdraw_kek(n(2), n(5)).unwrap_err(), EngineError::InsufficientKek);
    world.append_withdraw_kek(n(2), n(4)).unwrap();
    assert_eq!(world.kek_balance(&n(2)), Some(n(0)));
    assert_eq!(world.solvency_kek(&n(2)), Some(n(6)), "escrowed bid is still owed by the vault");
    let snap = world.snapshots().into_iter().find(|s| s.token_id == n(2)).unwrap();
    assert_eq!(snap.solvency_kek, n(6));
}


#[test]
fn deposit_nonce_rejects_replay_and_credits_two_nonces() {
    let mut world = spawn_pair();
    world.append_deposit_kek(n(1), n(4), 1).unwrap();
    assert_eq!(
        world.append_deposit_kek(n(1), n(4), 1).unwrap_err(),
        EngineError::ReplayInbound
    );
    assert_eq!(world.kek_balance(&n(1)), Some(n(4)));
    let len = world.character_len(&n(1)).unwrap();
    assert_eq!(
        world.append_deposit_kek(n(1), n(1), 3).unwrap_err(),
        EngineError::ReplayInbound,
        "a gap is not the next inbound"
    );
    assert_eq!(world.character_len(&n(1)), Some(len));
    world.append_deposit_kek(n(1), n(6), 2).unwrap();
    assert_eq!(world.kek_balance(&n(1)), Some(n(10)));
    world.append_import_item(n(1), lok_engine::fungible_id("iron_ore"), n(2), 3).unwrap();
    let cp = world.checkpoint_span(&n(1), world.character_len(&n(1)).unwrap()).unwrap();
    assert_eq!(cp.inbound_consumed, 3, "checkpoint counts consumed inbounds, not a new set");
    world.append_deposit_kek(n(2), n(1), 1).unwrap();
    let cp2 = world.checkpoint_span(&n(2), world.character_len(&n(2)).unwrap()).unwrap();
    assert_eq!(cp2.inbound_consumed, 1);
    assert_eq!(world.inbound_applied(&n(1)), Some(3));
    assert_eq!(world.inbound_applied(&n(2)), Some(1));

    let mut engine = Engine::open(n(1), 3);
    engine.apply(Input::Spawn { token_id: n(1), starting_job: 3 }).unwrap();
    engine.apply(Input::DepositKek { token_id: n(1), amount: n(2), nonce: 1 }).unwrap();
    assert_eq!(
        engine.apply(Input::DepositKek { token_id: n(1), amount: n(2), nonce: 1 }).unwrap_err(),
        EngineError::ReplayInbound
    );
    engine.apply(Input::DepositKek { token_id: n(1), amount: n(3), nonce: 2 }).unwrap();
    assert_eq!(engine.state().get(&Key::Kek), n(5));
}

fn total_solvency(w: &World) -> U256 {
    let mut t = U256::ZERO;
    for s in w.snapshots() {
        t = t.checked_add(s.solvency_kek).unwrap();
    }
    t
}

/// Net KEK that the surviving logs say entered the system: deposits minus withdrawals, counted once per seq.
fn expected_total(w: &World) -> U256 {
    let mut seen = std::collections::BTreeSet::new();
    let mut dep = U256::ZERO;
    let mut wd = U256::ZERO;
    for s in w.snapshots() {
        for e in w.character_entries(&s.token_id).unwrap() {
            if !seen.insert(e.seq) {
                continue;
            }
            match &e.input {
                Input::DepositKek { amount, .. } => dep = dep.checked_add(*amount).unwrap(),
                // SpendKek is a sink of spendable KEK, same as a withdrawal for what remains
                // on the logs. It is not kekOut.
                Input::WithdrawKek { amount, .. }
                | Input::SpendKek { amount, .. }
                | Input::PaidRespecSkills { amount, .. } => {
                    wd = wd.checked_add(*amount).unwrap()
                }
                _ => {}
            }
        }
    }
    dep.checked_sub(wd).unwrap()
}

#[test]
fn rebase_never_creates_kek_after_a_one_sided_commit() {
    let mut w = spawn_pair();
    deposit(&mut w, n(1), n(10)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.append_send_kek(n(1), n(2), n(4)).unwrap();
    w.commit_span(n(2), 2).unwrap();
    w.rebase(n(1)).unwrap();
    assert_eq!(total_solvency(&w), n(10));
}

#[test]
fn rebase_cascades_to_uncommitted_dependents_and_does_not_wedge() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut w = spawn_pair();
    import_item(&mut w, n(1), ore, n(1)).unwrap();
    deposit(&mut w, n(2), n(10)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.commit_span(n(2), 2).unwrap();
    w.append_list(n(1), n(1), ore, n(1)).unwrap();
    w.append_bid(n(1), n(2), n(6)).unwrap();
    // Nobody committed the list or the bid: seller rebases, the dependent bid goes too.
    w.rebase(n(1)).unwrap();
    assert!(w.listing(&n(1)).is_none());
    assert_eq!(w.kek_balance(&n(2)), Some(n(10)));
    assert_eq!(w.item_balance(&n(1), &ore), Some(n(1)));
}

#[test]
fn rebase_keeps_the_list_when_a_bid_on_it_is_committed() {
    let ore = lok_engine::fungible_id("iron_ore");
    let mut w = spawn_pair();
    import_item(&mut w, n(1), ore, n(1)).unwrap();
    deposit(&mut w, n(2), n(10)).unwrap();
    w.commit_span(n(1), 2).unwrap();
    w.commit_span(n(2), 2).unwrap();
    w.append_list(n(1), n(1), ore, n(1)).unwrap();
    w.append_bid(n(1), n(2), n(6)).unwrap();
    w.commit_span(n(2), 3).unwrap();
    w.rebase(n(1)).unwrap();
    assert!(w.listing(&n(1)).is_some(), "the committed bid pins the listing");
    assert_eq!(w.kek_balance(&n(2)), Some(n(4)));
    assert_eq!(total_solvency(&w), n(10));
}

/// Deterministic fuzz: random ops, one-sided commits and rebases never break conservation or wedge.
#[test]
fn random_ops_commits_and_rebases_conserve_kek_and_items() {
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
            match next(12) {
                0 => { let _ = deposit(&mut w, n(a), n(amt)); }
                1 => { let _ = w.append_withdraw_kek(n(a), n(amt)); }
                2 => { let _ = import_item(&mut w, n(a), ore, n(amt)); }
                3 => { let _ = w.append_send_kek(n(a), n(b), n(amt)); }
                4 => { let _ = w.append_send_item(n(a), n(b), ore, n(amt)); }
                5 => { listing += 1; let _ = w.append_list(n(listing), n(a), ore, n(amt)); }
                6 | 7 => { let _ = w.append_bid(n(1 + next(listing.max(1))), n(a), n(amt + next(20))); }
                8 => { let _ = w.append_cancel(n(1 + next(listing.max(1))), n(a)); }
                9 => { let _ = w.append_settle(n(1 + next(listing.max(1)))); }
                10 => {
                    let len = w.character_len(&n(a)).unwrap();
                    let c = w.committed_index(&n(a)).unwrap();
                    if len > c { let _ = w.commit_span(n(a), c + 1 + next(len - c)); }
                }
                _ => { w.rebase(n(a)).unwrap_or_else(|e| panic!("seed {seed}: rebase wedged: {e:?}")); }
            }
            assert_eq!(total_solvency(&w), expected_total(&w), "seed {seed}: KEK not conserved");
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
                Input::ImportItem { amount, .. } => inn = inn.checked_add(*amount).unwrap(),
                Input::ExportItem { amount, .. } => out = out.checked_add(*amount).unwrap(),
                _ => {}
            }
        }
    }
    inn.checked_sub(out).unwrap()
}
