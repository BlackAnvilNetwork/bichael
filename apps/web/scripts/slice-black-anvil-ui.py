#!/usr/bin/env python3
"""Slice the Black Anvil UI source sheet into transparent PNG/WebP assets.

Source is expected at apps/web/public/ui/black-anvil/source-sheet.png.
Baseline layout was authored at 1024×434; current upscaled sheet is 3072×1296 (3×).
Crops are defined in base (1024×434) space and scaled to the actual sheet size.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public" / "ui" / "black-anvil"
SHEET = ROOT / "source-sheet.png"
OUT = ROOT / "slices"
WEBP = ROOT / "webp"

BASE_W, BASE_H = 1024, 434

# Coordinates in base 1024×434 space: (left, top, right, bottom)
BASE_CROPS: dict[str, tuple[int, int, int, int]] = {
    "a1-title-banner": (6, 4, 270, 66),
    "a2-title-frame": (295, 4, 505, 66),
    "b2-login-input": (512, 2, 618, 90),
    "b3-login-button-iron": (622, 10, 755, 40),
    "b3-login-button-bronze": (622, 42, 755, 72),
    "d1-borders": (780, 6, 955, 115),
    "d2-texture-iron": (960, 8, 1022, 60),
    "d2-texture-bronze": (960, 62, 1022, 115),
    "e1-portrait-frame": (8, 82, 108, 195),
    "e2-health-orb": (112, 98, 178, 184),
    "e2-mana-orb": (182, 98, 248, 184),
    "e3-action-bar": (6, 210, 338, 260),
    "e4-hotkey-icons": (6, 274, 338, 312),
    "f1-equipment-frame": (310, 90, 525, 302),
    "f2-slot": (528, 115, 595, 182),
    "f3-grid": (528, 195, 640, 242),
    "f4-coins": (600, 248, 715, 288),
    "g1-minimap-compass": (705, 128, 818, 248),
    "g2-quest-log": (822, 118, 928, 280),
    "g3-map-markers": (932, 198, 1012, 280),
    "h1-dialogue-box": (305, 320, 552, 412),
    "h2-skill-node": (562, 328, 648, 412),
    "h3-skill-point-filled": (658, 332, 818, 370),
    "h4-skill-point-empty": (658, 378, 785, 418),
    "i1-parchment": (822, 322, 898, 398),
    "i2-iron": (902, 322, 978, 398),
    "i3-bronze-filigree": (942, 362, 1020, 428),
}


def scale_box(box: tuple[int, int, int, int], sx: float, sy: float, w: int, h: int) -> tuple[int, int, int, int]:
    l, t, r, b = box
    return (
        max(0, int(round(l * sx))),
        max(0, int(round(t * sy))),
        min(w, int(round(r * sx))),
        min(h, int(round(b * sy))),
    )


def punch_remaining_bg(im: Image.Image, thresh: int = 70) -> Image.Image:
    """Clear any leftover dark navy canvas pixels (idempotent if already transparent)."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            if r < thresh and g < thresh + 8 and b < thresh + 18 and abs(r - b) < 35:
                px[x, y] = (0, 0, 0, 0)
            elif max(r, g, b) < 48 and abs(r - g) < 12 and abs(g - b) < 12:
                px[x, y] = (0, 0, 0, 0)
    return im


def trim_alpha(im: Image.Image, pad: int = 2) -> Image.Image:
    bbox = im.getbbox()
    if not bbox:
        return im
    l, t, r, b = bbox
    return im.crop(
        (max(0, l - pad), max(0, t - pad), min(im.width, r + pad), min(im.height, b + pad))
    )


def save(im: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEBP.mkdir(parents=True, exist_ok=True)
    im.save(OUT / f"{name}.png", "PNG")
    im.save(WEBP / f"{name}.webp", "WEBP", quality=92, method=6)
    print(f"  {name}: {im.size[0]}x{im.size[1]}")


def build_panel_frame_from_d1(d1: Image.Image) -> Image.Image:
    size = 512
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    src = d1.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    canvas.paste(src, (0, 0), src)
    return canvas


def main() -> None:
    if not SHEET.exists():
        raise SystemExit(f"missing sheet: {SHEET}")
    sheet = Image.open(SHEET).convert("RGBA")
    w, h = sheet.size
    sx, sy = w / BASE_W, h / BASE_H
    print(f"sheet {SHEET} size={sheet.size} scale=({sx:.3f},{sy:.3f})")

    OUT.mkdir(parents=True, exist_ok=True)
    WEBP.mkdir(parents=True, exist_ok=True)

    pieces: dict[str, Image.Image] = {}
    for name, base in BASE_CROPS.items():
        box = scale_box(base, sx, sy, w, h)
        piece = punch_remaining_bg(sheet.crop(box))
        piece = trim_alpha(piece)
        pieces[name] = piece
        save(piece, name)

    panel = build_panel_frame_from_d1(pieces["d1-borders"])
    save(panel, "d1-panel-frame")

    h_orb = pieces["e2-health-orb"]
    m_orb = pieces["e2-mana-orb"]
    gap = max(8, int(8 * sx))
    orbs = Image.new(
        "RGBA",
        (h_orb.width + gap + m_orb.width, max(h_orb.height, m_orb.height)),
        (0, 0, 0, 0),
    )
    orbs.paste(h_orb, (0, 0), h_orb)
    orbs.paste(m_orb, (h_orb.width + gap, 0), m_orb)
    save(orbs, "e2-orbs")

    (ROOT / "manifest.json").write_text(
        f"""{{
  "theme": "black-anvil",
  "source": "source-sheet.png",
  "sourceSize": [{w}, {h}],
  "baseLayoutSize": [{BASE_W}, {BASE_H}],
  "scale": [{sx:.4f}, {sy:.4f}],
  "note": "Upscaled user sheet with agent-side navy background removal. Crops defined in 1024x434 base space and scaled.",
  "nineSlice": {{
    "panel": {{ "image": "slices/d1-panel-frame.png", "slice": "80 80 80 80", "width": "16px" }},
    "dialogue": {{ "image": "slices/h1-dialogue-box.png", "slice": "48 48 48 48", "width": "14px" }},
    "quest": {{ "image": "slices/g2-quest-log.png", "slice": "40 40 40 40", "width": "12px" }},
    "banner": {{ "image": "slices/a2-title-frame.png", "slice": "36 60 36 60", "width": "16px" }},
    "slot": {{ "image": "slices/f2-slot.png", "slice": "18 18 18 18", "width": "7px" }}
  }},
  "assets": {{
    "titleBanner": "slices/a1-title-banner.png",
    "titleFrame": "slices/a2-title-frame.png",
    "loginInput": "slices/b2-login-input.png",
    "loginButtonIron": "slices/b3-login-button-iron.png",
    "loginButtonBronze": "slices/b3-login-button-bronze.png",
    "borders": "slices/d1-borders.png",
    "panelFrame": "slices/d1-panel-frame.png",
    "textureIron": "slices/d2-texture-iron.png",
    "textureBronze": "slices/d2-texture-bronze.png",
    "portraitFrame": "slices/e1-portrait-frame.png",
    "healthOrb": "slices/e2-health-orb.png",
    "manaOrb": "slices/e2-mana-orb.png",
    "orbs": "slices/e2-orbs.png",
    "actionBar": "slices/e3-action-bar.png",
    "hotkeyIcons": "slices/e4-hotkey-icons.png",
    "equipmentFrame": "slices/f1-equipment-frame.png",
    "slot": "slices/f2-slot.png",
    "grid": "slices/f3-grid.png",
    "coins": "slices/f4-coins.png",
    "minimap": "slices/g1-minimap-compass.png",
    "questLog": "slices/g2-quest-log.png",
    "mapMarkers": "slices/g3-map-markers.png",
    "dialogue": "slices/h1-dialogue-box.png",
    "skillNode": "slices/h2-skill-node.png",
    "skillPointFilled": "slices/h3-skill-point-filled.png",
    "skillPointEmpty": "slices/h4-skill-point-empty.png",
    "texParchment": "slices/i1-parchment.png",
    "texIron": "slices/i2-iron.png",
    "texBronze": "slices/i3-bronze-filigree.png"
  }}
}}
""",
        encoding="utf-8",
    )
    print("manifest written")


if __name__ == "__main__":
    main()
