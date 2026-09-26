# 更新日志

## 0.1.0 - 2026-09-26

实验包首个版本，含一个节点。

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
