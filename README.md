# Black Anvil

Browser vertical slice: wallet connect → greybox palace hall → Time Mage combat vs Petrified Guard → potion "burn".

Formerly developed as Bellgrave / Legend of KEK. On-chain identifiers, engine ops, log schemas, and npm package names (`@bellgrave/*`) are unchanged so log replay and deployed contracts keep working.

## Stack

- `apps/web` — React + Vite + R3F (fixed isometric camera, placeholder billboards)
- `apps/server` — Node WebSocket game loop @ 20 Hz
- `packages/combat` — TIM formulas + abilities
- `packages/protocol` — Zod client messages
- `packages/config` — shared constants

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
3. Campaign world (see `docs/world.md`):
   - **Pale Hollow** ↔ The Shard Dwellings → **Ashlands** ↔ Obsidia → **Slagpits** ↔ The Great Filter → **Bellmarsh** ↔ Belltower Keep → **Throne Approach** ↔ Citadel of KEK
   - Areas: mobs + harvest nodes · Cities: NPCs + quests · Craft while progressing
4. Clear the campaign, then replay with enemies scaled to your level
5. MVP combat slice still runs in Citadel hall vs Petrified Guard (keys **1–4**, etc.)

Potion use removes inventory (mock on-chain burn). Settlement targets Gnosis (see `docs/gnosis-launch.md`).

## UI pack

Black Anvil HUD chrome lives in `apps/web/public/ui/black-anvil/` (source sheet + sliced PNG/WebP). Re-slice with `python3 apps/web/scripts/slice-black-anvil-ui.py`.

## Contracts (stub)

See `contracts/README.md`. MVP does not deploy; inventory is server-authoritative mock state.

The log-model Foundry package lives in `contracts/lok-log/` (not part of the pnpm workspace).
