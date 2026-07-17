from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
WEB = ROOT / "web"
NATIVE_SIZE = 1024


def load_square(source_path: Path) -> Image.Image:
    with Image.open(source_path) as source:
        return ImageOps.fit(
            source.convert("RGB"),
            (NATIVE_SIZE, NATIVE_SIZE),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )


def save_resized(source: Image.Image, path: Path, size: int) -> None:
    image = source.resize((size, size), Image.Resampling.LANCZOS)
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate native and PWA app icons.")
    parser.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=ASSETS / "icon.png",
        help="Square source image; defaults to assets/icon.png.",
    )
    args = parser.parse_args()

    source = load_square(args.source.resolve())
    ASSETS.mkdir(parents=True, exist_ok=True)
    source.save(ASSETS / "icon.png", format="PNG", optimize=True)

    for filename, size in (
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("icon-maskable-192.png", 192),
        ("icon-maskable-512.png", 512),
    ):
        save_resized(source, WEB / filename, size)


if __name__ == "__main__":
    main()
