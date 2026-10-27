/**
 * Josia框选编辑 —— 经典模式（1.0）下的「创建边界框」平替：编辑器内嵌在节点面板里。
 *
 * 官方那个「创建边界框」只在 2.0 前端能用：它的框编辑器是 V3 schema 的
 * BOUNDING_BOXES 控件，由 Vue 组件渲染，经典 LiteGraph 前端不认识这个控件类型。
 * 这里用「节点内嵌 DOM + 原生 canvas」自己实现，经典模式下完全可控。
 *
 * 节点布局（自上而下）：
 *   整体描述（多行提示词） / 画布宽度 / 画布高度 / 选择图像（combo）  ← 标准控件
 *   内嵌编辑器（一个 DOM widget）：
 *     [状态行 + ＋/🗑/清空] → 画布（有图＝变暗的图，无图＝网格）
 *     → 胶囊开关（物体|文字）→ 文字 / 描述 / 颜色 / 位置 → 框列表
 *
 * 图像来源（二选一，端口优先）：
 *   · 「选择图像」下拉（内部键名 image）：input 目录图像文件；原生上传按钮传图后进本下拉
 *   · 「底图」输入端口：实时显示上游节点的预览图（上游 imgs 一变就跟着刷）
 * 有图像 ⇒ 画布/坐标按图像尺寸走，画布宽度/高度灰化；无图像 ⇒ 按面板分辨率画网格画布。
 *
 * 数据流：编辑框 → 序列化成 JSON → 写进隐藏的「框数据」控件 → 后端解析。
 * 落盘的 JSON 与官方编辑器状态同构：[{x,y,w,h,type,text,desc,palette}]，坐标是 0~1 分数。
 * 框的顺序即层级：官方注释写明「背景元素先放、前景最后放」，这里沿用同一约定。
 *
 * 「边界框」输入端口（BOUNDING_BOXES）：接上游的框；编辑器为空时，后端在执行时
 * 按画布尺寸把像素框归一化后灌进来，经 onExecuted 的 ui.boxes 落进编辑器显示
 * （前端落盘后下次执行即视为手画的框，不再重复灌）。编辑器已有框时端口不生效。
 */
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const NODE_CLASS = "JosiaBBoxEdit";

/* 与后端 bbox_edit.py 的控件名严格一致 */
const W_WIDTH = "画布宽度";
const W_HEIGHT = "画布高度";
const W_STATE = "框数据";
const W_PROMPT = "整体描述";
const W_IMAGE = "image";
const PORT_BG = "底图";
const IMAGE_PLACEHOLDER = "🖼️请选择或上传图像…";

/* ============================ 尺寸常量 / 样式 ============================ */
const ROW_H = 22;              // 本包 22px 控件规范
const CANVAS_MIN_H = 120;      // 画布最小显示高（flex 布局下随节点伸缩，再小挤压绘框）
const HANDLE = 8;              // 缩放手柄命中半径（画布像素）
const SNAP_PX = 7;             // 吸附容差（画布显示像素）：目标线多近就吸过去
const EDGE_TOL = 6;            // 边线穿透选中容差（画布像素）：点距某选区边线 ≤ 此值即算「点中边线」
/* DOM 容器固定行总高（不含画布与列表，这两块自适应）：
 * 状态22 + 胶囊22 + 文字22 + 描述22 + 颜色16 + 位置22 + 行间gap 6×6=36 + 内边距上下12 = 174 */
const CHROME_H = 174;
const CANVAS_BASE_H = 240;     // 画布基准高（flex-grow 拉伸的起点）
/* 列表不设高度上限、不滚动：每增/删一个选区，列表就高/矮一行，
 * 节点高度按差值同步向下生长/收缩，画布（预览区）高度始终不变。 */
const LIST_EMPTY_H = 36;       // 空列表（提示行）的估高，只用于新节点初始尺寸
/* 「画面描述」文本框固定为小尺寸且**不随节点缩放撑大**：
 * 该 multiline 控件是「可增长控件」，靠 h-full 填满被分配到的槽位。直接写死 height 会
 * 锁死（放大留白、缩小溢出）；只压 min-height 仍会随节点放大撑大。正确做法是用
 * computeLayoutSize 返回固定 min==max，自由空间分配时它分到的额外空间为 0，节点放大
 * 多出的高度全部给下方编辑器（画布+列表）。PROMPT_TA_H＝文本框像素高（约 3 行），
 * PROMPT_SLOT_H＝控件槽位总高（含标签行）。 */
const PROMPT_TA_H = 56;
const PROMPT_SLOT_H = 80;
/* 节点外壳高（编辑器 DOM widget 之上的全部内容）：标题 + 输出端口区 + 标准控件
 * （画面描述多行固定 PROMPT_SLOT_H＝80；画布宽度/画布高度/图像下拉/原生上传按钮 各24）
 * + 余量。无头实测编辑器起点 y≈262（端口数/高度变化时需重新实测）。NODE_CHROME_H 仅用于
 * 新节点初始高，运行时编辑器按真实 DOM 控件 y 定位。 */
const NODE_CHROME_H = 262;
const NODE_MIN_W = 300;
/* 节点初始高：外壳 + 容器固定行 + 画布基准 + 空列表 */
const NODE_BASE_H = NODE_CHROME_H + CHROME_H + CANVAS_BASE_H + LIST_EMPTY_H;

/* 调色板（中文名用于悬停提示） */
const PALETTE = [
  { hex: "#e05252", name: "红" },
  { hex: "#e08b3f", name: "橙" },
  { hex: "#d9c441", name: "黄" },
  { hex: "#5fbf5f", name: "绿" },
  { hex: "#3fa9d9", name: "天蓝" },
  { hex: "#4f6fe0", name: "蓝" },
  { hex: "#a45fd9", name: "紫" },
  { hex: "#d94f9e", name: "粉" },
  { hex: "#8a8f98", name: "灰" },
  { hex: "#c9ced6", name: "浅灰" },
];

/**
 * 本扩展只在浏览器里做事（要 document 建 DOM）。被误 import 到非浏览器环境
 * （后端测试、Node 回归脚本）时整体不挂钩子，而不是抛错把整个模块连带崩掉。
 */
function hasDOM() {
  return typeof document !== "undefined" && !!document.createElement;
}

const STYLE_ID = "josia-bbox-edit-style";
const CSS = `
.jbee{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:6px;
  padding:6px;font-size:11px;color:var(--base-foreground,#fff);font-family:inherit;}
.jbee-btn{border-radius:999px;cursor:pointer;white-space:nowrap;padding:0 10px;height:${ROW_H}px;
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  border:1px solid var(--border-default,#494a50);background:rgba(128,128,128,.12);
  color:inherit;font-size:11px;font-family:inherit;}
.jbee-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jbee-btn:disabled{opacity:.4;cursor:default;}
.jbee-info{display:flex;align-items:center;gap:5px;}
.jbee-info .st{flex:1 1 auto;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.jbee-info .jbee-btn{padding:0 8px;}
.jbee-stage{border:1px solid var(--border-default,#494a50);border-radius:6px;
  background:#232529;overflow:hidden;flex:1 1 auto;min-height:${CANVAS_MIN_H}px;}
/* 「画面描述」文本框固定小尺寸：高度写死 + 不可手动拉伸，长文本内部滚动，不撑大节点。 */
.jbee-prompt textarea{height:${PROMPT_TA_H}px !important;min-height:${PROMPT_TA_H}px !important;
  max-height:${PROMPT_TA_H}px !important;resize:none !important;overflow:auto !important;}
.jbee-stage canvas{display:block;width:100%;height:100%;touch-action:none;cursor:crosshair;}
.jbee-tools{display:flex;align-items:center;gap:6px;}
.jbee-capsule{display:inline-flex;border:1px solid var(--border-default,#494a50);
  border-radius:999px;overflow:hidden;flex:0 0 auto;}
.jbee-capsule button{border:0;background:transparent;color:inherit;height:${ROW_H}px;
  padding:0 12px;cursor:pointer;font-size:11px;font-family:inherit;}
.jbee-capsule button.on{background:#3d7ef0;color:#fff;}
.jbee-capsule button:disabled{opacity:.4;cursor:default;}
.jbee-row{display:flex;align-items:center;gap:6px;}
.jbee-row label{flex:0 0 34px;opacity:.8;}
.jbee-row input[type=text],.jbee-row textarea{flex:1 1 auto;min-width:0;box-sizing:border-box;
  height:${ROW_H}px;padding:0 6px;border-radius:4px;border:1px solid var(--border-default,#494a50);
  background:rgba(128,128,128,.14);color:inherit;font-size:11px;font-family:inherit;}
.jbee-row input[readonly]{opacity:.7;}
.jbee-swatches{display:flex;flex-wrap:wrap;gap:4px;flex:1 1 auto;}
.jbee-sw{width:16px;height:16px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.25);}
.jbee-sw.on{outline:2px solid #fff;outline-offset:1px;}
.jbee-list{flex:0 0 auto;border-radius:6px;
  border:1px solid var(--border-default,#494a50);padding:3px;display:flex;flex-direction:column;gap:2px;}
.jbee-item{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:4px;cursor:pointer;user-select:none;
  font-size:11px;}
.jbee-item:hover{background:var(--secondary-background,#262729);}
.jbee-item.on{background:rgba(120,170,255,.22);outline:1px solid rgba(120,170,255,.5);}
.jbee-item .no{flex:0 0 auto;font-weight:600;opacity:.85;min-width:18px;}
.jbee-item .tx{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jbee-item .del{flex:0 0 auto;opacity:.55;cursor:pointer;padding:0 3px;}
.jbee-item .del:hover{opacity:1;color:#e05252;}
.jbee-empty{opacity:.55;padding:6px;text-align:center;}
.jbee-grip{flex:0 0 auto;cursor:grab;opacity:.45;user-select:none;touch-action:none;
  padding:0 3px;font-size:12px;line-height:1;}
.jbee-grip:hover{opacity:.9;}
.jbee-grip:active{cursor:grabbing;}
.jbee-item.dragging{opacity:.4;}
.jbee-item.drop-before{box-shadow:inset 0 2px 0 0 #6fb0ff;}
.jbee-item.drop-after{box-shadow:inset 0 -2px 0 0 #6fb0ff;}
.jbee-hint{opacity:.5;font-size:10px;padding:2px 4px 0;line-height:1.4;}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hexToRgb(hex) {
  const t = String(hex || "").replace("#", "");
  if (t.length === 3) return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`;
  return `#${t.slice(0, 6).padEnd(6, "0")}`;
}

/* ============================ 图像来源 ============================ */
/** 「底图」端口的上游预览图（前端给有预览的节点挂 imgs，图变了引用也会变）。 */
function upstreamImageEl(node) {
  const inp = (node.inputs || []).find((i) => i && i.name === PORT_BG);
  if (!inp || inp.link == null) return null;
  const link = app.graph?.links?.[inp.link];
  const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
  const im = origin?.imgs?.[0];
  return im && im.naturalWidth ? im : null;
}

/** 「选择图像」的值 → /view 取图 URL；空选项返回 null。 */
function uploadViewURL(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === IMAGE_PLACEHOLDER) return null;
  let name = raw;
  let type = "input";
  const m = raw.match(/^(.*?)\s*\[([^\]]+)\]$/);
  if (m) { name = m[1].trim(); type = m[2].trim(); }
  let subfolder = "";
  const slash = name.lastIndexOf("/");
  if (slash >= 0) { subfolder = name.slice(0, slash); name = name.slice(slash + 1); }
  const q = `filename=${encodeURIComponent(name)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`;
  try { return api.apiURL?.(`/view?${q}`) || `/view?${q}`; } catch (e) { return `/view?${q}`; }
}

/* ============================ 内嵌编辑器 ============================ */
function buildEditor(node) {
  if (node._jbeBuilt) return;
  node._jbeBuilt = true;
  injectStyles();

  const regions = loadRegions(node);
  let selected = regions.length ? 0 : -1;
  let dragging = null;
  let hoverTarget = -1;        // 悬停时「点下去会选中的那一层」（≠ 顶层时高亮，给边线穿透/Alt 循环做预览）
  let gripDragging = null;     // 列表拖拽排序状态（含「点按 vs 拖动」区分）
  let img = null;              // 背景图（上游元素或 /view 加载的 <img>）
  let imgKind = null;          // 'upstream' | 'upload' | null
  let fitRect = { dx: 0, dy: 0, dw: 0, dh: 0 };
  let defaultType = "obj";     // 没选中框时胶囊开关指向的类型（新建框用它）
  let boundTextRegion = null;  // 🔴 文本框当前绑定的选区对象：选区切换（含新建）时强制回填输入框，
  let snapGuides = [];         // 拖动中的吸附辅助线 [{axis:'x'|'y', pos:分数}]，按下/松手清空

  const root = el("div", "jbee");

  /* 上传走官方原生机制（后端 image 控件带 image_upload ⇒ 前端自动出
   * 「选择上传的文件」按钮，与图像编码节点同款），这里不再自建按钮。 */

  /* —— 状态行 + 增删按钮 —— */
  const info = el("div", "jbee-info");
  const status = el("div", "st", "");
  info.appendChild(status);
  const btnAdd = el("button", "jbee-btn", "＋");
  btnAdd.title = "新建框";
  const btnDel = el("button", "jbee-btn", "🗑");
  btnDel.title = "删除选中";
  const btnClear = el("button", "jbee-btn", "清空");
  btnClear.title = "清空全部";
  info.appendChild(btnAdd);
  info.appendChild(btnDel);
  info.appendChild(btnClear);
  root.appendChild(info);

  /* —— 画布 —— */
  const stage = el("div", "jbee-stage");
  const canvas = el("canvas");
  stage.appendChild(canvas);
  root.appendChild(stage);
  const ctx = canvas.getContext("2d");

  /* —— 胶囊开关（物体|文字）+ 说明 —— */
  const tools = el("div", "jbee-tools");
  const capsule = el("div", "jbee-capsule");
  const capObj = el("button", null, "物体");
  const capText = el("button", null, "文字");
  capsule.appendChild(capObj);
  capsule.appendChild(capText);
  tools.appendChild(capsule);
  const capHint = el("div");
  capHint.style.cssText = "flex:1 1 auto;opacity:.55;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
  tools.appendChild(capHint);
  root.appendChild(tools);

  /* —— 文字 / 描述 —— */
  const rowText = el("div", "jbee-row");
  rowText.appendChild(el("label", null, "文字"));
  const inpText = el("input");
  inpText.type = "text";
  inpText.placeholder = "要渲染的字（text 类型）";
  rowText.appendChild(inpText);
  root.appendChild(rowText);

  const rowDesc = el("div", "jbee-row");
  rowDesc.appendChild(el("label", null, "描述"));
  const inpDesc = el("input");
  inpDesc.type = "text";
  inpDesc.placeholder = "例如 dress / logo（简短名词）";
  rowDesc.appendChild(inpDesc);
  root.appendChild(rowDesc);

  /* —— 颜色 —— */
  const rowColor = el("div", "jbee-row");
  rowColor.appendChild(el("label", null, "颜色"));
  const swBox = el("div", "jbee-swatches");
  PALETTE.forEach(({ hex, name }) => {
    const s = el("div", "jbee-sw");
    s.style.background = hex;
    s.dataset.hex = hex;
    s.title = `${name} ${hex}`;
    s.addEventListener("click", () => {
      const r = current();
      if (!r) return;
      r.palette = [hex];
      commit();
    });
    swBox.appendChild(s);
  });
  rowColor.appendChild(swBox);
  root.appendChild(rowColor);

  /* —— 位置（只读回显）—— */
  const rowCoord = el("div", "jbee-row");
  rowCoord.appendChild(el("label", null, "位置"));
  const inpCoord = el("input");
  inpCoord.type = "text";
  inpCoord.readOnly = true;
  inpCoord.placeholder = "x,y 宽×高（像素）";
  rowCoord.appendChild(inpCoord);
  root.appendChild(rowCoord);

  /* —— 框列表 —— */
  const list = el("div", "jbee-list");
  root.appendChild(list);
  const listHint = el("div", "jbee-hint", "拖动列表项调整层级顺序 · Alt+点击画布选中被遮挡的下一层");
  root.appendChild(listHint);

  /* ============================ 基础读写 ============================ */
  function current() {
    return selected >= 0 && selected < regions.length ? regions[selected] : null;
  }
  // 输入端口是否已连上游（连线后 node.inputs 对应槽位的 link 不为空）
  function inputLinked(name) {
    const inp = node.inputs && node.inputs.find((i) => i.name === name);
    return !!(inp && inp.link != null);
  }
  function panelDims() {
    return [intOf(node, W_WIDTH, 1024), intOf(node, W_HEIGHT, 1024)];
  }
  /** 「底图」端口上游节点广播的**实际输出**尺寸 [w,h]（取不到返回 null）。
   *  会缩放的节点（如图像编码）把算好的输出尺寸挂在 _jencOutSize 上。
   *  🔴 单向 duck-typed 读取：上游不广播就自动降级，Lab 包不依赖主包存在。 */
  function upstreamOutDims() {
    const inp = (node.inputs || []).find((i) => i && i.name === PORT_BG);
    if (!inp || inp.link == null) return null;
    const link = app.graph?.links?.[inp.link];
    const origin = link ? app.graph?.getNodeById?.(link.origin_id) : null;
    const d = origin && origin._jencOutSize;
    if (!Array.isArray(d) || d.length !== 2) return null;
    const w = +d[0];
    const h = +d[1];
    if (!(w > 0) || !(h > 0)) return null;
    return [w, h];
  }
  function curDims() {
    // 🔴 坐标基准必须等于**下游真正收到的那张图**的尺寸，否则框坐标整体错位。
    //    视觉上无差别（图都是 fit 缩放进画布矩形），错的只是坐标基准——最隐蔽的那种。
    // ① 「底图」端口接了上游 ⇒ 上游可能先缩放再输出，预览图只是源图、不可信：
    //    上游广播的实际输出尺寸（实时）> 后端回传权威尺寸（执行后）> 预览图原始尺寸。
    if (inputLinked(PORT_BG)) {
      const up = upstreamOutDims();
      if (up) return up;
      if (node._jbeDims) return node._jbeDims;
      if (img) return [img.naturalWidth, img.naturalHeight];
      return panelDims();
    }
    // ② 「选择图像」上传的图：预览即原文件，naturalWidth 就是实际尺寸
    if (img) return [img.naturalWidth, img.naturalHeight];
    // ③ 分辨率选择器接了上游：执行后优先用后端回传的权威尺寸（未执行前回落面板值）
    if (inputLinked(W_WIDTH) && node._jbeDims) return node._jbeDims;
    // ④ 无图像 ⇒ 面板分辨率（直接读控件，手改实时生效）
    return panelDims();
  }

  /* ============================ 画布布局 / 绘制 ============================ */
  function fit() {
    canvas.width = Math.max(60, stage.clientWidth || 240);
    canvas.height = Math.max(CANVAS_MIN_H, stage.clientHeight || CANVAS_BASE_H);
    const [bw, bh] = curDims();
    const m = 6;
    const s = Math.min((canvas.width - 2 * m) / bw, (canvas.height - 2 * m) / bh);
    fitRect.dw = Math.max(1, bw * s);
    fitRect.dh = Math.max(1, bh * s);
    fitRect.dx = (canvas.width - fitRect.dw) / 2;
    fitRect.dy = (canvas.height - fitRect.dh) / 2;
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const { dx, dy, dw, dh } = fitRect;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#232529";
    ctx.fillRect(0, 0, w, h);

    // 画布区内容裁进 fit 矩形
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    if (img) {
      try { ctx.drawImage(img, dx, dy, dw, dh); } catch (e) { /* 图未就绪就先画网格 */ }
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(dx, dy, dw, dh);
    } else {
      ctx.fillStyle = "#33363c";
      ctx.fillRect(dx, dy, dw, dh);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = Math.round(dx + (dw * i) / 8) + 0.5;
        const y = Math.round(dy + (dh * i) / 8) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, dy); ctx.lineTo(x, dy + dh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx, y); ctx.lineTo(dx + dw, y); ctx.stroke();
      }
    }
    ctx.restore();

    // 吸附辅助线（拖动中才出现）：压在选区下面，避免挡框
    snapGuides.forEach((g) => {
      ctx.save();
      ctx.strokeStyle = "rgba(0,229,255,.85)";
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (g.axis === "x") {
        const x = Math.round(dx + g.pos * dw) + 0.5;
        ctx.moveTo(x, dy);
        ctx.lineTo(x, dy + dh);
      } else {
        const y = Math.round(dy + g.pos * dh) + 0.5;
        ctx.moveTo(dx, y);
        ctx.lineTo(dx + dw, y);
      }
      ctx.stroke();
      ctx.restore();
    });

    regions.forEach((r, i) => {
      const x = dx + r.x * dw;
      const y = dy + r.y * dh;
      const bw = r.w * dw;
      const bh = r.h * dh;
      const color = (r.palette && r.palette[0]) || "#8a8f98";
      const on = i === selected;

      ctx.strokeStyle = color;
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.setLineDash(on ? [] : [5, 3]);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);

      const tag = String(i + 1).padStart(2, "0");
      ctx.font = "600 11px sans-serif";
      const tw = ctx.measureText(tag).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, tw + 8, 14);
      ctx.fillStyle = "#101114";
      ctx.fillText(tag, x + 4, y + 11);

      let body = r.desc || "";
      if (r.type === "text" && r.text) body = `"${r.text}"${body ? " — " + body : ""}`;
      if (body && bw > 10) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, bw, bh);
        ctx.clip();
        // 自动换行（兼容中英文：空格分词 + 超宽无空格串逐字断行）；
        // 仍超出框高时随框高微调字号，确保文字不被隐藏。
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 3;
        let fs = 11, lh = 14;
        let lines;
        for (;;) {
          ctx.font = fs + "px sans-serif";
          lines = wrapText(ctx, body, bw - 8);
          if (26 + lines.length * lh <= bh + 3 || fs <= 7) break;
          fs -= 1; lh = fs + 3;
        }
        let ty = y + 26;
        for (const ln of lines) {
          if (ty - fs > y + bh) break;   // 文字顶部已越过框底 ⇒ 停止
          ctx.fillText(ln, x + 4, ty);
          ty += lh;
        }
        ctx.restore();
      }

      if (on) {
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        handlesOf(x, y, bw, bh).forEach((p) => {
          ctx.beginPath();
          ctx.rect(p[0] - 3.5, p[1] - 3.5, 7, 7);
          ctx.fill();
          ctx.stroke();
        });
      }
    });

    // 悬停穿透预览：高亮「若点下去会选中的那一层」（非顶层时），提示边线穿透/Alt 循环目标
    if (hoverTarget >= 0 && hoverTarget !== selected && regions[hoverTarget]) {
      const r = regions[hoverTarget];
      const x = dx + r.x * dw, y = dy + r.y * dh, bw = r.w * dw, bh = r.h * dh;
      ctx.save();
      ctx.strokeStyle = "rgba(120,200,255,.9)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 1.5, y - 1.5, bw + 3, bh + 3);
      ctx.restore();
    }
  }

  function handlesOf(x, y, w, h) {
    return [
      [x, y], [x + w / 2, y], [x + w, y],
      [x, y + h / 2], [x + w, y + h / 2],
      [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
  }

  /** 按 maxWidth 断行：空格分词（英文），超宽无空格串（如中文）逐字断行；保留显式换行。 */
  function wrapText(ctx, text, maxWidth) {
    const out = [];
    const paras = String(text).split("\n");
    for (const para of paras) {
      const tokens = para.split(/(\s+)/);
      let line = "";
      for (const tok of tokens) {
        if (tok === "") continue;
        if (ctx.measureText(tok).width > maxWidth) {
          if (line) { out.push(line.trim()); line = ""; }
          let chunk = "";
          for (const ch of tok) {
            const t = chunk + ch;
            if (ctx.measureText(t).width > maxWidth && chunk) { out.push(chunk); chunk = ch; }
            else chunk = t;
          }
          if (chunk) line = chunk;
        } else {
          const t = line + tok;
          if (ctx.measureText(t).width > maxWidth && line) { out.push(line.trim()); line = tok; }
          else line = t;
        }
      }
      if (line) out.push(line.trim());
    }
    return out;
  }

  /* ============================ 吸附 ============================ */
  /** 某轴上的吸附目标线（分数）：画布居中 + 其他选区的两边与中线（排除拖动的那个）。 */
  function snapTargets(axis, excludeIdx) {
    const ts = [0.5];
    regions.forEach((r, i) => {
      if (i === excludeIdx) return;
      const a = axis === "x" ? r.x : r.y;
      const b = axis === "x" ? r.x + r.w : r.y + r.h;
      ts.push(a, b, (a + b) / 2);
    });
    return ts;
  }

  /** 把一组「正在移动的边」（分数）吸附到最近的目标线；一次只吸最近的一条，防抖。
   *  返回 {delta, guide} 或 null。edges 传该轴上移动中的边（左/右/中线）。 */
  function snapAxis(axis, edges, excludeIdx) {
    const span = axis === "x" ? fitRect.dw : fitRect.dh;
    if (!span || !edges.length) return null;
    const tol = SNAP_PX / span;
    let best = null;
    for (const v of edges) {
      for (const t of snapTargets(axis, excludeIdx)) {
        const d = t - v;
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.delta))) {
          best = { delta: d, guide: t };
        }
      }
    }
    return best;
  }

  /* 8 个手柄对应的鼠标指针：左上/右下↘、右上/左下↙、上下、左右 */
  const HANDLE_CURSORS = [
    "nwse-resize", "ns-resize", "nesw-resize",
    "ew-resize", "ew-resize",
    "nesw-resize", "ns-resize", "nwse-resize",
  ];

  /* ============================ 交互 ============================ */
  function toFrac(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / Math.max(1, rect.width));
    const y = (e.clientY - rect.top) * (canvas.height / Math.max(1, rect.height));
    return {
      x: (x - fitRect.dx) / fitRect.dw,
      y: (y - fitRect.dy) / fitRect.dh,
    };
  }

  function hitHandle(pt) {
    if (selected < 0) return -1;
    const r = regions[selected];
    const { dx, dy, dw, dh } = fitRect;
    // 手柄命中按「画布像素」直接比：px/py 与 hs 都是画布坐标，容差必须同单位（像素），
    // ❌ 旧写法把像素容差除以画布尺寸换成分数再比像素 ⇒ 数值≈0.03px，永远命不中。
    const tol = HANDLE;
    const hs = handlesOf(dx + r.x * dw, dy + r.y * dh, r.w * dw, r.h * dh);
    const px = dx + pt.x * dw;
    const py = dy + pt.y * dh;
    for (let i = 0; i < hs.length; i++) {
      if (Math.abs(px - hs[i][0]) <= tol && Math.abs(py - hs[i][1]) <= tol) return i;
    }
    return -1;
  }

  function hitBox(pt) {
    // 从后往前测，后画的（前景）优先被选中
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return i;
    }
    return -1;
  }

  /* —— 边线穿透 / Alt 循环选中 —— */
  /** 点 pt 处的 z 栈（从顶到底的 regions 索引）。 */
  function stackAt(pt) {
    const stack = [];
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) stack.push(i);
    }
    return stack;
  }
  /** pt 距 regions[i] 边线的画布像素距离（pt 需在框内；越小越贴边）。 */
  function edgeGapPx(i, pt) {
    const r = regions[i];
    const x = fitRect.dx + r.x * fitRect.dw, y = fitRect.dy + r.y * fitRect.dh;
    const w = r.w * fitRect.dw, h = r.h * fitRect.dh;
    const px = fitRect.dx + pt.x * fitRect.dw, py = fitRect.dy + pt.y * fitRect.dh;
    return Math.min(px - x, (x + w) - px, py - y, (y + h) - py);
  }
  /** 栈内「最靠上的、边线在容差内的」位置 p（0=顶）；无则 -1。 */
  function topmostEdgePos(stack, tol) {
    for (let p = 0; p < stack.length; p++) {
      if (edgeGapPx(stack[p], pt) <= tol) return p;
    }
    return -1;
  }
  /** 点击 pt 应选哪个选区（稳健版：已恢复「已选优先 → 顶层命中」的可用逻辑）。
   *   alt=true  ⇒ z 栈里循环到「当前选中的下一层」（含被完全遮挡的底层盲区）；
   *   alt=false ⇒ 先「已选优先」（点已选框内部直接移动它，不被上层局部盖走），
   *              再顶层命中；若点的恰是「非当前选中」层的边线且下方还藏有其它层 ⇒ 穿透到下方那层。
   *   任意异常都不应让点击变成「画新框」或「无反应」——调用方对返回 -1 才走新建分支，
   *   所以本函数对非空栈一律兜底返回顶层，绝不误返回 -1。 */
  function pickRegion(pt, alt) {
    const stack = stackAt(pt);
    if (!stack.length) return -1;            // 空白处 ⇒ 画新框
    if (alt) {                              // Alt+点击：循环到下一层（穿透遮挡盲区）
      const p = stack.indexOf(selected);
      return (p >= 0 && p < stack.length - 1) ? stack[p + 1] : stack[0];
    }
    // 已知可用逻辑：已选优先 → 顶层命中（后画的在上）
    let hit = -1;
    if (selected >= 0) {
      const s = regions[selected];
      if (s && pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h) hit = selected;
    }
    if (hit < 0) hit = hitBox(pt);
    // 边线穿透：点中「非当前选中」层的边线且下方还藏有其它层 ⇒ 选中下方那层
    if (hit >= 0 && hit !== selected) {
      const p = topmostEdgePos(stack, EDGE_TOL);
      if (p >= 0 && stack[p] === hit && p + 1 < stack.length) hit = stack[p + 1];
    }
    return hit;
  }

  canvas.addEventListener("pointerdown", (e) => {
    const pt = toFrac(e);
    snapGuides = [];
    hoverTarget = -1;
    const hh = hitHandle(pt);
    if (hh >= 0 && selected >= 0) {
      dragging = { mode: "resize", handle: hh, start: pt, orig: { ...regions[selected] } };
    } else {
      // 选框决策：已选优先 → 顶层命中 → 边线穿透 / Alt 循环（pickRegion）。
      // 🔴 兜底：任何异常都退回顶层命中（hitBox），绝不让点击变成「画新框」或「无反应」。
      let target;
      try { target = pickRegion(pt, e.altKey); } catch (err) { target = hitBox(pt); }
      if (target >= 0) {
        selected = target;
        dragging = { mode: "move", start: pt, orig: { ...regions[target] } };
      } else {
        // 空白处起手 = 画新框（起点也夹回画布内：四周留白处起手不许出界）
        const sx = Math.max(0, Math.min(1, pt.x));
        const sy = Math.max(0, Math.min(1, pt.y));
        dragging = { mode: "create", start: { x: sx, y: sy } };
        regions.push({
          x: sx, y: sy, w: 0, h: 0,
          type: defaultType, text: "", desc: "",
          palette: [PALETTE[regions.length % PALETTE.length].hex],
        });
        selected = regions.length - 1;
      }
    }
    canvas.setPointerCapture?.(e.pointerId);
    syncProps();
    draw();
    e.preventDefault();
    e.stopPropagation();
  });

  canvas.addEventListener("pointermove", (e) => {
    // 悬停反馈：手柄＝方向箭头 / 会触发穿透或循环的层＝alias / 框内＝移动 / 空白＝十字。
    // 拖动中不抢。
    if (!dragging) {
      const pt = toFrac(e);
      const hh = hitHandle(pt);
      if (hh >= 0) {
        canvas.style.cursor = HANDLE_CURSORS[hh];
        if (hoverTarget !== -1) { hoverTarget = -1; draw(); }
        return;
      }
      const stack = stackAt(pt);
      let target;
      try { target = pickRegion(pt, e.altKey); } catch (err) { target = stack[0] ?? -1; }
      // 仅当「会选中的不是顶层」时才高亮预览（顶层本身显而易见）
      const ht = (target >= 0 && stack.length && target !== stack[0]) ? target : -1;
      if (ht !== hoverTarget) { hoverTarget = ht; draw(); }
      canvas.style.cursor = target >= 0 ? (ht >= 0 ? "alias" : "move") : "crosshair";
      return;
    }
    const pt = toFrac(e);
    const dx = pt.x - dragging.start.x;
    const dy = pt.y - dragging.start.y;

    if (dragging.mode === "create") {
      // 画新框：指针一律夹回画布内（0~1），框永远画不出画布边界；拖动角吸合
      let cx = Math.max(0, Math.min(1, pt.x));
      let cy = Math.max(0, Math.min(1, pt.y));
      snapGuides = [];
      const scx = snapAxis("x", [cx], selected);
      if (scx) { cx = Math.max(0, Math.min(1, cx + scx.delta)); snapGuides.push({ axis: "x", pos: scx.guide }); }
      const scy = snapAxis("y", [cy], selected);
      if (scy) { cy = Math.max(0, Math.min(1, cy + scy.delta)); snapGuides.push({ axis: "y", pos: scy.guide }); }
      const r = regions[selected];
      r.x = Math.max(0, Math.min(dragging.start.x, cx));
      r.y = Math.max(0, Math.min(dragging.start.y, cy));
      r.w = Math.abs(cx - dragging.start.x);
      r.h = Math.abs(cy - dragging.start.y);
    } else if (dragging.mode === "move") {
      const r = regions[selected];
      let nx = Math.max(0, Math.min(1 - r.w, dragging.orig.x + dx));
      let ny = Math.max(0, Math.min(1 - r.h, dragging.orig.y + dy));
      // 移动吸附：左/右/中线 → 画布居中 + 其他选区的边与中线（含紧贴对齐）
      snapGuides = [];
      const sx = snapAxis("x", [nx, nx + r.w, nx + r.w / 2], selected);
      if (sx) { nx += sx.delta; snapGuides.push({ axis: "x", pos: sx.guide }); }
      const sy = snapAxis("y", [ny, ny + r.h, ny + r.h / 2], selected);
      if (sy) { ny += sy.delta; snapGuides.push({ axis: "y", pos: sy.guide }); }
      r.x = Math.max(0, Math.min(1 - r.w, nx));
      r.y = Math.max(0, Math.min(1 - r.h, ny));
    } else if (dragging.mode === "resize") {
      const o = dragging.orig;
      const r = regions[selected];
      let x1 = o.x;
      let y1 = o.y;
      let x2 = o.x + o.w;
      let y2 = o.y + o.h;
      const H = dragging.handle;
      if (H === 0 || H === 3 || H === 5) x1 = Math.min(x2 - 0.005, o.x + dx);
      if (H === 2 || H === 4 || H === 7) x2 = Math.max(x1 + 0.005, o.x + o.w + dx);
      if (H === 0 || H === 1 || H === 2) y1 = Math.min(y2 - 0.005, o.y + dy);
      if (H === 5 || H === 6 || H === 7) y2 = Math.max(y1 + 0.005, o.y + o.h + dy);
      // 缩放吸附：只吸正在拖动的那条边（角手柄各拖一横一竖两条）
      snapGuides = [];
      const sx = snapAxis("x", (H === 0 || H === 3 || H === 5) ? [x1] : [x2], selected);
      if (sx) {
        if (H === 0 || H === 3 || H === 5) x1 += sx.delta; else x2 += sx.delta;
        snapGuides.push({ axis: "x", pos: sx.guide });
      }
      const sy = snapAxis("y", (H === 0 || H === 1 || H === 2) ? [y1] : [y2], selected);
      if (sy) {
        if (H === 0 || H === 1 || H === 2) y1 += sy.delta; else y2 += sy.delta;
        snapGuides.push({ axis: "y", pos: sy.guide });
      }
      // 吸附后的最小尺寸护栏：防止吸合把框压成零宽/零高（负数宽高会毁掉下游坐标）
      if (x2 < x1 + 0.005) x2 = x1 + 0.005;
      if (y2 < y1 + 0.005) y2 = y1 + 0.005;
      r.x = Math.max(0, x1);
      r.y = Math.max(0, y1);
      r.w = Math.min(1, x2) - r.x;
      r.h = Math.min(1, y2) - r.y;
    }
    syncProps();
    draw();
    e.preventDefault();
    e.stopPropagation();
  });

  const endDrag = (e) => {
    if (!dragging) return;
    // 画出来一条线（还没拖出面积）视为误点，丢掉这个空框
    if (dragging.mode === "create") {
      const r = regions[selected];
      if (!r || r.w < 0.004 || r.h < 0.004) {
        regions.splice(selected, 1);
        selected = Math.min(selected, regions.length - 1);
      }
    }
    dragging = null;
    snapGuides = [];
    try { canvas.releasePointerCapture?.(e.pointerId); } catch (err) { /* 忽略 */ }
    commit();
    e?.preventDefault?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // 🔴 滚轮＝缩放 ComfyUI 界面（与节点外一致）。旧版在这里缩放所选框，
  //    与「想缩放画面」的手感冲突、极易误触，已彻底移除。
  //    DOM 区域的 wheel 事件目标不是 litegraph 主画布、不会自己触发界面缩放，
  //    所以在容器上统一截获后，用同坐标的合成 WheelEvent 转发给主画布，
  //    litegraph 以鼠标为中心完成缩放。
  root.addEventListener("wheel", (e) => {
    try {
      const lg = app.canvas && app.canvas.canvas;
      if (lg) {
        lg.dispatchEvent(new WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          clientX: e.clientX,
          clientY: e.clientY,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          bubbles: true,
          cancelable: true,
        }));
      }
    } catch (err) { /* 主画布不可用就随他去，绝不因转发挂掉 */ }
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false, capture: true });

  /* ============================ 属性区 / 列表 / 状态 ============================ */
  function syncCapsule() {
    const r = current();
    const t = r ? r.type : defaultType;
    capObj.classList.toggle("on", t !== "text");
    capText.classList.toggle("on", t === "text");
    capObj.disabled = !r;
    capText.disabled = !r;
    capHint.textContent = r
      ? (r.type === "text" ? "文字框：渲染引号里的字" : "物体框：分区描述给下游")
      : "先选框（或拖画布画一个）";
  }

  function syncProps() {
    const r = current();
    const has = !!r;
    inpText.disabled = !has || r?.type !== "text";
    inpText.style.opacity = has && r.type === "text" ? "1" : "0.45";
    inpDesc.disabled = !has;

    // 🔴 选区切换（选中别的框 / 新建框）时必须回填输入框，即便输入框此刻仍持有焦点。
    //    旧写法用 `document.activeElement !== inpText` 当护栏：在输入框里刚给上一个框打完字、
    //    紧接着去画布拖出新框时，焦点仍停在输入框上 ⇒ 护栏跳过回填 ⇒ 新框文本框残留旧文本，
    //    必须切到别的节点再切回来才会清空。改用「绑定选区对象」判定：选区对象变了就强制回填，
    //    同一选区内的 input 事件(r 仍是同一对象)不重填，避免打字时被打断。
    if (has) {
      if (r !== boundTextRegion) {
        inpText.value = r.text || "";
        inpDesc.value = r.desc || "";
        boundTextRegion = r;
      }
      const [bw, bh] = curDims();
      inpCoord.value = `${Math.round(r.x * bw)},${Math.round(r.y * bh)} ${Math.round(r.w * bw)}×${Math.round(r.h * bh)}`;
      const cur = (r.palette && r.palette[0]) || "";
      Array.from(swBox.children).forEach((s) => s.classList.toggle("on", hexToRgb(s.dataset.hex) === hexToRgb(cur)));
    } else {
      if (boundTextRegion !== null) {
        inpText.value = "";
        inpDesc.value = "";
        boundTextRegion = null;
      }
      inpCoord.value = "";
      Array.from(swBox.children).forEach((s) => s.classList.remove("on"));
    }
    btnDel.disabled = !has;
    btnClear.disabled = regions.length === 0;
    syncCapsule();
    syncList();
  }

  function syncList() {
    list.textContent = "";
    if (!regions.length) {
      list.appendChild(el("div", "jbee-empty", "还没有框。在画布空白处拖一下就能画。"));
      syncNodeHeight();
      return;
    }
    regions.forEach((r, i) => {
      const item = el("div", `jbee-item${i === selected ? " on" : ""}`);
      // 整个列表项都可拖动排序（拖动 ⇄ 点按 自动区分）；grip 仅作视觉提示。
      const grip = el("span", "jbee-grip", "⋮⋮");
      grip.title = "拖动整行调整层级顺序";
      item.appendChild(grip);
      item.appendChild(el("span", "no", String(i + 1).padStart(2, "0")));
      const label = r.type === "text" && r.text ? `"${r.text}" ${r.desc || ""}`.trim() : (r.desc || "(无描述)");
      item.appendChild(el("span", "tx", label));
      const del = el("span", "del", "✕");
      del.title = "删除这个框";
      // 🔴 删除按钮：pointerdown 拦在 item 之前，避免误触发整行拖拽
      del.addEventListener("pointerdown", (e) => e.stopPropagation());
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        regions.splice(i, 1);
        if (selected >= regions.length) selected = regions.length - 1;
        else if (selected > i) selected--;
        commit();
      });
      item.appendChild(del);
      // 整行 pointerdown ⇒ 起点拖拽；移动超阈值即排序，否则 pointerup 视为点按选中
      item.addEventListener("pointerdown", (e) => startListDrag(e, i, item));
      list.appendChild(item);
    });
    syncNodeHeight();
  }

  /* —— 列表拖拽排序（调整层级）：拖动任意列表项重排 regions（列表序＝z 序＝叠放顺序） —— */
  function startListDrag(e, fromIdx, itemEl) {
    if (e.target.classList.contains("del")) return;   // 删除按钮不触发拖拽
    if (regions.length < 2) {
      // 单框无需排序：仅记录，pointerup 时按「点按」选中该框
      gripDragging = { fromIdx, itemEl, startY: e.clientY, moved: false, reorder: false };
    } else {
      e.preventDefault();
      e.stopPropagation();
      gripDragging = {
        fromIdx, itemEl, startY: e.clientY, moved: false, reorder: true,
        items: Array.from(list.children).filter((c) => c.classList.contains("jbee-item") && c !== itemEl),
      };
      itemEl.classList.add("dragging");
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
      window.addEventListener("pointermove", onListDragMove);
    }
    window.addEventListener("pointerup", onListDragUp);
  }
  function onListDragMove(e) {
    if (!gripDragging || !gripDragging.reorder) return;
    if (!gripDragging.moved && Math.abs(e.clientY - gripDragging.startY) > 4) gripDragging.moved = true;
    if (!gripDragging.moved) return;            // 未越过阈值前不显示指示，保留点按手感
    gripDragging.items.forEach((it) => it.classList.remove("drop-before", "drop-after"));
    const y = e.clientY;
    let targetIdx = gripDragging.items.length;
    for (let k = 0; k < gripDragging.items.length; k++) {
      const rc = gripDragging.items[k].getBoundingClientRect();
      if (y < rc.top + rc.height / 2) { targetIdx = k; break; }
    }
    gripDragging.targetIdx = targetIdx;
    const mark = targetIdx < gripDragging.items.length
      ? gripDragging.items[targetIdx]
      : gripDragging.items[gripDragging.items.length - 1];
    mark.classList.add(targetIdx < gripDragging.items.length ? "drop-before" : "drop-after");
  }
  function onListDragUp(e) {
    if (!gripDragging) return;
    const { fromIdx, itemEl, moved, reorder } = gripDragging;
    window.removeEventListener("pointerup", onListDragUp);
    window.removeEventListener("pointermove", onListDragMove);
    itemEl.classList.remove("dragging");
    if (gripDragging.items) gripDragging.items.forEach((it) => it.classList.remove("drop-before", "drop-after"));
    gripDragging = null;
    if (moved && reorder && regions.length >= 2) {
      // 依据所有 item 的几何位置算插入点（含被拖项本身），与拖拽中的指示一致
      const allItems = Array.from(list.children).filter((c) => c.classList.contains("jbee-item"));
      const y = e.clientY;
      let ins = allItems.length;
      for (let k = 0; k < allItems.length; k++) {
        const rc = allItems[k].getBoundingClientRect();
        if (y < rc.top + rc.height / 2) { ins = k; break; }
      }
      const [movedRegion] = regions.splice(fromIdx, 1);
      if (ins > fromIdx) ins -= 1;             // 移除源位置后，后续索引整体左移一位
      regions.splice(ins, 0, movedRegion);
      selected = regions.indexOf(movedRegion);
      commit();
      return;
    }
    // 没拖动（点按）⇒ 选中该框
    selected = fromIdx;
    syncProps();
    draw();
  }

  function syncStatus() {
    const [bw, bh] = curDims();
    let line = regions.length
      ? `${regions.length} 个框 · 包围 ${bboxText(bw, bh)}`
      : "还没有框，拖画布画一个";
    line += ` · 画布 ${bw}×${bh}`;
    status.textContent = line;
  }

  function bboxText(bw, bh) {
    if (!regions.length) return "0×0";
    let x1 = 1, y1 = 1, x2 = 0, y2 = 0;
    for (const r of regions) {
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
      x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
    }
    return `${Math.max(0, Math.round((x2 - x1) * bw))}×${Math.max(0, Math.round((y2 - y1) * bh))}`;
  }

  /* 容器最小内容高：固定行(CHROME_H) + 画布基准(CANVAS_BASE_H) + 列表当前高。
   * 列表自然生长（不设上限），getMinHeight 跟着实时走，保证节点拖不进内容以下。 */
  function domContentH() {
    return CHROME_H + CANVAS_BASE_H + (list.offsetHeight || 0);
  }

  /* 🔴 列表高度 ⇒ 节点高度按差值联动：新增选区节点向下生长一行、删除则缩回一行，
   *    画布（预览区）高度始终不变 —— 改的只是节点总高，绝不重置画布。
   *    首次调用只记录基线（工作流重载时保持已保存的节点尺寸，不跳变）。 */
  let lastListH = 0;
  function syncNodeHeight() {
    const h = list.offsetHeight || 0;
    if (!lastListH) { lastListH = h; return; }
    const d = h - lastListH;
    lastListH = h;
    if (d && node.size) {
      node.size[1] = Math.max(300, node.size[1] + d);
      node.setDirtyCanvas?.(true, true);
    }
  }

  function commit() {
    saveRegions(node, regions);
    fit();
    syncProps();
    syncStatus();
    syncGrays(node);
    draw();
    // 节点高度联动在 syncList → syncNodeHeight 里做：列表增删一行，节点按差值
    // 向下生长/收缩一行，画布（预览区）高度始终不变 —— 绝不整体重置节点尺寸。
  }

  capObj.addEventListener("click", () => setType("obj"));
  capText.addEventListener("click", () => setType("text"));
  function setType(t) {
    const r = current();
    if (r) {
      r.type = t;
      if (t !== "text") r.text = "";
      commit();
    } else {
      defaultType = t;
      syncCapsule();
    }
  }

  inpText.addEventListener("input", () => {
    const r = current();
    if (!r) return;
    r.text = inpText.value;
    saveRegions(node, regions);
    syncList();
    draw();
  });
  inpText.addEventListener("change", commit);
  inpDesc.addEventListener("input", () => {
    const r = current();
    if (!r) return;
    r.desc = inpDesc.value;
    saveRegions(node, regions);
    syncList();
    draw();
  });
  inpDesc.addEventListener("change", commit);

  btnAdd.addEventListener("click", () => {
    // 在画布中央放一个默认框，省得每次都要从空白处起手
    const s = 0.3;
    regions.push({
      x: 0.35, y: 0.35, w: s, h: s,
      type: defaultType, text: "", desc: "",
      palette: [PALETTE[regions.length % PALETTE.length].hex],
    });
    selected = regions.length - 1;
    commit();
  });
  btnDel.addEventListener("click", () => {
    if (selected < 0) return;
    regions.splice(selected, 1);
    selected = Math.min(selected, regions.length - 1);
    commit();
  });
  btnClear.addEventListener("click", () => {
    regions.length = 0;
    selected = -1;
    commit();
  });

  /* ============================ 背景刷新 / 灰化 ============================ */
  /* 🔴 压制官方「节点体底部」原生预览：combo 带 image_upload ⇒ 前端 useImageUploadWidget
   *    会 setNodeOutputs + showPreview，把选中的图异步塞进 node.imgs，由官方
   *    ImagePreviewWidget 画到节点底部 —— 与内嵌画布内容重复（内嵌画布才是本节点的预览）。
   *    配方照抄主包 media_save 已验证的做法：
   *    ① node.isLoading = true —— 官方 useNodePreview.showPreview 的唯一读写点，
   *       置 true 后官方装载彻底休眠（它读 store 不读 node.images，只清 imgs 拦不住）；
   *    ② 官方预览 widget（$$canvas-image-preview 等）按官方同款移除法（onRemove + splice）
   *       卸掉，onRemove 会释放官方挂的事件监听。
   *    poll 每帧兜底 + 图像来源刷新时同步执行，异步回填也会被下一帧清掉。 */
  function removePreviewWidget(name) {
    try {
      const idx = (node.widgets || []).findIndex((w) => w && w.name === name);
      if (idx > -1) {
        const w = node.widgets[idx];
        w.onRemove?.();
        node.widgets.splice(idx, 1);
      }
    } catch (e) { /* 忽略 */ }
  }
  function suppressNativePreview() {
    try {
      if (node.isLoading !== true) node.isLoading = true;
      if (node.imgs?.length) {
        node.imgs = [];
        node.images = undefined;
        node.setDirtyCanvas?.(true, true);
      }
    } catch (e) { /* 忽略 */ }
    removePreviewWidget("$$canvas-image-preview");
    removePreviewWidget("$$comfy_animation_preview");
    removePreviewWidget("video-preview");
  }

  function refreshImage() {
    const up = upstreamImageEl(node);
    if (up) {
      img = up;
      imgKind = "upstream";
    } else {
      if (imgKind === "upstream") { img = null; imgKind = null; }
      const url = uploadViewURL(getWidget(node, W_IMAGE)?.value);
      if (url) {
        if (imgKind !== "upload" || img?._jbeUrl !== url) {
          const im = new Image();
          im._jbeUrl = url;
          im.onload = () => { if (img === im) commit(); };
          im.onerror = () => { if (img === im) { img = null; imgKind = null; commit(); } };
          im.src = url;
          img = im;
          imgKind = "upload";
        }
      } else {
        img = null;
        imgKind = null;
      }
    }
    suppressNativePreview();
    commit();
  }

  /* 每帧轻探：上游 imgs 换了引用 / 图像下拉换了值 ⇒ 实时跟着刷；
   * 顺带压制官方节点体预览（原生 image_upload 机制每帧都可能回填，见上方说明）。 */
  let lastUp = null;
  let lastComboVal = undefined;
  let lastDims = null;
  let lastCurDims = null;
  function poll() {
    if (gripDragging) return;   // 列表拖拽排序进行中：不动列表 DOM，避免打断拖拽
    suppressNativePreview();
    const up = upstreamImageEl(node);
    const v = getWidget(node, W_IMAGE)?.value;
    if (up !== lastUp || v !== lastComboVal) {
      lastUp = up;
      lastComboVal = v;
      refreshImage();
    }
    // 画布宽度/高度（手动改 或 上游链接回传值变化）⇒ 重拟合画布 + 刷新「画布 W×H」读数。
    // 链接态下把实时值记作权威尺寸 node._jbeDims，避免上游回传前回落到默认值。
    const d = panelDims();
    if (!lastDims || d[0] !== lastDims[0] || d[1] !== lastDims[1]) {
      lastDims = d;
      if (inputLinked(W_WIDTH)) node._jbeDims = d;
      fit();
      syncStatus();
      draw();
    }
    // 上游广播的实际输出尺寸变化（如改了图像编码的缩放设置）⇒ 重拟合画布 + 刷新读数。
    // 🔴 没这段就不算实时：改上游设置时预览图引用没换、面板尺寸也没变 ⇒ 上面两个
    //    分支都不触发，新基准要等到下一次任意交互才生效。
    const cd = curDims();
    if (!lastCurDims || cd[0] !== lastCurDims[0] || cd[1] !== lastCurDims[1]) {
      lastCurDims = cd;
      fit();
      syncStatus();
      draw();
    }
  }

  /* ============================ 初始化 / 收尾 ============================ */
  hideStateWidget(node);
  const ro = new ResizeObserver(() => { fit(); draw(); });
  ro.observe(stage);

  // 面板分辨率控件变化 ⇒ 无图模式下的画布网格要跟着变
  for (const nm of [W_WIDTH, W_HEIGHT]) {
    const w = getWidget(node, nm);
    if (!w) continue;
    const prev = w.callback;
    w.callback = function (v) {
      const r = prev ? prev.call(this, v) : v;
      if (!img) commit();
      return r;
    };
  }
  // 图像下拉换值 ⇒ 立即刷新背景与灰化
  {
    const w = getWidget(node, W_IMAGE);
    if (w) {
      const prev = w.callback;
      w.callback = function (v) {
        const r = prev ? prev.call(this, v) : v;
        try { refreshImage(); } catch (e) { /* 忽略 */ }
        return r;
      };
    }
  }

  fit();
  syncProps();
  syncStatus();
  syncGrays(node);
  poll();

  node._jbeEditor = {
    // 🔴 tick ＝ 每帧轻探（只比对引用/值，没变化零开销）；refresh ＝ 全量重刷
    tick: poll,
    refresh: () => { poll(); fit(); syncProps(); syncStatus(); draw(); },
    // 🔴 reload ＝ 从隐藏控件重新读框数据并整体替换 regions。
    //    buildEditor 里的 loadRegions 只发生在节点**建成那一刻**——那时 configure
    //    还没回填控件值，读到的是默认 "[]"。撤销 / 刷新 / loadGraphData 后控件值
    //    才回来，必须靠这个句柄把数据补进编辑器，否则选区与描述全丢。
    reload: (info) => {
      const fresh = loadRegions(node, info);
      regions.length = 0;
      for (const r of fresh) regions.push(r);
      selected = regions.length ? 0 : -1;
      boundTextRegion = null;   // 选区对象换了，强制输入框按新内容回填
      commit();
    },
    // 「边界框」端口灌入的框（后端在编辑器为空时 seed，经 ui.boxes 送达）：
    // 整体替换编辑器内容并落盘，之后即视为手画的框（后端见到非空框数据不再灌）。
    loadSeeded: (seeded) => {
      if (!Array.isArray(seeded) || !seeded.length) return;
      regions.length = 0;
      for (const r of seeded) {
        regions.push({
          x: Number(r.x) || 0,
          y: Number(r.y) || 0,
          w: Number(r.w) || 0,
          h: Number(r.h) || 0,
          type: r.type === "text" ? "text" : "obj",
          text: String(r.text || ""),
          desc: String(r.desc || ""),
          palette: Array.isArray(r.palette) ? r.palette.slice(0, 5) : [],
        });
      }
      selected = 0;
      boundTextRegion = null;
      commit();
    },
    // 「布局导入」端口回填：整体描述写进文本框控件，各框整体替换编辑器内容并落盘。
    // 后端仅在「布局导入」非空时经 ui.layout 送达；值为 {caption, regions} JSON 字符串。
    loadLayout: (raw) => {
      let data;
      try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return; }
      if (!data || typeof data !== "object") return;
      const caption = String(data.caption || "");
      const regs = Array.isArray(data.regions) ? data.regions : [];
      // 文本框（整体描述）回填：直接写控件值，运行时 setValue 不会被 Vue 重置
      try {
        const wp = getWidget(node, W_PROMPT);
        if (wp) {
          wp.value = caption;
          // DOM 同步：Vue 组件只在挂载时读一次 widget.value，运行时必须手动写回 textarea，
          // 否则控件值与界面显示不一致（序列化是对的，但用户看不到导入结果）。
          const el = wp.element;
          const ta = (el && el.matches && el.matches("textarea")) ? el
            : (el && el.querySelector ? el.querySelector("textarea") : null);
          if (ta && ta.value !== caption) {
            ta.value = caption;
            try { ta.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) { /* 忽略 */ }
          }
        }
      } catch (e) { /* 忽略 */ }
      regions.length = 0;
      for (const r of regs) {
        if (!r || typeof r !== "object") continue;
        regions.push({
          x: Number(r.x) || 0,
          y: Number(r.y) || 0,
          w: Number(r.w) || 0,
          h: Number(r.h) || 0,
          type: r.type === "text" ? "text" : "obj",
          text: String(r.text || ""),
          desc: String(r.desc || ""),
          palette: Array.isArray(r.palette) ? r.palette.slice(0, 5) : [],
        });
      }
      selected = regions.length ? 0 : -1;
      boundTextRegion = null;
      commit();
    },
    destroy: () => { try { ro.disconnect(); } catch (e) { /* 忽略 */ } },
    // 调试/无头回归句柄（只读 live 引用 + 最小操作，不暴露内部赋值）
    getRegions: () => regions,
    getSelected: () => selected,
    removeSelected: () => { if (selected >= 0) { regions.splice(selected, 1); selected = Math.min(selected, regions.length - 1); commit(); } },
    clear: () => { regions.length = 0; selected = -1; commit(); },
  };
  node.onRemoved = ((orig) => function () {
    try { node._jbeEditor?.destroy(); } catch (e) { /* 忽略 */ }
    return orig?.apply(this, arguments);
  })(node.onRemoved);

  // 🔴 DOM 容器高度：min ＝ 内容最小高（列表伸缩时节点不被压塌），
  //    max ＝ 大值（节点被用户拖高后，画布区 flex 撑满、自动跟随节点尺寸自适应）。
  const w = node.addDOMWidget("jbe_editor", "josia_bbox_edit", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: domContentH,
    getMaxHeight: () => 6000,
  });
  node._jbeDom = w;

  return node._jbeEditor;
}

/* ============================ 控件工具 ============================ */
function getWidget(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

function intOf(node, name, fallback) {
  const w = getWidget(node, name);
  const v = parseInt(w?.value, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 框数据三层取数：
 *  ① info.widgets_values_named —— configure 传入的原始序列化值。🔴 最关键：
 *     「框数据」是 customtext（Vue 组件控件），litegraph 回填写进 widget.value 后，
 *     Vue 组件挂载会用节点定义默认值 "[]" 覆盖（number/combo 传统控件没这个问题）。
 *     控件值因此在还原后不可信，必须优先读序列化原文。
 *  ② node.properties._jbeState —— 双写兜底（新工作流一定有；老工作流回落到①）。
 *  ③ 控件值 —— 前两者都没有时的最后回落。
 */
function loadRegions(node, info) {
  let raw;
  try {
    raw = info && info.widgets_values_named && info.widgets_values_named[W_STATE];
  } catch (e) { /* 忽略 */ }
  if (!raw) raw = node.properties && node.properties._jbeState;
  if (!raw) {
    const w = getWidget(node, W_STATE);
    raw = w ? w.value : "";
  }
  try {
    const data = JSON.parse(raw || "[]");
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function saveRegions(node, regions) {
  const w = getWidget(node, W_STATE);
  if (!w) return;
  // 只存需要执行的字段，别把前端临时状态带进去
  const clean = regions.map((r) => ({
    x: Number(r.x) || 0,
    y: Number(r.y) || 0,
    w: Number(r.w) || 0,
    h: Number(r.h) || 0,
    type: r.type === "text" ? "text" : "obj",
    text: String(r.text || ""),
    desc: String(r.desc || ""),
    palette: Array.isArray(r.palette) ? r.palette.slice(0, 5) : [],
  }));
  w.value = JSON.stringify(clean);
  // 🔴 properties 双写：widgets_values 在部分还原路径（真实 tab 切换 / 撤销栈快照）
  //    存在回填滞后或位置错位风险，node.properties 必随图序列化，是 reload 的兜底数据源
  try { node.properties._jbeState = w.value; } catch (e) { /* 忽略 */ }
  // 隐藏控件照样要通知后端图变了
  try { w.callback?.(w.value, app.canvas, node, undefined, 0, 0); } catch (e) { /* 忽略 */ }
  node.setDirtyCanvas?.(true, true);
}

/* 🔴 隐藏控件只设 hidden。ComfyUI 里 widget.hidden 同时管绘制与序列化，
 *    这里绝不能改成 options.serialize 那一套（那是 DOM 控件的开关）。 */
function hideStateWidget(node) {
  const w = getWidget(node, W_STATE);
  if (!w) return;
  w.hidden = true;
  if (w.inputEl) w.inputEl.style.display = "none";
  if (w.element) w.element.style.display = "none";
}

/** 分辨率与图像下拉的灰化：
 *  · 「底图」端口接线 ⇒ 图像下拉灰化（端口优先）
 *  · 有任何图像来源（接线或下拉选中）⇒ 画布宽度/高度灰化（画布按图像尺寸走） */
function syncGrays(node) {
  const wired = (node.inputs || []).some((i) => i && i.name === PORT_BG && i.link != null);
  const combo = getWidget(node, W_IMAGE);
  if (combo) combo.disabled = wired;
  const uploaded = !!uploadViewURL(combo?.value);
  for (const nm of [W_WIDTH, W_HEIGHT]) {
    const w = getWidget(node, nm);
    if (w) w.disabled = wired || uploaded;
  }
}

/** 把控件键名 image 显示成中文「选择图像」（借 widget.label 覆盖显示，不影响内部键名）。 */
function ensureComboLabel(node) {
  try {
    const w = getWidget(node, W_IMAGE);
    if (w && w.label !== "选择图像") w.label = "选择图像";
  } catch (e) { /* 忽略 */ }
}

/** 把「整体描述」显示名从内部键名改成更易懂的「画面描述」（借 widget.label 覆盖，
 *  不影响内部序列化键名，重载/撤销时 ComfyUI 仍按原名还原，无需三层取数）。 */
function ensurePromptLabel(node) {
  try {
    const w = getWidget(node, W_PROMPT);
    if (w && w.label !== "画面描述") w.label = "画面描述";
  } catch (e) { /* 忽略 */ }
}

/** 「画面描述」文本框固定为小尺寸、且**不随节点缩放撑大**：
 *  🔴 根因：该 multiline 控件是「可增长控件」，靠 h-full 填满被分配到的槽位。
 *     只压 min-height → 节点放大时槽位涨高、textarea 跟着撑大（占满空间）；节点缩小时
 *     槽位低于地板、textarea 溢出盖住下方。两种症状同源。
 *  🔴 修法：① 覆盖 computeLayoutSize 返回固定 min==max，自由空间分配时它分到的额外
 *     空间为 0，放大节点多出的高度全部给下方编辑器（画布+列表）；② 给容器打 .jbee-prompt
 *     类（CSS !important 写死内部 textarea 高度）+ 直接写死内联高度，双保险防 Vue 组件
 *     重建冲掉样式。组件挂载可能重建 textarea，故 onNodeCreated 与 onConfigure 的 rAF 各应用一次。 */
function shrinkPromptBox(node) {
  // 「画面描述」是可增长 multiline，要压成固定小槽位：
  // 否则独占 ~170px，编辑器被顶下去，节点初始高度虚高。
  // （「布局导入」已改为纯输入端口，没有文本框，无需处理。）
  shrinkTextBox(node, W_PROMPT, PROMPT_SLOT_H, PROMPT_TA_H);
}
function shrinkTextBox(node, wName, slotH, taH) {
  try {
    const w = getWidget(node, wName);
    if (!w) return;
    // ① 不增长：min==max ⇒ 自由空间分配时该控件分到的额外高度为 0
    w.computeLayoutSize = () => ({ minHeight: slotH, maxHeight: slotH, minWidth: 0 });
    // ② 兜底：打类 + 写死内部 textarea 高度（防组件重建冲掉）
    const H = taH + "px";
    const fix = (el) => {
      if (!el || !el.style) return;
      el.classList && el.classList.add("jbee-prompt");
      const ta = (el.matches && el.matches("textarea")) ? el
        : (el.querySelector ? el.querySelector("textarea") : null);
      if (ta) {
        ta.style.height = H; ta.style.minHeight = H; ta.style.maxHeight = H;
        ta.style.resize = "none"; ta.style.overflow = "auto";
      }
    };
    fix(w.element);
    fix(w.inputEl);
  } catch (e) { /* 忽略 */ }
}

/* ============================ 节点集成 ============================ */
app.registerExtension({
  name: "Josia.BBoxEdit",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    if (!hasDOM()) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      try {
        if (this.size) this.size[0] = Math.max(this.size[0], NODE_MIN_W);
        ensureComboLabel(this);
        ensurePromptLabel(this);
        shrinkPromptBox(this);
        // buildEditor 内部 commit 会刷新画布/列表；节点高度按列表差值联动（syncNodeHeight），
        // 画布高度不参与联动、不会被重置。
        buildEditor(this);
        // 新节点给一个合理初始高度（外壳 + 容器固定行 + 画布基准 + 空列表）；
        // 已保存过尺寸的旧工作流节点不强行覆盖，保持用户/上次的布局。
        if (this.size && this.size[1] < NODE_BASE_H - 60) {
          this.size[1] = NODE_BASE_H;
        }
        this.setDirtyCanvas?.(true, true);
      } catch (e) { /* 忽略 */ }
      return r;
    };

    // 1.0 里 onConfigure 在 onNodeCreated 之后跑：工作流重载后要恢复框、灰化与背景
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      // 🔴 arguments[0] ＝ configure 传入的原始序列化数据（含 widgets_values_named）。
      //    「框数据」控件值会被 Vue 组件挂载用默认 "[]" 覆盖，读序列化原文才可靠。
      const info = arguments[0];
      try {
        hideStateWidget(this);
        ensureComboLabel(this);
        buildEditor(this);
        this._jbeEditor?.refresh();
        this._jbeEditor?.reload(info);
        // 🔴 rAF 兜底：真实 tab 切换 / 撤销栈还原时，控件值回填可能晚于 onConfigure
        //    （主包 media_save/load_latent 同款时序坑，同步读会踩空），延迟一帧再读
        //    一次；reload 幂等，重复执行无副作用。
        requestAnimationFrame(() => {
          try {
            this._jbeEditor?.refresh();
            this._jbeEditor?.reload();
            ensurePromptLabel(this);
            shrinkPromptBox(this);
          } catch (e) { /* 忽略 */ }
        });
      } catch (e) { /* 忽略 */ }
      return r;
    };

    // 连线 / 断线：图像下拉灰化 + 背景实时切换
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = onConnectionsChange?.apply(this, arguments);
      try { this._jbeEditor?.refresh(); } catch (e) { /* 忽略 */ }
      return r;
    };

    // 执行后：「边界框」端口灌入的框（后端仅在编辑器为空时 seed）落进编辑器。
    // 护栏：只在编辑器当前为空时应用——用户已手画框时绝不被端口数据覆盖。
    // 同时把后端回传的权威分辨率（上游连线即上游值、手动即面板值）写入 node._jbeDims，
    // 编辑器 curDims 优先采用 ⇒ 连分辨率选择器 + 点播放后画布实时跟上。
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      try {
        const dims = message?.dims;
        if (Array.isArray(dims) && dims.length === 2
            && Number.isFinite(+dims[0]) && Number.isFinite(+dims[1])) {
          this._jbeDims = [+dims[0], +dims[1]];
        }
        const ed = this._jbeEditor;
        const raw = message?.boxes?.[0];
        if (ed && raw && ed.getRegions().length === 0) {
          const seeded = JSON.parse(raw);
          if (Array.isArray(seeded) && seeded.length) ed.loadSeeded(seeded);
        }
        // 「布局导入」回填：整体替换编辑器内容（覆盖现有框，符合「导入即还原」语义）
        // 🔴 ui 值一律是数组（后端已包一层），裸字符串会被服务端逐字符拆开 ⇒ 取 [0]
        const rawLayout = Array.isArray(message?.layout) ? message.layout[0] : (message?.layout || "");
        if (ed && rawLayout) ed.loadLayout(rawLayout);
        ed?.refresh();
      } catch (e) { /* 忽略 */ }
      return r;
    };

    // 每帧轻探：上游预览图与图像下拉值变化时实时刷新（比对引用/值，无变化零开销）
    const onDrawBackground = nodeType.prototype.onDrawBackground;
    nodeType.prototype.onDrawBackground = function () {
      const r = onDrawBackground?.apply(this, arguments);
      try { this._jbeEditor?.tick(); } catch (e) { /* 忽略 */ }
      return r;
    };
  },
});
