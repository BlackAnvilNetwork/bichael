# Black Anvil PvP — Ash Pit

## Product

Players place a fixed **1 xDAI** (1×10¹⁸ wei) bounty on their own head inside a
PvP arena. If they are slain there, the bounty pays the slayer on-chain. The
character log never holds settlement ETH — it only mirrors custody events.

## Ash Pit (first arena)

| Field | Value |
| --- | --- |
| Id | `ash_pit` |
| Zone | Pale Hollow (southwest pocket) |
| Level cap | **30** main / **15** support (`floor(30/2)`) |
| Abilities | Unlock levels above those caps are sealed while inside |
| Bounds | `minX:-72 maxX:-42 minZ:-18 maxZ:8` |

Config: `packages/config/src/pvp-areas.ts`.

## Ledger events (lok engine)

| Op | Meaning |
| --- | --- |
| `pvpBountyOpen` | On-chain escrow opened; book marks token as bounty-open |
| `pvpBountyCancel` | Refund / leave without dying; clears open bounty |
| `pvpKill` | Slay claim; clears **victim** bounty only |

Fixed `amountWei` = `1000000000000000000`. Linked onto victim (and slayer for
`pvpKill`) character chains. Same ruleset pin bump as any new event.

## On-chain

`contracts/lok-log/src/PvpBounty.sol` — player `place` (**1 xDAI** / 1e18 wei),
operator/owner `cancel`, operator `claim`. Settlement value never hits the
character log — the server verifies the place receipt (or recovers
`BountyOpened`), then appends `pvpBountyOpen` / `pvpBountyCancel` / `pvpKill`
mirrors.

## Server WS

- **`pvp/join`** (+ optional `placeTxHash`) — teleport into Ash Pit after escrow
- **`pvp/placeNeeded`** — live path: client must `PvpBounty.place` then rejoin
- **`pvp/leave`** — operator cancel + warp to hub
- `pvp/bountyPlace` / `pvp/bountyCancel` — aliases for join / leave
- `engage` a marked player (gold ring) inside the arena
- On slay: on-chain `claim` → `pvpKill` → kick + `pvp/slain` + **Join again**
- Leaving the arena with an open bounty auto-cancels (on-chain refund)

## Deploy (Gnosis — live)

- Bounty unit: **1 xDAI** (`BOUNTY_WEI = 1e18`)
- Additive script: `DeployPvpBountyGnosis.s.sol` (+ `broadcast-deploy-pvp-bounty-gnosis.sh`)
- Against official NFT `0x48aFeC…289F`; ADMIN `0x08cD…4e01`; OPERATOR = LISTING `0xbFa2…9E76`
- Record address in `deployments/gnosis.json` → `contracts.PvpBounty`
- Env: `NETWORK=gnosis` fills `LOK_PVP_BOUNTY` from that file; server needs `LOK_LISTING_KEY`
- Synthetic refused on Gnosis unless `LOK_PVP_SYNTHETIC=1` (never for production)
- Local anvil only: `DeployPvpBountyAnvil` + `deployments/anvil.json` (dev)

## Client

- Commands → **Ash Pit** panel — Join pays **1 xDAI** then warps
- Slain banner with one-click rejoin (fresh place)
- Marked players show a gold ring; click to engage
