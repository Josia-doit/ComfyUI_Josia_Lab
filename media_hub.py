"""
Josia媒体中枢 + 媒体枢纽（实验包）—— 一根总线 + 一块接线板

一、媒体中枢（JosiaMediaHub）
--------------------------------------------------
多路图片/视频/音频统一加载。前端内嵌资产面板（点击/拖拽上传、缩略图/视频小窗/
音频波形预览、悬停操作栏、单路绕过）。但**不再输出几十个端口** —— 只输出一根
「媒体总线」(JMEH_BUNDLE)，内部结构：

    [ {"images": n_img, "videos": n_vid, "audios": n_aud},   # 元信息：先报路数
      img_1, ..., img_n, vid_1, ..., vid_m, aud_1, ..., aud_k,  # 再按序给媒体
      None, None, ... ]                                       # 补齐到定长

定长 = 1 + MAX_IMAGES + MAX_VIDEOS + MAX_AUDIOS。空位/禁用位/加载失败位都是 None。
路数由配置决定，媒体按 图→视→音 顺序排列，位置编号稳定不错位。

二、媒体枢纽（JosiaMediaSwitchboard）—— 接线板
--------------------------------------------------
单输入「媒体总线」（与中枢输出端口同名），一个开关「端口常驻」（默认开启）：

· 关（端口常驻=False）：只按**实际收到的有效媒体数**紧凑生成输出端口（跳过空位/禁用位）
· 开（端口常驻=True）：按**上游配置的路数**生成端口（空位也占一个端口，输出 None）

输出端口顺序恒为 图片 → 视频 → 音频，与媒体所在位置一一对应。

三、媒体类型
--------------------------------------------------
· IMAGE : torch.Tensor [1,H,W,3]，0~1，pil2tensor 与官方 LoadImage 同式
· VIDEO : comfy_api 的 InputImpl.VideoFromFile（惰性包装路径，不立即解码）
· AUDIO : {"waveform": torch.Tensor [1,C,T], "sample_rate": int}

四、数据契约（前后端唯一真值）
--------------------------------------------------
隐藏控件 media_data (JSON)：
    {"images":[{"path":"a.png","disabled":false}, null, ...], "videos":[...], "audios":[...]}
前端 DOM 面板 serialize:false，路数由隐藏 INT widget 承载（自绘 ± 按钮驱动），
路数变化只改 widget 值 + 渲染前 N 张卡；state 保留满额(MAX)。
"""

import json
import os

import numpy as np
import torch
from PIL import Image, ImageFile, ImageOps
import folder_paths

try:
    from comfy_api.latest import InputImpl as _ComfyInputImpl
    _HAS_VIDEO_API = True
except Exception:  # pragma: no cover - 老版本 ComfyUI
    _ComfyInputImpl = None
    _HAS_VIDEO_API = False

try:
    from comfy_extras.nodes_audio import load as _official_audio_load
except Exception:  # pragma: no cover
    _official_audio_load = None

try:
    import av
except Exception:  # pragma: no cover
    av = None


# ─────────────────────────────────────────── 常量
MAX_IMAGES = 24
MAX_VIDEOS = 6
MAX_AUDIOS = 6
BUNDLE_LEN = 1 + MAX_IMAGES + MAX_VIDEOS + MAX_AUDIOS
BUNDLE_TYPE = "JMEH_BUNDLE"

GROUPS = ("images", "videos", "audios")
GROUP_MAX = {"images": MAX_IMAGES, "videos": MAX_VIDEOS, "audios": MAX_AUDIOS}
GROUP_TYPE = {"images": "IMAGE", "videos": "VIDEO", "audios": "AUDIO"}
GROUP_CN = {"images": "图片", "videos": "视频", "audios": "音频"}


def _log(msg):
    print("[JosiaMediaHub] " + str(msg))


# ─────────────────────────────────────────── 工具函数

def _resolve_path(rel):
    """前端传来的相对名 → input 目录绝对路径；绝对路径仅在其存在时接受。"""
    if not rel:
        return None
    rel = str(rel).strip().replace("\\", "/")
    if not rel:
        return None
    if os.path.isabs(rel):
        return rel if os.path.isfile(rel) else None
    try:
        return folder_paths.get_annotated_filepath(rel)
    except Exception:
        cand = os.path.join(folder_paths.get_input_directory(), rel)
        return cand if os.path.isfile(cand) else None


def _safe_pil_open(path):
    try:
        return Image.open(path)
    except (OSError, Image.DecompressionBombError, ValueError):
        prev = ImageFile.LOAD_TRUNCATED_IMAGES
        ImageFile.LOAD_TRUNCATED_IMAGES = True
        try:
            return Image.open(path)
        finally:
            ImageFile.LOAD_TRUNCATED_IMAGES = prev


def _pil2tensor(img):
    """PIL Image → ComfyUI IMAGE tensor (BHWC, 0~1)，与官方 LoadImage 同式。"""
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _load_video(path):
    if not _HAS_VIDEO_API:
        _log("当前 ComfyUI 缺少 comfy_api.latest，视频路不可用：" + str(path))
        return None
    if not os.path.isfile(path):
        return None
    try:
        return _ComfyInputImpl.VideoFromFile(path)
    except Exception as e:
        _log("视频构造失败：" + str(path) + " (" + str(e) + ")")
        return None


def _load_audio(path):
    if not os.path.isfile(path):
        return None
    if _official_audio_load is not None:
        try:
            waveform, sr = _official_audio_load(path)
            return {"waveform": waveform.unsqueeze(0), "sample_rate": int(sr)}
        except Exception as e:
            _log("音频解码失败：" + str(path) + " (" + str(e) + ")")
    if av is not None:
        try:
            with av.open(path) as af:
                if not af.streams.audio:
                    return None
                stream = af.streams.audio[0]
                sr = stream.codec_context.sample_rate
                ch = stream.channels
                frames = []
                for frame in af.decode(streams=stream.index):
                    buf = torch.from_numpy(frame.to_ndarray())
                    if buf.shape[0] != ch:
                        buf = buf.view(-1, ch).t()
                    frames.append(buf)
                if not frames:
                    return None
                wav = torch.cat(frames, dim=1).float()
                return {"waveform": wav.unsqueeze(0), "sample_rate": int(sr)}
        except Exception as e:
            _log("音频 PyAV 解码失败：" + str(path) + " (" + str(e) + ")")
    return None


def _parse_entries(raw, limit):
    out = []
    for i in range(limit):
        item = raw[i] if isinstance(raw, list) and i < len(raw) else None
        if not isinstance(item, dict):
            out.append((None, False))
            continue
        path = str(item.get("path") or "").strip()
        disabled = bool(item.get("disabled", False))
        out.append((path or None, disabled))
    return out


def _as_int(v, default):
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return default


def _counts_from_kwargs(kwargs):
    return {
        "images": min(MAX_IMAGES, _as_int(kwargs.get("图片路数", 9), 9)),
        "videos": min(MAX_VIDEOS, _as_int(kwargs.get("视频路数", 3), 3)),
        "audios": min(MAX_AUDIOS, _as_int(kwargs.get("音频路数", 3), 3)),
    }


# ═══════════════════════════════════════════ 节点一：媒体中枢

class JosiaMediaHub:
    """多路媒体统一加载 → 一根媒体总线。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # 这三个 INT 由前端自绘 ± 按钮驱动（widget 本体隐藏），后端据此定路数
                "图片路数": ("INT", {
                    "default": 9, "min": 0, "max": MAX_IMAGES, "step": 1,
                    "display_name": "图片路数",
                    "tooltip": "图片输出数量，默认 9。用面板上的 ± 按钮调整。",
                }),
                "视频路数": ("INT", {
                    "default": 3, "min": 0, "max": MAX_VIDEOS, "step": 1,
                    "display_name": "视频路数",
                    "tooltip": "视频输出数量，默认 3。用面板上的 ± 按钮调整。",
                }),
                "音频路数": ("INT", {
                    "default": 3, "min": 0, "max": MAX_AUDIOS, "step": 1,
                    "display_name": "音频路数",
                    "tooltip": "音频输出数量，默认 3。用面板上的 ± 按钮调整。",
                }),
            },
            "optional": {
                "media_data": ("STRING", {
                    "default": "{}",
                    "multiline": True,
                    "display_name": "媒体数据",
                    "tooltip": "前端资产面板的内部数据，不用手动改。",
                }),
            },
        }

    RETURN_TYPES = (BUNDLE_TYPE,)
    RETURN_NAMES = ("媒体总线",)
    FUNCTION = "load"
    CATEGORY = "⚡️Josia实验区"
    DESCRIPTION = (
        "一个节点加载多路图片/视频/音频，只输出一根「媒体总线」。前端资产面板支持点击或"
        "拖拽上传、缩略图/视频/波形预览、悬停更换/关闭/预览、单路点击绕过。路数用面板上的"
        "± 按钮调整。总线先给路数信息再按 图→视→音 顺序给媒体数据，空位/禁用位输出 None。"
        "接「媒体枢纽」即可把总线拆成独立媒体端口，节省节点布局空间。"
    )

    def load(self, **kwargs):
        counts = _counts_from_kwargs(kwargs)
        raw = kwargs.get("media_data") or "{}"
        try:
            data = json.loads(raw) if isinstance(raw, str) else (raw or {})
        except Exception:
            data = {}
        if not isinstance(data, dict):
            data = {}

        bundle = [dict(counts)]

        for group in GROUPS:
            entries = _parse_entries(data.get(group), counts[group])
            for path, disabled in entries:
                if disabled or not path:
                    bundle.append(None)
                    continue
                resolved = _resolve_path(path)
                if not resolved:
                    bundle.append(None)
                    continue
                try:
                    if group == "images":
                        bundle.append(_pil2tensor(_safe_pil_open(resolved)))
                    elif group == "videos":
                        bundle.append(_load_video(resolved))
                    else:
                        bundle.append(_load_audio(resolved))
                except Exception as e:
                    _log(group + " 加载失败：" + str(path) + " (" + str(e) + ")")
                    bundle.append(None)

        while len(bundle) < BUNDLE_LEN:
            bundle.append(None)
        return (bundle[:BUNDLE_LEN],)


# ═══════════════════════════════════════════ 节点二：媒体枢纽（接线板）

class JosiaMediaSwitchboard:
    """把媒体总线拆成独立媒体端口；一个开关决定按实际媒体数还是按配置数生成。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "媒体总线": (BUNDLE_TYPE, {
                    "tooltip": "接「Josia媒体中枢」的媒体总线输出。",
                }),
            },
            "optional": {
                "端口常驻": ("BOOLEAN", {
                    "default": True,
                    "display_name": "端口常驻",
                    "tooltip": "开：按上游配置的媒体数量生成端口（未加载也占位）；"
                               "关：只按实际接收到的媒体数量生成端口。",
                }),
            },
        }

    RETURN_TYPES = (("IMAGE",) * MAX_IMAGES
                    + ("VIDEO",) * MAX_VIDEOS
                    + ("AUDIO",) * MAX_AUDIOS)
    RETURN_NAMES = (tuple(GROUP_TYPE["images"] + "_" + str(i + 1) for i in range(MAX_IMAGES))
                    + tuple(GROUP_TYPE["videos"] + "_" + str(i + 1) for i in range(MAX_VIDEOS))
                    + tuple(GROUP_TYPE["audios"] + "_" + str(i + 1) for i in range(MAX_AUDIOS)))
    FUNCTION = "route"
    CATEGORY = "⚡️Josia实验区"
    DESCRIPTION = (
        "媒体总线接线板：把「媒体中枢」的一根总线拆成独立 IMAGE/VIDEO/AUDIO 端口，"
        "省去主节点上一大排端口。「端口常驻」开启时按上游配置的媒体数量生成端口"
        "（未加载也占位）；关闭时只按实际接收到的媒体数量生成。端口顺序恒为 "
        "IMAGE→VIDEO→AUDIO，与媒体位置一一对应。"
    )

    def route(self, 媒体总线, 端口常驻=True, **kwargs):
        out = []
        bundle = 媒体总线 if isinstance(媒体总线, (list, tuple)) else []
        meta = bundle[0] if bundle and isinstance(bundle[0], dict) else {}
        counts = {
            "images": min(MAX_IMAGES, _as_int(meta.get("images"), 0)),
            "videos": min(MAX_VIDEOS, _as_int(meta.get("videos"), 0)),
            "audios": min(MAX_AUDIOS, _as_int(meta.get("audios"), 0)),
        }
        media = list(bundle[1:])
        cursor = 0
        full = bool(端口常驻)
        for group in GROUPS:
            n = counts[group]
            slot = media[cursor:cursor + n]
            cursor += n
            if full:
                out.extend(slot)
            else:
                out.extend(x for x in slot if x is not None)
        total = MAX_IMAGES + MAX_VIDEOS + MAX_AUDIOS
        while len(out) < total:
            out.append(None)
        return tuple(out[:total])


# ─────────────────────────────────────────── 注册常量
HUB_NODE_CLASS = "JosiaMediaHub"
HUB_NODE_DISPLAY_NAME = "Josia媒体中枢"
SWITCH_NODE_CLASS = "JosiaMediaSwitchboard"
SWITCH_NODE_DISPLAY_NAME = "Josia媒体枢纽"


# ─────────────────────────────────────────── 流式上传路由
# 官方 /upload/image 受 --max-upload-size（默认 100MB）限制，视频常超限返回 413
# 纯文本，前端 resp.json() 就炸出 "Unexpected token 'M': Maximum request..."。
# 这里用 request.content 流式读（不走 request.post，绕开 client_max_size），
# 前端把文件以 application/octet-stream 直接 POST 过来。
def _register_stream_upload():
    try:
        from aiohttp import web
        from server import PromptServer
        if not hasattr(PromptServer, "instance") or PromptServer.instance is None:
            return  # 独立 import（回归脚本）时尚未实例化服务
    except Exception:
        return

    ALLOWED_EXT = {
        ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff",
        ".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v",
        ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus",
    }

    @PromptServer.instance.routes.post("/josia_media_hub/upload")
    async def _jmeh_upload(req):
        name = os.path.basename(str(req.query.get("name", ""))).strip()
        if not name or name in (".", ".."):
            return web.json_response({"error": "bad filename"}, status=400)
        ext = os.path.splitext(name)[1].lower()
        if ext not in ALLOWED_EXT:
            return web.json_response({"error": "unsupported extension: " + ext}, status=400)

        subfolder = str(req.query.get("subfolder", "")).strip().replace("\\", "/")
        if subfolder in (".", "..") or ".." in subfolder.split("/"):
            return web.json_response({"error": "bad subfolder"}, status=400)

        upload_dir = folder_paths.get_input_directory()
        target_dir = os.path.abspath(os.path.join(upload_dir, os.path.normpath(subfolder)))
        base_abs = os.path.abspath(upload_dir)
        if os.path.commonpath((base_abs, target_dir)) != base_abs:
            return web.json_response({"error": "path outside input"}, status=400)
        os.makedirs(target_dir, exist_ok=True)

        filepath = os.path.abspath(os.path.join(target_dir, name))
        if os.path.commonpath((target_dir, filepath)) != target_dir:
            return web.json_response({"error": "bad target"}, status=400)

        written = 0
        try:
            with open(filepath, "wb") as f:
                while True:
                    chunk = await req.content.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    written += len(chunk)
        except Exception as e:
            _log("流式上传失败：" + name + " (" + str(e) + ")")
            try:
                os.remove(filepath)
            except Exception:
                pass
            return web.json_response({"error": "write failed"}, status=500)

        return web.json_response({
            "name": name,
            "subfolder": subfolder,
            "type": "input",
            "size": written,
        })


_register_stream_upload()
