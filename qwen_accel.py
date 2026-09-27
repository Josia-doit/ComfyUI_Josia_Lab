"""
Qwen-Image 2.1 加速 LoRA 适配器（实验包）

节点上只有三个可填项，控件名全是中文：
    选择LoRA / 加速LoRA类型 / 采样器
三个可选输入：model（不接就只出采样器与 sigma，方便单独接预览节点看数值）、
sigmas（不接就用内置的，接了以接进来的为准）、latent（算 Viggle sigma 用）。
sigma 不做成选项，完全由「加速LoRA类型」在节点内部决定。

两个加速 LoRA 走完全不同的两条路：

  · Fun PDD（SLMONKER / ComfyUI-QwenImage21-Fun-PDD）
    它不是普通 LoRA：除了常规 lora_A/lora_B，还带 65 个整参数
    （norm_q / norm_k / text_norm 等）和 4 个「按步数选头」的输出头，
    只能走官方那套 patch 流程加载，采样器固定 euler，固定 4 个 sigma。
    它是写死的，所以不接受参考 Latent，sigma 用官方成品值。

  · Viggle Turbo（Viggle / Qwen-Image-2.1-viggle-turbo，v0.2.1）
    普通 LoRA，官方节点走 forward 旁路加载（不合并进权重），6 步。
    官方 ViggleTurboSigmas 输入框里那串「t 值」不是 sigma，
    任何分辨率都填同一串，运行时按参考 Latent 的尺寸 shift 成真正的 sigma，
    末位补 0 再交给采样器。不接 Latent 就按 1024² 兜底。

Viggle 为什么不用 LoraLoaderModelOnly 合并：官方源码注释写明，bf16 下
round-to-nearest 只剩约 70% 的更新量，int8 再量化还会引入约 4 倍体积的噪声，
所以保持 unmerged（y = Wx + B·A·x），权重一格不动。
"""

import json
import math
import os
from contextvars import ContextVar

import torch
import torch.nn.functional as F

import comfy.lora
import comfy.model_base
import comfy.model_management
import comfy.patcher_extension
import comfy.samplers
import comfy.utils
import folder_paths
from safetensors import safe_open
from safetensors.torch import load_file

NODE_CLASS = "JosiaQwenAccel"
NODE_DISPLAY_NAME = "QwenImage2.1加速LoRA适配器"
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# 这两个 LoRA 一直放在 loras/ 下的这个子目录里
LORA_SUBDIR = "QwenImage2.1"

# Fun PDD 官方那个「固定 euler」在数值上就是普通 euler（源码里最后一行是
# sample_euler，额外只多一道 sigma 校验和一次 .float()），所以这里直接给下拉选。
# 换成别的采样器会打乱 PDD 输出头的挑选。这些名字会拿去
# getattr(comfy.k_diffusion.sampling, "sample_" + name)，写错要到运行时才抛
# AttributeError（dpm_2_a 在当前版本就已经不存在了）。
SAMPLER_CHOICES = ["euler", "euler_ancestral", "heun", "dpm_2", "dpm_2_ancestral", "lcm"]

KINDS = {
    "fun_pdd": {
        "label": "Fun PDD（4 步）",
        "file": "Qwen-Image-2.1-Fun-Acc-4Step.safetensors",
        # sigma 框里填的：官方 pdd_sigmas 成品，末位本来就是 0、长度是 steps+1
        "sigmas": [1.0, 0.9169867038726807, 0.7861579060554504, 0.5494909882545471, 0.0],
        "sigmas_note": "官方 pdd_sigmas 成品，最后一位是 0",
        "sigmas_kind": "final",
        "samplers": ["euler"],
        "needs_latent": False,
    },
    "viggle": {
        "label": "Viggle Turbo（6 步）",
        "file": "Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors",
        # sigma 框里填的是官方 ViggleTurboSigmas 输入框那串「t 值」（官方叫 nodes）：
        # 它不是 sigma，通用就通用在这——任何分辨率都填同一串，运行时按参考 Latent
        # 的尺寸 shift 成真正的 sigma，末位再补 0
        "sigmas": [1.0, 0.9375, 0.875, 0.75, 0.5, 0.25],
        "sigmas_note": "官方 ViggleTurboSigmas 输入框那串 t 值，运行时按分辨率换算",
        "sigmas_kind": "nodes",
        "samplers": SAMPLER_CHOICES,
        "needs_latent": True,
    },
}

# 下拉里存的是这串标签（不是内部 key）
KIND_LABELS = {key: info["label"] for key, info in KINDS.items()}


def resolve_kind(value):
    """下拉里存的是标签，老工作流里存的是 key，两者都认；认不出就按 Viggle。"""
    v = str(value or "").strip()
    for key, label in KIND_LABELS.items():
        if v == label or v == key:
            return key
    return "viggle"


def default_sigmas(kind):
    """该类型官方那串 sigma 的原文：Fun 是成品 sigma，Viggle 是官方输入框里那串 t 值。"""
    return ", ".join(str(s) for s in KINDS[kind]["sigmas"])


# ─────────────────────────────────────────── Fun PDD 官方配置
# 来源：ComfyUI-QwenImage21-Fun-PDD 的 pdd_config.json（MIT）
PDD_TARGETS_LIST = [
    "img_in",
    "modulation.1",
    "norm_out.linear",
    "time_text_embed.timestep_embedder.linear_1",
    "time_text_embed.timestep_embedder.linear_2",
]
for _bi in range(32):
    for _tail in ("attn.to_k", "attn.to_out.0", "attn.to_q", "attn.to_v",
                  "img_mlp.gate_layer", "img_mlp.out", "img_mlp.proj"):
        PDD_TARGETS_LIST.append(f"transformer_blocks.{_bi}.{_tail}")
PDD_TARGETS_LIST = sorted(PDD_TARGETS_LIST + ["txt_in.in_layer", "txt_in.out_layer"])
PDD_TARGETS = ",".join(PDD_TARGETS_LIST)

PDD_FULL_PARAMETERS = sorted(
    f"transformer_blocks.{_i}.attn.{_n}.weight"
    for _i in range(32)
    for _n in ("norm_k", "norm_q")
) + ["txt_in.text_norm.weight"]

PDD_ALPHA = 64.0
PDD_RANK = 64
PDD_EXPORT_FORMAT = "qwenimage21_extracted_prefused_v1"
PDD_HEAD_KEY = "diffusion_model.proj_out.weight"
PDD_PATCH_KEY = "josia_qwen21_fun_pdd"
PDD_SIGMAS = KINDS["fun_pdd"]["sigmas"]


# ─────────────────────────────────────────── LoRA 文件列表


def _flat(name):
    """folder_paths 给的是反斜杠路径，比较/匹配前统一成 /"""
    return name.replace("\\", "/")


def list_lora_files():
    """
    把 loras 下所有文件都列出来，只是把 QwenImage2.1/ 子目录里的排到最前面。
    不能锁死子目录：别的机器上不一定有这个目录，文件名也可能跟这里写的不一样。
    """
    try:
        all_names = folder_paths.get_filename_list("loras") or []
    except Exception:
        all_names = []
    prefix = _flat(LORA_SUBDIR) + "/"
    in_dir, rest = [], []
    for n in all_names:
        (in_dir if _flat(n).lower().startswith(prefix.lower()) else rest).append(n)
    return sorted(in_dir) + sorted(rest)


def _match_file(names, want):
    """DEFAULT_FILES 里写的是纯文件名，列表项可能带子目录前缀，按尾部匹配。"""
    target = _flat(want).lower()
    for n in names:
        if _flat(n).lower().endswith(target):
            return n
    return None


def default_lora_name(kind=None):
    """按类型挑它自家那个文件（按尾部匹配）；都找不到就取列表第一项。"""
    names = list_lora_files()
    wanted = KINDS[kind]["file"] if kind in KINDS else None
    if wanted:
        hit = _match_file(names, wanted)
        if hit:
            return hit
    return names[0] if names else ""


def resolve_lora(lora_name):
    try:
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
    except Exception:
        # 带子目录的名字 get_full_path 认不出来，就自己按 loras 根目录拼一次
        path = None
        for root in folder_paths.get_folder_paths("loras") or []:
            cand = os.path.join(root, *lora_name.replace("\\", "/").split("/"))
            if os.path.isfile(cand):
                path = cand
                break
        if path is None:
            raise FileNotFoundError(
                f"[Josia实验/Qwen加速] 找不到 LoRA：{lora_name}"
            )
    if not path.lower().endswith(".safetensors"):
        raise ValueError(f"[Josia实验/Qwen加速] 只支持 .safetensors：{lora_name}")
    return path


def guess_kind(lora_name):
    """文件名反推类型，给用户手动换文件时兜个底。"""
    low = (lora_name or "").lower()
    if "viggle" in low:
        return "viggle"
    if "fun" in low or "pdd" in low:
        return "fun_pdd"
    return None


# ─────────────────────────────────────────── sigma


def _split_numbers(text, label):
    parts = [p.strip() for p in str(text).replace("，", ",").split(",")]
    parts = [p for p in parts if p]
    if len(parts) < 2:
        raise ValueError(
            f"[Josia实验/Qwen加速] {label} 至少要有两个数，当前是：{text!r}"
        )
    try:
        return [float(p) for p in parts]
    except ValueError:
        raise ValueError(
            f"[Josia实验/Qwen加速] {label} 只能用逗号分隔的数字：{text!r}"
        )


def parse_sigmas(text):
    """
    解析成品 sigma 文本（Fun PDD 那路）。两条规矩：
      · 必须严格递减；
      · 末位必须是 0（ComfyUI 的采样器把它当终点，非零会跑出未定义结果）。
    """
    vals = _split_numbers(text, "sigma")
    if any(v <= 0.0 for v in vals[:-1]):
        raise ValueError(
            f"[Josia实验/Qwen加速] 0 只能放在最后一位，前面都得是正数：{vals}"
        )
    if vals[-1] != 0.0:
        raise ValueError(
            f"[Josia实验/Qwen加速] sigma 最后一位必须是 0，当前是 {vals[-1]}"
        )
    if any(vals[i] <= vals[i + 1] for i in range(len(vals) - 1)):
        raise ValueError(f"[Josia实验/Qwen加速] sigma 必须严格递减：{vals}")
    return torch.tensor(vals, dtype=torch.float32)


def parse_nodes(text):
    """
    解析 Viggle 官方输入框里那串 t 值（官方叫 nodes，学生节点时刻表）。
    它全程是正数、严格递减，末位不是 0（补 0 是换算成 sigma 之后的事）。
    """
    vals = _split_numbers(text, "t 值")
    if any(v <= 0.0 for v in vals):
        raise ValueError(
            f"[Josia实验/Qwen加速] t 值必须全是正数（0 是换算成 sigma 后才补的）：{vals}"
        )
    if any(vals[i] <= vals[i + 1] for i in range(len(vals) - 1)):
        raise ValueError(f"[Josia实验/Qwen加速] t 值必须严格递减：{vals}")
    return torch.tensor(vals, dtype=torch.float64)


# 官方 ViggleTurboSigmas 的分辨率 shift：mu 由 latent 尺寸决定
# mu = 0.5 + (0.9 - 0.5) * (tokens - 256) / (8192 - 256)，tokens = (H/16)*(W/16)
VIGGLE_SHIFT_BASE = 0.5
VIGGLE_SHIFT_SPAN = 0.4
VIGGLE_SHIFT_TOKENS_MIN = 256
VIGGLE_SHIFT_TOKENS_MAX = 8192
# 不接 LATENT 时按 1024² 兜底（Qwen-Image 官方出图分辨率）
VIGGLE_FALLBACK_TOKENS = 64 * 64


def _latent_tokens(latent):
    """从 latent 拿 tokens；拿不到（没接 / 结构不对）返回 None 走兜底。"""
    if not isinstance(latent, dict) or "samples" not in latent:
        return None
    samples = latent["samples"]
    if not hasattr(samples, "shape") or samples.dim() != 4:
        return None
    # EmptyLatentImage 生成的是 ÷8 的 latent，采样器会缩到 ÷16；VAE Encode 出来就是 ÷16
    ratio = latent.get("downscale_ratio_spacial", 16) / 16
    return round(samples.shape[-2] * ratio) * round(samples.shape[-1] * ratio)


def shift_nodes_to_sigmas(nodes, latent=None):
    """
    官方那套换算：t 值 + latent 尺寸 → 真正的 sigma（末位补 0，ComfyUI 要 steps+1 长度）。
    t=1.0 永远映射到 sigma=1.0；换算只改数值不改步数。
    """
    tokens = _latent_tokens(latent) or VIGGLE_FALLBACK_TOKENS
    mu = VIGGLE_SHIFT_BASE + VIGGLE_SHIFT_SPAN * (
        (tokens - VIGGLE_SHIFT_TOKENS_MIN)
        / (VIGGLE_SHIFT_TOKENS_MAX - VIGGLE_SHIFT_TOKENS_MIN)
    )
    e = math.exp(mu)
    sigmas = e / (e + (1.0 / nodes - 1.0))
    return torch.cat([sigmas, sigmas.new_zeros(1)]).float()


# ─────────────────────────────────────────── Viggle unmerged 旁路


def _lora_fwd(x, ab):
    return F.linear(F.linear(x, ab[0].to(x.dtype)), ab[1].to(x.dtype))


def _attach_hook(mod, ab):
    return mod.register_forward_hook(lambda m, inp, out: out + _lora_fwd(inp[0], ab))


def _attach_mlp_hooks(mlp, gate, up, down):
    """fused SwiGLU：gate_up 的输出走 int8/fp16 核会绕过 hook，旁路得补在两侧。"""
    holder = {}

    def gate_up_hook(m, inp, out):
        holder["gu"] = out + torch.cat(
            [_lora_fwd(inp[0], gate), _lora_fwd(inp[0], up)], -1
        )
        return holder["gu"]

    def mlp_hook(m, inp, out):
        g, u = holder.pop("gu").chunk(2, -1)
        return out + _lora_fwd(F.silu(g) * u, down)

    return [
        mlp.gate_up.register_forward_hook(gate_up_hook),
        mlp.register_forward_hook(mlp_hook),
    ]


def _check_context_dim(model, context):
    """
    Qwen-Image-2.1 的 txt_in 只认固定宽度的 conditioning（context_in_dim，本模型是 4096）。
    上游 CLIP 若配成 Qwen3-VL-32B（5120），会在 txt_in 的 rms_norm 里抛一句
    「normalized_shape 对不上」的 torch 原文，看不出该改哪个控件。这里提前讲清楚。
    """
    if context is None or not hasattr(context, "shape"):
        return
    try:
        expected = model.get_submodule("txt_in.text_norm").weight.shape[0]
    except Exception:
        return  # 不是这套结构就不插手，交给 ComfyUI 自己报错
    if context.shape[-1] == expected:
        return
    raise ValueError(
        f"[Josia实验/Qwen加速] 文本编码器的输出宽度和模型对不上：CLIP 送出 "
        f"{context.shape[-1]} 维，而 Qwen-Image-2.1 的 txt_in 只认 {expected} 维。"
        f"把上游「CLIP模型」换成 Qwen3_VL_8B 目录下的 "
        f"qwen3.5_qwen_image_2.1_pe_i2i（带参考图）或 pe_t2i（纯文生图）那份。"
    )


def _run_with_lora(lora, executor, *args, **kwargs):
    dm = executor.class_obj
    _check_context_dim(dm, args[2] if len(args) > 2 else None)
    # LoRA 是从磁盘读进来的，躺在 CPU 上；这里把 A/B 搬到采样时那个张量所在的设备。
    # ab 就是 lora 里的那个 list，原地赋值等于顺带更新了 lora（所以下方 hook 能直接拿到）。
    device = args[0].device
    for ab in lora.values():
        if ab[0].device != device:
            ab[0], ab[1] = ab[0].to(device), ab[1].to(device)
    hooks = []
    for name, ab in lora.items():
        parent, _, leaf = name.rpartition(".")
        if not getattr(dm.get_submodule(parent), "fused", False):
            hooks.append(_attach_hook(dm.get_submodule(name), ab))
        elif leaf == "out":
            hooks += _attach_mlp_hooks(
                dm.get_submodule(parent),
                lora[parent + ".gate_layer"],
                lora[parent + ".proj"],
                ab,
            )
    try:
        # diffusion model 会和其它 MODEL 输出共享，hook 绝不能活过这一次调用
        return executor(*args, **kwargs)
    finally:
        for hook in hooks:
            hook.remove()


# 一个 turbo LoRA 奔 700MB，每次执行从头解一遍要 3-8 秒。
# 按「真实路径 + mtime + 大小」记一层内存缓存：文件没被动就直接拿现成的，
# 用户手改了 LoRA（mtime 变了）自动失效，不用重启 ComfyUI。
_LORA_CACHE = {}
_LORA_CACHE_LIMIT = 3


def _load_lora(lora_path):
    """读整个 LoRA，走一层内存缓存，返回 (state_dict, metadata)。"""
    try:
        st = os.stat(lora_path)
    except OSError:
        tag = None
    else:
        tag = (os.path.realpath(lora_path), st.st_mtime_ns, st.st_size)
    if tag is not None and tag in _LORA_CACHE:
        return _LORA_CACHE[tag]
    sd, meta = comfy.utils.load_torch_file(lora_path, return_metadata=True)
    if tag is not None:
        _LORA_CACHE[tag] = (sd, meta)
        while len(_LORA_CACHE) > _LORA_CACHE_LIMIT:
            _LORA_CACHE.pop(next(iter(_LORA_CACHE)))
    return sd, meta


def _read_viggle_lora(lora_path):
    # 节点上没有强度这个参数，turbo 自家建议就是 1.0
    strength = 1.0
    sd, meta = _load_lora(lora_path)
    cfg = json.loads(((meta or {}).get("lora_adapter_metadata") or "{}"))
    scale = strength * cfg.get("transformer.lora_alpha", 1) / cfg.get("transformer.r", 1)

    lora = {}
    for key in sd:
        if not key.endswith(".lora_A.weight"):
            continue
        base = key.removeprefix("transformer.").removesuffix(".lora_A.weight")
        a = sd[key]
        b = sd[key.replace("lora_A", "lora_B")] * scale
        # 存 list 不存 tuple：设备对齐那段要原地改 ab[0]/ab[1]（跟官方 ViggleTurboLora 一致）。
        # 成对判据只认 rank：A 是 (r, in)、B 是 (out, r)，两个 r 必须相等。
        # 不能拿「B 的行数 == A 的列数」（也就是要求 in == out）当判据——那只是方阵才成立，
        # 而 Qwen-Image 里 modulation（4096→16384）、img_mlp（4096→12288）、
        # timestep_embedder.linear_1（256→4096）这类非方阵层占了全部层的四成多。
        if a.shape[0] != b.shape[1]:
            raise ValueError(
                f"[Josia实验/Qwen加速] {base} 的 A/B 不是一对：A={tuple(a.shape)}（期望 rank "
                f"{a.shape[0]}），B={tuple(b.shape)}（期望 rank {b.shape[1]}）"
            )
        lora[base] = [a, b]
    if not lora:
        raise ValueError(
            f"[Josia实验/Qwen加速] {os.path.basename(lora_path)} 里没有成对的 lora_A / lora_B，"
            f"不是 Viggle turbo 格式。把「加速LoRA类型」切到 Fun PDD 再看一眼？"
        )
    return lora


def apply_viggle(model, lora_path):
    lora = _read_viggle_lora(lora_path)
    patched = model.clone()
    patched.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
        "josia_viggle_turbo_lora",
        lambda executor, *a, **kw: _run_with_lora(lora, executor, *a, **kw),
    )
    return patched


# ─────────────────────────────────────────── Fun PDD 官方加载流程


class _PDDHeadSelector:
    """按当前 sigma 选 4 个输出头里的一个；作用域只在这次 forward。"""

    def __init__(self, heads, sigmas):
        self.heads = heads
        self.sigmas = tuple(sigmas[:-1])
        self.active_head = ContextVar("josia_qwen21_pdd_head", default=None)

    def __call__(self, weight):
        index = self.active_head.get()
        if index is None:
            raise RuntimeError("PDD 输出头在模型 wrapper 之外被调用了。")
        return comfy.model_management.cast_to_device(
            self.heads[index], weight.device, weight.dtype
        )

    def wrap(self, executor, x, timestep, *args, **kwargs):
        _check_context_dim(executor.class_obj, args[0])
        values = timestep.detach().float().reshape(-1)
        sigma = values[0].item()
        index = min(range(4), key=lambda i: abs(self.sigmas[i] - sigma))
        if abs(self.sigmas[index] - sigma) > 1e-6 or not torch.all(values == values[0]).item():
            raise ValueError(
                "Fun PDD 需要它自己那 4 个固定 sigma。Sigmas 请接本节点的输出，"
                "采样器也用本节点的，SamplerCustom 的 CFG 保持 1。"
            )
        token = self.active_head.set(index)
        try:
            return executor(x, timestep, *args, **kwargs).float()
        finally:
            self.active_head.reset(token)


def _build_pdd_patches(base_model, state, path):
    targets = PDD_TARGETS.split(",")
    full_names = PDD_FULL_PARAMETERS
    expected = {"proj_out.weight", *full_names}
    for name in targets:
        expected.update((name + ".lora_down", name + ".lora_up"))
    if set(state) != expected:
        missing = sorted(expected - set(state))
        extra = sorted(set(state) - expected)
        raise ValueError(
            f"[Josia实验/Qwen加速] {os.path.basename(path)} 不是 Fun PDD 的 prefused 导出。"
            f"\n缺：{missing[:4]}  多：{extra[:4]}\n把「加速LoRA类型」切到 Viggle 试试？"
        )

    model_sd = base_model.state_dict()
    key_map = comfy.lora.model_lora_keys_unet(base_model, {})
    converted = {}
    mapping = {}
    for name in targets:
        if name not in key_map:
            raise ValueError(
                f"[Josia实验/Qwen加速] ComfyUI 里找不到 {name}，"
                f"需要原生 Qwen-Image-2.1 基础模型。"
            )
        destination = key_map[name]
        key = destination if isinstance(destination, str) else destination[0]
        shape = list(model_sd[key].shape)
        if not isinstance(destination, str):
            axis, start, length = destination[1]
            if start + length > shape[axis]:
                raise ValueError(f"[Josia实验/Qwen加速] {name} 的融合层映射越界。")
            shape[axis] = length
        down, up = state[name + ".lora_down"], state[name + ".lora_up"]
        if (len(shape) != 2 or tuple(down.shape) != (PDD_RANK, shape[1])
                or tuple(up.shape) != (shape[0], PDD_RANK)):
            raise ValueError(
                f"[Josia实验/Qwen加速] {name} 的 LoRA/基础形状对不上："
                f"down={tuple(down.shape)} up={tuple(up.shape)}"
            )
        converted[name + ".lora_down.weight"] = down
        converted[name + ".lora_up.weight"] = up
        converted[name + ".alpha"] = torch.tensor(PDD_ALPHA, dtype=torch.float32)
        mapping[name] = destination

    for name in full_names:
        key = "diffusion_model." + name
        if key not in model_sd or state[name].shape != model_sd[key].shape:
            raise ValueError(f"[Josia实验/Qwen加速] 整参数 {name} 与基础模型对不上。")
        module = name.removesuffix(".weight")
        converted[module + ".set_weight"] = state[name]
        mapping[module] = key

    heads = state["proj_out.weight"]
    if PDD_HEAD_KEY not in model_sd or tuple(heads.shape) != (4, *model_sd[PDD_HEAD_KEY].shape):
        raise ValueError(
            f"[Josia实验/Qwen加速] 输出头形状不对，Fun PDD 要 (4, *{PDD_HEAD_KEY})。"
        )
    patches = comfy.lora.load_lora(converted, mapping, log_missing=True)
    if len(patches) != len(targets) + len(full_names):
        raise ValueError("[Josia实验/Qwen加速] ComfyUI 没吃下全部 PDD patch，模型没改。")
    return patches, heads


def apply_fun_pdd(model, lora_path):
    if not isinstance(model.model, comfy.model_base.QwenImage21):
        raise ValueError(
            "[Josia实验/Qwen加速] Fun PDD 只吃原生 Qwen-Image-2.1 基础模型"
            "（不是 2509 / 2511，也不是 Diffusers 转换的）。"
        )
    try:
        sd, meta = _load_lora(lora_path)
    except Exception as exc:
        raise ValueError(f"[Josia实验/Qwen加速] 读不了 {os.path.basename(lora_path)}：{exc}")
    if (meta or {}).get("format") != PDD_EXPORT_FORMAT:
        raise ValueError(
            f"[Josia实验/Qwen加速] {os.path.basename(lora_path)} 的 format="
            f"{meta.get('format')!r}，不是 Fun-Acc-4Step 导出。把「加速LoRA类型」切到 Viggle 试试？"
        )

    patches, heads = _build_pdd_patches(model.model, sd, lora_path)

    clone = model.clone()
    applied = clone.add_patches(patches, strength_patch=1.0, strength_model=1.0)
    if len(applied) != len(patches):
        raise ValueError("[Josia实验/Qwen加速] ComfyUI 拒绝了部分 PDD patch。")
    if PDD_HEAD_KEY in clone.weight_wrapper_patches:
        raise ValueError("[Josia实验/Qwen加速] 输出头已经有 wrapper 了，接一个没打补丁的基础模型。")

    selector = _PDDHeadSelector(heads, PDD_SIGMAS)
    clone.add_weight_wrapper(PDD_HEAD_KEY, selector)
    clone.add_wrapper_with_key(
        comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, PDD_PATCH_KEY, selector.wrap
    )

    return clone


# ─────────────────────────────────────────── 节点


class JosiaQwenAccel:
    """
    控件名直接写成中文（选择LoRA / 加速LoRA类型 / 采样器）——
    和文本编码节点同一套做法：INPUT_TYPES 的 key 本身就是显示名，
    不依赖任何前端代码，永远生效。sigma 不做成选项，节点内部按类型决定；
    前端只负责「切类型时换上该类型的默认 LoRA 文件、把采样器收敛回合法值」。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "选择LoRA": (
                    list_lora_files(),
                    {"default": default_lora_name(),
                     "tooltip": "loras 目录里的 .safetensors。切类型会自动挑该类型的默认文件，"
                                "手动换文件也可能反推出类型。"},
                ),
                "加速LoRA类型": (
                    list(KIND_LABELS.values()),
                    {"default": KIND_LABELS["viggle"],
                     "tooltip": "Fun PDD（4 步）和 Viggle Turbo（6 步）的加载方式、采样器、sigma 都不一样，"
                                "切这里会连带着换 LoRA 文件、采样器，sigma 也跟着换成这一路的官方值"},
                ),
                "采样器": (
                    SAMPLER_CHOICES,
                    {"default": "euler",
                     "tooltip": "Fun PDD 一路只认 euler，切过去会自动跳回 euler；Viggle 可以换别的试试。"},
                ),
            },
            "optional": {
                # MODEL 也做成可选输入：不接就跳过打补丁，只算 sigma / sampler，
                # 方便接一台预览节点单独看数值（不必拉一整套工作流）。
                "model": (
                    "MODEL",
                    {"tooltip": "选填。不接 → 只把采样器和 sigma 传下去，方便单独接预览节点看数值；"
                                "接了 → 正常打上加速 LoRA 再输出。"},
                ),
                # SIGMAS 做成可选输入：不接就用「加速LoRA类型」决定的内置官方值，
                # 接了就以接进来的为准（接 Preview Anywhere 之类可以盯着数值看）。
                "sigmas": (
                    "SIGMAS",
                    {"tooltip": "选填。不接 → 按「加速LoRA类型」自动用该类型官方那套 sigma；"
                                "接了 → 以接进来的 SIGMAS 为准（比如接预览/调试节点看数值，"
                                "或接别的节点改用它那一串）。"},
                ),
                # 接上「喂给采样器的那个 latent」Viggle 就能按实际出图分辨率精确换算；
                # 不接按 1024² 兜底。Fun PDD 不吃这个口。
                "latent": (
                    "LATENT",
                    {"tooltip": "把送进采样器的那个 latent 拉根线过来（EmptyLatentImage 或 VAE Encode 的输出）。"
                                "只有 Viggle 会用它按分辨率换算 sigma；Fun PDD 无视它。"},
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "SAMPLER", "SIGMAS")
    RETURN_NAMES = ("model", "sampler", "sigmas")
    FUNCTION = "apply"
    CATEGORY = "⚡️Josia实验区/Qwen加速"
    DESCRIPTION = (
        "Qwen-Image 2.1 加速 LoRA：填「选择LoRA」+ 选「加速LoRA类型」，"
        "节点自动换上对应的加载方式、采样器与 sigma，sigma 不用自己填。"
        "Fun PDD（4 步）用官方 sigma 成品，不接受参考 Latent；"
        "Viggle Turbo（6 步）按官方那串 t 值走，接上参考 Latent 会按分辨率换算成真正的 sigma，"
        "不接就按 1024² 算。三个输出接 SamplerCustom，CFG 保持 1、不要负面提示。"
    )

    # 控件 key 是中文，直接用 kwargs 接，名字对得上 INPUT_TYPES 就行
    def apply(self, **kwargs):
        model = kwargs.get("model")  # 可选输入，不接就是 None
        kind = resolve_kind(kwargs.get("加速LoRA类型"))
        info = KINDS[kind]

        name = str(kwargs.get("选择LoRA") or "").strip()
        if not name:
            name = default_lora_name(kind)
        hit = _match_file(list_lora_files(), name) or (name if name in list_lora_files() else None)
        if hit is None:
            raise ValueError(
                f"[Josia实验/Qwen加速] 找不到 LoRA：{name}\n"
                f"把它放进 ComfyUI 的 loras/{LORA_SUBDIR}/ 目录。"
            )
        path = resolve_lora(hit)

        sampler = kwargs.get("采样器")
        allowed = info["samplers"]
        if sampler not in allowed:
            raise ValueError(
                f"[Josia实验/Qwen加速] {info['label']} 只配 {allowed} 里的采样器，"
                f"当前是 {sampler}。"
            )

        # sigma 分两路：外接的优先，没接就按类型内置官方值（节点内部决定，不给用户填）
        incoming = kwargs.get("sigmas")
        if incoming is not None:
            sigmas = incoming
        elif info["sigmas_kind"] == "final":
            sigmas = parse_sigmas(default_sigmas(kind))
        else:
            sigmas = shift_nodes_to_sigmas(parse_nodes(default_sigmas(kind)), kwargs.get("latent"))

        if model is None:
            patched = None  # 没接模型就不打补丁，sigma / 采样器照样出
        else:
            patched = apply_fun_pdd(model, path) if kind == "fun_pdd" else apply_viggle(model, path)
        return (patched, comfy.samplers.ksampler(sampler, {}), sigmas)
