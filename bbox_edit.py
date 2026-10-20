"""
Josia框选编辑（实验包）—— 经典模式（1.0）下的「创建边界框」平替

官方那个 Create Bounding Boxes 只在 2.0 前端能用：它靠的是 V3 schema 的
BOUNDING_BOXES 自定义控件，由 Vue 组件渲染成一块画布。经典 LiteGraph 前端
不认识这个控件类型，只会留一片空白，没法画框。

这里换一条路：框编辑器由本包自己的前端用 DOM 面板 + canvas 实现（经典模式
下完全可控），框数据以 JSON 字符串落进一个隐藏控件交给后端。后端解析后
**原样产出官方那三种数据格式**，所以下游（Flux 3 Image / MOSS-Image Layout
Prompt / Layers 等）照接不误。

三种数据格式与官方 CreateBoundingBoxes 完全一致（源码 comfy_extras/
nodes_bounding_boxes.py）：

  · 编辑器状态  [{x, y, w, h, type, text, desc, palette}]   归一化 0~1 浮点
  · bboxes      [[{x, y, width, height, metadata:{...}}]]   像素整数、双层 list
  · elements    [{type, bbox:[ymin,xmin,ymax,xmax], text, desc, color_palette}]
                bbox 为 0~1000 的整数网格、顺序是 yxyx

坐标语义提醒（官方源码注释）：元素按「背景先、前景后」的顺序排，靠前的框
在渲染里先画、层级更靠后。
"""

import json

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

NODE_CLASS = "JosiaBBoxEdit"
NODE_DISPLAY_NAME = "Josia框选编辑"
NODE_CATEGORY = "⚡️Josia实验区/框选编辑"

# 预览图最长边，跟官方一致：画布再大，预览也不会把节点撑爆
PREVIEW_LONG_EDGE = 1024
# 底图压暗倍数，跟官方一致（官方 _PREVIEW_DIM）
PREVIEW_DIM = 0.25

# 与前端共用的控件名 / 隐藏数据控件名。前端按名字找控件回填，两边必须一致。
WIDTH = "画布宽度"
HEIGHT = "画布高度"
STATE = "框数据"

MAX_DIM = 16384
MIN_DIM = 64


# ============================ 坐标换算（与官方逐行对齐）============================
# 官方把框存成 0~1 的分数，缩放/换画布时不用重算；输出时再乘回像素。
def pixels_to_fractions(box: dict, width: int, height: int) -> dict:
    w = width or 1
    h = height or 1
    return {
        "x": box.get("x", 0) / w,
        "y": box.get("y", 0) / h,
        "w": box.get("width", 0) / w,
        "h": box.get("height", 0) / h,
    }


def fractions_to_pixels(box: dict, width: int, height: int) -> dict:
    x, y = box.get("x", 0.0), box.get("y", 0.0)
    w, h = box.get("w", 0.0), box.get("h", 0.0)
    if w < 0:
        x, w = x + w, -w
    if h < 0:
        y, h = y + h, -h
    return {
        "x": round(x * width),
        "y": round(y * height),
        "width": round(w * width),
        "height": round(h * height),
    }


def fractions_to_bbox_frame(boxes: list, width: int, height: int) -> list:
    """像素框的双层 list（一帧一个 list），官方同名函数的行为。"""
    pixels = [
        fractions_to_pixels(box, width, height)
        for box in boxes
        if isinstance(box, dict)
    ]
    return [pixels] if pixels else []


# ============================ 颜色 ============================
def _hex_to_rgb(value: str):
    """'#rrggbb' / 'rrggbb' → (r, g, b)；认不出来就回一个中性灰，不抛。大小写通吃。"""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)
    if len(text) != 6:
        return (140, 140, 140)
    try:
        return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))
    except (TypeError, ValueError):
        return (140, 140, 140)


def _readable_color(rgb):
    """保证框内文字看得清。

    🔴 官方 color_util.readable_color 不是「深色用白字、浅色用黑字」二选一，
    而是：亮度够就直接用原色，否则把原色朝白色线性插值提亮。所以这里照抄，
    不简化 —— 简化会让预览图与官方差几个像素值。
    """
    r, g, b = rgb
    lum = 0.299 * r + 0.587 * g + 0.114 * b
    if lum >= 130:
        return (r, g, b)
    t = (130 - lum) / (255 - lum)
    return (round(r + (255 - r) * t), round(g + (255 - g) * t), round(b + (255 - b) * t))


def _tag_fill(rgb):
    """序号角标压在**纯色**方块上，要的是能看清的黑/白，与上面那个不是一回事
    （官方 render_preview 里就是写死 0.299/0.587/0.114 > 140 判黑白）。"""
    r, g, b = rgb
    return (0, 0, 0) if (0.299 * r + 0.587 * g + 0.114 * b) > 140 else (255, 255, 255)


def _clean_palette(values) -> list:
    """只做形状清洗，**不动大小写**（官方 boxes_to_regions 就是原样透传 metadata.palette，
    大写转换只发生在 build_elements 里 —— 位置必须对，否则两边输出不一致）。"""
    if not isinstance(values, (list, tuple)):
        return []
    out = []
    for item in values:
        text = str(item or "").strip()
        if not text:
            continue
        if not text.startswith("#"):
            text = "#" + text
        if len(text.lstrip("#")) in (3, 6):
            out.append(text)
    return out


def _normalize_palette(values) -> list:
    """官方 color_util.normalize_palette 的口径：c.upper()，最多 5 个。
    下游可能按字符串比对颜色，大写口径必须和官方一致。"""
    return [c.upper() for c in _clean_palette(values)][:5]


# ============================ 文本换行 ============================
def _font(size: int):
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def _wrap(draw, text: str, font, max_w: float) -> list:
    """按像素宽度折行。官方对中文其实是按空格切的，这里额外补一条
    「一个字也超宽就不换行」的兜底，避免窄框里死循环。"""
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split():
            test = word if not line else line + " " + word
            if line and draw.textlength(test, font=font) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        lines.append(line)
    return lines


# ============================ 解析前端框数据 ============================
def parse_regions(raw: str) -> list:
    """把前端写进来的 JSON 解析成官方那种 region 列表。

    宽容处理：整体非法就当空列表（不因为编辑器里手滑改坏了一个字符就让整次
    执行报错），单个框不合法只丢那一个框，其余照常。
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        data = list(raw)
    else:
        text = str(raw).strip()
        if not text:
            return []
        try:
            data = json.loads(text)
        except (ValueError, TypeError):
            return []
        if isinstance(data, dict):
            data = [data]
    if not isinstance(data, list):
        return []

    regions = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            x = float(item.get("x", 0) or 0)
            y = float(item.get("y", 0) or 0)
            w = float(item.get("w", item.get("width", 0)) or 0)
            h = float(item.get("h", item.get("height", 0)) or 0)
        except (TypeError, ValueError):
            continue
        if w < 0:
            x, w = x + w, -w
        if h < 0:
            y, h = y + h, -h
        if w <= 0 or h <= 0:
            continue
        etype = "text" if item.get("type") == "text" else "obj"
        regions.append({
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "type": etype,
            "text": str(item.get("text", "") or ""),
            "desc": str(item.get("desc", "") or ""),
            "palette": _clean_palette(item.get("palette", [])),
        })
    return regions


# ============================ 元素格式（下游吃的就是它）============================
def _grid(value: float) -> int:
    return max(0, min(1000, round(value * 1000)))


def norm_bbox(region: dict) -> list:
    """→ [ymin, xmin, ymax, xmax]，0~1000 整数网格。官方顺序是 yxyx，别写反。"""
    x, y = region.get("x", 0.0), region.get("y", 0.0)
    w, h = region.get("w", 0.0), region.get("h", 0.0)
    ymin, xmin, ymax, xmax = _grid(y), _grid(x), _grid(y + h), _grid(x + w)
    if ymin > ymax:
        ymin, ymax = ymax, ymin
    if xmin > xmax:
        xmin, xmax = xmax, xmin
    return [ymin, xmin, ymax, xmax]


def build_elements(regions: list) -> list:
    """转成 Ideogram/Flux3/MOSS 那种 layout 元素列表。"""
    elements = []
    for region in regions:
        if not isinstance(region, dict):
            continue
        etype = "text" if region.get("type") == "text" else "obj"
        element = {"type": etype, "bbox": norm_bbox(region)}
        if etype == "text":
            element["text"] = region.get("text", "")
        element["desc"] = region.get("desc", "")
        palette = _normalize_palette(region.get("palette", []))
        if palette:
            element["color_palette"] = palette[:5]
        elements.append(element)
    return elements


def build_bboxes(regions: list, width: int, height: int) -> list:
    """像素框的双层 list（一帧一个 list）。

    🔴 与官方 fractions_to_bbox_frame 完全一致：**不带 metadata**，只有 x/y/width/height。
    想要带描述的版本请用「元素」那路输出。
    """
    frame = []
    for region in regions:
        frame.append(fractions_to_pixels(region, width, height))
    return [frame] if frame else []


# ============================ 预览图 ============================
def _bg_from_image(image):
    if image is None:
        return None
    try:
        arr = (image[0].detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        return Image.fromarray(arr)
    except Exception:
        return None


def render_preview(regions: list, width: int, height: int, bg=None):
    """把框画成一张图。没有底图就画灰底，方便看清框位。"""
    if bg is not None:
        iw, ih = bg.size
        long_edge = max(iw, ih) or 1
        scale = min(1.0, PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(iw * scale)), max(1, round(ih * scale))
        base = bg.convert("RGB").resize((rw, rh), Image.LANCZOS)
        base = ImageEnhance.Brightness(base).enhance(PREVIEW_DIM)
        img = base.convert("RGBA")
    else:
        long_edge = max(width, height) or 1
        scale = min(1.0, PREVIEW_LONG_EDGE / long_edge)
        rw, rh = max(1, round(width * scale)), max(1, round(height * scale))
        grey = round(PREVIEW_DIM * 128)
        img = Image.new("RGBA", (rw, rh), (grey, grey, grey, 255))

    overlay = Image.new("RGBA", (rw, rh), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fs = max(10, round(rh / 64))
    font = _font(fs)
    tag_font = _font(max(9, fs - 2))
    line_h = fs + 2

    for i, region in enumerate(regions):
        if not isinstance(region, dict):
            continue
        palette = [c for c in (region.get("palette") or []) if c]
        r, g, b = _hex_to_rgb(palette[0]) if palette else (140, 140, 140)
        x1 = max(0, min(rw, round(region.get("x", 0) * rw)))
        y1 = max(0, min(rh, round(region.get("y", 0) * rh)))
        x2 = max(0, min(rw, round((region.get("x", 0) + region.get("w", 0)) * rw)))
        y2 = max(0, min(rh, round((region.get("y", 0) + region.get("h", 0)) * rh)))
        if x2 < x1:
            x1, x2 = x2, x1
        if y2 < y1:
            y1, y2 = y2, y1

        draw.rectangle([x1, y1, x2, y2], outline=(r, g, b, 255), width=2)

        swatches = palette[:5]
        if swatches and (x2 - x1) > 2:
            sh = max(5, fs // 2)
            seg = (x2 - x1) / len(swatches)
            for p, hexc in enumerate(swatches):
                sx = x1 + round(p * seg)
                draw.rectangle([sx, y1, x1 + round((p + 1) * seg), y1 + sh], fill=_hex_to_rgb(hexc))

        tag = str(i + 1).zfill(2)
        tw = draw.textlength(tag, font=tag_font)
        draw.rectangle([x1, y1, x1 + tw + 6, y1 + fs + 2], fill=(r, g, b, 255))
        draw.text((x1 + 3, y1 + 1), tag, fill=_tag_fill((r, g, b)) + (255,), font=tag_font)

        body = region.get("desc", "") or ""
        if region.get("type") == "text" and region.get("text"):
            body = '"%s"%s' % (region["text"], " — " + body if body else "")
        if body and (x2 - x1) > 8:
            ty = y1 + fs + 5
            for line in _wrap(draw, body, font, x2 - x1 - 8):
                if ty > y2:
                    break
                draw.text((x1 + 4, ty), line, fill=_readable_color((r, g, b)) + (255,), font=font)
                ty += line_h

    composed = Image.alpha_composite(img, overlay).convert("RGB")
    arr = np.asarray(composed, dtype=np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _dims(value, fallback: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(MIN_DIM, min(MAX_DIM, v))


class JosiaBBoxEdit:
    """经典模式下的边界框编辑器。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                WIDTH: ("INT", {"default": 1024, "min": MIN_DIM, "max": MAX_DIM, "step": 16}),
                HEIGHT: ("INT", {"default": 1024, "min": MIN_DIM, "max": MAX_DIM, "step": 16}),
                # 前端把框数据写成 JSON 存这里。隐藏控件，但仍然是执行必需项，
                # 这样每次执行都会把当前编辑结果带进后端，不需要额外缓存机制。
                STATE: ("STRING", {"default": "[]", "multiline": True}),
            },
            "optional": {
                "底图": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "BOUNDING_BOXES", "ARRAY", "STRING")
    RETURN_NAMES = ("预览图", "边界框", "元素", "元素JSON")
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = NODE_CATEGORY

    def run(self, 画布宽度=1024, 画布高度=1024, 框数据="[]", 底图=None):
        width = _dims(画布宽度, 1024)
        height = _dims(画布高度, 1024)
        regions = parse_regions(框数据)

        preview = render_preview(regions, width, height, _bg_from_image(底图))
        elements = build_elements(regions)

        ui = {"dims": [width, height], "regions": regions}
        # 经典模式（1.0 前端）不会把「输出节点返回的 IMAGE 输出」自动显示成缩略图——
        # 那是 2.0 前端才有的能力。这里照官方节点给 background 存图的同一手法，
        # 把预览图转成临时图塞进 ui.images，经典前端才会在节点上显示缩略图。
        # lazy import + try 兜底：缩略图存失败也绝不影响框数据产出。
        try:
            import nodes
            ui["images"] = nodes.PreviewImage().save_images(preview, "comfy.bboxes.preview")["ui"]["images"]
        except Exception:
            pass
        return {
            "ui": ui,
            "result": (preview, build_bboxes(regions, width, height), elements, json.dumps(elements, ensure_ascii=False)),
        }
