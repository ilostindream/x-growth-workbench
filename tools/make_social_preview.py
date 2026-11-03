# -*- coding: utf-8 -*-
"""生成 GitHub 仓库社交预览图 social-preview.png（1280x640，需 <1MB）。
视觉与 icons/ 定稿图标一致：暗底 + 琥珀橙渐变方块 + 深色 X + 白色活跃度柱。
"""
from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1280, 640
OUT = "assets/social-preview.png"

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ---------- 背景：对角渐变 + 琥珀辉光 ----------
img = Image.new("RGB", (W, H))
px = img.load()
c00, c11 = (10, 14, 19), (24, 31, 41)
for y in range(H):
    for x in range(0, W, 4):
        t = (x / W * 0.6 + y / H * 0.4)
        c = lerp(c00, c11, t)
        for dx in range(4):
            if x + dx < W:
                px[x + dx, y] = c

glow = Image.new("L", (W, H), 0)
gd = ImageDraw.Draw(glow)
gd.ellipse([W - 620, -340, W + 240, 320], fill=42)
amber_layer = Image.new("RGB", (W, H), (247, 181, 0))
img = Image.composite(amber_layer, img, glow)

d = ImageDraw.Draw(img, "RGBA")

# 网格细线
for gx in range(0, W + 1, 213):
    d.line([(gx, 0), (gx, H)], fill=(255, 255, 255, 10), width=1)
for gy in range(0, H + 1, 160):
    d.line([(0, gy), (W, gy)], fill=(255, 255, 255, 10), width=1)

F = lambda name, size: ImageFont.truetype("C:/Windows/Fonts/" + name, size)
f_title = F("msyhbd.ttc", 108)
f_sub = F("msyh.ttc", 34)
f_chip = F("msyhbd.ttc", 30)
f_foot = F("msyh.ttc", 24)

# ---------- 图标方块 ----------
S, SX, SY = 300, 96, 110
grad = Image.new("RGB", (S, S))
gp = grad.load()
top, bot = (255, 176, 46), (240, 118, 10)
for y in range(S):
    c = lerp(top, bot, y / S)
    for x in range(S):
        gp[x, y] = c
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=64, fill=255)
img.paste(grad, (SX, SY), mask)
d = ImageDraw.Draw(img, "RGBA")
d.rounded_rectangle([SX, SY, SX + S - 1, SY + S // 2], radius=64,
                    fill=(255, 255, 255, 26))

# 深色 X：两根交叉粗棒
cx, cy, arm, thick = SX + S * 0.52, SY + S * 0.46, 78, 46
def bar(p1, p2, w, fill):
    ang = math.atan2(p2[1] - p1[1], p2[0] - p1[0])
    dx, dy = math.sin(ang) * w / 2, -math.cos(ang) * w / 2
    d.polygon([p1[0] + dx, p1[1] + dy, p2[0] + dx, p2[1] + dy,
               p2[0] - dx, p2[1] - dy, p1[0] - dx, p1[1] - dy], fill=fill)
dark = (20, 24, 29)
bar((cx - arm, cy - arm), (cx + arm, cy + arm), thick, dark)
bar((cx - arm, cy + arm), (cx + arm, cy - arm), thick, dark)
# 内衬细棒（模拟 X 双线）
thin, off = 9, 17
bar((cx - arm + off, cy - arm), (cx + arm + off, cy + arm), thin, (46, 52, 60))
bar((cx - arm + off, cy + arm), (cx + arm + off, cy - arm), thin, (46, 52, 60))

# 白色活跃度柱（左下递增）
bw = 26
bars = [(58, 214, 46), (94, 188, 72), (130, 156, 104)]
for bx, by, bh in bars:
    d.rounded_rectangle([SX + bx, SY + by, SX + bx + bw, SY + by + bh], radius=8, fill=(255, 255, 255))

# ---------- 文案 ----------
TX = 470
d.text((TX, 150), "X 发展工作台", font=f_title, fill=(245, 247, 250))
d.text((TX + 4, 288), "X Growth Workbench · 浏览器扩展 · 数据全部本地", font=f_sub, fill=(147, 161, 176))

# ---------- 功能徽标条 ----------
chips = [("活跃统计", (247, 181, 0)), ("互关标记", (0, 186, 124)),
         ("爆帖灵感", (29, 155, 240)), ("AI 助手", (244, 33, 46)), ("媒体备份", (147, 161, 176))]
cxp, cyp, ch = 96, 448, 64
for label, color in chips:
    tw = d.textlength(label, font=f_chip)
    w = int(tw + 56)
    d.rounded_rectangle([cxp, cyp, cxp + w, cyp + ch], radius=32,
                        outline=color + (230,), width=3)
    tc = tuple(min(255, int(c * 1.35)) for c in color)
    d.text((cxp + 28, cyp + 13), label, font=f_chip, fill=tc)
    cxp += w + 22

d.text((TX, 556), "原创 · @lostindream · 仅供个人学习与自用", font=f_foot, fill=(93, 107, 122))

img.save(OUT, optimize=True)
import os
print("saved", OUT, os.path.getsize(OUT) // 1024, "KB")
