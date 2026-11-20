#!/usr/bin/env python3
"""The store icons and banner: the launcher's inbox tray (no GitHub logo: GitHub's brand rules
forbid using it as an app's icon), drawn large on the watch's cobalt blue, plus two of the
screens tools/store_shots.py captured.

    python3 tools/store_art.py

Writes store/icon_80x80.png, store/icon_144x144.png and store/banner_720x320.png.
"""
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, 'store')

COBALT = (0, 85, 170)
NAVY = (0, 0, 85)
WHITE = (255, 255, 255)
RED = (255, 0, 0)
GREY = (170, 170, 170)
FONT_DIRS = ['/System/Library/Fonts/Supplemental', '/usr/share/fonts/truetype/msttcorefonts',
             '/usr/share/fonts/truetype/dejavu']


def font(names, size):
    for folder in FONT_DIRS:
        for name in names:
            path = os.path.join(folder, name)
            if os.path.exists(path):
                return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def tray(draw, box, ink, width):
    """The inbox tray with an arrow dropping into it, fitted to box (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    p = lambda fx, fy: (x0 + fx * w, y0 + fy * h)
    # the tray: sides, bottom, and a lip with a dip for the slot
    draw.line([p(0.06, 0.52), p(0.06, 0.94), p(0.94, 0.94), p(0.94, 0.52)], fill=ink, width=width,
              joint='curve')
    draw.line([p(0.06, 0.52), p(0.30, 0.52), p(0.36, 0.66), p(0.64, 0.66), p(0.70, 0.52),
               p(0.94, 0.52)], fill=ink, width=width, joint='curve')
    # the arrow
    draw.line([p(0.5, 0.04), p(0.5, 0.40)], fill=ink, width=width)
    draw.polygon([p(0.32, 0.30), p(0.68, 0.30), p(0.5, 0.48)], fill=ink)


def icon(size):
    scale = 8
    s = size * scale
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=COBALT)
    pad = s * 0.2
    tray(d, (pad, pad * 1.05, s - pad, s - pad * 0.95), WHITE, max(1, int(s * 0.075)))
    # an unread dot
    r = s * 0.11
    cx, cy = s * 0.76, s * 0.25
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED, outline=COBALT, width=int(s * 0.025))
    return im.resize((size, size), Image.LANCZOS)


def shot(name, scale):
    im = Image.open(os.path.join(STORE, name)).convert('RGB')
    return im.resize((im.width * scale // 4, im.height * scale // 4), Image.NEAREST)


def banner():
    W, H = 720, 320
    im = Image.new('RGB', (W, H), NAVY)
    d = ImageDraw.Draw(im)
    bold = ['Arial Bold.ttf', 'DejaVuSans-Bold.ttf']
    regular = ['Arial.ttf', 'DejaVuSans.ttf']
    im.paste(icon(84), (36, 44), icon(84))
    d.text((36, 146), 'Inbox for GitHub', font=font(bold, 40), fill=WHITE)
    d.text((36, 198), 'Notifications, reviews, pull request', font=font(regular, 21), fill=WHITE)
    d.text((36, 224), 'checks and builds, on your wrist.', font=font(regular, 21), fill=WHITE)
    d.text((36, 276), 'Unofficial. Not affiliated with GitHub.', font=font(regular, 15), fill=GREY)
    # the Time 2's Home at 1.25x, framed in black, on the right
    s = shot('emery_1_home.png', 5)
    frame = Image.new('RGB', (s.width + 12, s.height + 12), (0, 0, 0))
    frame.paste(s, (6, 6))
    im.paste(frame, (W - frame.width - 28, (H - frame.height) // 2))
    return im


def main():
    icon(80).save(os.path.join(STORE, 'icon_80x80.png'))
    icon(144).save(os.path.join(STORE, 'icon_144x144.png'))
    banner().save(os.path.join(STORE, 'banner_720x320.png'))
    for name in ['icon_80x80.png', 'icon_144x144.png', 'banner_720x320.png']:
        print(os.path.join('store', name))


if __name__ == '__main__':
    main()
