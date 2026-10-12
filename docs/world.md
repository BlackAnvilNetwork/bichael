# Black Anvil — World

Campaign path (collect → craft → clear → **replay with level-scaled enemies**):

| # | Area (field: mobs + nodes) | Level | City (NPCs + quests) | Catalyst |
|---|----------------------------|-------|----------------------|----------|
| 1 | **Pale Hollow** | 1–20 | **The Shard Dwellings** | Pale Dust |
| 2 | **Ashlands** | 21–40 | **Obsidia** | Ash Dust |
| 3 | **Slagpits** | 41–60 | **The Great Filter** | Slag Dust |
| 4 | **Bellmarsh** | 61–80 | **Belltower Keep** | Bell Dust |
| 5 | **Throne Approach** | 81–100 | **Citadel of KEK** | Throne Dust |

## Rules

- **Areas** — harvesting nodes (mine / harvest / fish) and mob packs from the item manifest.
- **Cities** — hubs with quest givers, Job Master, spell trainer, crafter, vendor.
- **Campaign** — play chapters in order while gathering and crafting.
- **Replay** — after Citadel clear, enemies scale to player level (+ per-clear bonus). See `replayEnemyScale` in `@bellgrave/config`.

Source of truth: `packages/config/src/world.ts`  
Item sources: `docs/legend-of-kek-item-manifest.xlsx`
