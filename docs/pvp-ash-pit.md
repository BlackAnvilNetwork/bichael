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

`contracts/lok-log/src/PvpBounty.sol` — place / cancel / operator `claim`.
Live fill path mirrors AhEscrow → log (server watches receipts). Local/anvil
currently appends synthetic `txHash`/`logIndex` receipts so the ledger path is
exercisable before the operator watcher ships.

## Server WS

- **`pvp/join`** — teleport into Ash Pit + place bounty (easy join / rejoin)
- **`pvp/leave`** — cancel bounty and warp to hub
- `pvp/bountyPlace` / `pvp/bountyCancel` — place/cancel without teleport
- `engage` a marked player (gold ring) inside the arena
- On slay: `pvpKill` clears victim bounty, kick to hub, client gets `pvp/slain` + **Join again**
- Leaving the arena with an open bounty auto-cancels (refund mirror)

## Deploy

- `Deploy.s.sol` deploys `PvpBounty` (OPERATOR = LISTING key)
- Env: `LOK_PVP_BOUNTY` (filled from deploy JSON)
- Anvil/local: synthetic receipts (`pvpSyntheticReceiptsAllowed`) — no real ETH
- Gnosis: require live escrow + watcher before open/kill (synthetic refused)

## Client

- Commands → **Ash Pit** panel (Join / Leave)
- Slain banner with one-click rejoin
- Marked players show a gold ring; click to engage
