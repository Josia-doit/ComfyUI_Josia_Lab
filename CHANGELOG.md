# 更新日志

## 0.1.2 - 2026-10-12

### JosiaQwenAccel · QwenImage2.1 加速 LoRA 适配器

- **新增「官方 Turbo（8 步）」这条路**：Qwen 官方发布了 Qwen-Image-2.1-Turbo 检查点（不是 LoRA）。
  「选择LoRA」下拉最上面多了一个常驻项「使用官方 Qwen Image 2.1 Turbo 模型（不挂 LoRA）」，
  选它 = 用官方 Turbo 检查点当基础模型、不加载任何 LoRA，节点把 model 原样透传，只输出官方 8 步 sigma
  和 euler 采样器。
- 这根官方的 sigma 就是从检查点 `model_index.json` 里读出来的 `sample_sigmas`
  （1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568，末位补 0 凑 8 步），
  已对官方仓库核实。它和 Fun PDD 一样锁死 euler、CFG 保持 1、不要负面提示。
- 「选择LoRA」选哨兵项和「加速LoRA类型」选「官方 Turbo（8 步）」双向联动：任一选中都进入不挂 LoRA 模式，
  采样器自动收敛 euler；从这条路切回其它类型时，文件框会自动回到真实 LoRA 文件。

## 0.1.1 - 2026-10-04

### JosiaQwenAccel · QwenImage2.1 加速 LoRA 适配器

- **LoRA 文件完全由你选**：`加速LoRA类型` 只决定「怎么加载这个文件」（加载方式、sigma、可用采样器），
  切换类型不再替你换文件。官方加速 LoRA 一直在重训改名（v0.2.1 → v0.3 …），
  改名、换版本都不会让节点失效。
- 选中的文件在 `loras` 里找不到时（改名、删掉、换了机器）会原样保留并给出提示，
  执行时点名报「找不到 LoRA：xxx」，不会偷偷换成列表里第一个不相干的文件。
- 采样器按类型自动收敛：Fun PDD（4 步）只认 `euler`；Viggle Turbo（6 步）可用
  `euler` / `euler_ancestral` / `heun` / `dpm_2` / `dpm_2_ancestral` / `lcm`。
- 加速 LoRA 只对**原生满宽**的 Qwen-Image 2.1 有效：基础模型是量化版（权重按 N:1 打包）时，
  报错会直接说明「当前是量化版、几比一打包、加速 LoRA 只支持未量化的基础模型」，
  不再抛一串看不懂的形状数字。

## 0.1.0 - 2026-09-27

实验包首个可用版本，含一个节点。

### JosiaQwenAccel · QwenImage2.1 加速 LoRA 适配器

Qwen-Image 2.1 两个官方加速 LoRA 的适配器。选择 LoRA 与类型后，加载方式、采样器、sigma 由节点
按类型内部决定，界面上不再需要配置 sigma。

- `选择LoRA` / `加速LoRA类型` / `采样器` 三个必填项，控件名全部为中文。
- 三个可选输入：`model`、`sigmas`、`latent`；不接 `model` 时只输出采样器与 sigma，
  方便接一台预览节点单独看数值。
- 三条路线：

  | 类型 | 加载方式 | sigma |
  | --- | --- | --- |
  | Fun PDD（4 步） | 官方 patch 流程（含按步选头的输出头） | 官方 pdd_sigmas 成品 |
  | Viggle Turbo（6 步） | forward 旁路（权重不合并） | 官方 t 值按参考 Latent 尺寸换算 |

- `sigmas` 作为可选输入：不接用内置，接进来的以接进来的为准。
- `latent` 作为可选输入：Viggle Turbo 用它按分辨率换算 sigma，不接按 1024² 计算；
  Fun PDD 不使用这个输入。
- 同一份加速 LoRA 只在首次执行时解算一次，之后复用。
- 两种加速路线都不接管 KV 缓存设置，由工作流里的官方缓存节点决定。
