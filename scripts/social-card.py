"""Render the launch diagram. Requires Pillow; no runtime dependency."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIRS = [Path('/System/Library/Fonts/Supplemental'), Path('/usr/share/fonts/truetype/dejavu')]

def font(size, bold=False):
    names = ['Arial Bold.ttf', 'DejaVuSans-Bold.ttf'] if bold else ['Arial.ttf', 'DejaVuSans.ttf']
    for directory in FONT_DIRS:
        for name in names:
            if (directory / name).exists():
                return ImageFont.truetype(str(directory / name), size * 2)
    raise RuntimeError('Install Arial or DejaVu Sans to render the card.')

im = Image.new('RGB', (2400, 1260), '#f4f3ed')
d = ImageDraw.Draw(im)
ink, muted, green = '#173a2b', '#68816a', '#d5ff64'

def rect(box, fill, radius=0, outline=None, width=1):
    d.rounded_rectangle(tuple(v * 2 for v in box), radius * 2, fill, outline, width * 2)

def line(points, fill, width=1):
    d.line([(x * 2, y * 2) for x, y in points], fill, width * 2)

def label(x, y, text, size, color=ink, bold=False):
    d.text((x * 2, y * 2), text, font=font(size, bold), fill=color)

rect((64, 46, 106, 88), ink, 11)
line([(76, 59), (85, 59), (95, 76)], green, 3)
line([(76, 76), (85, 76), (95, 59)], green, 3)
label(120, 52, 'project relay', 27, bold=True)
label(902, 59, 'OPEN SOURCE / v0.1', 16, muted)
label(60, 125, 'Your agents.', 74, bold=True)
label(60, 209, 'One conversation.', 74, muted, True)
label(65, 315, 'A shared project inbox, memory, and handoff protocol over MCP.', 24)

for x, title, sub, initial, accent in [
    (64, 'Claude', 'VS Code', 'C', '#ebcab8'),
    (431, 'DeepSeek', 'Custom harness', 'D', '#c4d5fc'),
    (798, 'Gemini', 'Antigravity', 'G', '#d0d9c1'),
]:
    rect((x, 388, x + 338, 497), '#203329', 10)
    rect((x + 22, 414, x + 70, 462), accent, 9)
    label(x + 35, 421, initial, 27, ink, True)
    label(x + 89, 408, title, 25, '#eff5e8', True)
    label(x + 89, 444, sub, 17, '#b8c9b4')
    line([(x + 169, 497), (x + 169, 536)], '#8caa84', 2)

line([(233, 536), (967, 536)], '#8caa84', 2)
rect((463, 517, 737, 556), green, 6)
label(492, 525, 'PROJECT RELAY', 19, ink, True)
label(65, 590, 'LOCAL FIRST  /  MCP + HTTP  /  MIT LICENSE', 16, muted)
label(877, 590, 'Try it on GitHub', 17, ink, True)

im.resize((1200, 630), Image.Resampling.LANCZOS).save(ROOT / 'docs/assets/social-card.png', optimize=True)
