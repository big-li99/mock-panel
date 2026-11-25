#!/usr/bin/env python3
"""生成 MockPanel 扩展图标（纯标准库，无需 Pillow）。

图案：靛蓝到青绿渐变圆角方块 + 白色侧边栏与双向替换符号。
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

BG_TOP = (79, 70, 229)     # #4f46e5 靛蓝
BG_BOTTOM = (13, 148, 136) # #0d9488 青绿
FG = (255, 255, 255)

SS = 4  # 超采样倍数


def in_rounded_rect(x, y, r, x0=0.0, y0=0.0, x1=1.0, y1=1.0):
    """点 (x, y) 是否落在 [x0, x1] × [y0, y1]、圆角半径 r 的矩形内。"""
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def in_rect(x, y, x0, y0, x1, y1):
    return x0 <= x <= x1 and y0 <= y <= y1


def in_tri(px, py, a, b, c):
    """点是否在三角形 abc 内（重心法）。"""
    def sign(p1, p2, p3):
        return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1])

    d1 = sign((px, py), a, b)
    d2 = sign((px, py), b, c)
    d3 = sign((px, py), c, a)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def fg(x, y):
    """白色前景：左侧双箭头 + 右侧侧边栏面板条。"""
    # 外框轮廓（圆角面板边框）
    in_outer = in_rounded_rect(x, y, 0.10, 0.14, 0.18, 0.86, 0.82)
    in_inner = in_rounded_rect(x, y, 0.05, 0.21, 0.25, 0.79, 0.75)
    if in_outer and not in_inner:
        return True

    # 右侧侧边栏实体块
    if in_rounded_rect(x, y, 0.03, 0.59, 0.27, 0.76, 0.73):
        return True

    # 左侧居中向右 Mock 箭头（上下两道符号化替换）
    if in_rect(x, y, 0.25, 0.36, 0.44, 0.44):
        return True
    if in_tri(x, y, (0.54, 0.40), (0.42, 0.30), (0.42, 0.50)):
        return True

    if in_rect(x, y, 0.35, 0.56, 0.54, 0.64):
        return True
    if in_tri(x, y, (0.25, 0.60), (0.37, 0.50), (0.37, 0.70)):
        return True

    return False


def render(size):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg_hits = 0
            fg_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if not in_rounded_rect(x, y, 0.22):
                        continue
                    bg_hits += 1
                    if fg(x, y):
                        fg_hits += 1
            total = SS * SS
            if bg_hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            y = (py + 0.5) / size
            br = round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * y)
            bg_ = round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * y)
            bb = round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * y)
            f = fg_hits / total
            r = round(br + (FG[0] - br) * f)
            g = round(bg_ + (FG[1] - bg_) * f)
            b = round(bb + (FG[2] - bb) * f)
            a = round(255 * bg_hits / total)
            row += bytes((r, g, b, a))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)
    return png_bytes(size, size, raw)


def png_bytes(w, h, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        with open(path, "wb") as fh:
            fh.write(render(size))
        print("wrote", path)


if __name__ == "__main__":
    main()
