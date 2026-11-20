/*
 * Josia媒体枢纽（接线板）—— 前端动态端口
 *
 * 输入单口「媒体总线」接 Josia媒体中枢；一个「端口常驻」开关（默认开）：
 *   关：按上游实际有效媒体数（有 path 且未禁用）生成输出端口
 *   开：按上游配置路数生成端口（空位也占端口）
 * 输出端口顺序恒为 图片→视频→音频，与媒体位置一一对应。
 *
 * 上游路数/媒体是 JS 状态，没有事件推送，用 onDrawBackground 每帧轻探签名，
 * 变化才重建端口（复用 bbox 节点已验证的逐帧轻探模式）。
 */
import { app } from "../../../scripts/app.js";

const NODE_NAME = "JosiaMediaSwitchboard";
const GROUPS = ["images", "videos", "audios"];
const MAX = { images: 24, videos: 6, audios: 6 };
const TYPE = { images: "IMAGE", videos: "VIDEO", audios: "AUDIO" };
const CN = { images: "图片", videos: "视频", audios: "音频" };
// 端口名统一英文，与后端 RETURN_NAMES 一致：刷新后静态端口与动态端口不割裂
const PORT_LABEL = { images: "IMAGE", videos: "VIDEO", audios: "AUDIO" };

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

// 从输入口连线找上游媒体中枢节点
function upstreamHub(node) {
  try {
    const input = (node.inputs || []).find((i) => i && i.name === "媒体总线");
    if (!input || input.link == null) return null;
    const link = app.graph.links[input.link];
    if (!link) return null;
    const up = app.graph.getNodeById(link.origin_id);
    if (!up || up.comfyClass !== "JosiaMediaHub") return null;
    return up;
  } catch (e) { return null; }
}

// 读上游状态 → {配置数, 有效数}
function readUpstream(up) {
  const cfg = { images: 0, videos: 0, audios: 0 };
  const valid = { images: 0, videos: 0, audios: 0 };
  if (!up) return { cfg, valid };
  const wName = { images: "图片路数", videos: "视频路数", audios: "音频路数" };
  GROUPS.forEach((g) => {
    const w = findWidget(up, wName[g]);
    const v = w ? parseInt(w.value, 10) : 0;
    cfg[g] = Math.min(MAX[g], Math.max(0, isNaN(v) ? 0 : v));
  });
  const wd = findWidget(up, "media_data");
  let data = {};
  try { data = JSON.parse(wd && wd.value ? wd.value : "{}") || {}; } catch (e) {}
  GROUPS.forEach((g) => {
    const arr = Array.isArray(data[g]) ? data[g] : [];
    for (let i = 0; i < cfg[g]; i++) {
      const it = arr[i];
      if (it && typeof it === "object" && it.path && !it.disabled) valid[g]++;
    }
  });
  return { cfg, valid };
}

function desiredPorts(up, full) {
  const { cfg, valid } = readUpstream(up);
  const n = full ? cfg : valid;
  const ports = [];
  GROUPS.forEach((g) => {
    for (let i = 0; i < n[g]; i++) {
      ports.push({ name: PORT_LABEL[g] + "_" + (i + 1), type: TYPE[g] });
    }
  });
  return ports;
}

function portsSignature(ports) {
  return ports.map((p) => p.name + ":" + p.type).join("|");
}

app.registerExtension({
  name: "Josia.MediaSwitchboard",
  async nodeCreated(node) {
    if (node.comfyClass !== NODE_NAME) return;
    // sig 初值用不可能值，确保首次必定执行一次 applyPorts 清空静态默认端口。
    // forceFit：首次创建/载入工作流时把静态 36 端口留下的虚高尺寸压到最小。
    const st = node._jmehSwitch = {
      sig: "__INIT__", lastUp: null, lastFull: null,
      forceFit: true, lastPorts: -1, userSized: false, apply: null,
    };

    const getFull = () => {
      const w = findWidget(node, "端口常驻");
      // 与后端默认一致：默认开启；只有明确 false 才当关闭
      return w ? !(w.value === false || w.value === "false") : true;
    };

    // 载入时的最小尺寸：后端静态声明了 36 个输出，ComfyUI 的 setInitialSize
    // 会把节点撑得极高；清空端口后必须同步收缩。端口变多则按需增高；用户手动
    // 拉高的尺寸保留，不擅自往下压。
    function fitSize(force) {
      let needH;
      try { needH = node.computeSize()[1]; } catch (e) { return; }
      if (!isFinite(needH)) return;
      const curH = node.size[1] || 0;
      // 未手动拉过时双向贴合端口数；手动拉过后保留用户高度，但端口变多仍增高。
      if (force || curH < needH || (!st.userSized && curH > needH)) {
        node.setSize([Math.max(node.size[0] || 0, 160), needH]);
        node.setDirtyCanvas(true, true);
      }
    }

    const origResize = node.onResize;
    node.onResize = function () {
      const r = origResize ? origResize.apply(this, arguments) : undefined;
      try {
        // 只有画布拖拽触发的 setSize 才算用户主动改尺寸；代码内的自适应
        // setSize（以及 ComfyUI 载入时的 setSize）不应把节点锁成手动模式。
        if (app.canvas && app.canvas.resizing_node === node) st.userSized = true;
      } catch (e) {}
      return r;
    };

    function applyPorts() {
      const up = upstreamHub(node);
      const full = getFull();
      const ports = desiredPorts(up, full);
      const sig = portsSignature(ports);
      const force = st.forceFit;
      if (sig === st.sig && !force) return;
      st.sig = sig;
      st.lastUp = up ? up.id : null;
      st.lastFull = full;
      try {
        while (node.outputs && node.outputs.length) node.removeOutput(node.outputs.length - 1);
        ports.forEach((p) => node.addOutput(p.name, p.type));
        fitSize(force);
        node.setDirtyCanvas(true, true);
      } catch (e) {}
      st.lastPorts = ports.length;
      st.forceFit = false;
    }
    st.apply = applyPorts;

    // 每帧轻探：上游连线/路数/媒体或开关变化才重建端口
    const origDraw = node.onDrawBackground;
    node.onDrawBackground = function () {
      const r = origDraw ? origDraw.apply(this, arguments) : undefined;
      try { applyPorts(); } catch (e) {}
      return r;
    };

    // 开关 widget 变化时立即刷新（不等下一帧）
    const wFull = findWidget(node, "端口常驻");
    if (wFull) {
      const orig = wFull.callback;
      wFull.callback = function (value) {
        if (arguments.length && value !== undefined) {
          wFull.value = value === true || value === "true";
        }
        if (typeof orig === "function") {
          try { orig.apply(this, arguments); } catch (e) {}
        }
        try { applyPorts(); } catch (e) {}
      };
    }

    // 连线变化也立刻刷新
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function () {
      const r = origConn ? origConn.apply(this, arguments) : undefined;
      try { applyPorts(); } catch (e) {}
      return r;
    };

    // 节点创建即清空静态默认端口（未接入时不应有任何输出端口）
    try { applyPorts(); } catch (e) {}
  },
  // 工作流载入时 ComfyUI 会用保存的 size 覆盖节点尺寸（那是 36 端口遗留的虚高值），
  // 载入钩子在覆盖之后再压回最小。
  loadedGraphNode(node) {
    if (node.comfyClass !== NODE_NAME) return;
    const st = node._jmehSwitch;
    if (!st || typeof st.apply !== "function") return;
    st.forceFit = true;
    try { st.apply(); } catch (e) {}
  },
});
