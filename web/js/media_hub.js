/*
 * Josia媒体中枢 —— 前端资产面板
 *
 * 数据契约：隐藏 widget media_data (JSON) 是唯一真值，DOM 面板 serialize:false。
 * 路数：隐藏 INT widget 图片/视频/音频路数由自绘 ± 按钮驱动。
 * 输出：单根「媒体总线」，不再有几十个可见端口。
 * 上传：走 /josia_media_hub/upload 流式路由（绕开官方 100MB 限制）。
 */
import { app } from "../../../scripts/app.js";

// 媒体总线专属配色：让 JMEH_BUNDLE 端口在画布上与其他类型一眼区分。
// ComfyUI 在节点定义加载时会按端口 type 自动注册类型（registered_slot_*_types），
// 唯独颜色需在此显式登记。注意新版前端 loadLinkColorPalette 会用
// Object.assign(canvas.default_connection_color_byType, allTypes→"", userPalette)
// 重置亮色表，直接写值会被覆盖；故用 getter 兜底，读 JMEH_BUNDLE 时恒返回专属色。
const BUNDLE_TYPE = "JMEH_BUNDLE";
const BUNDLE_COLOR_ON = "#d26bd8";
const BUNDLE_COLOR_OFF = "#7a3d80";
function registerBundleColor() {
  try {
    const c = app.canvas;
    if (!c) return false;
    if (c.__jmehColorHooked) return true;
    for (const [table, color] of [
      ["default_connection_color_byType", BUNDLE_COLOR_ON],
      ["default_connection_color_byTypeOff", BUNDLE_COLOR_OFF],
    ]) {
      if (!c[table]) c[table] = {};
      const real = c[table];
      real[BUNDLE_TYPE] = color;
      // 劫持表的 getter：每次读取都兜底重灌 JMEH_BUNDLE，抗
      // loadLinkColorPalette 的 Object.assign(allTypes→"", userPalette) 重置。
      Object.defineProperty(c, table, {
        configurable: true,
        enumerable: true,
        get() { real[BUNDLE_TYPE] = color; return real; },
      });
    }
    // 新版 Vue 画布用 CSS 变量 --color-datatype-<TYPE> 给端口/连线着色，一并设置。
    try {
      document.documentElement.style.setProperty(
        "--color-datatype-" + BUNDLE_TYPE, BUNDLE_COLOR_ON
      );
    } catch (e) {}
    c.__jmehColorHooked = true;
    return true;
  } catch (e) { return false; }
}
registerBundleColor();

const NODE_NAME = "JosiaMediaHub";
const MAX = { images: 24, videos: 6, audios: 6 };
// 最小宽度：保证「点击 / 拖拽上传视频」一行完整显示不换行
const MIN_W = 360;
const GROUPS = ["images", "videos", "audios"];
// 音频波形解码结果缓存（按路径），避免频繁增减路数时反复 fetch+decodeAudioData。
const _waveCache = new Map();
// 媒体列数（默认 3），由设置面板滑块控制；每个节点实例独立存 node.properties.jmehCols。
const DEFAULT_COLS = 3;
const MIN_COLS = 1, MAX_COLS = 6;
// 与 CSS .jmeh-grid 的 gap 一致；运行时再从 computedStyle 读取校准。
const GRID_GAP = 6;

const GROUP_META = {
  images: {
    label: "image", groupName: "图像", countWidget: "图片路数",
    accept: ".png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,image/*",
    exts: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
    empty: "点击 / 拖拽上传图片",
    icon: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  },
  videos: {
    label: "video", groupName: "视频", countWidget: "视频路数",
    accept: ".mp4,.webm,.mkv,.mov,.avi,.m4v,video/*",
    exts: ["mp4", "webm", "mkv", "mov", "avi", "m4v"],
    empty: "点击 / 拖拽上传视频",
    icon: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 8l6 4-6 4z" fill="currentColor" stroke="none"/></svg>',
  },
  audios: {
    label: "audio", groupName: "音频", countWidget: "音频路数",
    accept: ".mp3,.wav,.ogg,.flac,.m4a,.aac,.opus,audio/*",
    exts: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"],
    empty: "点击 / 拖拽上传音频",
    icon: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  },
};

const STYLES = `
.jmeh-root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#d8d8d8;
  background:linear-gradient(180deg,rgba(30,30,36,.97),rgba(22,22,27,.97));
  border:1px solid #444;border-radius:6px;padding:8px 8px 10px;box-sizing:border-box;
  min-width:300px;height:100%;}
.jmeh-root *{box-sizing:border-box;}
.jmeh-counters{display:flex;align-items:center;justify-content:space-between;gap:4px;
  padding:2px 2px 8px;}
/* 设置齿轮：正方形按钮，内含描边齿轮 SVG（lucide settings 风格） */
.jmeh-gear{flex:none;width:24px;height:24px;padding:3px;margin-left:2px;border:1px solid #5a5a66;
  border-radius:4px;background:#3a3a44;color:#c8d0da;cursor:pointer;display:flex;
  align-items:center;justify-content:center;}
.jmeh-gear:hover{background:#52525f;border-color:#8a7fd0;color:#e0d8ff;}
.jmeh-gear svg{width:100%;height:100%;display:block;}
.jmeh-panel{position:fixed;z-index:100001;width:270px;pointer-events:auto;
  background:#1e1e1e;color:#e6e6e6;border:1px solid #4a4a4a;border-radius:8px;
  box-shadow:0 8px 26px rgba(0,0,0,.6);font:12px sans-serif;overflow:hidden;}
.jmeh-panel-bar{display:flex;align-items:center;padding:8px 10px;cursor:move;
  background:#2a2a2a;border-bottom:1px solid #3a3a3a;user-select:none;font-weight:bold;font-size:13px;}
.jmeh-panel-close{margin-left:auto;cursor:pointer;color:#aaa;padding:0 2px;}
.jmeh-panel-body{padding:10px 12px 12px;}
.jmeh-panel-row{margin-bottom:12px;}
.jmeh-panel-head{display:flex;justify-content:space-between;margin-bottom:5px;}
.jmeh-panel-val{color:#b39ddb;font-variant-numeric:tabular-nums;}
.jmeh-panel input[type=range]{width:100%;accent-color:#8a7fd0;cursor:pointer;}
.jmeh-panel-hint{color:#777;font-size:11px;text-align:center;margin-top:2px;}
.jmeh-counter{display:flex;align-items:center;gap:3px;}
.jmeh-counter-name{font-size:12px;font-weight:600;color:#dcdce4;margin-right:1px;}
.jmeh-counter-num{font-size:11px;font-weight:500;color:#b9b9c4;min-width:13px;text-align:center;
  font-variant-numeric:tabular-nums;}
.jmeh-step{display:flex;gap:2px;}
.jmeh-stepbtn{width:22px;height:22px;line-height:1;border:1px solid #555;border-radius:4px;
  background:#3a3a44;color:#f0f0f5;font-size:15px;font-weight:600;cursor:pointer;
  display:flex;align-items:center;justify-content:center;padding:0;}
.jmeh-stepbtn:hover{background:#52525f;border-color:#8a7fd0;}
.jmeh-stepbtn:active{background:#6d5fc0;}
.jmeh-stepbtn:disabled{opacity:.35;cursor:default;}
.jmeh-group{margin-bottom:8px;}
.jmeh-group:last-child{margin-bottom:0;}
.jmeh-gtitle{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:300;
  color:#9a9aa6;margin:0 0 5px 1px;letter-spacing:.4px;white-space:nowrap;}
.jmeh-gtitle::before,.jmeh-gtitle::after{content:"";flex:1;height:1px;background:#4a4a55;}
.jmeh-grid{display:grid;gap:6px;}
.jmeh-grid.images,.jmeh-grid.videos,.jmeh-grid.audios{grid-template-columns:repeat(var(--jmeh-cols,3),minmax(0,1fr));}
.jmeh-card{position:relative;width:100%;aspect-ratio:1/1;border:1px solid #4a4a54;
  border-radius:4px;background:#26262c;overflow:hidden;cursor:pointer;
  transition:border-color .12s,box-shadow .12s;}
.jmeh-card:hover{border-color:#8a7fd0;box-shadow:0 0 0 1px rgba(160,140,255,.3);}
.jmeh-card.filled{background:#1a1a20;}
.jmeh-card.disabled{opacity:.5;border-color:#8b5cf6;box-shadow:inset 0 0 0 2px #7c3aed;}
.jmeh-card.disabled::after{content:"";position:absolute;inset:0;background:rgba(124,58,237,.26);pointer-events:none;}
.jmeh-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:5px;text-align:center;padding:4px;font-size:10px;font-weight:300;
  color:#9a9aa6;line-height:1.3;white-space:nowrap;overflow:hidden;}
.jmeh-empty-icon{width:38%;height:38%;max-width:56px;max-height:56px;color:#5c5c6a;
  display:flex;align-items:center;justify-content:center;}
.jmeh-card:hover .jmeh-empty-icon{color:#8a7fd0;}
.jmeh-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
  background:#141418;display:block;pointer-events:none;}
.jmeh-wave{position:absolute;inset:0;width:100%;height:100%;background:#141418;pointer-events:none;}
.jmeh-badge{position:absolute;left:4px;bottom:4px;z-index:3;font-size:9px;font-weight:600;
  color:#fff;background:rgba(0,0,0,.6);border-radius:3px;padding:1px 4px;pointer-events:none;}
.jmeh-ban{position:absolute;inset:0;z-index:2;display:none;pointer-events:none;}
.jmeh-card.filled:not(.disabled):hover .jmeh-ban{display:block;
  background:radial-gradient(circle at center,rgba(20,20,28,.5),rgba(20,20,28,.62));}
.jmeh-card.disabled .jmeh-ban{display:block;}
.jmeh-ban svg{position:absolute;left:50%;top:50%;width:38px;height:38px;
  transform:translate(-50%,-50%);opacity:.92;}
/* 斜线端点正好落在圆环的描边中心线上（r=16，端点距中心 16），不外溢。 */
.jmeh-ban .ring{fill:none;stroke:#c4b5fd;stroke-width:3;}
.jmeh-ban .slash{stroke:#c4b5fd;stroke-width:3;stroke-linecap:butt;}
.jmeh-card.disabled .jmeh-ban .ring,
.jmeh-card.disabled .jmeh-ban .slash{stroke:#e9d5ff;}
.jmeh-actions{position:absolute;top:0;left:0;right:0;z-index:5;display:none;gap:3px;padding:3px;
  background:linear-gradient(180deg,rgba(0,0,0,.85),rgba(0,0,0,0));}
.jmeh-card:hover .jmeh-actions{display:flex;}
.jmeh-btn{height:22px;min-width:22px;padding:0 5px;border:1px solid #5a5a66;border-radius:4px;
  background:#33333c;color:#e8e8ee;font-size:12px;line-height:1;cursor:pointer;
  display:flex;align-items:center;justify-content:center;flex:1;}
.jmeh-btn:hover{background:#4a4a58;border-color:#8a7fd0;}
.jmeh-modal{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.72);
  display:none;align-items:center;justify-content:center;pointer-events:auto;}
.jmeh-modal.open{display:flex;}
.jmeh-modal-box{position:relative;max-width:92vw;max-height:92vh;background:#1c1c22;
  border:1px solid #555;border-radius:8px;padding:10px;box-shadow:0 12px 48px rgba(0,0,0,.7);
  display:flex;flex-direction:column;gap:8px;pointer-events:auto;}
.jmeh-modal-box img,.jmeh-modal-box video{max-width:88vw;max-height:78vh;border-radius:4px;display:block;background:#000;}
.jmeh-modal-box audio{width:min(70vw,560px);}
.jmeh-modal-head{display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12px;color:#bbb;}
.jmeh-close{width:24px;height:24px;border:1px solid #666;border-radius:4px;background:#333;
  color:#fff;font-size:15px;cursor:pointer;line-height:1;}
.jmeh-file{display:none;}
`;

let _injected = false;
function injectStyles() {
  if (_injected) return;
  _injected = true;
  const el = document.createElement("style");
  el.textContent = STYLES;
  document.head.appendChild(el);
}

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

function viewUrl(path) {
  const parts = String(path).replace(/\\/g, "/").split("/");
  const name = parts.pop() || "";
  const sub = parts.join("/");
  return "/api/view?filename=" + encodeURIComponent(name)
    + "&subfolder=" + encodeURIComponent(sub) + "&type=input";
}

function extOf(path) {
  const m = String(path).match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

function checkExt(file, exts) {
  const e = (file.name.match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
  if (!exts.includes(e)) {
    alert("文件类型不匹配：只接受 " + exts.map((x) => "." + x).join(" / "));
    return false;
  }
  return true;
}

let _modal = null;
function getModal() {
  if (_modal) return _modal;
  const m = document.createElement("div");
  m.className = "jmeh-modal";
  const box = document.createElement("div");
  box.className = "jmeh-modal-box";
  m.appendChild(box);
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(); });
  document.body.appendChild(m);
  _modal = m;
  return m;
}
function closeModal() {
  if (!_modal) return;
  _modal.classList.remove("open");
  const box = _modal.querySelector(".jmeh-modal-box");
  box.querySelectorAll("video").forEach(releaseMedia);
  while (box.firstChild) box.removeChild(box.firstChild);
}
function openPreview(group, path) {
  const m = getModal();
  const box = m.querySelector(".jmeh-modal-box");
  box.querySelectorAll("video").forEach(releaseMedia);
  while (box.firstChild) box.removeChild(box.firstChild);
  const head = document.createElement("div");
  head.className = "jmeh-modal-head";
  const title = document.createElement("span");
  title.textContent = GROUP_META[group].label + " 预览 · " + String(path).split("/").pop();
  const close = document.createElement("button");
  close.className = "jmeh-close";
  close.textContent = "×";
  close.onclick = closeModal;
  head.appendChild(title); head.appendChild(close); box.appendChild(head);
  const url = viewUrl(path);
  let media;
  if (group === "images") {
    media = document.createElement("img");
  } else if (group === "videos") {
    media = document.createElement("video");
    media.controls = true; media.autoplay = true; media.muted = false; media.playsInline = true;
  } else {
    media = document.createElement("audio");
    media.controls = true; media.autoplay = true;
  }
  media.src = url;
  box.appendChild(media);
  m.classList.add("open");
}

// 彻底释放媒体元素：DOM 移除本身不会停解码/清缓冲，必须 pause + 清 src + load()。
// 否则频繁增减路数 / 反复开关预览会积累游离媒体上下文，拖垮主线程与解码器。
function releaseMedia(el) {
  if (!el || el.tagName !== "VIDEO") return;
  try { el.pause(); } catch (e) {}
  try { el.removeAttribute("src"); el.load(); } catch (e) {}
}

async function drawWave(canvas, path) {
  const g = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  g.fillStyle = "#2a2a32"; g.fillRect(0, 0, w, h);
  let data = _waveCache.get(path);
  if (!data) {
    try {
      const resp = await fetch(viewUrl(path));
      const buf = await resp.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        try { data = (await ctx.decodeAudioData(buf)).getChannelData(0); }
        finally { ctx.close(); }
      }
      if (data) _waveCache.set(path, data);
    } catch (e) { data = null; }
  }
  g.fillStyle = "#8a7fd0";
  if (data && data.length) {
    const step = Math.max(1, Math.floor(data.length / w));
    for (let x = 0; x < w; x++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const v = data[x * step + j] || 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const y1 = (1 - max) * h / 2, y2 = (1 - min) * h / 2;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  } else {
    g.fillStyle = "#55555f"; g.fillRect(0, h / 2 - 1, w, 2);
  }
}

async function initNode(node) {
  if (node._jmehReady) return;
  node._jmehReady = true;
  injectStyles();
  if (node.loaded && typeof node.loaded.then === "function") {
    try { await node.loaded; } catch (e) {}
  }

  const countW = {
    images: findWidget(node, "图片路数"),
    videos: findWidget(node, "视频路数"),
    audios: findWidget(node, "音频路数"),
  };
  const wData = findWidget(node, "media_data");
  if (!wData || GROUPS.some((g) => !countW[g])) return;
  wData.hidden = true;
  // 三个路数是后端 INPUT_TYPES 的必需参数，必须留在 widgets 里供取值传参，
  // 只隐藏显示（hidden + inputEl/element display:none），不 removeWidget。
  GROUPS.forEach((g) => {
    const w = countW[g];
    w.hidden = true;
    if (w.inputEl) w.inputEl.style.display = "none";
    if (w.element) w.element.style.display = "none";
  });

  function counts() {
    const r = {};
    GROUPS.forEach((g) => {
      const v = parseInt(countW[g].value, 10);
      r[g] = Math.min(MAX[g], Math.max(0, isNaN(v) ? 0 : v));
    });
    return r;
  }

  // 媒体列数：每节点独立，存 node.properties.jmehCols 随工作流持久化。
  function getCols() {
    const v = parseInt(node.properties?.jmehCols, 10);
    return Math.min(MAX_COLS, Math.max(MIN_COLS, isNaN(v) ? DEFAULT_COLS : v));
  }
  let cols = getCols();
  function applyCols() {
    cols = getCols();
    root.style.setProperty("--jmeh-cols", String(cols));
  }

  let state = { images: [], videos: [], audios: [] };
  function normalize() {
    GROUPS.forEach((g) => {
      while (state[g].length < MAX[g]) state[g].push(null);
      if (state[g].length > MAX[g]) state[g].length = MAX[g];
      state[g] = state[g].map((it) => (it && typeof it === "object" && it.path)
        ? { path: String(it.path), disabled: !!it.disabled } : null);
    });
  }
  try {
    const parsed = JSON.parse(wData.value || "{}");
    if (parsed && typeof parsed === "object") {
      GROUPS.forEach((g) => { if (Array.isArray(parsed[g])) state[g] = parsed[g]; });
    }
  } catch (e) {}
  normalize();

  // 内部写回时记下字符串：新版 DOMWidgetImpl.set 会同步回调 widget.callback，
  // 若不认出是自己写的，就会 renderAll 把同组视频 src 清掉重载、画面闪回首帧。
  let lastWritten = null;
  function writeData() {
    const s = JSON.stringify(state);
    lastWritten = s;
    wData.value = s;
    node.setDirtyCanvas(true, true);
  }

  const root = document.createElement("div");
  root.className = "jmeh-root";
  applyCols();

  const counters = document.createElement("div");
  counters.className = "jmeh-counters";
  const numEls = {}, btnEls = {};
  GROUPS.forEach((g) => {
    const meta = GROUP_META[g];
    const box = document.createElement("div");
    box.className = "jmeh-counter";
    const name = document.createElement("span");
    name.className = "jmeh-counter-name";
    name.textContent = meta.groupName;
    const num = document.createElement("span");
    num.className = "jmeh-counter-num";
    numEls[g] = num;
    const step = document.createElement("div");
    step.className = "jmeh-step";
    const minus = document.createElement("button");
    minus.className = "jmeh-stepbtn"; minus.textContent = "−";
    minus.title = "减少" + meta.groupName;
    const plus = document.createElement("button");
    plus.className = "jmeh-stepbtn"; plus.textContent = "+";
    plus.title = "增加" + meta.groupName;
    btnEls[g] = { minus, plus };
    const apply = (delta) => {
      const w = countW[g];
      const nv = Math.min(MAX[g], Math.max(0, counts()[g] + delta));
      w.value = nv;
      if (typeof w.callback === "function") {
        try { w.callback(nv); } catch (e) {}
      }
      onCountsChange();
    };
    minus.onclick = () => apply(-1);
    plus.onclick = () => apply(1);
    step.appendChild(minus); step.appendChild(plus);
    box.appendChild(name); box.appendChild(num); box.appendChild(step);
    counters.appendChild(box);
  });

  // ── 设置齿轮按钮（counters 行末尾）──
  // 规范细线齿轮（lucide settings）：8 齿外圈 + 中心圆，stroke 1.5、圆角端点。
  const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>'
    + '<circle cx="12" cy="12" r="3"/></svg>';
  const gear = document.createElement("button");
  gear.className = "jmeh-gear"; gear.title = "媒体设置";
  gear.innerHTML = GEAR_SVG;
  counters.appendChild(gear);
  root.appendChild(counters);

  // 滑块定义：列数 + 三路数量（与路数 widget 双向联动）
  const PANEL_DEFS = [
    { id: "cols", name: "媒体列数", min: MIN_COLS, max: MAX_COLS, step: 1 },
    { id: "images", name: "图片数量", min: 0, max: MAX.images, step: 1 },
    { id: "videos", name: "视频数量", min: 0, max: MAX.videos, step: 1 },
    { id: "audios", name: "音频数量", min: 0, max: MAX.audios, step: 1 },
  ];
  let panel = null;
  let panelOutside = null;
  function panelRead(def) {
    return def.id === "cols" ? cols : counts()[def.id];
  }
  function panelWrite(def, v) {
    if (def.id === "cols") {
      node.properties = node.properties || {};
      node.properties.jmehCols = v;
      applyCols();
      renderAll(); applySize();
    } else {
      const w = countW[def.id];
      w.value = v;
      if (typeof w.callback === "function") {
        try { w.callback(v); } catch (e) {}
      }
      onCountsChange();
    }
  }
  function panelClose() {
    if (panel) { panel.remove(); panel = null; }
    if (panelOutside) {
      document.removeEventListener("pointerdown", panelOutside, true);
      panelOutside = null;
    }
  }
  gear.onclick = (ev) => {
    ev.stopPropagation();
    if (panel) { panelClose(); return; }
    panel = document.createElement("div");
    panel.className = "jmeh-panel";
    const bar = document.createElement("div");
    bar.className = "jmeh-panel-bar";
    bar.textContent = "⚙ 媒体设置";
    const close = document.createElement("span");
    close.className = "jmeh-panel-close"; close.textContent = "✕";
    close.onclick = panelClose;
    bar.appendChild(close);
    panel.appendChild(bar);
    const body = document.createElement("div");
    body.className = "jmeh-panel-body";
    PANEL_DEFS.forEach((def) => {
      const row = document.createElement("div"); row.className = "jmeh-panel-row";
      const head = document.createElement("div"); head.className = "jmeh-panel-head";
      const lab = document.createElement("span"); lab.textContent = def.name;
      const val = document.createElement("span"); val.className = "jmeh-panel-val";
      head.appendChild(lab); head.appendChild(val);
      const input = document.createElement("input");
      input.type = "range"; input.min = String(def.min); input.max = String(def.max);
      input.step = String(def.step); input.value = String(panelRead(def));
      val.textContent = input.value;
      input.addEventListener("input", () => {
        const v = Number(input.value);
        val.textContent = String(v);
        panelWrite(def, v);
      });
      row.appendChild(head); row.appendChild(input); body.appendChild(row);
    });
    const hint = document.createElement("div");
    hint.className = "jmeh-panel-hint"; hint.textContent = "拖动滑块即时生效";
    body.appendChild(hint); panel.appendChild(body);
    document.body.appendChild(panel);
    // 点击面板外任意区域关闭（含画布/其他节点/空白）；capture 阶段挂，
    // 齿轮自身与面板内的点击由 contains 判定放过，避免刚开即关。
    panelOutside = (ev) => {
      if (!panel) return;
      if (panel.contains(ev.target) || gear.contains(ev.target)) return;
      panelClose();
    };
    document.addEventListener("pointerdown", panelOutside, true);
    // 拖动逻辑
    let drag = null;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === close) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    const onMove = (e) => {
      if (!drag || !panel) return;
      const r = panel.getBoundingClientRect();
      panel.style.left = Math.max(4, Math.min(window.innerWidth - r.width - 4, e.clientX - drag.dx)) + "px";
      panel.style.top = Math.max(4, Math.min(window.innerHeight - r.height - 4, e.clientY - drag.dy)) + "px";
    };
    const onUp = () => {
      drag = null;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    bar.addEventListener("pointerdown", () => {
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    // 定位到齿轮附近
    const gr = gear.getBoundingClientRect(), pr = panel.getBoundingClientRect();
    panel.style.left = Math.max(4, Math.min(window.innerWidth - pr.width - 4, gr.left - pr.width - 8)) + "px";
    panel.style.top = Math.max(4, Math.min(window.innerHeight - pr.height - 4, gr.top + 8)) + "px";
  };

  const grids = {};
  GROUPS.forEach((g) => {
    const group = document.createElement("div");
    group.className = "jmeh-group";
    const title = document.createElement("div");
    title.className = "jmeh-gtitle";
    title.textContent = GROUP_META[g].label + " 0";
    const grid = document.createElement("div");
    grid.className = "jmeh-grid " + g;
    group.appendChild(title); group.appendChild(grid);
    root.appendChild(group);
    grids[g] = { grid, title };
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.className = "jmeh-file";
  root.appendChild(fileInput);

  root.addEventListener("wheel", (e) => {
    try {
      const lg = app.canvas && app.canvas.canvas;
      if (lg) {
        lg.dispatchEvent(new WheelEvent("wheel", {
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
          clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey,
          bubbles: true, cancelable: true,
        }));
      }
    } catch (err) {}
  }, { passive: false });

  // 内容真实高度：直接读 DOM（卡片是正方形，高度随节点宽度变，绝不能写死）。
  // root 此时高度由 ComfyUI 外壳撑开，scrollHeight >= 内容实际高度；
  // 用各 group 的 offsetHeight 累加更精确（避开 root 被撑大带来的空白）。
  function contentHeight() {
    const cs = getComputedStyle(root);
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    let h = padT + padB;
    const counters = root.querySelector(".jmeh-counters");
    if (counters) h += counters.offsetHeight;
    const groups = root.querySelectorAll(".jmeh-group");
    groups.forEach((g, i) => {
      h += g.offsetHeight;
      const m = getComputedStyle(g);
      if (i < groups.length - 1) h += parseFloat(m.marginBottom) || 0;
    });
    return Math.ceil(h);
  }

  // 拖拽要求同一帧出结果：DOM 宽度由 ComfyUI 的 Vue 包装层按 node.size 在下一帧
  // 才更新，直接读 offsetHeight 拿到的是旧宽度下的卡片高度 ⇒ 外框先变、内容后变。
  // 这里在首次 reflow 后量一次布局常量，之后用解析式从「节点宽度 + 路数」直接算
  // 内容高，onResize 内同步写 size[1]，拖拽全程零延迟。
  let metrics = null;
  let layoutMaxH = 6000;
  let _lastSig = "";
  function captureMetrics() {
    if ((node.size[0] || 0) < MIN_W) return false;
    const cs = getComputedStyle(root);
    const countersEl = root.querySelector(".jmeh-counters");
    const gs = [...root.querySelectorAll(".jmeh-group")];
    const grid0 = grids[GROUPS[0]].grid;
    const gridW = grid0 ? grid0.clientWidth : 0;
    if (!gridW || !countersEl || gs.length !== GROUPS.length) return false;
    const gcs = getComputedStyle(grid0);
    metrics = {
      padV: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
        + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
      countersH: countersEl.offsetHeight,
      titleH: gs.map((g) => {
        const t = g.querySelector(".jmeh-gtitle");
        return t ? t.offsetHeight + (parseFloat(getComputedStyle(t).marginBottom) || 0) : 0;
      }),
      marginB: gs.map((g) => parseFloat(getComputedStyle(g).marginBottom) || 0),
      gap: parseFloat(gcs.rowGap) || parseFloat(gcs.gap) || GRID_GAP,
      widthOffset: node.size[0] - gridW,
    };
    return true;
  }

  function contentHeightFor(W, c) {
    if (!metrics) return contentHeight();
    const gridW = Math.max(0, W - metrics.widthOffset);
    const card = Math.max(0, (gridW - metrics.gap * (cols - 1)) / cols);
    let h = metrics.padV + metrics.countersH;
    GROUPS.forEach((g, i) => {
      const rows = Math.ceil((c[g] || 0) / cols);
      const gridH = rows > 0 ? rows * card + (rows - 1) * metrics.gap : 0;
      h += (metrics.titleH[i] || 0) + gridH
        + (i < GROUPS.length - 1 ? (metrics.marginB[i] || 0) : 0);
    });
    return Math.ceil(h);
  }

  function signature() {
    const c = counts();
    return Math.max(node.size[0] || 0, MIN_W) + "|" + cols + "|"
      + c.images + "," + c.videos + "," + c.audios;
  }
  const domWidget = node.addDOMWidget("media_panel", "jmeh_panel", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 0,
    // 上限钳到「内容高 + 2×margin」：新版 Vue 画布拿到 computedHeight 后会
    // 再扣掉上下各 margin(默认 10) 才是 DOM 容器真实高度，不补这 20px 会裁掉卡片。
    getMaxHeight: () => layoutMaxH,
  });
  node._jmehDom = domWidget;
  const DOM_MARGIN = domWidget.margin ?? 10;
  // 外壳固定结构高（标题栏+端口区+隐藏控件占位，实测 46）+ Vue 扣除的上下 margin。
  const CHROME_H = 46;

  // 内容高随宽度变化：宽度变 → 正方形卡片变 → 目标节点高变。
  // 用 rAF 合并所有尺寸请求，等 DOM 按新宽度 reflow 后再读 contentHeight()，
  // 避免拖拽/连续 setSize 时读到旧布局造成抖动或出框。
  let _sizeRAF = 0;
  let _committing = false;
  function commitSize(w, h) {
    if (_committing) return;
    _committing = true;
    try { node.setSize([w, h]); } finally { _committing = false; }
    node.setDirtyCanvas(true, true);
  }
  function targetHeight(W) {
    const w = Math.max(W || node.size[0] || MIN_W, MIN_W);
    const contentH = contentHeightFor(w, counts());
    return { w, h: Math.ceil(contentH + CHROME_H), contentH };
  }
  function applySize() {
    if (_sizeRAF) return;
    _sizeRAF = requestAnimationFrame(() => {
      _sizeRAF = 0;
      if (!root.isConnected) return;
      if ((node.size[0] || 0) < MIN_W) {
        node.size[0] = MIN_W;
        node.setDirtyCanvas(true, true);
      }
      if (!metrics && !captureMetrics()) return;
      const t = targetHeight(node.size[0]);
      layoutMaxH = t.contentH + 2 * DOM_MARGIN;
      if (Math.abs(node.size[1] - t.h) > 1) commitSize(t.w, t.h);
      _lastSig = signature();
    });
  }

  async function uploadFile(file, group, idx) {
    if (!checkExt(file, GROUP_META[group].exts)) return;
    try {
      const resp = await fetch(
        "/josia_media_hub/upload?name=" + encodeURIComponent(file.name),
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file }
      );
      if (!resp.ok) {
        let msg = "HTTP " + resp.status;
        try { const j = await resp.json(); if (j.error) msg = j.error; } catch (e) {}
        alert("上传失败：" + msg);
        return;
      }
      const data = await resp.json();
      const rel = data.subfolder ? data.subfolder + "/" + data.name : data.name;
      state[group][idx] = { path: rel, disabled: false };
      writeData(); renderGroup(group);
    } catch (e) {
      alert("上传失败：" + (e && e.message ? e.message : e));
    }
  }

  let pending = null;
  fileInput.onchange = () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (f && pending) uploadFile(f, pending.group, pending.idx);
    pending = null;
  };
  function pickFile(group, idx) {
    pending = { group, idx };
    fileInput.accept = GROUP_META[group].accept;
    fileInput.click();
  }

  function renderCard(group, idx) {
    const meta = GROUP_META[group];
    const item = state[group][idx];
    const card = document.createElement("div");
    card.className = "jmeh-card" + (item && item.path ? " filled" : "")
      + (item && item.disabled ? " disabled" : "");

    if (item && item.path) {
      if (group === "images") {
        const img = document.createElement("img");
        img.className = "jmeh-media"; img.src = viewUrl(item.path); img.alt = "";
        card.appendChild(img);
      } else if (group === "videos") {
        // 卡片只做「首帧静帧 + hover 按水平进度取帧」：不再循环播放，
        // 否则 N 路视频同时解码会持续吃满解码器，频繁增减路数时越来越卡。
        const vid = document.createElement("video");
        vid.className = "jmeh-media"; vid.src = viewUrl(item.path);
        vid.muted = true; vid.playsInline = true; vid.preload = "metadata";
        card.appendChild(vid);
        // 元数据就绪后定位到首帧（0.05s，避开门槛/黑场），保持暂停。
        const seekTo = (t) => {
          try {
            const d = vid.duration;
            if (d && isFinite(d) && d > 0) vid.currentTime = Math.max(0, Math.min(d - 0.01, t));
          } catch (e) {}
        };
        const firstFrame = () => seekTo(0.05);
        vid.addEventListener("loadedmetadata", firstFrame, { once: true });
        if (vid.readyState >= 1) firstFrame();
        // hover 划过：按占位水平位置(0~1)映射到视频进度，rAF 合并 mousemove，
        // 避免每像素触发 seek 造成解码风暴。停在哪就显示哪一帧的静帧。
        let seekRAF = 0, pendingT = 0;
        card.addEventListener("mousemove", (e) => {
          const r = card.getBoundingClientRect();
          if (!r.width) return;
          const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
          pendingT = ratio * (vid.duration && isFinite(vid.duration) ? vid.duration : 0);
          if (seekRAF) return;
          seekRAF = requestAnimationFrame(() => {
            seekRAF = 0;
            seekTo(pendingT);
          });
        });
        card._jmehRelease = () => { if (seekRAF) cancelAnimationFrame(seekRAF); releaseMedia(vid); };
      } else {
        const cv = document.createElement("canvas");
        cv.className = "jmeh-wave"; cv.width = 160; cv.height = 120;
        card.appendChild(cv); drawWave(cv, item.path);
      }
      const badge = document.createElement("div");
      badge.className = "jmeh-badge";
      badge.textContent = "#" + (idx + 1) + " " + extOf(item.path).toUpperCase();
      card.appendChild(badge);
    } else {
      const empty = document.createElement("div");
      empty.className = "jmeh-empty";
      const icon = document.createElement("div");
      icon.className = "jmeh-empty-icon";
      icon.innerHTML = meta.icon;
      const label = document.createElement("span");
      label.textContent = meta.empty;
      empty.appendChild(icon); empty.appendChild(label);
      card.appendChild(empty);
    }

    const ban = document.createElement("div");
    ban.className = "jmeh-ban";
    ban.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true">'
      + '<circle class="ring" cx="20" cy="20" r="16"/>'
      + '<line class="slash" x1="8.7" y1="8.7" x2="31.3" y2="31.3"/>'
      + '</svg>';
    card.appendChild(ban);

    // 空占位卡不生成左上角操作按钮：整卡可点击/拖拽上传，hover 仅边框高亮。
    if (item && item.path) {
      const acts = document.createElement("div");
      acts.className = "jmeh-actions";
      const mk = (txt, title, fn) => {
        const b = document.createElement("button");
        b.className = "jmeh-btn";
        b.textContent = txt; b.title = title;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        acts.appendChild(b);
      };
      mk("🔄", "更换", () => pickFile(group, idx));
      mk("✕", "关闭（清空此路）", () => {
        state[group][idx] = null; writeData(); renderGroup(group);
      });
      mk("🔍", "预览", () => openPreview(group, item.path));
      card.appendChild(acts);
    }

    card.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
    card.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadFile(f, group, idx);
    });
    card.onclick = () => {
      if (!item || !item.path) { pickFile(group, idx); return; }
      // 禁用只切这一张卡的 class：禁用态视觉全由 .disabled 驱动，
      // 整组重建会把同组其它视频的 src 清掉重载、画面闪回首帧。
      const it = state[group][idx];
      it.disabled = !it.disabled;
      writeData();
      card.classList.toggle("disabled", it.disabled);
    };
    return card;
  }

  function renderGroup(group) {
    const c = counts();
    const { grid, title } = grids[group];
    title.textContent = GROUP_META[group].label + " " + c[group];
    // 先释放旧卡片里的媒体（video 解码上下文 / seek rAF），再移除 DOM。
    [...grid.children].forEach((card) => {
      if (card._jmehRelease) card._jmehRelease();
    });
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    for (let i = 0; i < c[group]; i++) grid.appendChild(renderCard(group, i));
  }
  function renderAll() {
    GROUPS.forEach(renderGroup);
    const c = counts();
    GROUPS.forEach((g) => {
      numEls[g].textContent = String(c[g]);
      btnEls[g].minus.disabled = c[g] <= 0;
      btnEls[g].plus.disabled = c[g] >= MAX[g];
    });
  }

  function onCountsChange() {
    const c = counts();
    GROUPS.forEach((g) => { while (state[g].length < c[g]) state[g].push(null); });
    renderAll(); applySize(); writeData();
  }

  const origDataCb = wData.callback;
  wData.callback = function (v) {
    if (typeof origDataCb === "function") {
      try { origDataCb.apply(this, arguments); } catch (e) {}
    }
    try {
      // 内部 writeData() 触发的回调：state 已是真值，无需重建 UI。
      if (v === lastWritten) return;
      lastWritten = null;
      const parsed = JSON.parse(v || "{}");
      if (parsed && typeof parsed === "object") {
        GROUPS.forEach((g) => { if (Array.isArray(parsed[g])) state[g] = parsed[g]; });
        normalize(); renderAll();
      }
    } catch (e) {}
  };

  // 每帧只检测「宽度/路数签名」变化并触发 rAF 重算，不在每帧直接 setSize
  // （那会打断用户拖拽手感）。宽度下限在 applySize 的 rAF 里统一 clamp。
  const origOnDraw = node.onDrawBackground;
  node.onDrawBackground = function () {
    const r = origOnDraw ? origOnDraw.apply(this, arguments) : undefined;
    try {
      const sig = signature();
      if (sig !== _lastSig) {
        _lastSig = sig;
        applySize();
      }
    } catch (e) {}
    return r;
  };

  // 拖拽缩放：LiteGraph 在 onDrag 里先按「原始拖拽尺寸」写入 n.pos，再 setSize →
  // 触发本回调。这里把尺寸锁定到内容高，若不同步修正 pos，节点就会被带着平移
  // （上角拖 → 整体上下跑；左角拖到最小宽 → 继续带着横移）。
  // 先记录拖拽方向：findResizeDirection 由画布在 pointerdown 时调用，返回 NE/SE/SW/NW。
  const origFindDir = node.findResizeDirection;
  node.findResizeDirection = function (x, y) {
    const d = origFindDir ? origFindDir.call(this, x, y) : null;
    if (d) this._jmehResizeDir = d;
    return d;
  };
  const origResize = node.onResize;
  node.onResize = function (size) {
    const s = size || node.size;
    const rawW = s[0], rawH = s[1];
    try {
      if (!metrics) captureMetrics();
      if (metrics) {
        const w = Math.max(s[0] || MIN_W, MIN_W);
        const contentH = contentHeightFor(w, counts());
        layoutMaxH = contentH + 2 * DOM_MARGIN;
        s[0] = w;
        s[1] = Math.ceil(contentH + CHROME_H);
        _lastSig = signature();
      }
    } catch (e) {}
    // LiteGraph 的大小钳制里，W 方向锚定右边、N 方向锚定下边。尺寸被我改写后，
    // 把 pos 按「锚定边不动」拉回：newX = posX + rawW - finalW，Y 同理。
    if (app.canvas && app.canvas.resizing_node === node) {
      const dir = node._jmehResizeDir || "";
      if (dir.indexOf("W") >= 0 && s[0] !== rawW) node.pos[0] += rawW - s[0];
      if (dir.indexOf("N") >= 0 && s[1] !== rawH) node.pos[1] += rawH - s[1];
    }
    const r = origResize ? origResize.apply(this, arguments) : undefined;
    return r;
  };

  renderAll();
  applySize();
  writeData();
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "Josia.MediaHub",
  init() { registerBundleColor(); },
  async nodeCreated(node) {
    if (node.comfyClass === NODE_NAME) registerBundleColor();
    if (node.comfyClass !== NODE_NAME) return;
    try { await initNode(node); }
    catch (e) { console.error("[JosiaMediaHub] initNode 失败", e); }
  },
});
