# Black Anvil

Browser game: wallet connect, a campaign world, and job combat. The Citadel hall fight (Time Mage vs Petrified Guard, keys **1–4** on the hotbar) still runs.

Formerly developed as Bellgrave / Legend of KEK. On-chain identifiers, engine ops, log schemas, and npm package names (`@bellgrave/*`) are unchanged so log replay and deployed contracts keep working.

## Stack

- `apps/web` — React + Vite + R3F
- `apps/server` — Node WebSocket game loop @ 20 Hz
- `packages/combat` — job formulas and ability kits
- `packages/protocol` — Zod client messages
- `packages/config` — shared constants
- `packages/items` — item catalog
- `contracts/lok-log` — character log contracts and the Rust engine (not in the pnpm workspace)

System index: [`docs/systems.md`](docs/systems.md).

## Run

```bash
pnpm install
pnpm dev
```

- Web: http://localhost:5173
- Server: `ws://localhost:8787`

## Play loop

1. **Connect Wallet** — injected extension or Reown AppKit
2. **Create character** — pick appearance + job; claim starter kit
3. Campaign world (see [`docs/world.md`](docs/world.md)):
   - **Pale Hollow** ↔ The Shard Dwellings → **Ashlands** ↔ Obsidia → **Slagpits** ↔ The Great Filter → **Bellmarsh** ↔ Belltower Keep → **Throne Approach** ↔ Citadel of KEK
   - Areas: mobs + harvest nodes · Cities: NPCs + quests · Craft while progressing
4. Clear the campaign, then replay with enemies scaled to your level
5. The Citadel hall fight vs Petrified Guard still runs (hotbar keys **1–4**)

Using a potion removes it from the bag. That is not an on-chain burn. Settlement targets Gnosis (see [`docs/gnosis-launch.md`](docs/gnosis-launch.md)).

The bag is a character save. Gold and log item balances live in the Rust engine under `contracts/lok-log/engine`, loaded by the server as wasm. `bagImport` / `bagExport` move stacks between the bag and the log and are not checkpoint mints. `exportItem` is the chain withdrawal. KEK custody is retired. The live contracts are in `contracts/lok-log/` (not the pnpm workspace). Entry files and the ruleset pin: [`docs/systems.md`](docs/systems.md). This README does not deploy.

## Where to read next

| Topic | Doc |
| --- | --- |
| System map | [`docs/systems.md`](docs/systems.md) |
| Campaign | [`docs/world.md`](docs/world.md) |
| Character contracts | [`contracts/lok-log/README.md`](contracts/lok-log/README.md), [`contracts/lok-log/CONTRACTS.md`](contracts/lok-log/CONTRACTS.md) |
| Engine | [`contracts/lok-log/engine/README.md`](contracts/lok-log/engine/README.md) |
| Items | [`packages/items/README.md`](packages/items/README.md) |
| Gnosis / mainnet | [`docs/gnosis-launch.md`](docs/gnosis-launch.md), [`docs/mainnet-plan.md`](docs/mainnet-plan.md) |

`contracts/README.md` is an old stub. The live package is `contracts/lok-log/`.

## UI pack

Black Anvil HUD chrome lives in `apps/web/public/ui/black-anvil/` (source sheet + sliced PNG/WebP). Re-slice with `python3 apps/web/scripts/slice-black-anvil-ui.py`.

## Trademarks

Black Anvil™ and its logo are trademarks of Black Anvil Network. The code license does not grant rights to use them. Forks and modified versions must use their own name and logo. See [TRADEMARK.md](TRADEMARK.md).
