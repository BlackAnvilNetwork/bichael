#!/usr/bin/env python3
"""Slice the Black Anvil UI source sheet into transparent PNG/WebP assets.

Source is expected at apps/web/public/ui/black-anvil/source-sheet.png.
Baseline layout was authored at 1024×434; current upscaled sheet is 3072×1296 (3×).
Crops are defined in base (1024×434) space and scaled to the actual sheet size.

Sheet slices are reference art (many are collages). Prefer CSS chrome for
resizable HUD frames; use these assets only where aspect ratio can stay natural
(banner, textures, decorative accents).
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
# Tightened to exclude sheet labels and neighboring art where possible.
BASE_CROPS: dict[str, tuple[int, int, int, int]] = {
    "a1-title-banner": (8, 6, 268, 54),
    "a2-title-frame": (298, 6, 500, 54),
    "b2-login-input": (515, 8, 612, 48),
    "b3-login-button-iron": (625, 8, 752, 36),
    "b3-login-button-bronze": (625, 40, 752, 68),
    "d1-borders": (785, 4, 950, 100),
    "d2-texture-iron": (962, 8, 1020, 55),
    "d2-texture-bronze": (962, 60, 1020, 108),
    "e1-portrait-frame": (10, 78, 105, 188),
    "e2-health-orb": (114, 96, 176, 168),
    "e2-mana-orb": (184, 96, 246, 168),
    "e3-action-bar": (8, 208, 336, 250),
    "e4-hotkey-icons": (8, 272, 336, 308),
    "f1-equipment-frame": (318, 92, 520, 288),
    "f2-slot": (535, 118, 590, 172),
    "f3-grid": (535, 198, 635, 238),
    "f4-coins": (608, 250, 710, 284),
    "g1-minimap-compass": (712, 130, 812, 240),
    "g2-quest-log": (828, 120, 922, 268),
    "g3-map-markers": (938, 200, 1008, 272),
    "h1-dialogue-box": (360, 328, 530, 400),
    "h2-skill-node": (568, 330, 640, 400),
    "h3-skill-point-filled": (662, 334, 812, 366),
    "h4-skill-point-empty": (662, 380, 780, 412),
    "i1-parchment": (828, 318, 894, 384),
    "i2-iron": (908, 318, 974, 384),
    "i3-bronze-filigree": (948, 358, 1014, 422),
}


def scale_box(box: tuple[int, int, int, int], sx: float, sy: float, w: int, h: int) -> tuple[int, int, int, int]:
    l, t, r, b = box
    return (
        max(0, int(round(l * sx))),
        max(0, int(round(t * sy))),
        min(w, int(round(r * sx))),
        min(h, int(round(b * sy))),
    )


def punch_bg(im: Image.Image, dark: int = 28, near_black: int = 42) -> Image.Image:
    """Clear navy/black canvas + faint grid; keep metallic art."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            mx = max(r, g, b)
            mn = min(r, g, b)
            # Pure / near-black canvas
            if mx <= near_black and (mx - mn) <= 14:
                px[x, y] = (0, 0, 0, 0)
                continue
            # Dark navy leftover from older sheets
            if r < dark + 20 and g < dark + 28 and b < dark + 40 and abs(r - b) < 40 and mx < 70:
                px[x, y] = (0, 0, 0, 0)
                continue
            # Faint grey grid lines on black
            if mx < 70 and (mx - mn) < 10 and a < 220:
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


def largest_opaque_column_run(im: Image.Image, min_frac: float = 0.2) -> Image.Image:
    """Keep the widest contiguous column run (drops divider gaps / neighbor slivers)."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    thresh = max(4, int(h * min_frac))
    opaque_cols = [sum(1 for y in range(h) if px[x, y][3] > 24) >= thresh for x in range(w)]
    best = (0, 0)
    start = None
    for x, ok in enumerate(opaque_cols + [False]):
        if ok and start is None:
            start = x
        elif not ok and start is not None:
            if x - start > best[1] - best[0]:
                best = (start, x)
            start = None
    if best[1] - best[0] < 8:
        return im
    pad = 1
    return im.crop((max(0, best[0] - pad), 0, min(w, best[1] + pad), h))


def strip_bottom_labels(im: Image.Image, max_frac: float = 0.22) -> Image.Image:
    """Drop a bottom band that is mostly bright label text on empty alpha."""
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    cut = h
    band = max(8, int(h * max_frac))
    for y in range(h - 1, max(0, h - band) - 1, -1):
        bright = 0
        opaque = 0
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            opaque += 1
            if r > 190 and g > 190 and b > 190:
                bright += 1
        # Label rows: sparse bright glyphs, little metal fill
        if opaque > 0 and bright / opaque > 0.35 and opaque < w * 0.45:
            cut = y
        elif opaque > w * 0.08 and bright / max(opaque, 1) < 0.12:
            break
    if cut < h - 2:
        return im.crop((0, 0, w, cut))
    return im


def save(im: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEBP.mkdir(parents=True, exist_ok=True)
    im.save(OUT / f"{name}.png", "PNG")
    im.save(WEBP / f"{name}.webp", "WEBP", quality=92, method=6)
    print(f"  {name}: {im.size[0]}x{im.size[1]}")


def extract_orb_gem(orb: Image.Image) -> Image.Image:
    """Keep the circular gem; drop ornate corner filigree for HUD vitals use."""
    orb = orb.convert("RGBA")
    w, h = orb.size
    # Center on densest bright region in upper-middle
    cx, cy = w // 2, int(h * 0.42)
    radius = int(min(w, h) * 0.38)
    out = Image.new("RGBA", (radius * 2 + 4, radius * 2 + 4), (0, 0, 0, 0))
    src = orb.load()
    dst = out.load()
    ox, oy = 2, 2
    for y in range(radius * 2):
        for x in range(radius * 2):
            dx = x - radius
            dy = y - radius
            if dx * dx + dy * dy > radius * radius:
                continue
            sx = cx - radius + x
            sy = cy - radius + y
            if 0 <= sx < w and 0 <= sy < h:
                dst[ox + x, oy + y] = src[sx, sy]
    return trim_alpha(out, pad=1)


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
        piece = punch_bg(sheet.crop(box))
        piece = strip_bottom_labels(piece)
        if name.startswith("i") or name.startswith("d2-texture") or name.startswith("a1"):
            piece = largest_opaque_column_run(piece)
        piece = trim_alpha(piece)
        pieces[name] = piece
        save(piece, name)

    # Clean circular gems for optional HUD use
    save(extract_orb_gem(pieces["e2-health-orb"]), "e2-health-orb-gem")
    save(extract_orb_gem(pieces["e2-mana-orb"]), "e2-mana-orb-gem")

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
  "note": "Reference sheet slices. HUD chrome uses CSS bronze/iron frames; do not stretch collage slices as border-image.",
  "usage": {{
    "banner": "slices/a1-title-banner.png — boot brand, natural aspect",
    "textures": "i1/i2/i3 — subtle repeating panel fills",
    "orbGems": "e2-*-orb-gem.png — optional circular vitals art",
    "avoidStretch": ["e3-action-bar", "a2-title-frame", "d1-borders", "h1-dialogue-box", "f2-slot", "login buttons"]
  }},
  "assets": {{
    "titleBanner": "slices/a1-title-banner.png",
    "titleFrame": "slices/a2-title-frame.png",
    "loginInput": "slices/b2-login-input.png",
    "loginButtonIron": "slices/b3-login-button-iron.png",
    "loginButtonBronze": "slices/b3-login-button-bronze.png",
    "borders": "slices/d1-borders.png",
    "textureIronSmall": "slices/d2-texture-iron.png",
    "textureBronzeSmall": "slices/d2-texture-bronze.png",
    "portraitFrame": "slices/e1-portrait-frame.png",
    "healthOrb": "slices/e2-health-orb.png",
    "manaOrb": "slices/e2-mana-orb.png",
    "healthOrbGem": "slices/e2-health-orb-gem.png",
    "manaOrbGem": "slices/e2-mana-orb-gem.png",
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
