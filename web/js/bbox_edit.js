/**
 * Josia框选编辑 —— 经典模式（1.0）下的边界框编辑器前端。
 *
 * 官方那个「创建边界框」只在 2.0 前端能用：它的框编辑器是 V3 schema 的
 * BOUNDING_BOXES 控件，由 Vue 组件渲染，经典 LiteGraph 前端不认识这个控件类型。
 * 这里改用「DOM 面板 + 原生 canvas」自己实现，经典模式下完全可控。
 *
 * 数据流：面板里编辑框 → 序列化成 JSON → 写进隐藏的「框数据」控件 → 后端解析。
 * 落盘的 JSON 与官方编辑器状态同构：[{x,y,w,h,type,text,desc,palette}]，坐标是 0~1 分数。
 *
 * 框的顺序即层级：官方注释写明「背景元素先放、前景最后放」，这里沿用同一约定。
 */
import { app } from "../../../scripts/app.js";

const NODE_CLASS = "JosiaBBoxEdit";

/* 与后端 bbox_edit.py 的控件名严格一致 */
const W_WIDTH = "画布宽度";
const W_HEIGHT = "画布高度";
const W_STATE = "框数据";

/* ============================ 尺寸常量 / 样式 ============================ */
const ROW_H = 22;              // 本包 22px 控件规范
const STYLE_ID = "josia-bbox-edit-style";
const HANDLE = 7;              // 缩放手柄命中半径（屏幕像素）

const PALETTE = [
  "#e05252", "#e08b3f", "#d9c441", "#5fbf5f", "#3fa9d9",
  "#4f6fe0", "#a45fd9", "#d94f9e", "#8a8f98", "#c9ced6",
];

/**
 * 本扩展只在浏览器里做事（要 document 建 DOM 面板）。
 * 被误 import 到非浏览器环境（后端测试、Node 回归脚本）时整体不挂钩子，
 * 而不是抛 ReferenceError 把整个模块连带崩掉。
 */
function hasDOM() {
  return typeof document !== "undefined" && !!document.createElement;
}

const CSS = `
.jbe-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);
  display:flex;align-items:center;justify-content:center;}
.jbe-panel{box-sizing:border-box;width:min(880px,94vw);max-height:92vh;display:flex;
  flex-direction:column;gap:8px;padding:12px;border-radius:8px;
  background:var(--base-background,#171718);color:var(--base-foreground,#fff);
  border:1px solid var(--border-default,#494a50);box-shadow:0 12px 40px rgba(0,0,0,.55);
  font-size:12px;}
.jbe-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;}
.jbe-head .sub{font-weight:400;opacity:.7;font-size:11px;}
.jbe-main{display:flex;gap:10px;min-height:0;flex:1 1 auto;}
.jbe-stage{flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:center;
  background:rgba(128,128,128,.08);border:1px solid var(--border-default,#494a50);
  border-radius:6px;overflow:hidden;padding:6px;}
.jbe-stage canvas{display:block;touch-action:none;cursor:crosshair;border-radius:3px;}
.jbe-side{width:212px;flex:0 0 212px;display:flex;flex-direction:column;gap:7px;min-height:0;}
.jbe-row{display:flex;align-items:center;gap:6px;}
.jbe-row label{flex:0 0 auto;opacity:.8;font-size:11px;}
.jbe-row input[type=text],.jbe-row input[type=number],.jbe-row textarea,.jbe-row select{
  flex:1 1 auto;min-width:0;box-sizing:border-box;height:${ROW_H}px;padding:0 6px;border-radius:4px;
  border:1px solid var(--border-default,#494a50);background:rgba(128,128,128,.14);
  color:inherit;font-size:11px;font-family:inherit;}
.jbe-row textarea{height:auto;min-height:44px;padding:4px 6px;resize:vertical;line-height:1.35;}
.jbe-row select{cursor:pointer;}
.jbe-list{flex:1 1 auto;min-height:70px;max-height:26vh;overflow:auto;border-radius:6px;
  border:1px solid var(--border-default,#494a50);padding:3px;display:flex;flex-direction:column;gap:2px;}
.jbe-item{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:4px;cursor:pointer;
  font-size:11px;}
.jbe-item:hover{background:var(--secondary-background,#262729);}
.jbe-item.on{background:rgba(120,170,255,.22);outline:1px solid rgba(120,170,255,.5);}
.jbe-item .no{flex:0 0 auto;font-weight:600;opacity:.85;min-width:20px;}
.jbe-item .tx{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.jbe-item .del{flex:0 0 auto;opacity:.55;cursor:pointer;padding:0 3px;}
.jbe-item .del:hover{opacity:1;color:#e05252;}
.jbe-empty{opacity:.55;font-size:11px;padding:8px 6px;text-align:center;}
.jbe-foot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.jbe-foot .sp{flex:1 1 auto;}
.jbe-btn{border-radius:999px;cursor:pointer;white-space:nowrap;padding:0 11px;height:${ROW_H}px;
  display:inline-flex;align-items:center;border:1px solid var(--border-default,#494a50);
  background:rgba(128,128,128,.12);color:inherit;font-size:11px;font-family:inherit;}
.jbe-btn:hover{background:var(--secondary-background,rgba(128,128,128,.24));}
.jbe-btn:disabled{opacity:.4;cursor:default;}
.jbe-btn.pri{background:#3d7ef0;border-color:#3d7ef0;color:#fff;}
.jbe-btn.pri:hover{background:#5590f5;}
.jbe-swatches{display:flex;flex-wrap:wrap;gap:4px;}
.jbe-sw{width:19px;height:19px;border-radius:4px;cursor:pointer;border:1px solid rgba(255,255,255,.25);}
.jbe-sw.on{outline:2px solid #fff;outline-offset:1px;}
.jbe-hint{opacity:.62;font-size:11px;line-height:1.45;}
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
function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/* ============================ 面板 ============================ */
/**
 * @param {object}   opts
 * @param {Array}    opts.regions  已有框（0~1 分数），会被就地修改
 * @param {Function} opts.onChange 数据变化回调（每次改动都调，用于回写隐藏控件）
 * @param {Function} [opts.onBackgroundChange] 选好底图后回调
 */
function openEditor(opts) {
  if (!hasDOM()) return null;
  injectStyles();

  const regions = Array.isArray(opts?.regions) ? opts.regions : [];
  const onChange = typeof opts?.onChange === "function" ? opts.onChange : () => {};
  const onBgChange = typeof opts?.onBackgroundChange === "function" ? opts.onBackgroundChange : null;

  let selected = -1;            // 选中框下标，-1 = 没选
  let dragging = null;          // 拖拽会话
  let bgImg = null;             // 底图 <img>
  let zoom = 1;                 // 显示缩放
  let viewW = 1024, viewH = 1024;

  const mask = el("div", "jbe-mask");
  const panel = el("div", "jbe-panel");
  mask.appendChild(panel);
  document.body.appendChild(mask);

  /* ---------------- 顶栏 ---------------- */
  const head = el("div", "jbe-head");
  const headL = el("div");
  headL.appendChild(el("span", null, "🖼 框选编辑"));
  const sub = el("div", "sub", "");
  headL.appendChild(sub);
  head.appendChild(headL);
  const btnClose = el("button", "jbe-btn", "✕ 关闭");
  head.appendChild(btnClose);
  panel.appendChild(head);

  /* ---------------- 主体：画布 + 右侧属性 ---------------- */
  const main = el("div", "jbe-main");
  const stage = el("div", "jbe-stage");
  const canvas = el("canvas");
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  main.appendChild(stage);

  const side = el("div", "jbe-side");

  // 类型
  const rowType = el("div", "jbe-row");
  rowType.appendChild(el("label", null, "类型"));
  const selType = el("select");
  [["obj", "物体 obj"], ["text", "文字 text"]].forEach(([v, t]) => {
    const o = el("option", null, t);
    o.value = v;
    selType.appendChild(o);
  });
  rowType.appendChild(selType);
  side.appendChild(rowType);

  // 文字内容（仅 text 类型有意义）
  const rowText = el("div", "jbe-row");
  rowText.appendChild(el("label", null, "文字"));
  const inpText = el("input");
  inpText.type = "text";
  inpText.placeholder = "要渲染的字";
  rowText.appendChild(inpText);
  side.appendChild(rowText);

  // 描述
  const rowDesc = el("div", "jbe-row");
  rowDesc.appendChild(el("label", null, "描述"));
  const inpDesc = el("textarea");
  inpDesc.placeholder = "例如 dress / logo（简短名词）";
  rowDesc.appendChild(inpDesc);
  side.appendChild(rowDesc);

  // 颜色
  const rowColor = el("div", "jbe-row");
  rowColor.appendChild(el("label", null, "颜色"));
  const swBox = el("div", "jbe-swatches");
  PALETTE.forEach((hex) => {
    const s = el("div", "jbe-sw");
    s.style.background = hex;
    s.title = hex;
    s.addEventListener("click", () => {
      if (selected < 0) return;
      regions[selected].palette = [hex];
      commit();
    });
    swBox.appendChild(s);
  });
  rowColor.appendChild(swBox);
  side.appendChild(rowColor);

  // 坐标（只读展示，方便对齐）
  const rowCoord = el("div", "jbe-row");
  rowCoord.appendChild(el("label", null, "位置"));
  const inpCoord = el("input");
  inpCoord.type = "text";
  inpCoord.readOnly = true;
  rowCoord.appendChild(inpCoord);
  side.appendChild(rowCoord);

  // 框列表
  const list = el("div", "jbe-list");
  side.appendChild(list);

  main.appendChild(side);
  panel.appendChild(main);

  /* ---------------- 底栏 ---------------- */
  const foot = el("div", "jbe-foot");
  const btnAdd = el("button", "jbe-btn pri", "＋ 新建框");
  const btnDel = el("button", "jbe-btn", "🗑 删除选中");
  const btnClear = el("button", "jbe-btn", "清空全部");
  const btnFit = el("button", "jbe-btn", "适应窗口");
  const btnBg = el("button", "jbe-btn", "🖼 底图");
  const btnBgClear = el("button", "jbe-btn", "✕ 除底图");
  btnBgClear.style.display = "none";
  const sp = el("div", "sp");
  const hint = el("div", "jbe-hint", "拖拽画框 · 拖角缩放 · 框内拖动移动 · 先背景后前景");
  foot.appendChild(btnAdd);
  foot.appendChild(btnDel);
  foot.appendChild(btnClear);
  foot.appendChild(btnFit);
  foot.appendChild(btnBg);
  foot.appendChild(btnBgClear);
  foot.appendChild(sp);
  foot.appendChild(hint);
  panel.appendChild(foot);

  /* ============================ 绘制 ============================ */
  function current() {
    return selected >= 0 && selected < regions.length ? regions[selected] : null;
  }

  function layout() {
    // 底图优先按底图尺寸，没有底图就按画布控件尺寸
    const bw = bgImg ? bgImg.naturalWidth : viewW;
    const bh = bgImg ? bgImg.naturalHeight : viewH;
    const box = stage.getBoundingClientRect();
    const availW = Math.max(80, box.width - 12);
    const availH = Math.max(80, Math.min(box.height || 420, window.innerHeight * 0.6) - 12);
    zoom = Math.min(availW / bw, availH / bh);
    if (!isFinite(zoom) || zoom <= 0) zoom = 1;
    canvas.width = Math.max(1, Math.round(bw * zoom));
    canvas.height = Math.max(1, Math.round(bh * zoom));
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (bgImg) {
      try { ctx.drawImage(bgImg, 0, 0, w, h); } catch (e) { /* 忽略 */ }
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = "#33363c";
      ctx.fillRect(0, 0, w, h);
      // 网格：每 1/8 一格，给个空间参照
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 8; i++) {
        const x = Math.round((w * i) / 8) + 0.5;
        const y = Math.round((h * i) / 8) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
    }

    regions.forEach((r, i) => {
      const x = r.x * w;
      const y = r.y * h;
      const bw = r.w * w;
      const bh = r.h * h;
      const color = (r.palette && r.palette[0]) || "#8a8f98";
      const on = i === selected;

      ctx.strokeStyle = color;
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.setLineDash(on ? [] : [5, 3]);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);

      // 序号标签
      const tag = String(i + 1).padStart(2, "0");
      ctx.font = "600 11px sans-serif";
      const tw = ctx.measureText(tag).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, tw + 8, 14);
      ctx.fillStyle = "#101114";
      ctx.fillText(tag, x + 4, y + 11);

      // 描述文字
      let body = r.desc || "";
      if (r.type === "text" && r.text) body = `"${r.text}"${body ? " — " + body : ""}`;
      if (body && bw > 10) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, bw, bh);
        ctx.clip();
        ctx.font = "11px sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 3;
        const words = String(body).split(/(\s+)/);
        let line = "";
        let ty = y + 26;
        for (const word of words) {
          const test = line + word;
          if (ctx.measureText(test).width > bw - 8 && line) {
            ctx.fillText(line, x + 4, ty);
            ty += 14;
            line = word;
            if (ty > y + bh) break;
          } else {
            line = test;
          }
        }
        if (line && ty <= y + bh) ctx.fillText(line, x + 4, ty);
        ctx.restore();
      }

      // 选中时画 8 个缩放手柄
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
  }

  function handlesOf(x, y, w, h) {
    return [
      [x, y], [x + w / 2, y], [x + w, y],
      [x, y + h / 2], [x + w, y + h / 2],
      [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
  }

  /* ============================ 交互 ============================ */
  function toLocal(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / Math.max(1, rect.width),
      y: (e.clientY - rect.top) / Math.max(1, rect.height),
    };
  }

  function hitHandle(pt) {
    if (selected < 0) return -1;
    const r = regions[selected];
    const w = canvas.width;
    const h = canvas.height;
    // 转成像素判命中：手柄是屏幕尺寸的，缩放后不该变得难点/难抓
    const tol = HANDLE / Math.max(1, Math.min(rectScale()));
    const hs = handlesOf(r.x * w, r.y * h, r.w * w, r.h * h);
    for (let i = 0; i < hs.length; i++) {
      if (Math.abs(pt.x * w - hs[i][0]) <= tol && Math.abs(pt.y * h - hs[i][1]) <= tol) return i;
    }
    return -1;
  }

  function rectScale() {
    const rect = canvas.getBoundingClientRect();
    return rect.width ? canvas.width / rect.width : 1;
  }

  function hitBox(pt) {
    // 从后往前测，后画的（前景）优先被选中
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i];
      if (pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return i;
    }
    return -1;
  }

  canvas.addEventListener("pointerdown", (e) => {
    const pt = toLocal(e);
    const hh = hitHandle(pt);
    if (hh >= 0 && selected >= 0) {
      dragging = { mode: "resize", handle: hh, start: pt, orig: { ...regions[selected] } };
    } else {
      const hit = hitBox(pt);
      if (hit >= 0) {
        selected = hit;
        dragging = { mode: "move", start: pt, orig: { ...regions[hit] } };
      } else {
        // 空白处起手 = 画新框
        dragging = { mode: "create", start: pt };
        regions.push({
          x: pt.x, y: pt.y, w: 0, h: 0,
          type: "obj", text: "", desc: "", palette: [PALETTE[regions.length % PALETTE.length]],
        });
        selected = regions.length - 1;
      }
    }
    canvas.setPointerCapture?.(e.pointerId);
    syncSide();
    draw();
    e.preventDefault();
    e.stopPropagation();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const pt = toLocal(e);
    const dx = pt.x - dragging.start.x;
    const dy = pt.y - dragging.start.y;

    if (dragging.mode === "create") {
      const r = regions[selected];
      r.x = Math.min(dragging.start.x, pt.x);
      r.y = Math.min(dragging.start.y, pt.y);
      r.w = Math.abs(dx);
      r.h = Math.abs(dy);
    } else if (dragging.mode === "move") {
      const r = regions[selected];
      r.x = Math.max(0, Math.min(1 - r.w, dragging.orig.x + dx));
      r.y = Math.max(0, Math.min(1 - r.h, dragging.orig.y + dy));
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
      r.x = Math.max(0, x1);
      r.y = Math.max(0, y1);
      r.w = Math.min(1, x2) - r.x;
      r.h = Math.min(1, y2) - r.y;
    }
    syncSide();
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
    try { canvas.releasePointerCapture?.(e.pointerId); } catch (err) { /* 忽略 */ }
    commit();
    e?.preventDefault?.();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // 滚轮调整所选框大小（不缩放视图，免得越滚越糊）
  canvas.addEventListener("wheel", (e) => {
    const r = current();
    if (!r) return;
    e.preventDefault();
    e.stopPropagation();
    const k = e.deltaY > 0 ? 0.98 : 1.02;
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    r.w = Math.max(0.01, Math.min(1, r.w * k));
    r.h = Math.max(0.01, Math.min(1, r.h * k));
    r.x = Math.max(0, Math.min(1 - r.w, cx - r.w / 2));
    r.y = Math.max(0, Math.min(1 - r.h, cy - r.h / 2));
    commit();
  }, { passive: false, capture: true });

  /* ============================ 侧栏 ============================ */
  function syncSide() {
    const r = current();
    const has = !!r;
    selType.disabled = !has;
    inpText.disabled = !has;
    inpDesc.disabled = !has;
    inpText.style.opacity = has && r.type === "text" ? "1" : "0.45";
    inpText.disabled = !has || r?.type !== "text";

    if (has) {
      selType.value = r.type;
      if (document.activeElement !== inpText) inpText.value = r.text || "";
      if (document.activeElement !== inpDesc) inpDesc.value = r.desc || "";
      inpCoord.value = `${(r.x * viewW).toFixed(0)},${(r.y * viewH).toFixed(0)} ${(r.w * viewW).toFixed(0)}×${(r.h * viewH).toFixed(0)}`;
      const cur = (r.palette && r.palette[0]) || "";
      Array.from(swBox.children).forEach((s) => s.classList.toggle("on", hexToRgb(s.title) === hexToRgb(cur)));
    } else {
      inpCoord.value = "";
    }
    btnDel.disabled = !has;
    btnClear.disabled = regions.length === 0;
    syncList();
    sub.textContent = `${regions.length} 个框 · 画布 ${viewW}×${viewH}`;
  }

  function syncList() {
    list.textContent = "";
    if (!regions.length) {
      list.appendChild(el("div", "jbe-empty", "还没有框。在左侧空白处拖一下就能画。"));
      return;
    }
    regions.forEach((r, i) => {
      const item = el("div", `jbe-item${i === selected ? " on" : ""}`);
      item.appendChild(el("span", "no", String(i + 1).padStart(2, "0")));
      const label = r.type === "text" && r.text ? `"${r.text}" ${r.desc || ""}`.trim() : (r.desc || "(无描述)");
      item.appendChild(el("span", "tx", label));
      const del = el("span", "del", "✕");
      del.title = "删除这个框";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        regions.splice(i, 1);
        if (selected >= regions.length) selected = regions.length - 1;
        else if (selected > i) selected--;
        commit();
      });
      item.appendChild(del);
      item.addEventListener("click", () => {
        selected = i;
        syncSide();
        draw();
      });
      list.appendChild(item);
    });
  }

  function commit() {
    syncSide();
    draw();
    onChange(regions);
  }

  selType.addEventListener("change", () => {
    const r = current();
    if (!r) return;
    r.type = selType.value === "text" ? "text" : "obj";
    if (r.type !== "text") r.text = "";
    commit();
  });
  inpText.addEventListener("input", () => {
    const r = current();
    if (!r) return;
    r.text = inpText.value;
    syncList();
    onChange(regions);
  });
  inpText.addEventListener("change", commit);
  inpDesc.addEventListener("input", () => {
    const r = current();
    if (!r) return;
    r.desc = inpDesc.value;
    syncList();
    onChange(regions);
  });
  inpDesc.addEventListener("change", commit);

  btnAdd.addEventListener("click", () => {
    // 在画布中央放一个默认框，省得每次都要从空白处起手
    const s = 0.3;
    regions.push({
      x: 0.35, y: 0.35, w: s, h: s,
      type: "obj", text: "", desc: "",
      palette: [PALETTE[regions.length % PALETTE.length]],
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
  btnFit.addEventListener("click", () => {
    layout();
    draw();
  });

  // 点遮罩空白处不关闭（怕误触丢数据），只能按关闭或 Esc
  mask.addEventListener("pointerdown", (e) => {
    if (e.target === mask) e.stopPropagation();
  });
  function close() {
    try { mask.remove(); } catch (e) { /* 忽略 */ }
    document.removeEventListener("keydown", onKey, true);
  }
  btnClose.addEventListener("click", close);
  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }
  document.addEventListener("keydown", onKey, true);

  /* ============================ 底图 ============================ */
  let bgSrc = null;   // 当前底图 data URL（重开编辑器还原用；只存内存，不写进工作流）
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  panel.appendChild(fileInput);

  function loadBackground(src) {
    if (!src) { clearBackground(); return; }
    const img = new Image();
    img.onload = () => {
      bgImg = img;
      bgSrc = src;
      // 编辑器的坐标读数和 fallback 布局也按底图尺寸走，显示才对得上
      viewW = img.naturalWidth;
      viewH = img.naturalHeight;
      btnBg.textContent = "🖼 更换底图";
      btnBgClear.style.display = "";
      layout();
      draw();
      // 把画布尺寸对齐到底图尺寸：框是按 0~1 分数存的，画布尺寸对了，
      // 输出出去的像素坐标才落在底图正确的位置上
      if (onBgChange) onBgChange({ width: img.naturalWidth, height: img.naturalHeight, src });
    };
    img.onerror = () => { bgImg = null; bgSrc = null; btnBg.textContent = "🖼 底图"; btnBgClear.style.display = "none"; layout(); draw(); };
    img.src = src;
  }

  function pickBackground() {
    fileInput.value = "";   // 清掉上次的选择，同名文件也能再触发 change
    fileInput.click();
  }

  function clearBackground() {
    bgImg = null;
    bgSrc = null;
    btnBg.textContent = "🖼 底图";
    btnBgClear.style.display = "none";
    layout();
    draw();
    if (onBgChange) onBgChange(null);
  }

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => loadBackground(reader.result);
    reader.onerror = () => { /* 读失败就当没选，不弹喧嚣报错 */ };
    reader.readAsDataURL(file);
  });

  btnBg.addEventListener("click", pickBackground);
  btnBgClear.addEventListener("click", clearBackground);

  /* ============================ 初始化 ============================ */
  viewW = opts?.width || 1024;
  viewH = opts?.height || 1024;
  if (opts?.background) loadBackground(opts.background);

  const onResize = () => { layout(); draw(); };
  window.addEventListener("resize", onResize);
  const origClose = close;
  void origClose;

  layout();
  syncSide();
  draw();

  // 选中第一个框，打开就能看到右侧属性，不至于对着空面板发呆
  if (regions.length) selected = 0;
  syncSide();
  draw();

  return { close, setBackground: loadBackground, refresh: () => { layout(); syncSide(); draw(); } };
}

/* ============================ 节点集成 ============================ */
function getWidget(node, name) {
  return node.widgets ? node.widgets.find((w) => w.name === name) : null;
}

function intOf(node, name, fallback) {
  const w = getWidget(node, name);
  const v = parseInt(w?.value, 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nodeSize(node) {
  const s = node.getSize ? node.getSize() : [280, 400];
  return { w: Math.max(240, s[0] || 280), h: 150 };
}

app.registerExtension({
  name: "Josia.BBoxEdit",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;
    if (!hasDOM()) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };

    // 1.0 里 onConfigure 在 onNodeCreated 之后跑，工作流重载要把框恢复出来
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      try { restore(this); } catch (e) { /* 忽略 */ }
      return r;
    };
  },
});

function loadRegions(node) {
  const w = getWidget(node, W_STATE);
  if (!w) return [];
  try {
    const data = JSON.parse(w.value || "[]");
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
  // 隐藏控件照样要通知后端图变了
  try { w.callback?.(w.value, app.canvas, node, undefined, 0, 0); } catch (e) { /* 忽略 */ }
  node.setDirtyCanvas?.(true, true);
}

function setDims(node, width, height) {
  const ww = getWidget(node, W_WIDTH);
  const wh = getWidget(node, W_HEIGHT);
  if (ww) ww.value = width;
  if (wh) wh.value = height;
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

function restore(node) {
  hideStateWidget(node);
  buildButton(node);
}

function buildButton(node) {
  if (node._jbeBuilt) return;
  node._jbeBuilt = true;

  const root = el("div");
  root.style.pointerEvents = "none";

  const btn = el("button", "jbe-btn pri", "🖼 打开框选编辑器");
  btn.style.pointerEvents = "auto";
  btn.style.width = "100%";
  btn.style.justifyContent = "center";
  btn.style.height = "26px";
  btn.style.fontSize = "12px";
  root.appendChild(btn);

  const info = el("div", "jbe-hint");
  info.style.pointerEvents = "none";
  info.style.marginTop = "4px";
  root.appendChild(info);

  const syncInfo = () => {
    const n = loadRegions(node).length;
    info.textContent = n ? `当前 ${n} 个框` : "还没有框，点上面开始框选";
  };

  let panel = null;
  btn.addEventListener("click", () => {
    if (panel) {
      panel.refresh();
      return;
    }
    panel = openEditor({
      regions: loadRegions(node),
      width: intOf(node, W_WIDTH, 1024),
      height: intOf(node, W_HEIGHT, 1024),
      background: node._jbeBgSrc || null,
      onChange: (regions) => {
        saveRegions(node, regions);
        syncInfo();
      },
      onBackgroundChange: (info) => {
        if (info && info.width && info.height) {
          // 选了底图就把画布尺寸对齐过去：框按 0~1 分数存，画布尺寸对了，
          // 输出出去的像素坐标才落在底图正确的位置上
          setDims(node, info.width, info.height);
          // 记住底图，重开编辑器还在（只存节点内存，不写进工作流、不撑大 .json）
          node._jbeBgSrc = info.src || null;
        } else {
          node._jbeBgSrc = null;
        }
        panel?.refresh();
      },
    });
  });

  // 🔴 绝不给这个 DOM 控件设 computeSize（litegraph 会把它当成固定高度并撑大节点，
  //    历史踩坑见主包 media_save 的注释）。只给 min/max，让它按内容取高。
  const w = node.addDOMWidget("jbe_open", "josia_bbox_edit", root, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => 46,
    getMaxHeight: () => 46,
  });
  node._jbeDom = w;
  syncInfo();

  // 面板内选好的底图存在节点上，重开编辑器还在
  node.onRemoved = ((orig) => function () {
    try { panel?.close(); } catch (e) { /* 忽略 */ }
    return orig?.apply(this, arguments);
  })(node.onRemoved);
}

function setupNode(node) {
  hideStateWidget(node);
  buildButton(node);
  const size = nodeSize(node);
  node.size = [size.w, size.h];
  node.setDirtyCanvas?.(true, true);
}
