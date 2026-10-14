//! PvP bounty ledger mirrors — open / cancel / kill. No ETH on the log.

use lok_engine::{EngineError, Input, World, U256};

fn n(v: u64) -> U256 {
    U256::from_u64(v)
}

fn spawn(world: &mut World, token: u64, job: u8) {
    world
        .apply(Input::Spawn {
            token_id: n(token),
            starting_job: job,
        })
        .unwrap();
}

const ONE_XDAI: u64 = 1_000_000_000_000_000_000;
const TX: [u8; 32] = [0x11; 32];

#[test]
fn open_cancel_kill_lifecycle() {
    let mut world = World::new();
    spawn(&mut world, 1, 0);
    spawn(&mut world, 2, 1);

    world
        .append_pvp_bounty_open(n(1), n(ONE_XDAI), "ash_pit".into(), TX, 0)
        .unwrap();
    assert_eq!(
        world.pvp_bounty(&n(1)).unwrap().area_id,
        "ash_pit"
    );

    // Second open rejected.
    assert_eq!(
        world
            .append_pvp_bounty_open(n(1), n(ONE_XDAI), "ash_pit".into(), TX, 1)
            .unwrap_err(),
        EngineError::AlreadyBounty
    );

    // Wrong amount rejected.
    assert_eq!(
        world
            .append_pvp_bounty_open(n(2), n(1), "ash_pit".into(), TX, 2)
            .unwrap_err(),
        EngineError::BadBountyAmount
    );

    world
        .append_pvp_bounty_open(n(2), n(ONE_XDAI), "ash_pit".into(), TX, 3)
        .unwrap();

    // Cancel victim leaves the pit.
    world
        .append_pvp_bounty_cancel(n(2), "ash_pit".into(), TX, 4)
        .unwrap();
    assert!(world.pvp_bounty(&n(2)).is_none());

    // Re-open for kill path.
    world
        .append_pvp_bounty_open(n(2), n(ONE_XDAI), "ash_pit".into(), TX, 5)
        .unwrap();

    world
        .append_pvp_kill(n(2), n(1), "ash_pit".into(), n(ONE_XDAI), TX, 6)
        .unwrap();
    assert!(world.pvp_bounty(&n(2)).is_none());
    // Slayer's bounty stays open.
    assert!(world.pvp_bounty(&n(1)).is_some());

    // No double claim.
    assert_eq!(
        world
            .append_pvp_kill(n(2), n(1), "ash_pit".into(), n(ONE_XDAI), TX, 7)
            .unwrap_err(),
        EngineError::NoBounty
    );
}

#[test]
fn kill_rejects_self_and_area_mismatch() {
    let mut world = World::new();
    spawn(&mut world, 1, 0);
    spawn(&mut world, 2, 1);
    world
        .append_pvp_bounty_open(n(1), n(ONE_XDAI), "ash_pit".into(), TX, 0)
        .unwrap();

    assert_eq!(
        world
            .append_pvp_kill(n(1), n(1), "ash_pit".into(), n(ONE_XDAI), TX, 1)
            .unwrap_err(),
        EngineError::SelfTransfer
    );

    assert_eq!(
        world
            .append_pvp_kill(n(1), n(2), "other_pit".into(), n(ONE_XDAI), TX, 2)
            .unwrap_err(),
        EngineError::BountyMismatch
    );
}
