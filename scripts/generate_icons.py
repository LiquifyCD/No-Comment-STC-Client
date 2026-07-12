from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1] / "web"
BG = "#08090d"
SURFACE = "#171b28"
ACCENT = "#929dff"
LIGHT = "#c9ceff"


def icon(size: int, safe: bool = False) -> Image.Image:
    image = Image.new("RGB", (size, size), BG)
    draw = ImageDraw.Draw(image)
    scale = size / 512
    inset = 88 if safe else 56
    radius = 96 if safe else 112

    def box(values):
        return tuple(round(value * scale) for value in values)

    draw.rounded_rectangle(box((inset, inset, 512 - inset, 512 - inset)), radius=round(radius * scale), fill=SURFACE)
    draw.polygon([box((160, 390))[:2], box((160, 144))[:2], box((352, 144))[:2], box((352, 390))[:2], box((300, 390))[:2], box((300, 196))[:2], box((212, 196))[:2], box((212, 390))[:2]], fill=ACCENT)
    draw.polygon([box((212, 196))[:2], box((316, 220))[:2], box((316, 390))[:2], box((212, 389))[:2]], fill="#10131d")
    draw.ellipse(box((281, 286, 301, 306)), fill=LIGHT)
    draw.line(box((132, 410, 380, 410)), fill=ACCENT, width=max(1, round(20 * scale)))
    return image


for filename, size, safe in (
    ("apple-touch-icon.png", 180, False),
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-192.png", 192, True),
    ("icon-maskable-512.png", 512, True),
):
    icon(size, safe).save(ROOT / filename, optimize=True)
