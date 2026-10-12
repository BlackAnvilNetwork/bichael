# Black Anvil UI pack

Source sheet: `source-sheet.png` (also `source-sheet.jpg`).

Sliced transparent PNG/WebP assets live in `slices/` and `webp/`. Labels follow the sheet legend:

| ID | Asset | Use |
|----|-------|-----|
| A1 | `a1-title-banner*` | Boot title banner |
| A2 | `a2-title-frame` | Empty title / log frame (nine-slice) |
| B2 | `b2-login-input` | Login inputs |
| B3 | `b3-login-button-*` | Primary/secondary buttons |
| D1 | `d1-borders`, `d1-panel-frame-hi` | Panel nine-slice |
| D2 | `d2-texture-*` | Iron / bronze fills |
| E1–E4 | portrait, orbs, action bar, hotkeys | HUD |
| F1–F4 | equipment, slot, grid, coins | Inventory |
| G1–G3 | minimap, quest log, markers | Nav / quests |
| H1–H4 | dialogue, skill node/points | Dialogue / skills |
| I1–I3 | parchment / iron / bronze | Tileable fills |

Re-slice after replacing the source sheet:

```bash
python3 apps/web/scripts/slice-black-anvil-ui.py
```

**Note:** The original user attachment did not reach the agent VM. The committed sheet was regenerated from the label inventory so work could proceed; drop the authentic pack over `source-sheet.png` and re-run the slicer to refresh crops.
