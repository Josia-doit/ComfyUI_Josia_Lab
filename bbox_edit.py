"""
Josia框选编辑（实验包）—— 经典模式（1.0）下的「创建边界框」平替

官方那个 Create Bounding Boxes 只在 2.0 前端能用：它靠的是 V3 schema 的
BOUNDING_BOXES 自定义控件，由 Vue 组件渲染成一块画布。经典 LiteGraph 前端
不认识这个控件类型，只会留一片空白，没法画框。

这里换一条路：框编辑器由本包自己的前端**内嵌在节点面板里**实现（DOM + canvas，
经典模式下完全可控），框数据以 JSON 字符串落进一个隐藏控件交给后端。后端解析后
**原样产出官方那三种数据格式**，所以下游（Flux 3 Image / MOSS-Image Layout
Prompt / Layers 等）照接不误。

三种数据格式与官方 CreateBoundingBoxes 完全一致（源码 comfy_extras/
nodes_bounding_boxes.py）：

  · 编辑器状态  [{x, y, w, h, type, text, desc, palette}]   归一化 0~1 浮点
  · bboxes      [[{x, y, width, height, metadata:{...}}]]   像素整数、双层 list
  · elements    [{type, bbox:[ymin,xmin,ymax,xmax], text, desc, color_palette}]
                bbox 为 0~1000 的整数网格、顺序是 yxyx

「提示词」输出 ＝「整体描述」控件 + 各框描述，按官方 MOSS-Image Layout Prompt
同款结构打包（源码 comfy_extras/nodes_moss_image.py）：

  {"summary":{"caption":总体描述},
   "items":[{"label":"object"|"text","caption":描述[,"text":文字][,"palette":[色]],
             "bbox":[y_min,x_min,y_max,x_max]}],
   "bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}

bbox 是相对画布中心的像素边（与官方逐行同式的 floor/ceil + 中心原点换算）；
没有任何框时退化为纯「整体描述」文本（官方同款行为）。

「边界框」输入端口（BOUNDING_BOXES，类型同官方 CreateBoundingBoxes 的 bboxes
输出）用于反向灌数：接上游的框，编辑器为空时自动按画布尺寸归一化后落进编辑器。

坐标语义提醒（官方源码注释）：元素按「背景先、前景后」的顺序排，靠前的框
在渲染里先画、层级更靠后。
"""

import json
import math
import os

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageEnhance, ImageFont

try:
    import folder_paths
except ImportError:      # 脱离 ComfyUI 环境做单测时兜底
    folder_paths = None

NODE_CLASS = "JosiaBBoxEdit"
NODE_DISPLAY_NAME = "Josia框选编辑"
NODE_CATEGORY = "⚡️Josia实验区/框选编辑"

# 底图压暗倍数，跟官方一致（官方 _PREVIEW_DIM）
PREVIEW_DIM = 0.25

# 与前端共用的控件名 / 隐藏数据控件名。前端按名字找控件回填，两边必须一致。
WIDTH = "画布宽度"
HEIGHT = "画布高度"
STATE = "框数据"
PROMPT = "整体描述"
BBOX_INPUT = "边界框"

MAX_DIM = 16384
MIN_DIM = 64

# 「选择图像」控件的空选项与判定集合：选中它们 ＝ 无图像来源，画布走面板分辨率
IMAGE_PLACEHOLDER = "🖼️请选择或上传图像…"
_EMPTY_IMAGE_VALUES = ("", IMAGE_PLACEHOLDER)


def _input_image_choices() -> list:
    """「选择图像」下拉候选：input 目录里的图像文件（含子目录），空选项恒在首位。

    🔴 必须**递归**子目录 + 用 `filter_files_content_types` 过滤：
    这版 ComfyUI 的 `folder_paths.get_filename_list("input")` 会抛 `KeyError: 'input'`
    （"input" 不再是注册的 folder type），直接退化成只剩占位符。照搬主包图像编码的
    `os.walk + filter_files_content_types` 写法，既能列到 input 全量图像、又避免 2.0
    资产体系重构后的 KeyError。候选用相对 input 的路径（正斜杠），与
    `get_annotated_filepath` / 原生 LoadImage 口径一致。
    """
    choices = [IMAGE_PLACEHOLDER]
    if folder_paths is None:
        return choices
    try:
        input_dir = folder_paths.get_input_directory()
        files = []
        for root, _dirs, names in os.walk(input_dir):
            for n in names:
                rel = os.path.relpath(os.path.join(root, n), input_dir)
                files.append(rel.replace("\\", "/"))
        files = folder_paths.filter_files_content_types(files, ["image"])
        choices += sorted(files, key=str.lower)
    except Exception:
        pass
    return choices


def _load_bg_file(name: str):
    """按「选择图像」的值加载 input 目录图像，返回 PIL RGB 图；取不到就返回 None。"""
    if folder_paths is None:
        return None
    try:
        path = folder_paths.get_annotated_filepath(name)
        if not path or not os.path.isfile(path):
            return None
        with Image.open(path) as im:
            return im.convert("RGB")
    except Exception:
        return None


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


# ============================ 「边界框」输入端口：反向灌数 ============================
def seed_regions_from_bboxes(bboxes, width: int, height: int) -> list:
    """BOUNDING_BOXES 端口的值 → 编辑器 regions（0~1 分数）。

    端口数据是**源节点的像素空间**（{x, y, width, height}，单帧外层再包一层
    list，与官方 fractions_to_bbox_frame 输出一致），按本节点画布尺寸归一化。
    源节点分辨率不同时会整体缩放——像素端口不携带尺寸信息，这是该格式的固有
    口径（KJNodes 的 MossImagePromptBuilderKJ 同款处理）。
    单 dict（裸一个框）也认。灌入的框不带文字/描述/颜色（端口里没有）。
    """
    if isinstance(bboxes, dict):
        frame = [bboxes]                                   # 裸单个框
    elif isinstance(bboxes, (list, tuple)) and bboxes and isinstance(bboxes[0], (list, tuple)):
        frame = bboxes[0]                                  # 双层 list：取第一帧
    elif isinstance(bboxes, (list, tuple)):
        frame = bboxes                                     # 已经是平铺单层
    else:
        return []
    w = width or 1
    h = height or 1
    out = []
    for bb in frame:
        if not isinstance(bb, dict):
            continue
        try:
            x = float(bb.get("x", 0) or 0) / w
            y = float(bb.get("y", 0) or 0) / h
            bw = float(bb.get("width", 0) or 0) / w
            bh = float(bb.get("height", 0) or 0) / h
        except (TypeError, ValueError):
            continue
        if bw <= 0 or bh <= 0:
            continue
        out.append({"x": x, "y": y, "w": bw, "h": bh,
                    "type": "obj", "text": "", "desc": "", "palette": []})
    return out


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


# ============================ 布局提示词（MOSS-Image Layout Prompt 同款）============================
def build_layout_prompt(prompt: str, elements: list, width: int, height: int) -> str:
    """「整体描述」+ 元素列表 ⇒ 布局提示词字符串。

    结构与官方 MOSSImageLayoutPrompt.execute 逐行对齐（源码 comfy_extras/
    nodes_moss_image.py）：

      {"summary":{"caption":总体描述},
       "items":[{"label":"object"|"text","caption":框描述[,"text":渲染文字][,"palette":[色]],
                 "bbox":[y_min,x_min,y_max,x_max]}],
       "bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}

    bbox 由 0~1000 网格换算成**相对画布中心的像素边**（官方同款 floor/ceil +
    减半宽/半高）；label 只有 object / text 两种（官方还支持 character，那需要
    character_boxes 序号输入，本节点没有，物体的框一律 object）。
    没有任何元素 ⇒ 退化为纯「整体描述」文本（官方同款）。
    """
    items = []
    for el in elements:
        if not isinstance(el, dict):
            continue
        label = "text" if el.get("type") == "text" else "object"
        item = {"label": label, "caption": el.get("desc", "") or ""}
        if label == "text":
            item["text"] = el.get("text", "") or ""
        if el.get("color_palette"):
            item["palette"] = el["color_palette"]
        y0, x0, y1, x1 = el["bbox"]
        item["bbox"] = [
            math.floor(round(y0 * height / 1000, 9)) - height // 2,
            math.floor(round(x0 * width / 1000, 9)) - width // 2,
            math.ceil(round(y1 * height / 1000, 9)) - height // 2,
            math.ceil(round(x1 * width / 1000, 9)) - width // 2,
        ]
        items.append(item)
    if not items:
        return prompt
    layout = {"summary": {"caption": prompt.strip()}, "items": items,
              "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    return json.dumps(layout, ensure_ascii=False, separators=(",", ":"))


def parse_layout_prompt(text: str, width: int, height: int) -> dict | None:
    """「布局导入」端口的反向解析：把一段布局提示词还原成 {caption, regions}。

    支持两种输入：
      · 本节点 / MOSS 产出的 JSON（{summary:{caption}, items:[{label,caption,
        text?,palette?,bbox:[y_min,x_min,y_max,x_max 0~1000 abs_centralized]}]}）；
      · 任意纯文本（非 JSON）⇒ 整段当作整体描述，清空框。

    坐标逆换算与 build_layout_prompt 严格互逆：grid = (abs_centered + dim//2)/dim*1000。
    返回 None 表示「空输入，不导入」（调用方据此跳过覆盖，原编辑器内容不动）。
    """
    text = (text or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        # 非 JSON：整段当整体描述，无框
        return {"caption": text, "regions": []}
    if not isinstance(data, dict):
        return None

    caption = ""
    if isinstance(data.get("summary"), dict):
        caption = str(data["summary"].get("caption", "") or "")
    elif "caption" in data:
        caption = str(data.get("caption") or "")
    caption = caption.strip()

    regions = []
    items = data.get("items")
    if not isinstance(items, list):
        items = []
    w = max(1, int(width))
    h = max(1, int(height))
    for it in items:
        if not isinstance(it, dict):
            continue
        bbox = it.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        try:
            ay0, ax0, ay1, ax1 = (float(v) for v in bbox)   # abs_centralized 像素，yxyx
        except (TypeError, ValueError):
            continue
        # 逆换算：grid = (abs_centered + dim//2) / dim * 1000
        y0 = (ay0 + h // 2) / h * 1000.0
        x0 = (ax0 + w // 2) / w * 1000.0
        y1 = (ay1 + h // 2) / h * 1000.0
        x1 = (ax1 + w // 2) / w * 1000.0
        x = x0 / 1000.0
        y = y0 / 1000.0
        bw = (x1 - x0) / 1000.0
        bh = (y1 - y0) / 1000.0
        if bw <= 0 or bh <= 0:
            continue
        etype = "text" if (it.get("label") == "text" or it.get("type") == "text") else "obj"
        regions.append({
            "x": min(x, x + bw), "y": min(y, y + bh),
            "w": abs(bw), "h": abs(bh),
            "type": etype,
            "text": str(it.get("text", "") or ""),
            "desc": str(it.get("caption", "") or ""),
            "palette": _clean_palette(it.get("palette", [])),
        })
    return {"caption": caption, "regions": regions}


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
    """把框画成一张图。没有底图就画灰底，方便看清框位。

    🔴 **始终按原始分辨率出图**：有底图＝底图尺寸，无底图＝面板分辨率。
    早期为「节点体预览不撑爆节点」压过预览长边（≤1024），但节点体底部预览
    （ui.images）早已移除，预览图端口的消费者是下游图像链路（获取图像信息 /
    布局提示词等）——压过分辩率会让像素坐标与实际画布对不上，故不再缩放。
    """
    if bg is not None:
        rw, rh = bg.size
        base = bg.convert("RGB")
        base = ImageEnhance.Brightness(base).enhance(PREVIEW_DIM)
        img = base.convert("RGBA")
    else:
        rw, rh = max(1, int(width)), max(1, int(height))
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
                # 整张图的总体描述：与 MOSS-Image Layout Prompt 的 prompt 控件同款
                # （多行文本框，排在本节点最顶部）。它与各框的描述一起被打包进
                # 「提示词」输出端口；没有任何框时「提示词」就是这段纯文本。
                PROMPT: ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "用一两句话描述整张图的整体画面、主体与构图，\n"
                               "例如：清晨的森林里一只鹿站在溪边。\n"
                               "留空时「提示词」端口只汇总各框的描述。",
                }),
                # 面板分辨率：只在**没有图像来源**时用来当画布尺寸（画框的坐标网格）；
                # 一旦有图像（上传或接上游），画布与坐标全部按图像尺寸走，这两项在前端灰化。
                WIDTH: ("INT", {"default": 1024, "min": MIN_DIM, "max": MAX_DIM, "step": 16}),
                HEIGHT: ("INT", {"default": 1024, "min": MIN_DIM, "max": MAX_DIM, "step": 16}),
                # 前端把框数据写成 JSON 存这里。隐藏控件，但仍然是执行必需项，
                # 这样每次执行都会把当前编辑结果带进后端，不需要额外缓存机制。
                STATE: ("STRING", {"default": "[]", "multiline": True}),
                # 「选择图像」：input 目录图像下拉（原生 image_upload ＝ 控件右侧的
                # 「点击上传图像」按钮，与图像编码节点同款样式）。上传后文件名自动进本下拉。
                # 空选项 ＝ 无图像来源；「底图」端口接线时前端会把本项灰化（端口优先）。
                "image": (_input_image_choices(), {
                    "default": IMAGE_PLACEHOLDER,
                    "image_upload": True,
                    "tooltip": "从 input 目录选一张图当画布底图，或点控件右侧的上传按钮传图。\n"
                               "有图像时：画布与坐标按图像尺寸走，上方分辨率自动灰化。\n"
                               "「底图」端口接线时本项自动灰化 —— 端口优先。",
                }),
            },
            "optional": {
                "底图": ("IMAGE", {"tooltip": "接上游图像当画布底图：实时显示上游预览，画布与坐标按图像尺寸走。"}),
                # 类型与官方「创建边界框」的 bboxes 输出端口一致（BOUNDING_BOXES，
                # 像素 {x,y,width,height} 双层 list）。接上后：编辑器为空时按画布
                # 尺寸归一化自动灌入（执行时生效）；编辑器已有框时不动，用户画的框优先。
                # 🔴 forceInput：该类型在前端有控件构造器，不加这个会多渲染一行空白
                #    控件占位（KJNodes 同款端口同样带它）。
                BBOX_INPUT: ("BOUNDING_BOXES", {
                    "forceInput": True,
                    "tooltip": "接「创建边界框」等节点的边界框输出。\n"
                               "编辑器为空时：执行后自动按画布尺寸灌入这些框。\n"
                               "编辑器已有框时：不灌入，手画的框优先。",
                }),
                # 「布局导入」：把一段布局提示词还原进本节点（整体描述 + 框选内容）。
                # 🔴 forceInput ⇒ 只以**输入端口**形态存在，节点上不再渲染文本框。
                #    这样没有上游接线就完全不会触发导入，不存在「上次粘的文本没清、
                #    被当成导入源把当前布局冲掉、还把无意义内容传下游」的隐患。
                #    需要复用时从上游（如读文本的节点 / 之前导出的提示词）接进来即可。
                "布局导入": ("STRING", {
                    "forceInput": True,
                    "tooltip": "接上游一段布局提示词，还原进本节点：整体描述填进文本框，各框自动生成。\n"
                               "支持本节点「提示词」端口导出的 JSON，也支持 MOSS 同款布局 JSON；\n"
                               "纯文本则整段当整体描述并清空各框。\n"
                               "执行（点节点播放）后生效，回填编辑器；不接线则不导入、不动现有内容。",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "BOUNDING_BOXES", "ARRAY")
    RETURN_NAMES = ("提示词", "预览图", "边界框", "元素")
    OUTPUT_NODE = True
    FUNCTION = "run"
    CATEGORY = NODE_CATEGORY

    def run(self, 整体描述="", 画布宽度=1024, 画布高度=1024, 框数据="[]",
            image=IMAGE_PLACEHOLDER, 底图=None, 边界框=None, 布局导入=""):
        # 底图来源二选一，端口优先：①「底图」端口（上游图像 tensor）②「选择图像」文件。
        # 有底图 ⇒ 画布与坐标一律按底图尺寸走（面板分辨率自动失效）；都没有 ⇒ 面板分辨率。
        bg = _bg_from_image(底图)
        if bg is None and str(image or "").strip() not in _EMPTY_IMAGE_VALUES:
            bg = _load_bg_file(image)
        if bg is not None:
            width, height = bg.size
        else:
            width = _dims(画布宽度, 1024)
            height = _dims(画布高度, 1024)
        regions = parse_regions(框数据)

        # 「边界框」端口灌数：仅当编辑器为空（没有手画的框）时按画布尺寸归一化落进
        # 编辑器，同时经 ui.boxes 通知前端把框显示出来（前端落盘后下次执行就有框了）。
        # 用户手画的框永远优先——端口只在空编辑器时说话（与 KJNodes 同款语义）。
        seeded = False
        if not regions and 边界框:
            regions = seed_regions_from_bboxes(边界框, width, height)
            seeded = bool(regions)

        # 「布局导入」：非空 ⇒ 覆盖整体描述 + 各框，把提示词里的布局一键回填编辑器
        # （经 ui.layout 通知前端；前端落盘后下次执行就以回填内容为准，不再依赖此端口）。
        imported = None
        if str(布局导入 or "").strip():
            imported = parse_layout_prompt(str(布局导入), width, height)
        if imported is not None:
            整体描述 = imported["caption"]
            regions = imported["regions"]

        preview = render_preview(regions, width, height, bg)
        elements = build_elements(regions)
        prompt = build_layout_prompt(str(整体描述 or ""), elements, width, height)

        # 预览图只在内嵌画布（节点面板里的编辑器）实时显示，不在节点底部再渲染一张
        # 冗余缩略图（那张图与画布内容重复、且极易被误认成「上传后多出的无用预览」）。
        # 下游仍可正常接「预览图」输出端口：这里只去掉 ui.images 的节点体预览，不动 result。
        ui = {"dims": [width, height], "regions": regions}
        if seeded:
            # 通知前端把灌入的框落进编辑器（值为编辑器状态 JSON 的字符串数组）
            ui["boxes"] = [json.dumps(regions, ensure_ascii=False)]
        if imported is not None:
            # 通知前端把导入的布局回填编辑器（整体描述 + 各框）
            # 🔴 ui 的值必须是**数组**：ComfyUI 在 get_output_from_returns 里把每个 ui 值
            #    当条目列表重新拼一遍（{k:[y for x in uis for y in x[k]]}），裸字符串会被
            #    逐字符拆成字符数组（实测 156 长度），前端拿到的就不是 JSON 了。与 boxes 同规。
            ui["layout"] = [json.dumps(
                {"caption": imported["caption"], "regions": regions}, ensure_ascii=False)]
        return {
            "ui": ui,
            "result": (prompt, preview, build_bboxes(regions, width, height), elements),
        }
