# Black Anvil UI pack

Source sheet: `source-sheet.png` (also `source-sheet-upscaled.jpg` for provenance).

Sliced transparent PNG/WebP assets live in `slices/` and `webp/`.

## How the web HUD uses these

**Do not stretch collage slices as `border-image`.** The sheet is a labeled art board — many crops include neighboring pieces or baked labels. Resizable HUD chrome (panels, combat log, hotbar tray, docks, slots, dialogue) uses **CSS iron/bronze frames** plus subtle `i1`/`i2`/`i3` texture fills.

Safe natural-aspect uses:

| Asset | Use |
|-------|-----|
| `a1-title-banner` | Boot brand banner (`object-fit: contain`) |
| `i1` / `i2` / `i3` | Soft repeating panel fills |
| `e2-*-orb-gem` | Optional circular vitals art |

Keep as reference only (not stretched behind grids): `e3-action-bar`, `a2-title-frame`, `d1-borders`, `h1-dialogue-box`, login button art (baked “LOGIN” text), equipment/slot collages.

## Re-slice

```bash
python3 apps/web/scripts/slice-black-anvil-ui.py
```

Source is currently **3072×1296** (3× upscale). Navy/black grid background is punched out in the slicer. Crops are defined in 1024×434 base space and auto-scaled.
