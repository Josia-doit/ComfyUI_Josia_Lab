import { app } from "../../../scripts/app.js";

const NODE_CLASS = "JosiaQwenAccel";

/**
 * 与后端 TURBO_SENTINEL 必须完全一致：选它 = 用官方 Qwen-Image-2.1-Turbo 检查点当基础模型、
 * 不挂任何 LoRA。后端 apply() 里拿它当哨兵认官方 Turbo 这一路，前后端字符串对不上就会认错路。
 */
const TURBO_SENTINEL = "使用官方 Qwen Image 2.1 Turbo 模型（不挂 LoRA）";

/**
 * 与后端 KINDS 保持一致（只同步 label 这一项）。
 * sigma 早就不是控件了 —— 节点内部按类型自己决定，切类型时连数值都不用改。
 * 控件名（选择LoRA / 加速LoRA类型 / 采样器）直接写在后端 INPUT_TYPES 的 key 上，
 * 前端只负责联动，不碰名字。
 *
 * 这里刻意不写文件名：官方加速 LoRA 一直在换版本改名（0.2.1 → 0.3 → 之后还会出蒸馏版），
 * 前端跟着认文件名的话，用户一改名节点就「找不到官方文件」，纯属自找麻烦。
 * 文件由用户在下拉里自己选，前端只保证「选中的文件 + 选中的类型」两件事对得上。
 */
const KINDS = {
  fun_pdd: {
    label: "Fun PDD（4 步）",
  },
  viggle: {
    label: "Viggle Turbo（6 步）",
  },
  official_turbo: {
    label: "官方 Turbo（8 步）",
    // 不选任何 LoRA 文件：用官方 Turbo 检查点当基础模型，model 原样透传
    no_lora: true,
  },
};

const KIND_KEYS = Object.keys(KINDS);
const KIND_LABELS = Object.fromEntries(
  KIND_KEYS.map((k) => [k, KINDS[k].label]),
);
const KIND_BY_LABEL = Object.fromEntries(
  KIND_KEYS.map((k) => [KINDS[k].label, k]),
);

/** 与后端 KINDS[kind]["samplers"] 一致：Fun PDD 与官方 Turbo 都只认 euler。 */
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
  official_turbo: ["euler"],
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
 * 保存下来的文件名已经不在列表里了（换机器、清过 loras、文件被改名）时的兜底：
 * 给一个最可能用得上的候选（列表第一项，QwenImage2.1/ 子目录排最前），
 * 由用户自己确认换到哪一个 —— 不偷偷退回别的文件，也不伪装成「未找到」。
 */
function fallbackFile(files) {
  return files[0] ?? "";
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

  let file = String(fileW?.value ?? "");

  // 0) 选了「用官方 Turbo 模型」哨兵项 → 类型也强制切到官方 Turbo（双向联动的一半）
  if (file === TURBO_SENTINEL) {
    setValue(node, kindW, KINDS.official_turbo.label);
  }

  // 1) 类型：下拉里存的是标签，这里认回内部 key（旧工作流存的 key 也认）
  let kind = kindKey(kindW?.value);
  setValue(node, kindW, KINDS[kind].label);

  // 2) 官方 Turbo 模式：不挂 LoRA，文件框锁到哨兵项、采样器收敛 euler，跳过选文件那套
  if (kind === "official_turbo") {
    setValue(node, fileW, TURBO_SENTINEL);
    const allowed = SAMPLER_BY_KIND.official_turbo;
    if (!allowed.includes(samplerW?.value)) setValue(node, samplerW, "euler");
    node.setDirtyCanvas?.(true, true);
    return;
  }

  // 3) 换文件时按文件名反推类型 —— 必须用当前这个文件名反推，
  //    不能等下面把它重挑成默认文件再反推，否则永远反推不出来（哨兵项认不出类型，跳过）
  if (source !== "kind" && file !== TURBO_SENTINEL) {
    const guess = guessKind(file);
    if (guess && guess !== kind) {
      kind = guess;
      setValue(node, kindW, KINDS[kind].label);
    }
  }

  // 4) 没选过文件（新节点）或刚从官方 Turbo 切走（还停在哨兵项）才给个候选；
  //    选过但已经不在 loras 里（换机器 / 被删 / 被改名）就原样留着 ——
  //    偷偷替成列表第一项等于换了个不相干的 LoRA，出图跑偏还查不出原因。
  if (!file || file === TURBO_SENTINEL) {
    file = fallbackFile(files);
    setValue(node, fileW, file);
  } else if (!matchFile(files, file)) {
    console.warn(
      `[Josia实验/Qwen加速] 选中的「${file}」不在 loras 里了（改名、删掉或换了机器？）。`
      + `没有替你换成别的文件，请在「选择LoRA」里重选一个。`,
    );
  }

  // 5) 采样器按类型收敛（Fun PDD 只认 euler）
  const allowed = SAMPLER_BY_KIND[kind] ?? SAMPLER_BY_KIND.viggle;
  if (!allowed.includes(samplerW?.value)) setValue(node, samplerW, "euler");

  // 6) 主动切类型时不换文件 —— 文件是你的选择，节点只管按上面那个类型去加载它。
  //    万一选中的文件其实是另一路的（文件名能认出来的那种），控制台提一句，
  //    由你自己决定是留着还是换一个：悄悄替你换，等于把「用哪个 LoRA」这个决定也收走了。
  //    sigma 也不用管，它是节点内部按类型算的，切了类型数值自然就换了。
  if (source === "kind") {
    const guess = guessKind(file);
    if (guess && guess !== kind) {
      console.warn(
        `[Josia实验/Qwen加速] 现在选的是「${file}」，看名字是 ${KINDS[guess].label} 那一路，`
        + `但类型已切成「${KINDS[kind].label}」。没替你换文件 —— 加载方式会对不上，`
        + `要的话请在「选择LoRA」里手动换一个。`,
      );
    }
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
  TURBO_SENTINEL,
  KINDS,
  KIND_LABELS,
  KIND_KEYS,
  guessKind,
  matchFile,
  fallbackFile,
  sync,
};
