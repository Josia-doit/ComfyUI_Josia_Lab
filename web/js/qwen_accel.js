import { app } from "../../scripts/app.js";

const NODE_CLASS = "JosiaQwenAccel";

/**
 * 与后端 KINDS 保持一致（只有 label / file 这两项会被前端用到）。
 * sigma 早就不是控件了 —— 节点内部按类型自己决定，切类型时连数值都不用改。
 * 控件名（选择LoRA / 加速LoRA类型 / 采样器）直接写在后端 INPUT_TYPES 的 key 上，
 * 前端只负责联动，不碰名字。
 */
const KINDS = {
  fun_pdd: {
    label: "Fun PDD（4 步）",
    file: "Qwen-Image-2.1-Fun-Acc-4Step.safetensors",
  },
  viggle: {
    label: "Viggle Turbo（6 步）",
    file: "Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors",
  },
};

const KIND_KEYS = Object.keys(KINDS);
const KIND_LABELS = Object.fromEntries(
  KIND_KEYS.map((k) => [k, KINDS[k].label]),
);
const KIND_BY_LABEL = Object.fromEntries(
  KIND_KEYS.map((k) => [KINDS[k].label, k]),
);

/** 与后端 KINDS[kind]["samplers"] 一致：Fun PDD 那一路只认 euler。 */
const SAMPLER_BY_KIND = {
  fun_pdd: ["euler"],
  viggle: [
    "euler",
    "euler_ancestral",
    "heun",
    "dpm_2",
    "dpm_2_ancestral",
    "lcm",
  ],
};

function kindKey(raw) {
  const v = String(raw ?? "").trim();
  if (KINDS[v]) return v;
  if (KIND_BY_LABEL[v]) return KIND_BY_LABEL[v];
  return "viggle";
}

function findWidget(node, name) {
  return node.widgets?.find((w) => w.name === name) ?? null;
}

function fileOptions(node) {
  const w = findWidget(node, "选择LoRA");
  return Array.isArray(w?.options?.values) ? w.options.values : [];
}

/** 后端列表里的名字可能带子目录前缀（反斜杠），按尾部匹配。 */
function matchFile(files, want) {
  const target = String(want ?? "").toLowerCase();
  if (!target) return null;
  return files.find((f) => String(f).toLowerCase().endsWith(target)) ?? null;
}

/**
 * 该类型的官方 LoRA 没在 loras 目录里时，往下拉里显式插一条「未找到」。
 * 不然下面 pickFile 会退化成 files[0] —— 用户以为在用加速 LoRA，
 * 实际加载的是列表里第一个不相干的文件，跑出来的图完全不是那回事。
 */
function ensureMissingOption(widget, files, want) {
  if (!widget) return null;
  const values = Array.isArray(widget.options?.values) ? widget.options.values : [];
  if (matchFile(values, want)) return null;
  const label = `⚠ 未找到：${want}`;
  if (!values.includes(label)) values.push(label);
  return label;
}

/** 挑一个该类型该用的文件：官方文件 → 「未找到」提示项 → 列表第一项。 */
function pickFile(files, kind, fileW) {
  if (matchFile(files, KINDS[kind].file)) return matchFile(files, KINDS[kind].file);
  return ensureMissingOption(fileW, files, KINDS[kind].file) ?? files[0] ?? "";
}

/** 文件名反推类型，和后端 guess_kind 同一套规则。 */
function guessKind(fileName) {
  const low = String(fileName ?? "").toLowerCase();
  if (low.includes("viggle")) return "viggle";
  if (low.includes("fun") || low.includes("pdd")) return "fun_pdd";
  return null;
}

/**
 * 只改 widget.value 的话，界面上那个下拉框还是旧内容 —— 看着像「切了没生效」。
 * 所以顺手把控件内部的 select 也写上（litegraph 把 DOM 挂在 widget.element 下）。
 */
function paintWidget(widget) {
  const el = widget?.element ?? widget?.inputEl ?? widget?.inputElement ?? null;
  if (!el || typeof el.querySelector !== "function") return;
  const field = el.querySelector("input, select");
  if (!field) return;
  const text = String(widget.value ?? "");
  if (field.tagName === "SELECT") {
    field.value = [...field.options].some((o) => o.value === text)
      ? text
      : "";
    return;
  }
  const readonly = field.readOnly || field.disabled;
  if (field.value !== text) {
    if (!readonly) {
      field.value = text;
    } else {
      const prev = field.value;
      field.value = text;
      field.setSelectionRange?.(0, 0);
      if (field.value !== text) field.value = prev;
    }
  }
}

function setValue(node, widget, value) {
  if (!widget || widget.value === value) return;
  widget.value = value;
  const i = node.widgets?.indexOf(widget);
  if (i >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[i] = value;
  paintWidget(widget);
  // 重绘留到 sync 最后统一调一次：一次联动刷好几下画布，节点会明显卡顿一拍
}

/**
 * @param {"init"|"kind"|"file"} source 这次联动是谁触发的。
 *   改类型时不能让文件名反推把类型又顶回去（文件还是上一个类型的默认文件），
 *   改文件时才以文件名为准 —— 少了这个区分，两边会互相打架。
 */
function sync(node, source = "init") {
  const kindW = findWidget(node, "加速LoRA类型");
  const fileW = findWidget(node, "选择LoRA");
  const samplerW = findWidget(node, "采样器");
  const files = fileOptions(node);

  // 1) 类型：下拉里存的是标签，这里认回内部 key（旧工作流存的 key 也认）
  let kind = kindKey(kindW?.value);
  setValue(node, kindW, KINDS[kind].label);

  // 2) 换文件时按文件名反推类型 —— 必须用当前这个文件名反推，
  //    不能等下面把它重挑成默认文件再反推，否则永远反推不出来
  let file = String(fileW?.value ?? "");
  if (source !== "kind") {
    const guess = guessKind(file);
    if (guess && guess !== kind) {
      kind = guess;
      setValue(node, kindW, KINDS[kind].label);
    }
  }

  // 3) 文件不在列表里就按当前类型挑一个（默认文件没下载 / 列表缓存过时都会走到这）
  if (!matchFile(files, file)) {
    file = pickFile(files, kind, fileW);
    setValue(node, fileW, file);
  }

  // 4) 采样器按类型收敛（Fun PDD 只认 euler）
  const allowed = SAMPLER_BY_KIND[kind] ?? SAMPLER_BY_KIND.viggle;
  if (!allowed.includes(samplerW?.value)) setValue(node, samplerW, "euler");

  // 5) 主动切类型时，文件还挂着上一个类型的就换成新类型的默认文件
  //    （sigma 不用管：它是节点内部按类型算的，切了类型数值自然就换了）
  if (source === "kind" && guessKind(file) !== kind) {
    file = pickFile(files, kind, fileW);
    setValue(node, fileW, file);
  }

  node.setDirtyCanvas?.(true, true);
}

// 最近一次建节点/载入的节点，widget 回调里拿不到节点时兜底用
let currentNode = null;

app.registerExtension({
  name: "JosiaQwenAccel",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_CLASS) return;

    const refresh = (node, source) => {
      const target = node ?? currentNode;
      if (!target) return;
      try {
        sync(target, source);
      } catch (e) {
        console.warn("[Josia实验/Qwen加速] 控件联动失败：", e);
      }
    };

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      currentNode = this;
      // 回调必须挂在节点实例上：beforeRegisterNodeDef 里的 this 是节点类型，
      // 在那个层级 findWidget(this, ...) 永远找不到控件，联动就成了摆设。
      // 两个下拉各带一个来源标记，免得改类型时被文件名反推顶回去。
      for (const [name, source] of [
        ["加速LoRA类型", "kind"],
        ["选择LoRA", "file"],
      ]) {
        const w = findWidget(this, name);
        if (!w) continue;
        const orig = w.callback;
        w.callback = function (...args) {
          // 这里 this 是控件本身不是节点，先从它身上反查，找不到退回 currentNode
          const host = this && Array.isArray(this.widgets) ? this : null;
          refresh(host ?? currentNode, source);
          return orig ? orig.apply(this, args) : undefined;
        };
      }
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      refresh(this, "init");
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      currentNode = this;
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      refresh(this, "init");
      return r;
    };
  },
});

// 调试用：控制台敲 window.__josiaQwenAccel 看当前类型配置
window.__josiaQwenAccel = {
  KINDS,
  KIND_LABELS,
  KIND_KEYS,
  guessKind,
  matchFile,
  pickFile,
  sync,
};
