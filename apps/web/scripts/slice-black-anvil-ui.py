#!/usr/bin/env python3
"""Slice Black Anvil UI source sheet + chroma-key generated isolates into transparent PNGs/WebPs."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "public" / "ui" / "black-anvil"
SHEET = ROOT / "source-sheet.png"
OUT = ROOT / "slices"
WEBP = ROOT / "webp"
GEN = Path("/opt/cursor/artifacts/assets")


def chroma_magenta(im: Image.Image, thresh: int = 70) -> Image.Image:
    """Make near-magenta pixels transparent."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 180 and b > 180 and g < 120 and (r - g) > thresh and (b - g) > thresh:
                px[x, y] = (r, g, b, 0)
            elif r > 220 and g < 40 and b > 220:
                px[x, y] = (r, g, b, 0)
    return im


def dark_bg_to_alpha(im: Image.Image, thresh: int = 28) -> Image.Image:
    """Sheet grid background → transparent (near-black charcoal)."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r < thresh and g < thresh and b < thresh:
                px[x, y] = (r, g, b, 0)
            # faint grid lines
            elif max(r, g, b) < 45 and abs(r - g) < 8 and abs(g - b) < 8:
                px[x, y] = (r, g, b, 0)
    return im


def trim_alpha(im: Image.Image, pad: int = 2) -> Image.Image:
    bbox = im.getbbox()
    if not bbox:
        return im
    l, t, r, b = bbox
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(im.width, r + pad)
    b = min(im.height, b + pad)
    return im.crop((l, t, r, b))


def save(im: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEBP.mkdir(parents=True, exist_ok=True)
    png = OUT / f"{name}.png"
    webp = WEBP / f"{name}.webp"
    im.save(png, "PNG")
    im.save(webp, "WEBP", quality=90, method=6)
    print(f"wrote {png.relative_to(ROOT)} {im.size}")


def crop_sheet(box: tuple[int, int, int, int], name: str) -> None:
    sheet = Image.open(SHEET).convert("RGBA")
    piece = dark_bg_to_alpha(sheet.crop(box))
    piece = trim_alpha(piece)
    save(piece, name)


def process_generated(src_name: str, out_name: str) -> None:
    # tool may write .jpg
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        p = GEN / f"{src_name}{ext}"
        if p.exists():
            im = chroma_magenta(Image.open(p))
            im = trim_alpha(im)
            save(im, out_name)
            return
    print("missing generated", src_name)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    WEBP.mkdir(parents=True, exist_ok=True)

    # Approximate cells on 1280x720 labeled sheet (tuned to generated pack layout).
    # Format: left, top, right, bottom
    crops = {
        "a1-title-banner": (40, 18, 620, 115),
        "a2-title-frame": (660, 18, 1240, 115),
        "b2-login-input": (40, 120, 700, 175),
        "b3-login-button-iron": (740, 118, 960, 185),
        "b3-login-button-bronze": (980, 118, 1200, 185),
        "d1-borders": (30, 195, 420, 310),
        "d2-texture-iron": (450, 195, 720, 310),
        "d2-texture-bronze": (740, 195, 1010, 310),
        "e1-portrait-frame": (40, 320, 170, 450),
        "e2-health-orb": (190, 320, 320, 450),
        "e2-mana-orb": (330, 320, 460, 450),
        "e3-action-bar": (480, 330, 1100, 430),
        "e4-hotkey-icons": (1120, 320, 1260, 450),
        "f1-equipment-frame": (40, 460, 220, 620),
        "f2-slot": (240, 470, 340, 570),
        "f3-grid": (360, 460, 700, 620),
        "f4-coins": (720, 470, 920, 610),
        "g1-minimap-compass": (40, 620, 160, 715),
        "g2-quest-log": (180, 620, 420, 715),
        "g3-map-markers": (440, 620, 580, 715),
        "h1-dialogue-box": (600, 560, 1000, 680),
        "h2-skill-node": (1020, 560, 1120, 650),
        "h3-skill-point-filled": (1020, 650, 1120, 715),
        "h4-skill-point-empty": (1140, 560, 1240, 650),
        "i1-parchment": (1140, 650, 1240, 715),
        "i2-iron": (900, 460, 1040, 560),
        "i3-bronze-filigree": (1060, 460, 1200, 560),
    }

    for name, box in crops.items():
        crop_sheet(box, name)

    # Higher-quality chroma-keyed isolates (prefer these in CSS when present).
    process_generated("ba-a1-title-banner", "a1-title-banner-hi")
    process_generated("ba-d1-panel-frame", "d1-panel-frame-hi")
    process_generated("ba-e2-orbs", "e2-orbs-hi")
    process_generated("ba-e3-action-bar", "e3-action-bar-hi")

    # Manifest for border-image / UI wiring
    (ROOT / "manifest.json").write_text(
        """{
  "theme": "black-anvil",
  "source": "source-sheet.png",
  "note": "Original user attachment did not land on the agent VM; sheet regenerated from the label inventory and sliced. Replace source-sheet.png and re-run scripts/slice-black-anvil-ui.py to refresh.",
  "nineSlice": {
    "panel": { "image": "slices/d1-panel-frame-hi.png", "slice": "48 48 48 48", "width": "18px" },
    "dialogue": { "image": "slices/h1-dialogue-box.png", "slice": "36 36 36 36", "width": "14px" },
    "quest": { "image": "slices/g2-quest-log.png", "slice": "32 32 32 32", "width": "12px" },
    "banner": { "image": "slices/a2-title-frame.png", "slice": "40 60 40 60", "width": "20px" }
  },
  "assets": {
    "titleBanner": "slices/a1-title-banner-hi.png",
    "titleFrame": "slices/a2-title-frame.png",
    "loginInput": "slices/b2-login-input.png",
    "loginButtonIron": "slices/b3-login-button-iron.png",
    "loginButtonBronze": "slices/b3-login-button-bronze.png",
    "borders": "slices/d1-borders.png",
    "textureIron": "slices/d2-texture-iron.png",
    "textureBronze": "slices/d2-texture-bronze.png",
    "portraitFrame": "slices/e1-portrait-frame.png",
    "healthOrb": "slices/e2-health-orb.png",
    "manaOrb": "slices/e2-mana-orb.png",
    "orbsHi": "slices/e2-orbs-hi.png",
    "actionBar": "slices/e3-action-bar-hi.png",
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
  }
}
""",
        encoding="utf-8",
    )
    print("manifest written")


if __name__ == "__main__":
    main()
