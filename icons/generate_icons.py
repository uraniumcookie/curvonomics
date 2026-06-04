#!/usr/bin/env python3
"""
Generate the Curvonomics toolbar/store icons in both states:

    on  = green  glow  (extension active — input is on top)
    off = orange glow  (extension paused)

The source art (On.png / Off.png) is a soft radial glow on a SOLID WHITE field.
A white-backed square reads as an opaque tile in the toolbar, so we lift the
glow onto a transparent background: the colour stays, the white falls away to
nothing, leaving a clean glowing dot that works on light or dark toolbars.

How: a pixel painted as `ink` over white is  C = ink*a + 255*(1-a).
The whiter the pixel, the lower its alpha -> alpha ~ (255 - min(R,G,B)),
normalised so the most saturated pixel is fully opaque. RGB is flattened to the
core hue so down-scaling can't introduce dark fringes.

    python3 generate_icons.py            # uses ~/Downloads/On.png + Off.png
    python3 generate_icons.py ON.png OFF.png

Requires Pillow.
"""

import os
import sys

from PIL import Image

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SRC = {
    "on": os.path.expanduser("~/Downloads/On.png"),
    "off": os.path.expanduser("~/Downloads/Off.png"),
}
SIZES = (16, 48, 128)


def core_hue(img):
    """The most saturated colour in the glow — used as the flat ink colour."""
    rgb = img.convert("RGB")
    best, best_sat = (0, 0, 0), -1
    for r, g, b in rgb.getdata():
        sat = max(r, g, b) - min(r, g, b)
        if sat > best_sat:
            best, best_sat = (r, g, b), sat
    return best


def glow_to_alpha(src_path):
    """Return an RGBA master: flat core hue, alpha = the glow lifted off white."""
    img = Image.open(src_path).convert("RGB")
    ink = core_hue(img)
    px = img.load()
    w, h = img.size

    raw = [[255 - min(px[x, y]) for x in range(w)] for y in range(h)]
    peak = max(max(row) for row in raw) or 1  # normalise core to fully opaque

    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            a = min(255, round(raw[y][x] * 255 / peak))
            op[x, y] = (ink[0], ink[1], ink[2], a)
    return out, ink


def main():
    if len(sys.argv) > 2:
        SRC["on"], SRC["off"] = sys.argv[1], sys.argv[2]

    for state, path in SRC.items():
        if not os.path.exists(path):
            raise SystemExit("Source image not found: {}".format(path))
        master, ink = glow_to_alpha(path)
        print("{:3} : {}  core hue rgb{}".format(state, path, ink))
        for s in SIZES:
            icon = master.resize((s, s), Image.LANCZOS)
            out = os.path.join(OUT_DIR, "icon-{}-{}.png".format(state, s))
            icon.save(out, "PNG")
            print("      wrote", out)


if __name__ == "__main__":
    main()
