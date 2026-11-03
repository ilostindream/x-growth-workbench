"""生成扩展图标（纯标准库，无需 Pillow）。

v2 设计目标：在扩展栏小尺寸（16px）下一眼认出。
多方案渲染 → 预览对比图 → 选定后写 icon16/48/128.png。

方案：
  mint-old  旧版：蓝紫渐变底 + 白 X + 薄荷绿柱（对比基准）
  bigmint   蓝紫渐变底，X 放大到 0.62 宽、上移，加粗绿柱压角
  amber     琥珀橙渐变底 + 近黑粗 X + 白柱（扩展栏里橙色极少，最易找）
  neon      深靛底 + 荧光青→绿渐变 X + 亮白柱（深底在浅色工具栏最突出）

用法：
    python tools/make_icons.py              # 用选定方案生成 icons/icon16|48|128.png
    python tools/make_icons.py --preview    # 额外生成 tools/icon-preview.png 对比图
"""

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, "..", "icons"))
PREVIEW = os.path.join(HERE, "icon-preview.png")

WHITE = (255, 255, 255)
INK = (24, 24, 30)          # 近黑
MINT = (110, 240, 198)      # 薄荷绿
NEON_A = (0, 240, 255)      # 荧光青
NEON_B = (124, 255, 79)     # 荧光绿

# X 官方字形的两个子路径（24×24 视图盒），奇偶填充 → 中间留出镂空缺口
X_PATH = [
    [(18.244, 2.25), (21.552, 2.25), (14.325, 10.51), (22.827, 21.75),
     (16.17, 21.75), (10.956, 14.933), (4.99, 21.75), (1.68, 21.75),
     (9.41, 12.915), (1.254, 2.25), (8.08, 2.25), (12.793, 8.481)],
    [(17.083, 19.77), (18.916, 19.77), (7.084, 4.126), (5.117, 4.126)],
]

X_MINX, X_W, X_MINY, X_H = 1.254, 21.573, 2.25, 19.5

CARD_R = 0.235              # 圆角半径


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _mix(c0, c1, t):
    return (
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
    )


class Design(object):
    """一个图标方案的几何与配色参数。"""

    def __init__(self, bg_a, bg_b, x_mode, x_color_a, x_color_b,
                 x_target_w, x_cy, bars, bar_color, bar_alpha=1.0):
        self.bg_a = bg_a
        self.bg_b = bg_b
        self.x_mode = x_mode            # flat | grad
        self.x_a = x_color_a
        self.x_b = x_color_b
        self.x_w = x_target_w
        self.x_cy = x_cy
        self.bars = bars                # [(x0, h), ...] 归一化
        self.bar_color = bar_color
        self.bar_alpha = bar_alpha
        self.bar_r = 0.03
        # X 字形多边形
        k = self.x_w / X_W
        x0 = 0.5 - self.x_w / 2.0
        y0 = self.x_cy - (X_H * k) / 2.0
        self.x_polys = [
            [(x0 + (px - X_MINX) * k, y0 + (py - X_MINY) * k) for px, py in sp]
            for sp in X_PATH
        ]
        self.x_box = (
            min(p[0] for sp in self.x_polys for p in sp),
            min(p[1] for sp in self.x_polys for p in sp),
            max(p[0] for sp in self.x_polys for p in sp),
            max(p[1] for sp in self.x_polys for p in sp),
        )
        # 柱子矩形
        base = 0.888
        bw = 0.125
        self.bar_rects = [(bx, base - h, bx + bw, base) for bx, h in self.bars]

    def in_x(self, x, y):
        bx = self.x_box
        if x < bx[0] or x > bx[2] or y < bx[1] or y > bx[3]:
            return False
        cross = 0
        for sp in self.x_polys:
            n = len(sp)
            for i in range(n):
                ax, ay = sp[i]
                bx2, by2 = sp[(i + 1) % n]
                if (ay > y) != (by2 > y):
                    t = (y - ay) / (by2 - ay)
                    if x < ax + t * (bx2 - ax):
                        cross += 1
        return cross % 2 == 1

    def pixel(self, u, v):
        if not in_round_rect(u, v, 0.0, 0.0, 1.0, 1.0, CARD_R):
            return None
        t = (u + v) / 2.0
        base = _mix(self.bg_a, self.bg_b, t)
        if self.in_x(u, v):
            if self.x_mode == "grad":
                bx = self.x_box
                gt = (u - bx[0]) / max(1e-6, bx[2] - bx[0])
                gt = (gt + (1 - gt) * ((v - bx[1]) / max(1e-6, bx[3] - bx[1]))) / 1.0
                gt = max(0.0, min(1.0, (gt + ((v - bx[1]) / max(1e-6, bx[3] - bx[1]))) / 2.0))
                return _mix(self.x_a, self.x_b, gt)
            return self.x_a
        for (x0, y0, x1, y1) in self.bar_rects:
            if in_round_rect(u, v, x0, y0, x1, y1, self.bar_r):
                return tuple(base[i] + (self.bar_color[i] - base[i]) * self.bar_alpha
                             for i in range(3))
        return base


DESIGNS = {
    # 旧版（对比基准）：蓝紫渐变 + 白 X + 薄荷绿柱
    "mint-old": Design(
        bg_a=(29, 155, 240), bg_b=(104, 74, 255),
        x_mode="flat", x_color_a=WHITE, x_color_b=WHITE,
        x_target_w=0.440, x_cy=0.378,
        bars=[(0.2775, 0.105), (0.4425, 0.165), (0.6075, 0.225)],
        bar_color=MINT,
    ),
    # 大 X：蓝紫底不变，X 放大上移，粗绿白柱压底
    "bigmint": Design(
        bg_a=(37, 99, 235), bg_b=(147, 51, 234),
        x_mode="flat", x_color_a=WHITE, x_color_b=WHITE,
        x_target_w=0.60, x_cy=0.40,
        bars=[(0.16, 0.14), (0.345, 0.22), (0.53, 0.30)],
        bar_color=(190, 255, 120),
    ),
    # 琥珀：橙金渐变底 + 近黑 X + 白柱 —— 扩展栏里橙色极少，辨识度最高
    "amber": Design(
        bg_a=(255, 176, 7), bg_b=(255, 80, 0),
        x_mode="flat", x_color_a=INK, x_color_b=INK,
        x_target_w=0.52, x_cy=0.42,
        bars=[(0.235, 0.12), (0.405, 0.19), (0.575, 0.26)],
        bar_color=WHITE,
    ),
    # 荧光：深靛底 + 荧光青绿渐变 X + 亮白柱 —— 浅色工具栏里深底最跳
    "neon": Design(
        bg_a=(17, 19, 46), bg_b=(47, 22, 86),
        x_mode="grad", x_color_a=NEON_A, x_color_b=NEON_B,
        x_target_w=0.56, x_cy=0.42,
        bars=[(0.20, 0.13), (0.375, 0.20), (0.55, 0.27)],
        bar_color=(240, 255, 250),
    ),
}

CHOSEN = "amber"


def render_master(design, master=384, ss=2):
    n = master * ss
    buf = bytearray(n * n * 4)
    step = 1.0 / n
    for py in range(n):
        v = (py + 0.5) * step
        row = py * n * 4
        for px in range(n):
            u = (px + 0.5) * step
            c = design.pixel(u, v)
            i = row + px * 4
            if c is None:
                continue
            buf[i] = int(c[0] + 0.5)
            buf[i + 1] = int(c[1] + 0.5)
            buf[i + 2] = int(c[2] + 0.5)
            buf[i + 3] = 255
    return buf, n


def downsample(buf, n, size):
    """预乘 alpha 的面积平均，避免透明边缘发黑。"""
    out = bytearray(size * size * 4)
    for y in range(size):
        y0 = y * n // size
        y1 = max(y0 + 1, (y + 1) * n // size)
        for x in range(size):
            x0 = x * n // size
            x1 = max(x0 + 1, (x + 1) * n // size)
            sr = sg = sb = sa = 0
            cnt = 0
            for yy in range(y0, y1):
                base = yy * n * 4
                for xx in range(x0, x1):
                    i = base + xx * 4
                    a = buf[i + 3]
                    if a:
                        sr += buf[i] * a
                        sg += buf[i + 1] * a
                        sb += buf[i + 2] * a
                        sa += a
                    cnt += 1
            o = (y * size + x) * 4
            if sa:
                out[o] = min(255, (sr // sa))
                out[o + 1] = min(255, (sg // sa))
                out[o + 2] = min(255, (sb // sa))
            out[o + 3] = sa // cnt
    return out


def write_png(path, w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


# ---------- 预览图 ----------

def blit(dst, dw, dh, dx, dy, src, sw, sh):
    for y in range(sh):
        for x in range(sw):
            if dx + x < 0 or dy + y < 0 or dx + x >= dw or dy + y >= dh:
                continue
            i = (y * sw + x) * 4
            a = src[i + 3] / 255.0
            if a <= 0:
                continue
            o = ((dy + y) * dw + dx + x) * 4
            for c in range(3):
                dst[o + c] = int(src[i + c] * a + dst[o + c] * (1 - a) + 0.5)
            dst[o + 3] = 255


def nearest(rgba, size, scale):
    out = bytearray(size * scale * size * scale * 4)
    for y in range(size * scale):
        for x in range(size * scale):
            i = ((y // scale) * size + (x // scale)) * 4
            o = (y * size * scale + x) * 4
            out[o:o + 4] = rgba[i:i + 4]
    return out


def make_preview(sheets):
    pad = 20
    cw = 128 * len(sheets) + pad * (len(sheets) + 1)
    ch = pad * 4 + 128 + 32 + 128
    canvas = bytearray(cw * ch * 4)
    for i in range(cw * ch):
        canvas[i * 4] = 242
        canvas[i * 4 + 1] = 244
        canvas[i * 4 + 2] = 247
        canvas[i * 4 + 3] = 255
    x = pad
    for name in sheets:
        blit(canvas, cw, ch, x, pad, sheets[name][128], 128, 128)
        blit(canvas, cw, ch, x + 48, pad + 128 + 16, sheets[name][32], 32, 32)
        blit(canvas, cw, ch, x, pad + 128 + 16 + 32 + 16,
             nearest(sheets[name][16], 16, 8), 128, 128)
        x += 128 + pad
    write_png(PREVIEW, cw, ch, canvas)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    do_preview = "--preview" in sys.argv
    # 允许 python tools/make_icons.py amber 临时切换方案
    chosen = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in DESIGNS else CHOSEN
    sheets = {}
    for name in DESIGNS:
        buf, n = render_master(DESIGNS[name])
        sheets[name] = {s: downsample(buf, n, s) for s in (16, 32, 48, 128)}
        print("rendered", name)

    if do_preview:
        make_preview(sheets)
        print(PREVIEW)

    for s in (16, 48, 128):
        p = os.path.join(OUT_DIR, "icon%d.png" % s)
        write_png(p, s, s, sheets[chosen][s])
        print(p, "->", chosen)


if __name__ == "__main__":
    main()
