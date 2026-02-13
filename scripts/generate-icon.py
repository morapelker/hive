#!/usr/bin/env python3
"""
generate-icon.py — Generate macOS-compliant app icons from source artwork.

Applies Apple's squircle (continuous superellipse) mask with proper padding
so the icon matches other macOS dock icons in size and shape.

Usage:
    python3 scripts/generate-icon.py [--source path/to/source.png]

Defaults to resources/icon-source.png as source artwork.

Outputs:
    resources/icon.icns    — macOS icon (all 10 required sizes)
    resources/icon.png     — Linux icon (512x512)

Requirements:
    pip3 install Pillow
    macOS with iconutil (ships with Xcode Command Line Tools)
"""

import argparse
import math
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print('Error: Pillow is required. Install with: pip3 install Pillow', file=sys.stderr)
    sys.exit(1)

# Apple's macOS icon grid specifies artwork should sit within ~80% of the
# 1024x1024 canvas. The standard inset is 100px on each side (824x824 art area).
CANVAS_SIZE = 1024
ICON_INSET = 100  # px on each side at 1024x1024
ART_SIZE = CANVAS_SIZE - (ICON_INSET * 2)  # 824x824

# Apple's continuous corner radius for the squircle mask.
# At 824px art size, the corner radius is ~185px (~22.5% of art size).
CORNER_RADIUS_RATIO = 0.225

# The superellipse exponent for Apple's "squircle" shape.
# n=5 closely approximates the continuous curvature Apple uses.
SUPERELLIPSE_N = 5

# All required macOS .iconset sizes: (filename, pixel_size)
ICONSET_SIZES = [
    ('icon_16x16.png', 16),
    ('icon_16x16@2x.png', 32),
    ('icon_32x32.png', 32),
    ('icon_32x32@2x.png', 64),
    ('icon_128x128.png', 128),
    ('icon_128x128@2x.png', 256),
    ('icon_256x256.png', 256),
    ('icon_256x256@2x.png', 512),
    ('icon_512x512.png', 512),
    ('icon_512x512@2x.png', 1024),
]


def superellipse_mask(size: int, radius: float, n: float = SUPERELLIPSE_N) -> Image.Image:
    """Create a superellipse (squircle) mask matching Apple's icon shape.

    The superellipse formula: |x/a|^n + |y/b|^n = 1
    Points inside the curve are opaque, outside are transparent.
    Anti-aliasing is achieved by rendering at 4x and downscaling.
    """
    # Render at 4x for anti-aliasing
    scale = 4
    hi_size = size * scale
    hi_radius = radius * scale

    mask = Image.new('L', (hi_size, hi_size), 0)
    draw = ImageDraw.Draw(mask)

    cx = hi_size / 2
    cy = hi_size / 2

    # The superellipse half-axes
    a = hi_size / 2
    b = hi_size / 2

    # For each pixel, determine if it's inside the rounded superellipse
    # We use a polygon approximation with many points for accuracy
    points = []
    num_points = 1000
    for i in range(num_points):
        t = 2 * math.pi * i / num_points
        cos_t = math.cos(t)
        sin_t = math.sin(t)

        # Superellipse parametric form
        x = a * _sign(cos_t) * abs(cos_t) ** (2 / n)
        y = b * _sign(sin_t) * abs(sin_t) ** (2 / n)

        points.append((cx + x, cy + y))

    draw.polygon(points, fill=255)

    # Downscale with anti-aliasing
    mask = mask.resize((size, size), Image.LANCZOS)
    return mask


def _sign(x: float) -> float:
    """Return the sign of x (-1, 0, or 1)."""
    if x > 0:
        return 1.0
    elif x < 0:
        return -1.0
    return 0.0


def apply_icon_mask(source: Image.Image) -> Image.Image:
    """Apply macOS squircle mask with proper padding to source artwork.

    Takes full-bleed source artwork and returns a 1024x1024 RGBA image
    with the artwork inset and masked to Apple's icon shape.
    """
    # Create transparent canvas
    canvas = Image.new('RGBA', (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))

    # Scale source artwork to fit within the art area
    art = source.convert('RGBA').resize((ART_SIZE, ART_SIZE), Image.LANCZOS)

    # Create the squircle mask at the art size
    corner_radius = ART_SIZE * CORNER_RADIUS_RATIO
    mask = superellipse_mask(ART_SIZE, corner_radius)

    # Apply mask to artwork
    art.putalpha(mask)

    # Paste masked artwork centered on canvas
    canvas.paste(art, (ICON_INSET, ICON_INSET), art)

    return canvas


def generate_iconset(masked_icon: Image.Image, output_dir: Path) -> None:
    """Generate all 10 required .iconset PNG files from the masked 1024x1024 icon."""
    iconset_dir = output_dir / 'icon.iconset'
    iconset_dir.mkdir(parents=True, exist_ok=True)

    for filename, size in ICONSET_SIZES:
        resized = masked_icon.resize((size, size), Image.LANCZOS)
        resized.save(iconset_dir / filename, 'PNG')

    print(f'  Generated {len(ICONSET_SIZES)} iconset PNGs in {iconset_dir}')


def build_icns(output_dir: Path) -> Path:
    """Convert .iconset directory to .icns using macOS iconutil."""
    iconset_dir = output_dir / 'icon.iconset'
    icns_path = output_dir / 'icon.icns'

    result = subprocess.run(
        ['iconutil', '--convert', 'icns', str(iconset_dir), '-o', str(icns_path)],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f'Error: iconutil failed: {result.stderr}', file=sys.stderr)
        sys.exit(1)

    print(f'  Built {icns_path} ({icns_path.stat().st_size:,} bytes)')
    return icns_path


def main():
    parser = argparse.ArgumentParser(description='Generate macOS-compliant app icons')
    parser.add_argument(
        '--source',
        type=Path,
        default=None,
        help='Path to source artwork PNG (default: resources/icon-source.png)',
    )
    args = parser.parse_args()

    # Resolve project root (script lives in scripts/)
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent
    resources_dir = project_root / 'resources'

    # Find source artwork
    source_path = args.source
    if source_path is None:
        source_path = resources_dir / 'icon-source.png'

    if not source_path.exists():
        print(f'Error: Source artwork not found: {source_path}', file=sys.stderr)
        print('Place your full-bleed source artwork at resources/icon-source.png', file=sys.stderr)
        print('or specify --source path/to/artwork.png', file=sys.stderr)
        sys.exit(1)

    print(f'Source: {source_path}')

    # Load source
    source = Image.open(source_path)
    print(f'  Dimensions: {source.size[0]}x{source.size[1]}')

    # Apply mask
    print('Applying macOS squircle mask...')
    masked = apply_icon_mask(source)

    # Generate iconset in a temp directory, then build .icns
    with tempfile.TemporaryDirectory() as tmpdir:
        tmpdir = Path(tmpdir)

        print('Generating iconset...')
        generate_iconset(masked, tmpdir)

        print('Building .icns...')
        icns_path = build_icns(tmpdir)

        # Copy outputs to resources/
        import shutil

        dest_icns = resources_dir / 'icon.icns'
        shutil.copy2(icns_path, dest_icns)
        print(f'  Wrote {dest_icns}')

    # Also save 512x512 PNG for Linux
    linux_icon = masked.resize((512, 512), Image.LANCZOS)
    linux_icon_path = resources_dir / 'icon.png'
    linux_icon.save(linux_icon_path, 'PNG')
    print(f'  Wrote {linux_icon_path} (512x512, Linux)')

    print('')
    print('Done! Icon files updated in resources/')
    print('  - icon.icns  (macOS)')
    print('  - icon.png   (Linux)')


if __name__ == '__main__':
    main()
