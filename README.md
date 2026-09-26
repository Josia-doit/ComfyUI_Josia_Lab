# ComfyUI_Josia_Lab

JosiaNodes 的**实验包**：临时节点与未定稿功能的独立试验田，与主节点包 `ComfyUI_JosiaNodes` 分离，
节点可以随时增删，不影响正式包。

> 实验性质：节点没有稳定性承诺，接口与行为可能在下一个版本调整。

## 安装

把整个目录放进 ComfyUI 的 `custom_nodes/` 下即可，无需额外依赖。

```
ComfyUI/custom_nodes/ComfyUI_Josia_Lab/
```

## 当前节点

### JosiaQwenAccel · QwenImage2.1 加速 LoRA 适配器

给 Qwen-Image 2.1 的两个官方加速 LoRA 做适配：选好文件与类型，加载方式、采样器、sigma 都由节点内部
按类型决定，不需要手工配置。

分类：`⚡️Josia实验区/Qwen加速`

**必填**

| 控件 | 说明 |
| --- | --- |
| 选择LoRA | `loras` 目录下的 `.safetensors` 下拉。切类型会自动挑该类型的默认文件，手动换文件也可能反推出类型。 |
| 加速LoRA类型 | `Fun PDD（4 步）` / `Viggle Turbo（6 步）`。切这里会连带换 LoRA 文件、采样器与 sigma。 |
| 采样器 | Fun PDD 一路只放开 euler；Viggle 可以另外试试。 |

**可选输入**

| 端口 | 说明 |
| --- | --- |
| model | 选填。不接就只把采样器与 sigma 传下去，方便单独接一个预览节点看数值。 |
| sigmas | 选填。不接就按类型用内置的那套；接进来的 SIGMAS 优先。 |
| latent | 选填。喂给采样器的那个 latent，Viggle 用它按分辨率换算 sigma；Fun PDD 无视它。 |

**输出**：`model` / `sampler` / `sigmas`

**两条路线**

- **Fun PDD（SLMONKER / ComfyUI-QwenImage21-Fun-PDD，4 步）**
  不是普通 LoRA：除常规 lora_A/lora_B 外还带若干整参数与 4 个「按步数选头」的输出头，
  只能走官方那套 patch 流程加载，采样固定 euler、sigma 为官方成品值。
  需要**原生 Qwen-Image-2.1 基础模型**（不是 2509 / 2511，也不是 Diffusers 转换的），
  不接受参考 Latent。

- **Viggle Turbo（v0.2.1，6 步）**
  普通 LoRA，官方建议走 forward 旁路加载而不合并进权重（bf16 融合只剩约 70% 更新量，
  int8 再量化还会引入约 4 倍噪声），因此权重一格不动，用 hook 在 forward 后补上 LoRA 贡献。
  sigma 用的是官方 `ViggleTurboSigmas` 输入框那串 t 值，运行时按参考 Latent 的尺寸换算成真正的 sigma
  （末位补 0），不接 Latent 就按 1024² 兜底。

**接线要求**

- 三个输出接 `SamplerCustom`，**CFG 保持 1**，不要接负面提示。
- 用哪个类型就接哪个 LoRA；内置 sigma 已经与该类型绑定，不要从别处接 sigma 进去。

## 目录结构

```
ComfyUI_Josia_Lab/
├── __init__.py            节点注册 + 前端挂载（WEB_DIRECTORY）
├── qwen_accel.py          节点实现（两条加速路线）
├── web/js/qwen_accel.js   前端联动
├── pyproject.toml         包元数据
└── CHANGELOG.md           版本记录
```

只保留运行节点所必需的文件，没有附带任何测试或开发脚本。
