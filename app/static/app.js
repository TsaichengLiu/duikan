/* 對勘 —— 界面 */
"use strict";

// ================================================================ 工具
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (x, d) => (x * 100).toFixed(d == null ? 1 : d) + "%";
const IS_NODE = typeof window === "undefined";

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.setAttribute("style", v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

const CN = "〇一二三四五六七八九";
function cnum(n) {
  if (n < 10) return CN[n];
  if (n < 20) return "十" + (n % 10 ? CN[n % 10] : "");
  if (n < 100) return CN[Math.floor(n / 10)] + "十" + (n % 10 ? CN[n % 10] : "");
  return String(n).split("").map(d => CN[+d]).join("");
}

// ================================================================ 與後台通訊
async function api(path, body, raw) {
  const opt = { headers: { "X-DK-Token": DK.token } };
  if (raw !== undefined) { opt.method = "POST"; opt.body = raw; }
  else if (body !== undefined) { opt.method = "POST"; opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch("/api/" + path, opt);
  let d;
  try { d = await r.json(); } catch (e) { throw new Error("後台無回應（" + r.status + "）"); }
  if (!r.ok) throw new Error(d.error || ("錯誤 " + r.status));
  return d;
}

async function runJob(started, onProgress) {
  const { job } = await started;
  let wait = 150;
  for (;;) {
    await sleep(wait);
    wait = Math.min(600, wait * 1.4);
    const j = await api("job?id=" + job);
    if (onProgress) onProgress(j.state === "queued" ? "排隊中…" : j.msg, j.frac);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error);
    if (j.state === "cancelled") { const e = new Error("已被新的計算取代"); e.cancelled = true; throw e; }
  }
}

// 原生外殼（WKWebView）橋接
const Native = {
  seq: 0, cbs: {},
  ok() { return DK.native && window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dk; },
  call(cmd, args) {
    return new Promise(res => {
      const id = ++this.seq;
      this.cbs[id] = res;
      window.webkit.messageHandlers.dk.postMessage(Object.assign({ cmd, id }, args || {}));
    });
  },
  resolve(id, v) { const f = this.cbs[id]; delete this.cbs[id]; if (f) f(v); },
};
if (!IS_NODE) window.DKNative = Native;

async function saveText(name, content, mime) {
  if (Native.ok()) {
    const p = await Native.call("save", { name, content });
    if (p) toast("已保存：" + p);
    return;
  }
  const blob = new Blob([content], { type: (mime || "text/plain") + ";charset=utf-8" });
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function saveBinary(name, b64, mime) {
  if (Native.ok()) {
    const p = await Native.call("save", { name, base64: b64 });
    if (p) toast("已保存：" + p);
    return;
  }
  const bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const a = h("a", { href: URL.createObjectURL(new Blob([u8], { type: mime })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
// fmt：docx（payload.blocks）或 xlsx（payload.sheets），由後台生成
async function saveOffice(fmt, name, payload) {
  try {
    const d = await api("office", Object.assign({ fmt }, payload));
    await saveBinary(name, d.b64, fmt === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } catch (e) { fail(e); }
}
const fileSafe = x => String(x).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
const plainRaw = t => t.replace(/[\f\x01]/g, "").replace(/\n+/g, "");
const IS_CHAR = /[\p{Script=Han}\p{L}\p{N}□■〓〼]/u;

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch (e) { /* 退回舊方法 */ }
  const ta = h("textarea", { style: "position:fixed;left:-9999px" }); ta.value = s;
  document.body.append(ta); ta.select();
  const ok = document.execCommand("copy"); ta.remove(); return ok;
}

// ================================================================ 小部件
function toast(msg, err) {
  const t = h("div", { class: "toast" + (err ? " err" : "") }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3200);
}
const fail = e => { console.error(e); toast(e.message || String(e), true); };

function dialog(title, body, buttons, wide) {
  return new Promise(resolve => {
    const bd = h("div", { class: "backdrop" });
    const close = v => { bd.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const foot = h("div", { class: "dlg-f" });
    for (const b of buttons) {
      if (b === "|") { foot.append(h("span", { class: "sp" })); continue; }
      foot.append(h("button", {
        class: "btn " + (b.cls || ""), onclick: async () => {
          if (b.act) { const r = await b.act(); if (r === false) return; close(r === undefined ? b.value : r); }
          else close(b.value);
        },
      }, b.label));
    }
    const dlg = h("div", { class: "dialog" + (wide ? " " + (wide === true ? "wide" : wide) : "") }, h("div", { class: "dlg-h" }, title),
      h("div", { class: "dlg-b" }, body), foot);
    bd.append(dlg);
    bd.addEventListener("mousedown", e => { if (e.target === bd) close(null); });
    const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(null); } };
    document.addEventListener("keydown", onKey, true);
    $("#layer").append(bd);
    const f = dlg.querySelector("input[type=text],textarea");
    if (f) setTimeout(() => f.focus(), 30);
  });
}

async function confirmDialog(title, msg) {
  return !!(await dialog(title, h("div", { class: "help", style: "font-size:13px" }, msg || ""),
    [{ label: "取消", value: false }, { label: "確定", cls: "primary", value: true }]));
}

// 菜單：anchor 為按鈕時掛在其下方；為鼠標事件時在鼠標處彈出（右鍵菜單）。
// items 中的 false/null 略去，"-" 為分隔線，{ label, act, disabled }；開頭、結尾、重複的分隔線自動去掉。
function menu(anchor, items) {
  $$(".menu").forEach(m => m.remove());
  const list = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "-" && (!list.length || list[list.length - 1] === "-")) continue;
    list.push(it);
  }
  while (list[list.length - 1] === "-") list.pop();
  if (!list.length) return;
  const m = h("div", { class: "menu" });
  const close = () => { m.remove(); document.removeEventListener("mousedown", off, true); document.removeEventListener("keydown", esc, true); };
  const off = e => { if (!m.contains(e.target)) close(); };
  const esc = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  for (const it of list) {
    if (it === "-") { m.append(h("hr")); continue; }
    m.append(h("button", { disabled: !!it.disabled, onclick: () => { close(); Promise.resolve().then(it.act).catch(fail); } }, it.label));
  }
  document.body.append(m);
  let x, y;
  if (anchor.clientX !== undefined) { x = anchor.clientX; y = anchor.clientY; }
  else { const r = anchor.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  m.style.left = Math.max(4, Math.min(x, innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = Math.max(4, Math.min(y, innerHeight - m.offsetHeight - 8)) + "px";
  setTimeout(() => { document.addEventListener("mousedown", off, true); document.addEventListener("keydown", esc, true); }, 0);
}
// 右鍵菜單：fn(e) 返回菜單項（或 null：不處理）。在已選中的文字上右鍵時，留給系統菜單（拷貝、查詢）。
function onCtx(el, fn) {
  el.addEventListener("contextmenu", e => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim() && sel.containsNode(e.target, true)) return;
    const items = fn(e);
    if (!items) return;
    e.preventDefault();
    menu(e, items);
  });
}
async function copyAndTell(s) { const ok = await copyText(s); toast(ok ? "已複製" : "複製失敗", !ok); }

function busy(el, msg) {
  el.innerHTML = "";
  const bar = h("div", { class: "progress" }, h("div"));
  const lab = h("div", {}, msg || "計算中…");
  el.append(h("div", { class: "busy" }, h("div", { class: "spinner" }), lab, bar));
  return (m, f) => { if (m) lab.textContent = m; if (f != null) bar.firstChild.style.width = Math.round(f * 100) + "%"; };
}

// ================================================================ 狀態
const S = {
  texts: [], settings: {}, defaults: {}, ui: {},
  tab: "pair",
  pair: null, pairSel: -1, pairSort: "a",
  coll: null, marks: {}, sub: "same", sameFilter: null, sameSort: "pos", showGra: false, vtFilter: "all", onlyStar: true,
  segs: {}, search: null,
};
// 文本；檢索所得的片段（id 形如「文本id@起-止」）登記在 S.segs
const T = id => S.texts.find(t => t.id === id) || S.segs[id];
const baseId = w => String(w).split("@")[0];
const sigName = t => !t ? "?" : (Array.from(t.siglum).length === 1 ? t.siglum + "本" : t.siglum);
const onTexts = () => S.texts.filter(t => t.on && !t.err);

function locStr(loc, t) {
  if (!loc) return "";
  const [p, l] = loc;
  if (p != null) return p + "頁" + l + "行";
  const unit = t && /^(doc|docx|rtf|odt|epub|html|htm)$/.test(t.ext) ? "段" : "行";
  return "第" + l + unit;
}
function textDesc(t) {
  const bits = [];
  if (t.n != null) bits.push(t.n.toLocaleString() + " 字");
  if (t.npages) bits.push(t.npages + " 頁");
  if (t.npages && t.textpages != null && t.textpages < t.npages * 0.8)
    bits.push("僅 " + t.textpages + " 頁有文字層");
  if (t.pages) bits.push("頁 " + t.pages);
  if (t.start || t.end) bits.push("截取");
  if (t.nheads) bits.push("略頁眉 " + t.nheads + " 行");
  return bits.join(" · ");
}

let uiTimer = null;
function saveUI(patch) {
  Object.assign(S.ui, patch);
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => api("ui", S.ui).catch(() => {}), 400);
}

// ================================================================ 原文渲染
// 原文片段 → HTML。偏移以「碼位」計（與後台一致，擴展區漢字不拆成兩半）。
// 無字形標記的片段走快速路徑：整段轉義後只替換分頁、換行、已略去的頁眉
function rawHTMLFast(text, paged, pg) {
  return esc(text).replace(/\x01+|\f|[\n\r]+/g, m => {
    if (m[0] === "\x01") return "";
    if (m === "\f") { pg.p = (pg.p || 0) + 1; return `<span class="pg">${pg.p}頁</span>`; }
    return (m.length > 1 || !paged) ? "<br>" : "";
  });
}
// 按「碼位」截取（後台的偏移以碼位計）；沒有擴展區字時碼位即 UTF-16 下標，直接切
function cpSlicer(text) {
  if (!/[\uD800-\uDBFF]/.test(text)) return (a, b) => text.slice(a, b);
  const idx = new Uint32Array(text.length + 1);
  let cp = 0;
  for (let i = 0; i < text.length; i++) {
    idx[cp++] = i;
    const c = text.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) i++;
  }
  idx[cp] = text.length;
  const n = cp;
  return (a, b) => text.slice(idx[Math.min(a, n)], idx[Math.min(b, n)]);
}
function rawHTML(text, paged, pg, marks, side) {
  if (!marks || !marks.length) return rawHTMLFast(text, paged, pg);
  const cps = Array.from(text);
  let out = "", mi = 0;
  marks = marks || [];
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === "\x01") continue;     // 已忽略的頁眉頁腳
    if (c === "\f") { pg.p = (pg.p || 0) + 1; out += `<span class="pg">${pg.p}頁</span>`; continue; }
    if (c === "\n" || c === "\r") {
      let n = 1;
      while (cps[i + 1] === "\n" || cps[i + 1] === "\r") { i++; n++; }
      if (n > 1 || !paged) out += "<br>";
      continue;
    }
    while (mi < marks.length && marks[mi][0] < i) mi++;
    if (mi < marks.length && marks[mi][0] === i) {
      const [, kind, other] = marks[mi];
      const kn = { st: "繁簡", full: "異體", custom: "視同" }[kind] || "字形";
      out += `<span class="g" title="${kn}：${side === "a" ? "右" : "左"}欄作「${esc(other)}」">${esc(c)}</span>`;
      mi++;
      continue;
    }
    out += esc(c);
  }
  return out;
}

// ================================================================ 側欄
function renderTexts() {
  const box = $("#texts");
  box.innerHTML = "";
  $("#text-count").textContent = S.texts.length ? onTexts().length + " / " + S.texts.length : "";
  if (!S.texts.length) {
    box.append(h("div", { class: "empty-side", html:
      "還沒有文本。<br>點上方「加入文件」選 PDF、Word、TXT，或直接把文件拖進窗口；也可以「貼上文字」。<br><br>" +
      "掃描版 PDF 需要先有文字層（OCR）。" }));
    return;
  }
  for (const t of S.texts) {
    const cb = h("input", { type: "checkbox", title: "參與比對", onchange: e => updateText(t.id, { on: e.target.checked }) });
    cb.checked = !!t.on;
    const more = h("button", { class: "icon-btn t-more", title: "設定", onclick: e => { e.stopPropagation(); textDialog(t.id); } },
      h("span", { html: '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>' }));
    box.append(h("div", { class: "text-item" + (t.on ? "" : " off"), "data-id": t.id, ondblclick: () => textDialog(t.id), title: t.path || "" },
      cb, h("span", { class: "t-sig" }, t.siglum), h("span", { class: "t-name" }, t.name),
      h("div", { class: "t-meta" }, t.err ? h("span", { class: "err" }, t.err) : textDesc(t)), more));
  }
}

function setSummary() {
  const s = S.settings;
  const lv = { exact: "精確字形", st: "簡繁歸一", full: "異體歸一" }[s.level];
  const ps = presetOf(s);
  const bits = [lv, "去標點", ps ? "段落參數" + PRESET_NAMES[ps] : `種子${s.k}·空隙${s.gap}·下限${s.min}·${Math.round(s.dens * 100)}%`];
  if (s.skip_notes) bits.push("略夾注");
  if (!s.skip_heads) bits.push("含頁眉");
  if (s.keep_alnum) bits.push("含數字西文");
  $("#set-summary").textContent = bits.join(" · ");
}

async function loadState() {
  const d = await api("state");
  S.texts = d.texts; S.settings = d.settings; S.defaults = d.defaults; S.ui = d.ui || {};
  S.presets = d.presets || {}; S.prmOpen = !!S.ui.prmOpen;
  renderTexts(); setSummary();
}

async function updateText(id, patch) {
  try {
    const t = await api("update", Object.assign({ id }, patch));
    const i = S.texts.findIndex(x => x.id === id);
    S.texts[i] = t;
    renderTexts();
    refreshViews(Object.keys(patch).every(k => k === "on"));
    return t;
  } catch (e) { fail(e); throw e; }
}

async function addPaths(paths) {
  if (!paths || !paths.length) return;
  toast("正在抽取文字…");
  try {
    const r = await runJob(api("add", { paths }));
    afterAdd(r);
  } catch (e) { fail(e); }
}
async function uploadFiles(files) {
  for (const f of files) {
    try {
      const buf = await f.arrayBuffer();
      toast("正在抽取「" + f.name + "」…");
      const r = await runJob(api("upload?name=" + encodeURIComponent(f.name), undefined, buf));
      afterAdd(r);
    } catch (e) { fail(e); }
  }
}
function afterAdd(r) {
  for (const t of r.added) { S.texts.push(t); toast("已加入「" + t.name + "」（" + (t.n || 0).toLocaleString() + " 字）"); }
  for (const e of r.errors) toast(e, true);
  renderTexts(); refreshSelectors();
}

function pasteDialog() {
  const name = h("input", { type: "text", placeholder: "例：國榷卷一百" });
  const ta = h("textarea", { rows: 14, placeholder: "把文字貼在這裡。有無標點、繁體簡體都可以。" });
  dialog("貼上文字", [
    h("div", { class: "field" }, h("label", {}, "名稱"), name),
    h("div", { class: "field" }, h("label", {}, "內容"), ta),
  ], [{ label: "取消" }, {
    label: "加入", cls: "primary", act: async () => {
      try {
        const t = await api("paste", { name: name.value, content: ta.value });
        S.texts.push(t); renderTexts(); refreshViews();
      } catch (e) { fail(e); return false; }
    },
  }]);
}

async function removeText(id) {
  const t = T(id);
  if (!t || !await confirmDialog("從列表中移除「" + t.name + "」？", "不會刪除原文件。對這個文本做過的判讀標記會保留。")) return false;
  try { await api("remove", { id }); S.texts = S.texts.filter(x => x.id !== id); renderTexts(); refreshSelectors(); }
  catch (e) { fail(e); return false; }
  return true;
}
// 打開或顯示文本的來源文件；拖入時保存的副本，後台會先試著找回原文件
async function openSource(id, how) {
  const r = await api(how, { id });
  if (r.text) { const i = S.texts.findIndex(x => x.id === id); if (i >= 0) { S.texts[i] = r.text; renderTexts(); } }
  if (r.relinked) toast("已找回原文件並改為指向它：" + r.text.path);
  else if (r.copy) toast("找不到原文件：這是拖入時對勘保存的副本。可在右鍵「指定原文件…」重新關聯。", true);
}
async function pickSource(id) {
  const t = T(id);
  const paths = await Native.call("pickFiles");
  if (!paths || !paths.length) return;
  const r = await api("relink", { id, path: paths[0] });
  const i = S.texts.findIndex(x => x.id === id);
  if (i >= 0) { S.texts[i] = r.text; renderTexts(); }
  toast(r.same ? `「${t.name}」已改為指向原文件` : `「${t.name}」已改用新文件；內容與原來不同，比對會重新計算`);
  if (!r.same) refreshViews();
}
// 文本列表的右鍵菜單
function textMenu(t) {
  const [pa, pb] = pairIds(), [cb] = collIds();
  const ensureOn = async () => { if (!T(t.id).on) await updateText(t.id, { on: true }); };
  const toPair = side => async () => {
    await ensureOn();
    const [a, b] = pairIds();
    if (side === "a") saveUI({ pa: t.id, pb: b === t.id ? (a !== t.id ? a : "") : b });
    else saveUI({ pb: t.id, pa: a === t.id ? (b !== t.id ? b : "") : a });
    switchTab("pair"); pairFollow(true);
  };
  return [
    { label: "設定（名稱、簡稱、比對範圍）…", act: () => textDialog(t.id) },
    { label: t.on ? "不參與比對" : "參與比對", act: () => updateText(t.id, { on: !t.on }) },
    "-",
    { label: "兩本對讀：放在左欄" + (pa === t.id ? "　✓" : ""), act: toPair("a") },
    { label: "兩本對讀：放在右欄" + (pb === t.id ? "　✓" : ""), act: toPair("b") },
    { label: "多本對校：設為底本" + (cb === t.id ? "　✓" : ""), act: async () => { await ensureOn(); saveUI({ cbase: t.id }); switchTab("coll"); collFollow(true); } },
    "-",
    !t.pasted && { label: "打開原文件", act: () => openSource(t.id, "open") },
    !t.pasted && { label: "在訪達中顯示", act: () => openSource(t.id, "reveal") },
    !t.pasted && Native.ok() && { label: t.uploaded ? "指定原文件…（現為拖入時保存的副本）" : "改用另一個文件…", act: () => pickSource(t.id) },
    "-",
    { label: "移除…", act: () => removeText(t.id) },
  ];
}
async function textDialog(id) {
  const t = T(id);
  if (!t) return;
  const name = h("input", { type: "text", value: t.name });
  const sig = h("input", { type: "text", value: t.siglum, maxlength: 8 });
  const pages = h("input", { type: "text", value: t.pages || "", placeholder: "例：12-30" });
  const start = h("input", { type: "text", value: t.start || "", placeholder: "從這句開始（可不填）" });
  const end = h("input", { type: "text", value: t.end || "", placeholder: "到這句結束（可不填）" });
  const pv = h("div", { class: "preview-box" }, "載入中…");
  const meta = h("div", { class: "help" });
  const loadPv = async () => {
    try {
      const d = await api("preview?id=" + id + "&len=1500");
      pv.innerHTML = rawHTML(d.text, d.paged, { p: d.page0 }, null) + (d.n > 1500 ? "<span class='muted'> ……</span>" : "");
      meta.textContent = "共 " + d.n.toLocaleString() + " 字（不計標點）";
    } catch (e) { pv.textContent = e.message; }
  };
  loadPv();
  const body = [
    h("div", { class: "row3" },
      h("div", { class: "field" }, h("label", {}, "簡稱（校記中用）"), sig),
      h("div", { class: "field", style: "grid-column: span 2" }, h("label", {}, "名稱"), name)),
    h("div", { class: "field" }, h("label", {}, "比對範圍"),
      h("div", { class: "row3" }, t.paged ? pages : h("div", { class: "muted", style: "font-size:12px;padding-top:5px" }, "（不分頁）"), start, end),
      h("div", { class: "help" }, "只比對文件的一部分時填寫：頁碼範圍只適用於 PDF；起止文字按歸一後的字匹配（不計標點，簡繁異體互通），取第一次出現處。")),
    h("div", { class: "field" }, h("label", {}, "預覽（範圍開頭）"), pv, meta),
    h("div", { class: "help" }, "來源：" + (t.pasted ? "貼上的文字"
      : t.uploaded ? `拖入時對勘保存的副本（原文件名「${t.orig || t.name + "." + t.ext}」；打開時會試著找回原文件，也可右鍵「指定原文件…」）`
      : t.path)),
  ];
  const r = await dialog("文本設定", body, [
    { label: "移除", act: async () => (await removeText(id)) ? "removed" : false },
    !t.pasted && { label: "在訪達中顯示", act: () => { openSource(id, "reveal").catch(fail); return false; } },
    "|",
    { label: "取消" },
    { label: "保存", cls: "primary", act: async () => {
      try {
        await updateText(id, { name: name.value, siglum: sig.value, pages: pages.value, start: start.value, end: end.value });
      } catch (e) { return false; }
    } },
  ].filter(Boolean), true);
  return r;
}

function settingsDialog() {
  const s = Object.assign({}, S.settings);
  const radio = (key, opts) => h("div", { class: "radio-list" }, opts.map(([v, lab, sub]) => {
    const inp = h("input", { type: "radio", name: key, value: v, onchange: () => { s[key] = v; } });
    inp.checked = s[key] === v;
    return h("label", {}, inp, h("span", {}, lab, h("small", {}, sub)));
  }));
  const chk = (key, lab) => {
    const c = h("input", { type: "checkbox", onchange: e => { s[key] = e.target.checked; } });
    c.checked = !!s[key];
    return h("label", { class: "chk" }, c, lab);
  };
  const custom = h("textarea", { rows: 3, placeholder: "每行一組，行內的字一律視為同一字。例：\n峯峰\n餘余" });
  custom.value = s.custom || "";
  const bihui = h("textarea", { rows: 6 });
  bihui.value = s.bihui || "";
  const body = [
    h("div", { class: "field" }, h("label", {}, "字形歸一"), radio("level", [
      ["exact", "精確", "只統一全角半角；字形不同即算異文。適合研究刻本字樣、俗字的傳承。"],
      ["st", "簡繁", "簡體與繁體視為同字（后／後、发／發／髮 等一對多也會合併）。"],
      ["full", "異體（推薦）", "再加上異體字、舊字形、日本新字體、兼容漢字。"],
    ]), h("div", { class: "help" }, "無論選哪一級，原字形不同之處都會另記為「字形差異」，可隨時查看，不會丟失。標點、空白、換行一律不參與比對，但顯示時保留原樣。")),
    h("div", { class: "field" }, h("label", {}, "忽略"),
      h("div", { style: "display:flex;gap:18px;flex-wrap:wrap" },
        chk("skip_heads", "PDF 的頁眉頁腳（在多頁首尾重複出現的行）"),
        chk("skip_notes", "括號（）〔〕中的夾注"),
        chk("keep_alnum", "比對阿拉伯數字與西文字母（默認忽略，以免頁碼、OCR 雜訊干擾）"))),
    h("div", { class: "field" }, h("label", {}, "平行段落的參數"), prmPanel(s, () => {}),
      h("div", { class: "help" }, "預設由「嚴格」到「詞語」：「嚴格」只找明顯的成段抄錄；「寬鬆」容許改寫較多；「短句」「片語」「詞語」找短到十字、六字、四字的同文，適合條目、摘錄之間的比對（整書比對時結果會多）。滑鼠停在預設或參數名上可看說明；在「兩本對讀」中點「參數」可以邊拖邊看結果。")),
    h("div", { class: "field" }, h("label", {}, "視同字（自定義）"), custom,
      h("div", { class: "help" }, "例如某些版本系統性地以甲字代乙字，而你不想讓它們淹沒其他異文時使用。視同的字仍記為字形差異（類別「視同」）。")),
    h("div", { class: "field" }, h("label", {}, "避諱字對照"), bihui,
      h("div", { class: "help" }, "只用來給異文加「疑諱」提示，不影響對齊。")),
  ];
  dialog("比對設定", body, [
    { label: "恢復默認", act: async () => { await applySettings({ reset: true }); } },
    { label: "磁盤與緩存…", act: () => { usageDialog(); return false; } },
    "|",
    { label: "取消" },
    { label: "保存", cls: "primary", act: async () => {
      s.custom = custom.value; s.bihui = bihui.value;
      await applySettings(s);
    } },
  ], true);
}
async function usageDialog() {
  const box = h("div", { class: "help", style: "font-size:13px;line-height:1.9" }, "計算中…");
  const fmt = n => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB";
  const show = u => {
    box.innerHTML = `抽取緩存：<b>${fmt(u.cache)}</b>（PDF、Word 抽出的文字；文件改動或移除後的舊版本會自動清理）<br>` +
      `貼上、拖入的文件：<b>${fmt(u.files)}</b>（移除文本時一併刪除）<br>工作區（文本列表、設定、判讀標記）：<b>${fmt(u.workspace)}</b><br>` +
      `<span class="muted">比對結果只放在內存，空閒五分鐘後自動釋放；不在磁盤上累積。</span>`;
  };
  api("usage").then(show).catch(fail);
  await dialog("磁盤與緩存", box, [
    { label: "清空抽取緩存", act: async () => { try { show((await api("clearcache", {})).usage); toast("已清空，需要時會重新抽取"); } catch (e) { fail(e); } return false; } },
    "|", { label: "關閉", cls: "primary" }]);
}
const AFFECTS = ["level", "keep_alnum", "skip_notes", "skip_heads", "custom", "bihui", "k", "gap", "min", "dens", "maxfreq"];
async function applySettings(s) {
  try {
    const old = S.settings;
    const d = await api("settings", s);
    S.settings = d.settings; S.texts = d.texts;
    renderTexts(); setSummary();
    if (AFFECTS.some(k => JSON.stringify(old[k]) !== JSON.stringify(d.settings[k]))) {
      refreshViews();
      toast("比對設定已更新，結果按新設定重算");
    } else toast("設定已保存");
  } catch (e) { fail(e); return false; }
}

// ================================================================ 平行段落參數
// 預設檔位：由成段抄錄到幾個字的同文（後三檔找短的同文，見 dk_align.PRESETS 的說明）
const PRESET_NAMES = { strict: "嚴格", normal: "標準", loose: "寬鬆", sentence: "短句", phrase: "片語", word: "詞語" };
const PRESET_HELP = {
  strict: "只找成段抄錄：至少 40 字相同，段內差異不多。適合大部頭、只看明顯的抄錄。",
  normal: "段落：至少 24 字相同（默認）。",
  loose: "改寫較多的段落：至少 14 字相同，段內可隔 160 字的增刪改寫；雜訊也多些。",
  sentence: "短句：至少 10 字相同，段內空隙收緊；在兩本中反覆出現的官銜、人名等套語不作線索。適合條目、摘錄之間的比對。",
  phrase: "片語：至少 6 字相同。適合短篇、摘錄；整書比對時結果較多，多為人名、任命等共有的記載。",
  word: "詞語：至少 4 字相同。只宜短篇；整書比對雜訊很多。",
};
// [鍵, 名稱, 最小, 最大, 刻度（lin 線性 / log 對數）, 顯示, 說明]
const PRM = [
  ["k", "種子長度", 2, 12, "lin", v => v + " 字",
    "至少連續這麼多字完全相同，才作為兩本相關的線索。短則敏感（改寫多也找得到），長則乾淨。"],
  ["gap", "段內空隙", 5, 1000, "log", v => v + " 字",
    "同一段落內，兩處相同文字之間最多可隔多少字的差異。大則能把增刪、改寫較多的文字連成一段。"],
  ["min", "段落下限", 4, 1000, "log", v => v + " 字",
    "一段之中至少要有多少字完全相同，才列為平行段落。"],
  ["dens", "相同比例", 0.02, 0.9, "lin", v => Math.round(v * 100) + "%",
    "段內完全相同的字至少佔多少。調低可容許大幅改寫，但雜訊也多。"],
  ["maxfreq", "套語上限", 2, 500, "log", v => v + " 次",
    "在兩本中都出現超過這麼多次的種子字串視為套語，不作線索（逐字對齊時仍會對上）。書內重複文字多時調低。"],
];
function presetOf(s) {
  const P = S.presets || {};
  for (const [name, p] of Object.entries(P))
    if (Object.keys(p).every(k => Math.abs(+s[k] - p[k]) < 1e-9)) return name;
  return null;
}
const toPos = (lo, hi, sc, v) => sc === "log" ? Math.round(1000 * Math.log(v / lo) / Math.log(hi / lo)) : Math.round(1000 * (v - lo) / (hi - lo));
function fromPos(key, lo, hi, sc, t) {
  let v = sc === "log" ? lo * Math.pow(hi / lo, t / 1000) : lo + (hi - lo) * t / 1000;
  if (key === "dens") return Math.round(v * 100) / 100;
  v = Math.round(v);
  if (key === "gap" && v > 50) v = Math.round(v / 5) * 5;
  return Math.max(lo, Math.min(hi, v));
}
// vals 會被就地修改；onInput(vals, 改了哪個鍵) 在拖動時連續觸發
function prmPanel(vals, onInput) {
  const box = h("div", { class: "prm" });
  const presets = h("div", { class: "prm-presets" }, h("span", { class: "muted" }, "預設："));
  const sliders = {};
  const refresh = () => {
    for (const [key, , lo, hi, sc, fmt] of PRM) {
      sliders[key].input.value = toPos(lo, hi, sc, vals[key]);
      sliders[key].out.textContent = fmt(vals[key]);
    }
    const ps = presetOf(vals);
    $$("button", presets).forEach(b => b.classList.toggle("on", b.dataset.p === ps));
  };
  for (const [name, lab] of Object.entries(PRESET_NAMES))
    presets.append(h("button", { class: "chip-btn", "data-p": name, title: PRESET_HELP[name] || "", onclick: () => {
      Object.assign(vals, S.presets[name]); refresh(); onInput(vals, "preset");
    } }, lab));
  box.append(presets);
  for (const [key, name, lo, hi, sc, fmt, help] of PRM) {
    const input = h("input", { type: "range", min: 0, max: 1000, step: 1 });
    const out = h("output", {});
    input.addEventListener("input", () => {
      vals[key] = fromPos(key, lo, hi, sc, +input.value);
      out.textContent = fmt(vals[key]);
      $$("button", presets).forEach(b => b.classList.toggle("on", b.dataset.p === presetOf(vals)));
      onInput(vals, key);
    });
    sliders[key] = { input, out };
    box.append(h("label", { class: "prm-row", title: help }, h("span", { class: "prm-name" }, name), input, out));
  }
  refresh();
  box.refresh = refresh;
  return box;
}
const prmOf = s => ({ k: s.k, gap: s.gap, min: s.min, dens: s.dens, maxfreq: s.maxfreq });

// ================================================================ 選擇器
function textSelect(val, onchange, empty) {
  const sel = h("select", { onchange: e => onchange(e.target.value) });
  if (empty) sel.append(h("option", { value: "" }, empty));
  for (const t of onTexts()) {
    const o = h("option", { value: t.id }, t.siglum + "　" + t.name);
    if (t.id === val) o.selected = true;
    sel.append(o);
  }
  return sel;
}
// 頁面顯示的永遠是「當前選擇」的比對結果：文本、範圍、勾選、設定一變，結果就作廢；
// 當前頁立即重算（舊結果淡出，算好後替換），其他頁在切換過去時再算。
// 清空就是取消選擇：選「（未選）」、關掉全部校本、清空檢索框。
function refreshSelectors() { refreshViews(); }
let refreshTimer = null;
// onlyChecks：只是勾選有變（文本內容、範圍、設定都沒變）
function refreshViews(onlyChecks) {
  if (!onlyChecks) S.pairDirty = true;
  S.collDirty = S.overDirty = S.segDirty = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (S.tab === "pair") pairFollow(true);
    if (S.tab === "coll" && !(S.coll && S.coll.seg)) collFollow(true);
    if (S.tab === "coll" && S.coll && S.coll.seg) renderCollBar();
    if (S.tab === "over") renderOver();
    if (S.tab === "seg") segFollow(true);
  }, 150);
}
function updating(view, on) { const v = $("#view-" + view); if (v) v.classList.toggle("updating", !!on); }

// ================================================================ 兩本對讀
// 與其他頁一致：只從左側勾選的文本中選。"" 表示使用者選了「未選」；
// 選過的文本被取消勾選，該欄即為未選（頁面隨之清空），重新勾選即恢復；從未選過時默認取前兩個勾選的文本。
function pairIds() {
  const ok = onTexts().map(t => t.id);
  const fix = x => (x === undefined ? undefined : (x && ok.includes(x) ? x : ""));
  let a = fix(S.ui.pa), b = fix(S.ui.pb);
  if (a === undefined) a = ok.find(x => x !== b) || "";
  if (b === undefined) b = ok.find(x => x !== a) || "";
  return [a, b];
}
let pairTimer = null;
function pairFollow(now) {
  clearTimeout(pairTimer);
  pairTimer = setTimeout(() => {
    const [a, b] = pairIds();
    if (a && b && a !== b) {
      if (S.pair && S.pair.a === a && S.pair.b === b && !S.pairDirty && $("#view-pair .pair-body")) renderPairBar();
      else runPair();
    } else {
      S.pair = null; pairSeq++; updating("pair", false);
      renderPairEmpty(a && a === b ? "<h3>兩本對讀</h3>左右選了同一個文本，請換一個。"
        : onTexts().length < 2 ? "<h3>兩本對讀</h3>請在左側勾選至少兩個文本。" : undefined);
    }
  }, now ? 0 : 200);
}

function renderPairBar() {
  const v = $("#view-pair");
  let bar = $(".bar", v);
  if (!bar) { bar = h("div", { class: "bar" }); v.prepend(bar); }
  if (!S.pair && S.prmOpen && !$(".prm-strip", v)) bar.after(prmStrip());
  if (!S.prmOpen) { const ps = $(".prm-strip", v); if (ps && !S.pair) ps.remove(); }
  bar.innerHTML = "";
  if (onTexts().length < 2) { bar.append(h("span", { class: "muted" }, "請在左側勾選至少兩個文本。")); return; }
  const [a, b] = pairIds();
  bar.append(...[
    h("span", { class: "lbl" }, "左欄"), textSelect(a, x => { saveUI({ pa: x }); pairFollow(); }, "（未選）"),
    h("button", { class: "icon-btn", title: "左右互換", onclick: () => { saveUI({ pa: b, pb: a }); pairFollow(true); },
      html: '<svg viewBox="0 0 24 24"><path d="M7 7h12l-3-3M17 17H5l3 3"/></svg>' }),
    h("span", { class: "lbl" }, "右欄"), textSelect(b, x => { saveUI({ pb: x }); pairFollow(); }, "（未選）"),
    h("button", { class: "btn" + (S.prmOpen ? " on" : ""), title: "調整平行段落的參數，邊拖邊看結果",
      onclick: () => { S.prmOpen = !S.prmOpen; saveUI({ prmOpen: S.prmOpen }); if (S.pair) renderPair(); else renderPairBar(); } }, "參數"),
    h("span", { class: "sp" }),
    S.pair ? h("button", { class: "btn", onclick: e => pairExportMenu(e.currentTarget) }, "匯出 ▾") : null,
  ].filter(Boolean));
}

function renderPairEmpty(msg) {
  const v = $("#view-pair");
  v.innerHTML = "";
  renderPairBar();
  v.append(h("div", { class: "placeholder", html: msg || `<h3>兩本對讀</h3>
    在上方選擇兩個文本，程序即找出其中文字相同或相近的段落（不論先後次序），並逐字標出異同。<br>
    適合：史源追蹤（某書某段抄自何書、如何刪改）、同一文獻不同版本的對讀。<br>
    <span class="muted">比對前會統一簡繁異體、去掉標點，所以有無句讀、繁體簡體的文本可以直接比。<br>
    結果隨選擇而變：換文本、改範圍或設定都會自動重算；選「（未選）」或在左側取消勾選即清空。</span>` }));
}

let pairSeq = 0;
async function runPair(live) {
  const [a, b] = pairIds();
  if (!a || !b) return;
  const seq = ++pairSeq;
  S.pairDirty = false;
  const keep = S.pair && S.pair.a === a && S.pair.b === b && $("#view-pair .pair-body");
  const old = keep && S.pairSel >= 0 ? S.pair.passages[S.pairSel] : null;
  let prog;
  if (keep) {
    const st = $("#view-pair .prm-status");
    prog = m => { if (st && seq === pairSeq) st.textContent = m || "計算中…"; };
    prog("計算中…");
    updating("pair", true);
  } else {
    const v = $("#view-pair");
    v.innerHTML = ""; renderPairBar();
    const body = h("div", { class: "pair-body" });
    v.append(body);
    prog = busy(body, "尋找平行段落…");
  }
  try {
    const r = await runJob(api("pair", { a, b }), prog);
    if (seq !== pairSeq) return;            // 期間又有新的請求，丟棄這個結果
    updating("pair", false);
    S.pair = Object.assign(r, { a, b });
    S.pairSel = -1;
    S.pairRows = null;
    renderPair();
    if (!r.passages.length) return;
    // 保持原來選中的段落（取與之重疊最多的新段落）
    let pick = bestPassage();
    if (old) {
      let bo = 0;
      for (const p of r.passages) {
        const ov = Math.min(p.a1, old.a1) - Math.max(p.a0, old.a0);
        if (ov > bo) { bo = ov; pick = p.i; }
      }
    }
    selectPassage(pick);
  } catch (e) {
    if (e.cancelled || seq !== pairSeq) return;
    updating("pair", false);
    if (keep) { fail(e); return; }
    const body = $("#view-pair .pair-body");
    if (body) { body.innerHTML = ""; body.append(h("div", { class: "placeholder" }, e.message)); }
  }
}
// 拖動滑桿：參數寫入設定，稍停即重算（只改空隙、下限、比例時沿用已算好的種子，幾乎即時）
let prmTimer = null;
function onPrmInput(vals) {
  Object.assign(S.settings, prmOf(vals));
  setSummary();
  const st = $("#view-pair .prm-status");
  if (st) st.textContent = "…";
  clearTimeout(prmTimer);
  prmTimer = setTimeout(async () => {
    try {
      const d = await api("settings", Object.assign({ prm_only: true }, prmOf(vals)));
      S.settings = d.settings; setSummary();
      S.collDirty = S.overDirty = true;      // 對校、總覽切換過去時按新參數重算
      runPair(true);
    } catch (e) { fail(e); }
  }, 280);
}
function prmStrip() {
  const vals = prmOf(S.settings);
  const panel = prmPanel(vals, onPrmInput);
  return h("div", { class: "prm-strip" }, panel, h("div", { class: "prm-side" },
    h("div", { class: "prm-status muted" }, S.pair ? `${S.pair.passages.length} 段` : ""),
    h("div", { class: "muted", style: "font-size:11px;line-height:1.6" }, "參數對「總覽」「多本對校」同樣生效。")));
}
function bestPassage() {
  let best = 0;
  S.pair.passages.forEach((p, i) => { if (p.m > S.pair.passages[best].m) best = i; });
  return S.pair.passages[best].i;
}

// ---------------------------------------------------------------- 列表的鍵盤操作
// 單擊選中一條後，↑↓ 逐條移動選中項（不再捲動列表），回車相當於雙擊。
// box：可聚焦的容器；items()：按顯示次序的條目；cur()：當前條目；go(el)：選中並捲到可見處；
// enter(el)：回車；space(el)：空格；more()：到了已載入的最後一條時再載入一批，有新條目返回 true。
// 尚未選中時，↓ 選視區內第一條、↑ 選視區內最後一條。輸入框、下拉框裡的方向鍵照舊。
function listKeys(box, o) {
  box.tabIndex = 0;
  box.classList.add("kbd-list");
  box.addEventListener("keydown", e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("textarea, select, [contenteditable], input:not([type=checkbox])")) return;
    const k = e.key, c = o.cur();
    if (k === "Enter" && o.enter) { if (c) { e.preventDefault(); o.enter(c); } return; }
    if (k === " " && o.space) { if (c) { e.preventDefault(); o.space(c); } return; }
    if (k !== "ArrowDown" && k !== "ArrowUp") return;
    e.preventDefault();
    let list = o.items();
    if (!list.length) return;
    const down = k === "ArrowDown";
    const i = c ? list.indexOf(c) : -1;
    if (i < 0) {
      const r = (o.view || box).getBoundingClientRect();
      const vis = list.filter(el => { const q = el.getBoundingClientRect(); return q.bottom > r.top && q.top < r.bottom; });
      const pool = vis.length ? vis : list;
      o.go(pool[down ? 0 : pool.length - 1]);
      return;
    }
    const j = i + (down ? 1 : -1);
    if (j >= list.length && o.more && o.more()) list = o.items();
    if (j >= 0 && j < list.length) o.go(list[j]);
  });
}
// 按段落列表當前的排序，選上一段或下一段（點圖裡用方向鍵時）
function stepPassage(d) {
  const els = $$(".pitem", S.pairUI.list);
  if (!els.length) return null;
  const i = els.findIndex(el => +el.dataset.i === S.pairSel);
  const j = i < 0 ? 0 : Math.max(0, Math.min(els.length - 1, i + d));
  if (j === i) return null;
  const pi = +els[j].dataset.i;
  selectPassage(pi, 150);
  return S.pair.passages[pi];
}

function renderPair() {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const v = $("#view-pair");
  v.innerHTML = ""; renderPairBar();
  const nOut = R.passages.filter(p => !p.ord).length;
  if (S.prmOpen) v.append(prmStrip());
  v.append(h("div", { class: "summary" },
    h("span", { html: `<b>${esc(sigName(A))}</b> ${R.nA.toLocaleString()} 字，其中 <b>${pct(R.coverA)}</b> 見於${esc(sigName(B))}` }),
    h("span", { html: `<b>${esc(sigName(B))}</b> ${R.nB.toLocaleString()} 字，其中 <b>${pct(R.coverB)}</b> 見於${esc(sigName(A))}` }),
    h("span", { html: `平行段落 <b>${R.passages.length}</b> 處` + (nOut ? `，其中 <b>${nOut}</b> 處次序與左欄不同` : "") }),
  ));
  if (!R.passages.length) {
    v.append(h("div", { class: "placeholder", html: "<h3>沒有找到平行段落</h3>兩本之間沒有足夠長的相同文字。比較條目、摘錄這類短文字時，可點上方「參數」改用「短句」或「片語」（找十字、六字的同文）；也可自己縮短種子、放寬空隙或降低下限，或檢查起止範圍是否正確。" }));
    return;
  }
  const left = h("div", { class: "pair-left" });
  const right = h("div", { class: "pair-right" }, h("div", { class: "placeholder" }, "選擇左側的段落"));
  v.append(h("div", { class: "pair-body" }, left, right));
  // 點圖
  const cv = h("canvas");
  const tip = h("div", { class: "plot-tip", hidden: true });
  const reset = h("button", { class: "btn ghost plot-btn", hidden: true, onclick: () => S.plot && S.plot.setView(null) }, "復原");
  left.append(h("div", { class: "plot-wrap" }, h("div", { class: "plot-box" }, cv, tip),
    h("div", { class: "plot-cap" }, h("span", {}, "橫：" + A.siglum + "　縱：" + B.siglum),
      h("span", { class: "plot-btns" }, reset, h("button", { class: "btn ghost plot-btn", onclick: openBigPlot }, "放大查看"))),
    h("div", { class: "plot-hint" }, "拖框放大 · 滾輪縮放 · 雙擊復原 · 點擊選段落")));
  const sortSel = h("select", { style: "height:24px;font-size:11.5px", onchange: e => { S.pairSort = e.target.value; renderPList(); } },
    h("option", { value: "a" }, "按" + A.siglum + "順序"), h("option", { value: "b" }, "按" + B.siglum + "順序"),
    h("option", { value: "m" }, "按長度"), h("option", { value: "s" }, "按差異多少"));
  sortSel.value = S.pairSort;
  left.append(h("div", { class: "plist-h" }, h("span", { style: "flex:1" }, "平行段落"), sortSel));
  const list = h("div", { class: "plist" });
  left.append(list);
  listKeys(list, { items: () => $$(".pitem", list), cur: () => $(".pitem.on", list),
    go: el => selectPassage(+el.dataset.i, 150) });
  onCtx(list, e => {
    const el = e.target.closest(".pitem");
    if (!el) return null;
    const i = +el.dataset.i, p = R.passages[i];
    if (S.pairSel !== i) selectPassage(i);
    const ready = async () => { if (!(S.pairRows && S.pairRowsI === i)) await selectPassage(i); };
    return [
      p.ra && { label: "看兩本原文（本段）", act: () => openContext([{ id: R.a, r0: p.ra[0], r1: p.ra[1] }, { id: R.b, r0: p.rb[0], r1: p.rb[1] }],
        { title: `段落 #${i + 1}：兩本原文（左右對照）` }) },
      "-",
      { label: "匯出本段：Word（彩色）", act: async () => { await ready(); exportPairDocx(false); } },
      { label: "匯出本段：Excel", act: async () => { await ready(); exportPairXlsx(); } },
      { label: "匯出本段：Markdown", act: async () => { await ready(); exportPairMD(false); } },
      { label: "LLM 分析稿（本段）", act: async () => { await ready(); llmPassage(); } },
    ];
  });
  onCtx(cv, () => [
    { label: "復原點圖", act: () => S.plot && S.plot.setView(null), disabled: !S.plotView },
    { label: "放大查看", act: openBigPlot },
  ]);
  S.pairUI = { cv, list, right };
  S.plotView = S.plotView && S.plotView.key === R.a + "|" + R.b ? S.plotView : null;
  S.plot = makePlot(cv, tip, { view: S.plotView, onView: v => { S.plotView = v && Object.assign({ key: R.a + "|" + R.b }, v); reset.hidden = !v; } });
  reset.hidden = !S.plotView;
  requestAnimationFrame(() => S.plot.draw());
  renderPList();
}

function renderPList() {
  const R = S.pair, A = T(R.a), B = T(R.b), list = S.pairUI.list;
  list.innerHTML = "";
  const ps = R.passages.slice();
  const k = S.pairSort;
  if (k === "b") ps.sort((x, y) => x.b0 - y.b0);
  else if (k === "m") ps.sort((x, y) => y.m - x.m);
  else if (k === "s") ps.sort((x, y) => x.sim - y.sim);
  for (const p of ps) {
    const el = h("div", { class: "pitem" + (p.i === S.pairSel ? " on" : ""), "data-i": p.i, onclick: () => selectPassage(p.i) },
      h("div", { class: "ph" },
        h("span", {}, "#" + (p.i + 1) + "　" + A.siglum + " " + locStr(p.locA, A) + " ↔ " + B.siglum + " " + locStr(p.locB, B)),
        h("span", {}, p.ord ? null : h("span", { class: "chip warn", title: "這段在右欄中的位置與左欄的先後次序不一致（移位、重編）" }, "移位"), " ",
          h("span", { class: "chip", title: "完全相同的字所佔比例（下限）" }, "≥" + pct(p.sim, 0)))),
      h("div", { class: "pp" }, h("span", { class: "s" }, (p.la).toLocaleString() + "字"), p.pa + "……"));
    list.append(el);
  }
}

// ---- 點圖：每條斜線是一段兩本相同的文字（橫軸左欄、縱軸右欄的位置）。
// 沿對角線連成一條＝順序抄錄；偏離對角＝移位；斷開＝刪節或增補。
// 拖框放大、滾輪縮放、雙擊復原、點擊選段落；放大後向後台取該範圍內的全部片段（整本書時概覽圖是抽樣的）。
function drawPlot() { if (S.plot) S.plot.draw(); if (S.bigPlot) S.bigPlot.draw(); }
function makePlot(cv, tip, opt) {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const full = () => ({ x0: 0, x1: R.nA, y0: 0, y1: R.nB });
  const P = { v: opt.view ? Object.assign({}, opt.view) : full(), runs: null, labels: null, rect: null, big: !!opt.big };
  let W = 0, H = 0;
  const X = i => (i - P.v.x0) / (P.v.x1 - P.v.x0) * W, Y = j => (j - P.v.y0) / (P.v.y1 - P.v.y0) * H;
  const toData = e => {
    const r = cv.getBoundingClientRect();
    return [P.v.x0 + (e.clientX - r.left) / r.width * (P.v.x1 - P.v.x0), P.v.y0 + (e.clientY - r.top) / r.height * (P.v.y1 - P.v.y0)];
  };
  const zoomed = () => P.v.x0 > 0 || P.v.y0 > 0 || P.v.x1 < R.nA || P.v.y1 < R.nB;
  P.draw = () => {
    W = cv.clientWidth || 316;
    if (P.big) H = cv.clientHeight || 600;
    else {
      const ratio = (P.v.y1 - P.v.y0) / Math.max(1, P.v.x1 - P.v.x0);
      H = Math.round(Math.max(150, Math.min(300, W * Math.min(1.2, Math.max(0.5, ratio)))));
      cv.style.height = H + "px";
    }
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext("2d");
    g.scale(dpr, dpr);
    const cs = getComputedStyle(document.documentElement);
    const acc = cs.getPropertyValue("--accent").trim(), t3 = cs.getPropertyValue("--text-3").trim(), t1 = cs.getPropertyValue("--text").trim();
    const panel = cs.getPropertyValue("--panel").trim();
    g.lineWidth = 1; g.strokeStyle = t3; g.globalAlpha = .6;
    g.beginPath();
    for (const [i, j, L] of (P.runs || R.runs)) {
      if (i > P.v.x1 || i + L < P.v.x0 || j > P.v.y1 || j + L < P.v.y0) continue;
      g.moveTo(X(i), Y(j)); g.lineTo(Math.max(X(i) + .8, X(i + L)), Math.max(Y(j) + .8, Y(j + L)));
    }
    g.stroke();
    for (const p of R.passages) {
      const on = p.i === S.pairSel;
      g.strokeStyle = acc; g.lineWidth = on ? 2.4 : 1.3; g.globalAlpha = on ? 1 : .55; g.fillStyle = acc;
      const x = X(p.a0), y = Y(p.b0), w = Math.max(2, X(p.a1) - x), hh = Math.max(2, Y(p.b1) - y);
      if (x > W || y > H || x + w < 0 || y + hh < 0) continue;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + w, y + hh); g.stroke();
      if (on) { g.globalAlpha = .12; g.fillRect(x - 3, y - 3, w + 6, hh + 6); }
      if (P.big && w > 40) { g.globalAlpha = .9; g.font = "11px -apple-system, sans-serif"; g.fillText("#" + (p.i + 1), x + w / 2 + 4, y + hh / 2); }
    }
    g.globalAlpha = 1;
    if (P.rect) {
      const [x0, y0, x1, y1] = P.rect;
      g.strokeStyle = acc; g.setLineDash([4, 3]); g.lineWidth = 1.2;
      g.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      g.setLineDash([]); g.globalAlpha = .08; g.fillStyle = acc;
      g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); g.globalAlpha = 1;
    }
    // 四角：可見範圍的起止位置
    if (P.labels) {
      const [[a0, a1], [b0, b1]] = P.labels;
      g.font = (P.big ? "12px" : "10px") + " -apple-system, 'PingFang TC', sans-serif";
      const tag = (t, x, y, al) => {
        const w = g.measureText(t).width + 6;
        const bx = al === "r" ? x - w : x;
        g.globalAlpha = .85; g.fillStyle = panel; g.fillRect(bx, y - 11, w, 14);
        g.globalAlpha = 1; g.fillStyle = t1; g.fillText(t, bx + 3, y);
      };
      tag(A.siglum + " " + locStr(a0, A), 3, H - 4, "l");
      tag(locStr(a1, A), W - 3, H - 4, "r");
      tag(B.siglum + " " + locStr(b0, B), 3, 13, "l");
      if (!P.big) return;
      tag(B.siglum + " " + locStr(b1, B), 3, H - 22, "l");
    }
  };
  let lblTimer = null, runTimer = null;
  const refresh = () => {
    clearTimeout(lblTimer); clearTimeout(runTimer);
    lblTimer = setTimeout(async () => {
      try {
        const d = await api("locs", { items: [{ id: R.a, idx: [P.v.x0, P.v.x1 - 1] }, { id: R.b, idx: [P.v.y0, P.v.y1 - 1] }] });
        P.labels = d.locs; P.draw();
      } catch (e) { /* 標籤只是輔助 */ }
    }, 120);
    if (!zoomed()) { P.runs = null; return; }
    runTimer = setTimeout(async () => {
      try {
        const v = Object.assign({}, P.v);
        const d = await api("runs", { a: R.a, b: R.b, x0: v.x0, x1: v.x1, y0: v.y0, y1: v.y1 });
        if (v.x0 === P.v.x0 && v.x1 === P.v.x1 && v.y0 === P.v.y0 && v.y1 === P.v.y1) { P.runs = d.runs; P.draw(); }
      } catch (e) { /* 取不到就用抽樣的 */ }
    }, 250);
  };
  P.setView = v => {
    if (!v) v = full();
    const minSpan = 30;
    let { x0, x1, y0, y1 } = v;
    if (x1 - x0 < minSpan) { const c = (x0 + x1) / 2; x0 = c - minSpan / 2; x1 = c + minSpan / 2; }
    if (y1 - y0 < minSpan) { const c = (y0 + y1) / 2; y0 = c - minSpan / 2; y1 = c + minSpan / 2; }
    const clampX = (a, b) => { const w = Math.min(b - a, R.nA); a = Math.max(0, Math.min(a, R.nA - w)); return [a, a + w]; };
    const clampY = (a, b) => { const w = Math.min(b - a, R.nB); a = Math.max(0, Math.min(a, R.nB - w)); return [a, a + w]; };
    [x0, x1] = clampX(x0, x1); [y0, y1] = clampY(y0, y1);
    P.v = { x0: Math.round(x0), x1: Math.round(x1), y0: Math.round(y0), y1: Math.round(y1) };
    if (!zoomed()) P.runs = null;
    if (opt.onView) opt.onView(zoomed() ? P.v : null);
    P.draw(); refresh();
  };
  const nearest = (x, y) => {
    let best = null, bd = Infinity;
    const sx = P.v.x1 - P.v.x0, sy = P.v.y1 - P.v.y0;
    for (const p of R.passages) {
      const t = Math.max(0, Math.min(1, ((x - p.a0) / sx + (y - p.b0) / sy) / ((p.a1 - p.a0) / sx + (p.b1 - p.b0) / sy || 1)));
      const px = p.a0 + t * (p.a1 - p.a0), py = p.b0 + t * (p.b1 - p.b0);
      const d = Math.hypot((x - px) / sx, (y - py) / sy);
      if (d < bd) { bd = d; best = p; }
    }
    return bd < 0.06 ? best : null;
  };
  let start = null;
  cv.tabIndex = 0;
  cv.addEventListener("keydown", e => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!d || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    const p = stepPassage(d);
    if (p && opt.onPick) opt.onPick(p);
  });
  cv.addEventListener("mousedown", e => { const r = cv.getBoundingClientRect(); start = { px: e.clientX - r.left, py: e.clientY - r.top, e }; });
  const onUp = e => {
    if (!cv.isConnected) { window.removeEventListener("mouseup", onUp); return; }
    if (!start) return;
    const s0 = start; start = null;
    if (P.rect) {
      const [px0, py0, px1, py1] = P.rect;
      P.rect = null;
      const r = cv.getBoundingClientRect();
      const fx = px => P.v.x0 + px / r.width * (P.v.x1 - P.v.x0), fy = py => P.v.y0 + py / r.height * (P.v.y1 - P.v.y0);
      P.setView({ x0: fx(Math.min(px0, px1)), x1: fx(Math.max(px0, px1)), y0: fy(Math.min(py0, py1)), y1: fy(Math.max(py0, py1)) });
      return;
    }
    if (e.target !== cv) return;
    const [x, y] = toData(s0.e);
    const p = nearest(x, y);
    if (p) { selectPassage(p.i); if (opt.onPick) opt.onPick(p); }
  };
  window.addEventListener("mouseup", onUp);
  cv.addEventListener("mousemove", e => {
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    if (start && (Math.abs(px - start.px) > 4 || Math.abs(py - start.py) > 4)) {
      P.rect = [start.px, start.py, Math.max(0, Math.min(r.width, px)), Math.max(0, Math.min(r.height, py))];
      tip.hidden = true;
      P.draw();
      return;
    }
    if (start) return;
    const [x, y] = toData(e);
    const p = nearest(x, y);
    if (!p) { tip.hidden = true; cv.style.cursor = "crosshair"; return; }
    cv.style.cursor = "pointer";
    tip.hidden = false;
    tip.innerHTML = `<b>段落 #${p.i + 1}</b>${p.ord ? "" : " <span class='chip warn'>移位</span>"}<br>` +
      `${esc(A.siglum)} ${esc(locStr(p.locA, A))}–${esc(locStr(p.locA2, A))}<br>${esc(B.siglum)} ${esc(locStr(p.locB, B))}–${esc(locStr(p.locB2, B))}<br>` +
      `<span class="muted">${p.la} 字／${p.lb} 字，相同 ≥${pct(p.sim, 0)}</span>`;
    const bw = cv.parentElement.clientWidth;
    tip.style.left = Math.min(px + 12, bw - 190) + "px";
    tip.style.top = (py + 14) + "px";
  });
  cv.addEventListener("mouseleave", () => { tip.hidden = true; });
  cv.addEventListener("dblclick", e => { e.preventDefault(); P.setView(null); });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const [x, y] = toData(e);
    const f = e.deltaY > 0 ? 1.25 : 0.8;
    P.setView({ x0: x - (x - P.v.x0) * f, x1: x + (P.v.x1 - x) * f, y0: y - (y - P.v.y0) * f, y1: y + (P.v.y1 - y) * f });
  }, { passive: false });
  refresh();
  return P;
}
function openBigPlot() {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const cv = h("canvas", { class: "plot-big" });
  const tip = h("div", { class: "plot-tip", hidden: true });
  const info = h("span", { class: "muted" });
  const showSel = () => {
    const p = R.passages[S.pairSel];
    info.textContent = p ? `已選段落 #${p.i + 1}：${A.siglum} ${locStr(p.locA, A)}–${locStr(p.locA2, A)} ↔ ${B.siglum} ${locStr(p.locB, B)}–${locStr(p.locB2, B)}` : "點擊斜線選段落";
  };
  const box = h("div", { class: "plot-box" }, cv, tip);
  const body = [h("div", { class: "ctx-bar" }, h("span", {}, `橫軸：${A.siglum} ${A.name}　縱軸：${B.siglum} ${B.name}`),
    h("span", { class: "muted", style: "font-size:11.5px" }, "拖框放大 · 滾輪縮放 · 雙擊復原 · 點擊選段落（右側對照隨之切換）")), box, h("div", { style: "margin-top:6px;font-size:12px" }, info)];
  showSel();
  const done = dialog("點圖：" + A.siglum + " × " + B.siglum, body, [{ label: "關閉", cls: "primary" }], "xwide");
  requestAnimationFrame(() => {
    S.bigPlot = makePlot(cv, tip, { big: true, view: S.plot ? S.plot.v : null, onPick: showSel });
    S.bigPlot.draw();
  });
  done.then(() => { S.bigPlot = null; });
}

async function selectPassage(i, delay) {
  S.pairSel = i;
  $$(".pitem", S.pairUI.list).forEach(el => el.classList.toggle("on", +el.dataset.i === i));
  const el = $(`.pitem[data-i="${i}"]`, S.pairUI.list);
  if (el) el.scrollIntoView({ block: "nearest" });
  drawPlot();
  clearTimeout(selectPassage.timer);
  if (delay) { selectPassage.timer = setTimeout(() => { if (S.pairSel === i) selectPassage(i); }, delay); return; }
  const right = S.pairUI.right;
  const prog = busy(right, "逐字對齊…");
  try {
    const d = await api("passage", { a: S.pair.a, b: S.pair.b, i });
    if (S.pairSel !== i) return;
    S.pairRows = d; S.pairRowsI = i;
    renderRows(d);
  } catch (e) { right.innerHTML = ""; right.append(h("div", { class: "placeholder" }, e.message)); }
}

function renderRows(d) {
  const R = S.pair, A = T(R.a), B = T(R.b), p = R.passages[S.pairSel], right = S.pairUI.right;
  right.innerHTML = "";
  const st = d.stat;
  let tbl;
  right.append(h("div", { class: "summary" },
    h("span", { html: `段落 #${p.i + 1}：${esc(A.siglum)} ${st.la} 字、${esc(B.siglum)} ${st.lb} 字，相同 <b>${st.eq}</b> 字，異文 <b>${st.nvar}</b> 處，相似度 <b>${pct(st.sim)}</b>` }),
    sameToggle(() => tbl),
    h("span", { class: "legend" }, h("span", {}, h("i", { style: "background:var(--da);box-shadow:inset 0 -2px 0 var(--da-line)" }), "只見於" + A.siglum + "（左欄）"),
      h("span", {}, h("i", { style: "background:var(--db);box-shadow:inset 0 -2px 0 var(--db-line)" }), "只見於" + B.siglum + "（右欄）"),
      h("span", { title: "歸一後相同，原字形不同（繁簡、異體）" }, h("span", { class: "g" }, "字"), " 字形不同"),
      h("span", {}, h("span", { class: "gap a" }), "此處無字")),
    h("span", { class: "muted", style: "font-size:11.5px" }, "懸停一處：另一欄的對應處加框；雙擊一行：看原文上下文"),
    h("button", { class: "btn", style: "margin-left:auto", title: "生成一份可貼給任何 LLM 的文檔：本段兩本的對照與分析要求", onclick: () => llmPassage() }, "LLM 分析稿")));
  const wrap = h("div", { class: "ptable-wrap" });
  tbl = h("table", { class: "ptable" + (S.ui.showSame === false ? "" : " show-same") },
    h("colgroup", {}, h("col", { class: "c-loc" }), h("col"), h("col"), h("col", { class: "c-loc" })),
    h("thead", {}, h("tr", {}, h("th"), h("th", {}, A.siglum + "　" + A.name), h("th", {}, B.siglum + "　" + B.name), h("th"))));
  const tb = h("tbody");
  tbl.append(tb); wrap.append(tbl); right.append(wrap);
  const rows = d.rows;
  let done = 0;
  const more = () => {
    let html = "";
    const end = Math.min(rows.length, done + 300);
    for (; done < end; done++) {
      const r = rows[done];
      html += `<tr data-i="${done}" title="雙擊看原文上下文"><td class='loc'>` + esc(locStr(r.la, A)) + "</td><td>" + rowSide(r.a, "a", A, r.la) + "</td><td>" +
        rowSide(r.b, "b", B, r.lb) + "</td><td class='loc'>" + esc(locStr(r.lb, B)) + "</td></tr>";
    }
    tb.insertAdjacentHTML("beforeend", html);
  };
  more();
  wrap.addEventListener("scroll", () => {
    if (done < rows.length && wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 800) more();
  });
  // 懸停一段：同一行另一欄的對應段加框
  let cpEls = [];
  const clearCp = () => { cpEls.forEach(el => el.classList.remove("cp")); cpEls = []; };
  tb.addEventListener("mouseover", e => {
    const sp = e.target.closest("[data-k]");
    const td = sp && sp.closest("td");
    if (!td) return clearCp();
    const tds = td.parentElement.children, other = td === tds[1] ? tds[2] : td === tds[2] ? tds[1] : null;
    const mate = other && $(`[data-k="${sp.dataset.k}"]`, other);
    if (cpEls[0] === sp) return;
    clearCp();
    cpEls = [sp, mate].filter(Boolean);
    cpEls.forEach(el => el.classList.add("cp"));
  });
  tb.addEventListener("mouseleave", clearCp);
  const rowCtx = r => openContext([{ id: R.a, r0: r.ra[0], r1: r.ra[1] }, { id: R.b, r0: r.rb[0], r1: r.rb[1] }], { title: "原文上下文（左右對照）" });
  tb.addEventListener("dblclick", e => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    window.getSelection().removeAllRanges();
    rowCtx(rows[+tr.dataset.i]);
  });
  onCtx(tb, e => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return null;
    const r = rows[+tr.dataset.i];
    return [
      { label: "看原文上下文（左右對照）", act: () => rowCtx(r) },
      { label: "複製此行（〔〕＝與另一本不同）", act: () => copyAndTell(`${A.siglum} ${locStr(r.la, A)}：${segPlain(r.a, ["〔", "〕"])}\n${B.siglum} ${locStr(r.lb, B)}：${segPlain(r.b, ["〔", "〕"])}`) },
    ];
  });
}
// 「相同文字著色」開關（對照表、原文預覽、檢索結果共用）
function sameToggle(getTarget) {
  const c = h("input", { type: "checkbox", onchange: e => {
    saveUI({ showSame: e.target.checked });
    $$(".show-same-able").concat([getTarget && getTarget()]).forEach(el => el && el.classList.toggle("show-same", e.target.checked));
  } });
  c.checked = S.ui.showSame !== false;
  return h("label", { class: "chk", title: "把與對方相同的文字塗上淡綠色" }, c, h("i", { class: "same-swatch" }), "相同文字著色");
}
function rowSide(segs, side, t, loc) {
  const pg = { p: loc && loc[0] };
  const paged = loc && loc[0] != null;
  let out = "";
  // data-k：同一行左右兩欄的第 k 段彼此對應（懸停時框出另一欄的對應段）
  segs.forEach(([tag, text, marks], k) => {
    if (tag === "=") out += `<span class="s" data-k="${k}">${rawHTML(text, paged, pg, marks, side)}</span>`;
    else if (!text) out += `<span class="gap ${side}" data-k="${k}" title="此處${side === "a" ? "左" : "右"}欄無字"></span>`;
    else out += `<span class="d d${side}" data-k="${k}">${rawHTML(text, paged, pg, null, side)}</span>`;
  });
  return out;
}

// ================================================================ 原文預覽
const CTX_PADS = [[80, "±80 字"], [300, "±300 字"], [800, "±800 字"], [2000, "±2000 字"]];
// 上下文 → HTML：保留原來的分行；與參照相同的字加 .s，所選位置加 .ctx-f（無字處畫一道插入號）
function ctxHTML(it) {
  const cps = Array.from(it.text);
  const same = it.same || [];
  const [f0, f1] = it.focus || [-1, -1];
  let si = 0, out = "", pg = it.page0, cur = null;
  const cls = i => {
    while (si < same.length && same[si][1] <= i) si++;
    const inS = si < same.length && same[si][0] <= i && i < same[si][1];
    return (inS ? "s" : "") + (i >= f0 && i < f1 ? " ctx-f" : "");
  };
  // 每段文字記下起點（data-o），換行、分頁、頁眉處斷開：由鼠標所在的字即可算出原文位置（各欄互相對應用）
  const close = () => { if (cur !== null) { out += "</span>"; cur = null; } };
  for (let i = 0; i <= cps.length; i++) {
    if (i === f0 && f0 === f1) { close(); out += '<span class="ctx-caret" title="此處無字"></span>'; }
    if (i === cps.length) break;
    const c = cps[i];
    if (c === "\x01") { close(); continue; }
    if (c === "\f") { close(); pg = (pg || 0) + 1; out += `<span class="pg">${pg}頁</span>`; continue; }
    if (c === "\n") { close(); out += "<br>"; continue; }
    const k = cls(i);
    if (k !== cur) { close(); out += `<span class="${k}" data-o="${i}">`; cur = k; }
    out += esc(c);
  }
  close();
  return out;
}

// ---- 各欄互相對應 ----
// 懸停或點擊任一欄的一處，各欄把對應的一段加框（與兩本對讀對照表的懸停樣式相同）。
// 「一段」與對照表的片段一致：在異文處斷開，並在句末標點處斷開（任一本有標點即斷，無標點的本子也能分段），
// 太長的再按 40 字切開；落在異文處則框出整個不同的單位，另一本無字處畫一個小空框。
// 對應關係取自後台的對齊塊（各本與參照逐對對齊）：非參照欄先對到參照，再由參照對到其餘各欄。
const SENT_STOP = new Set(Array.from("。！？；：!?;:\n\f"));
function linkPanels(its, panels) {
  if (its.length < 2) return;
  const boxes = panels.map(pn => $(".ctx-text", pn));
  const spans = boxes.map(box => $$("[data-o]", box).map(sp => [+sp.dataset.o, sp]));
  const layers = boxes.map(box => { const l = h("div", { class: "cp-layer" }); box.append(l); return l; });
  const N = its.map(it => it.npos.length);
  // 第 x 欄：字 k-1 與字 k 之間是否有句末標點（或換行、分頁）
  const stops = its.map(it => {
    const cps = Array.from(it.text), np = it.npos, out = new Set();
    for (let k = 1; k < np.length; k++)
      for (let r = np[k - 1] + 1; r < np[k]; r++) if (SENT_STOP.has(cps[r])) { out.add(k); break; }
    return out;
  });
  // 參照上的切分點：各本的異文邊界、各本的句末（經相同的對齊塊換算到參照）、參照自己的句末
  const cutSet = new Set([0, N[0], ...stops[0]]);
  for (let y = 1; y < its.length; y++)
    for (const [t, a0, a1, b0, b1] of its[y].ops) {
      cutSet.add(a0); cutSet.add(a1);
      if (t === "=") for (let k = b0 + 1; k < b1; k++) if (stops[y].has(k)) cutSet.add(a0 + k - b0);
    }
  const base = [...cutSet].filter(c => c >= 0 && c <= N[0]).sort((a, b) => a - b), cuts = [];
  base.forEach((c, i) => { cuts.push(c); const nx = base[i + 1]; if (nx !== undefined) for (let k = c + 40; k < nx - 5; k += 40) cuts.push(k); });
  const cell = a => { let lo = 0, hi = cuts.length - 1; while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cuts[m] <= a) lo = m; else hi = m; } return [cuts[lo], cuts[lo + 1]]; };
  const bsearch = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= v) lo = m + 1; else hi = m; } return lo - 1; };
  const r2n = (x, r) => { const np = its[x].npos; let lo = 0, hi = np.length; while (lo < hi) { const m = (lo + hi) >> 1; if (np[m] < r) lo = m + 1; else hi = m; } return Math.min(lo, np.length - 1); };
  const opOf = (x, n) => its[x].ops.find(([, , , b0, b1]) => b0 <= n && n < b1);
  // 參照範圍 [A0, A1) → 第 y 欄的範圍；參照一側為空（插入點）時取對應的插入點
  const fromRef = (y, A0, A1) => {
    let lo = Infinity, hi = -Infinity;
    for (const [t, a0, a1, b0, b1] of its[y].ops) {
      if (A0 === A1 ? !(a0 <= A0 && A0 <= a1 && (a0 < a1 || a0 === A0)) : (a1 <= A0 || a0 >= A1 || a0 === a1)) continue;
      if (t === "=") { const s0 = b0 + Math.max(A0, a0) - a0, s1 = b0 + Math.min(Math.max(A1, A0), a1) - a0; lo = Math.min(lo, s0); hi = Math.max(hi, A0 === A1 ? s0 : s1); }
      else { lo = Math.min(lo, b0); hi = Math.max(hi, b1); }
    }
    return lo === Infinity ? null : [lo, hi];
  };
  const u16 = (s, k) => { let i = 0; for (let c = 0; c < k && i < s.length; c++) i += s.codePointAt(i) > 0xffff ? 2 : 1; return i; };
  const point = (x, r, after) => {   // 原文位置 → DOM 位置（after：該字之後）
    const k = bsearch(spans[x], r);
    if (k < 0) return null;
    const [o, sp] = spans[x][k], node = sp.firstChild;
    return node ? [node, u16(node.data, r - o + (after ? 1 : 0))] : null;
  };
  const range = (x, n0, n1) => {
    const np = its[x].npos, a = point(x, np[n0], false), b = point(x, np[n1 - 1], true);
    if (!a || !b) return null;
    const rg = document.createRange();
    try { rg.setStart(a[0], a[1]); rg.setEnd(b[0], b[1]); } catch (e) { return null; }
    return rg;
  };
  // 在第 x 欄畫框：範圍內每一行一個框；空範圍畫一個小空框在插入處
  const frame = (x, n0, n1, center) => {
    const box = boxes[x], layer = layers[x], br = box.getBoundingClientRect(), np = its[x].npos;
    const put = (l, t, w, hh, cls) => {
      layer.append(h("div", { class: "cp-box" + (cls ? " " + cls : ""), style:
        `left:${l - br.left + box.scrollLeft - box.clientLeft}px;top:${t - br.top + box.scrollTop - box.clientTop}px;width:${w}px;height:${hh}px` }));
    };
    let first = null;
    if (n0 < n1) {
      const rg = range(x, n0, n1);
      if (!rg) return;
      const lines = [];
      for (const r of [...rg.getClientRects()].filter(r => r.width > 0 && r.height > 0).sort((a, b) => a.top - b.top || a.left - b.left)) {
        const ln = lines[lines.length - 1];
        if (ln && Math.abs(ln.top - r.top) < 4) { ln.right = Math.max(ln.right, r.right); ln.bottom = Math.max(ln.bottom, r.bottom); }
        else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
      }
      lines.forEach(ln => put(ln.left - 2, ln.top - 1, ln.right - ln.left + 4, ln.bottom - ln.top + 2));
      first = lines[0];
    } else if (np.length) {
      const k = Math.min(n0, np.length - 1), rg = range(x, k, k + 1);
      if (!rg) return;
      const r = rg.getBoundingClientRect(), left = n0 < np.length ? r.left : r.right;
      put(left - 4, r.top - 1, 8, r.height + 2, "gap");
      first = r;
    }
    if (first) {
      const top = first.top, bottom = first.bottom || first.top + 20;
      if (center || top < br.top || bottom > br.bottom) box.scrollTop += top - br.top - box.clientHeight / 3;
    }
  };
  let lastKey = "";
  const mark = (p, n, center) => {
    const tg = new Array(its.length).fill(null);
    if (p === 0) {
      const c = cell(n);
      tg[0] = c;
      for (let y = 1; y < its.length; y++) tg[y] = fromRef(y, c[0], c[1]);
    } else {
      const op = opOf(p, n);
      if (!op) return;
      const [t, a0, a1, b0, b1] = op;
      let ref;
      if (t === "=") { ref = cell(a0 + n - b0); tg[p] = fromRef(p, ref[0], ref[1]); }
      else { ref = [a0, a1]; tg[p] = [b0, b1]; }
      tg[0] = ref;
      for (let y = 1; y < its.length; y++) if (y !== p) tg[y] = fromRef(y, ref[0], ref[1]);
    }
    const key = JSON.stringify(tg);
    if (key === lastKey && !center) return;
    lastKey = key;
    layers.forEach(l => { l.innerHTML = ""; });
    tg.forEach((r, x) => { if (r) frame(x, r[0], r[1], center && x !== p); });
  };
  const clear = () => { layers.forEach(l => { l.innerHTML = ""; }); lastKey = ""; };
  // 鼠標下的字（原文位置）；不在任何字上（行尾空白、段間空行、邊距等）返回 null。
  // caretRangeFromPoint 總會給出最近的插入點，所以還要核對鼠標確實落在該插入點兩旁某個字的框裡。
  const at = e => {
    let node, off;
    if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(e.clientX, e.clientY); if (!r) return null; node = r.startContainer; off = r.startOffset; }
    else if (document.caretPositionFromPoint) { const r = document.caretPositionFromPoint(e.clientX, e.clientY); if (!r) return null; node = r.offsetNode; off = r.offset; }
    if (!node || node.nodeType !== 3) return null;
    const sp = node.parentElement && node.parentElement.closest("[data-o]");
    if (!sp) return null;
    const d = node.data;
    for (let k of [off, off - 1]) {
      if (k < 0 || k >= d.length) continue;
      const c = d.charCodeAt(k);
      if (c >= 0xdc00 && c <= 0xdfff && k > 0) k--;           // 落在代理對的後半：退到前半
      const len = d.codePointAt(k) > 0xffff ? 2 : 1;
      const rg = document.createRange();
      rg.setStart(node, k); rg.setEnd(node, k + len);
      for (const b of rg.getClientRects())
        if (e.clientX >= b.left - 1 && e.clientX <= b.right + 1 && e.clientY >= b.top - 1 && e.clientY <= b.bottom + 1)
          return +sp.dataset.o + Array.from(d.slice(0, k)).length;
    }
    return null;
  };
  // 懸停在字上：加框；移到空白處或移出文字框：框消失。
  // 點擊一個字：固定這組框（此時懸停不再改動，可以把鼠標移到另一欄去看）；再點另一個字換一組，點空白處取消。
  let pinned = false;
  boxes.forEach((box, p) => {
    let pending = null, timer = 0;
    // 用計時器而非 requestAnimationFrame 節流：窗口在後台時也不會積壓
    box.addEventListener("mousemove", e => {
      pending = e;
      if (!timer) timer = setTimeout(() => {
        timer = 0;
        if (pinned) return;
        const r = at(pending);
        if (r == null) clear(); else mark(p, r2n(p, r), false);
      }, 40);
    });
    box.addEventListener("mouseleave", () => { clearTimeout(timer); timer = 0; if (!pinned) clear(); });
    box.addEventListener("click", e => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;     // 拖選文字時不跳
      const r = at(e);
      if (r == null) { pinned = false; clear(); return; }
      pinned = true;
      lastKey = "";
      mark(p, r2n(p, r), true);
    });
  });
}
function focusPage(it) {
  const cps = Array.from(it.text).slice(0, Math.max(0, it.focus[0]));
  return (it.page0 || 1) + cps.filter(c => c === "\f").length;
}
// items：[{id, r0, r1, label?}]，第一個為參照；兩個時左右並排，多個時上下排列
async function openContext(items, opt) {
  opt = opt || {};
  let pad = S.ui.ctxPad || 300;
  const modes = [];        // 各欄目前看文字還是原件；改上下文長度重載時沿用
  let loaded = null;       // 當前顯示的內容，供匯出
  const body = h("div", { class: "ctx-wrap show-same-able" + (S.ui.showSame === false ? "" : " show-same") + (items.length === 2 ? " cols" : "") });
  const padSeg = h("div", { class: "seg" });
  const load = async () => {
    $$("button", padSeg).forEach(b => b.classList.toggle("on", +b.dataset.p === pad));
    body.innerHTML = "<div class='muted' style='padding:20px'>載入中…</div>";
    try {
      const d = await api("context", { items: items.map(x => ({ id: x.id, r0: x.r0, r1: x.r1 })), pad });
      body.innerHTML = "";
      loaded = { its: d.items, srcs: items, pad, title: opt.title || "原文上下文", panels: [] };
      d.items.forEach((it, x) => { const pn = ctxPanel(it, items[x], x, items.length, modes); loaded.panels.push(pn); body.append(pn); });
      linkPanels(d.items, loaded.panels);
      requestAnimationFrame(() => $$(".ctx-text", body).forEach(box => {
        const f = $(".ctx-f, .ctx-caret", box);   // 用屏幕坐標算：文字框是定位容器（畫對應框用），offsetTop 的參照不同
        if (f) box.scrollTop += f.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3;
      }));
    } catch (e) { body.innerHTML = ""; body.append(h("div", { class: "placeholder" }, e.message)); }
  };
  for (const [p, lab] of CTX_PADS)
    padSeg.append(h("button", { "data-p": p, onclick: () => { pad = p; saveUI({ ctxPad: p }); load(); } }, lab));
  const multi = items.length > 1;
  const bar = h("div", { class: "ctx-bar" }, h("span", { class: "muted" }, "上下文"), padSeg, multi ? sameToggle(() => body) : null,
    h("span", { class: "legend" },
      multi ? h("span", {}, h("i", { class: "plain-swatch" }), "未著色＝不同或參照所無") : null,
      h("span", {}, h("i", { class: "focus-swatch" }), "所選位置"),
      h("span", {}, h("span", { class: "ctx-caret", style: "margin:0 4px 0 2px" }), "此處無字"),
      multi ? h("span", {}, h("i", { class: "cp-swatch" }), "對應的一段") : null),
    h("button", { class: "btn", style: "margin-left:auto", onclick: e => loaded && menu(e.currentTarget, ctxExportItems(loaded)) }, "匯出 ▾"));
  onCtx(body, e => {
    if (!loaded) return null;
    const pn = e.target.closest(".ctx-panel");
    const x = pn ? loaded.panels.indexOf(pn) : -1;
    return [
      x >= 0 && { label: "複製此欄（【】＝所選位置）", act: () => copyAndTell(ctxPlainPanel(loaded, x)) },
      ...ctxExportItems(loaded),
    ];
  });
  const note = h("div", { class: "ctx-note muted" }, multi
    ? "第一欄是參照。淡綠標「異同」：與參照相同的字塗淡綠" + (items.length > 2 ? "（參照欄的淡綠＝各本皆同）" : "") +
      "。金色底線標「位置」：你雙擊進來的那一處，與異同無關——底線內沒有塗綠的字，就是那裡的異文。" +
      "鼠標停在任一欄的字上，各欄把對應的一段加框（到異文或句末為止；落在異文處框出整個不同的單位，另一本無字處畫小空框），不在視區內會捲過去；點擊可固定這組框，再點空白處取消。"
    : "金色底線是你雙擊進來的那一處。");
  load();
  await dialog(opt.title || "原文上下文", [bar, note, body], [{ label: "關閉", cls: "primary" }], "xwide");
}
function ctxPanel(it, src, x, n, modes) {
  const t = T(src.id);
  const label = src.label || (t ? t.siglum + "　" + t.name : src.id);
  const textBox = h("div", { class: "ctx-text", html: ctxHTML(it) });
  const head = h("div", { class: "ctx-head" }, h("b", {}, label), h("span", { class: "muted" }, locStr(it.loc, t)),
    x === 0 && n > 1 ? h("span", { class: "chip" }, "參照") : null);
  const panel = h("div", { class: "ctx-panel" }, head, textBox);
  if (it.pdf) {
    const viewer = pdfViewer(src.id, it, n > 1);
    const bText = h("button", { class: "on" }, "文字"), bImg = h("button", {}, "原件");
    const mode = img => {
      bImg.classList.toggle("on", img); bText.classList.toggle("on", !img);
      textBox.hidden = img; viewer.bar.hidden = !img; viewer.box.hidden = !img;
      if (modes) modes[x] = img;
      if (img) viewer.open();
    };
    bText.onclick = () => mode(false);
    bImg.onclick = () => mode(true);
    head.append(h("span", { class: "sp" }), h("div", { class: "seg" }, bText, bImg));
    panel.append(viewer.bar, viewer.box);
    panel._pdfv = viewer;
    if (modes && modes[x]) requestAnimationFrame(() => mode(true));
  }
  return panel;
}

// ---------------------------------------------------------------- 原件瀏覽
// 各頁上下相接，滾動即翻頁，只載入看得到的頁；可縮放，按住拖動可平移。
// PDF 有文字層時，把「所選位置」和「與參照相同」的文字標在原件上，與文字視圖一致。
const PDFV_ZOOMS = [1, 1.25, 1.5, 2, 3];
const SVGNS = "http://www.w3.org/2000/svg";
// 相鄰的字併成一個框：與前一字同在一橫行且左右相接，或同在一豎行且上下相接；null 表示中間隔了不標的字。
// 只跟前一字比（不跟已併的框比），否則橫排下一行的首字會被當作豎排的下一字併進來。
function mergeBoxes(list) {
  const out = [];
  let r = null, last = null;
  for (const b of list) {
    if (!b) { r = last = null; continue; }
    if (last) {
      const [x, y, w, hh] = b, [lx, ly, lw, lh] = last;
      const size = Math.max(Math.min(hh, lh), Math.min(w, lw));
      const vOver = Math.min(y + hh, ly + lh) - Math.max(y, ly), hOver = Math.min(x + w, lx + lw) - Math.max(x, lx);
      const hGap = x - (lx + lw), vGap = y - (ly + lh);
      const row = vOver > 0.5 * Math.min(hh, lh) && hGap > -0.5 * size && hGap < 0.5 * size;
      const col = hOver > 0.5 * Math.min(w, lw) && vGap > -0.5 * size && vGap < 0.5 * size;
      if (row || col) {
        const nx = Math.min(r[0], x), ny = Math.min(r[1], y);
        r[2] = Math.max(r[0] + r[2], x + w) - nx; r[3] = Math.max(r[1] + r[3], y + hh) - ny; r[0] = nx; r[1] = ny;
        last = b;
        continue;
      }
    }
    r = b.slice();
    last = b;
    out.push(r);
  }
  return out;
}
function pdfViewer(id, it, compared) {
  const fpage = focusPage(it);
  const total = Math.max(it.pages || 1, fpage);
  const cps = Array.from(it.text);
  const w0 = it.w0 || 0, w1 = w0 + cps.length;
  const firstPg = it.page0 || 1, lastPg = firstPg + cps.filter(c => c === "\f").length;
  const same = it.same || [];
  const [f0, f1] = it.focus || [-1, -1];
  let zi = 0, cur = fpage, started = false, userMoved = false, raf = 0, io = null, marked = 0, unmarked = 0;

  const box = h("div", { class: "pdfv", hidden: true, tabindex: "0" });
  const pages = [];
  for (let n = 1; n <= total; n++) {
    const img = h("img", { alt: "", draggable: "false" });
    const el = h("div", { class: "pdfv-page", "data-n": n }, h("span", { class: "pdfv-num" }, n), img);
    const pg = { n, el, img, w: 0, aspect: 0, marks: null, asked: false, timer: 0 };
    img.onload = () => { setAspect(pg, img.naturalHeight / Math.max(1, img.naturalWidth)); draw(pg); };
    img.onerror = () => { if (img.getAttribute("src")) { pg.w = 0; el.classList.add("err"); } };
    pages.push(pg);
    box.append(el);
  }
  const go = h("input", { class: "pdfv-go", type: "number", min: 1, max: total, value: fpage, title: "輸入頁碼後按回車跳轉",
    onchange: e => toPage(Math.max(1, Math.min(total, +e.target.value || cur))) });
  const zlab = h("span", { class: "pdfv-zlab" });
  const hint = h("span", { class: "muted pdfv-hint" });
  const bar = h("div", { class: "pdfv-bar", hidden: true },
    h("button", { class: "icon-btn", title: "上一頁（←）", onclick: () => toPage(cur - 1) }, "‹"),
    h("span", { class: "muted" }, "第"), go, h("span", { class: "muted" }, "/ " + total + " 頁"),
    h("button", { class: "icon-btn", title: "下一頁（→）", onclick: () => toPage(cur + 1) }, "›"),
    h("span", { class: "pdfv-sep" }),
    h("button", { class: "icon-btn", title: "縮小（−）", onclick: () => zoom(zi - 1) }, "−"), zlab,
    h("button", { class: "icon-btn", title: "放大（＋）", onclick: () => zoom(zi + 1) }, "+"),
    hint, h("span", { class: "sp" }),
    h("button", { class: "btn ghost", onclick: () => api("open", { id }).catch(fail) }, "打開原文件"));

  const want = () => Math.min(2400, Math.max(600,
    Math.ceil(box.clientWidth * PDFV_ZOOMS[zi] * (window.devicePixelRatio || 1) / 200) * 200));
  function load(pg) {
    const w = want();
    if (pg.w < w) {
      pg.w = w;
      pg.el.classList.remove("err");
      pg.img.src = `/api/pageimg?id=${encodeURIComponent(id)}&p=${pg.n}&w=${w}&t=${DK.token}`;
    }
    if (!pg.asked && pg.n >= firstPg && pg.n <= lastPg) {
      pg.asked = true;
      api("pageboxes", { id, p: pg.n }).then(d => {
        d.boxes = d.boxes.map(b => b && b.map(v => v / 10000));   // 後台給的是萬分之一的整數
        pg.marks = d;
        if (d.boxes.some(Boolean)) marked++; else unmarked++;
        updHint();
        draw(pg);
      }).catch(() => { unmarked++; updHint(); });
    }
  }
  function updHint() {
    hint.textContent = marked ? (compared ? "框＝所選位置　綠＝與參照相同" : "框＝所選位置")
      : unmarked ? "此頁沒有文字層，無法在原件上標注" : "";
  }
  // 各頁高寬比：第一頁載入後作為其餘未載入頁的默認值；在視區之上的頁變高變矮時，眼前的內容不動
  function anchor() {
    const pg = pages[viewPage() - 1];
    const top = pg.el.offsetTop, hgt = pg.el.offsetHeight || 1, frac = (box.scrollTop - top) / hgt;
    return () => { box.scrollTop = pg.el.offsetTop + frac * pg.el.offsetHeight; };
  }
  function setAspect(pg, a) {
    if (!a || Math.abs(a - pg.aspect) < 1e-3) return;
    const restore = anchor();
    if (!box.style.getPropertyValue("--pa")) box.style.setProperty("--pa", a.toFixed(4));
    pg.aspect = a;
    pg.el.style.aspectRatio = "1 / " + a.toFixed(4);
    restore();
  }
  function viewPage() {
    const y = box.scrollTop + box.clientHeight * 0.35;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pages[mid].el.offsetTop <= y) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  function updPage() { cur = viewPage(); if (document.activeElement !== go) go.value = cur; }
  function toPage(n) {
    if (n < 1 || n > total) return;
    userMoved = true;
    box.scrollTop = pages[n - 1].el.offsetTop - 10;
    updPage();
  }
  function zoom(z) {
    z = Math.max(0, Math.min(PDFV_ZOOMS.length - 1, z));
    if (z === zi) return;
    const restore = anchor(), cx = (box.scrollLeft + box.clientWidth / 2) / Math.max(1, box.scrollWidth);
    zi = z;
    box.style.setProperty("--z", PDFV_ZOOMS[zi]);
    zlab.textContent = Math.round(PDFV_ZOOMS[zi] * 100) + "%";
    restore();
    box.scrollLeft = cx * box.scrollWidth - box.clientWidth / 2;
    for (let n = Math.max(1, cur - 2); n <= Math.min(total, cur + 2); n++) if (pages[n - 1].w) load(pages[n - 1]);
  }
  function draw(pg) {
    if (!pg.marks || !pg.aspect || pg.drawn) return;
    pg.drawn = true;
    const { o0, boxes } = pg.marks;
    const sameL = [], focL = [];
    let caret = null, si = 0;
    for (let k = Math.max(0, w0 - o0), hi = Math.min(boxes.length, w1 - o0); k < hi; k++) {
      const b = boxes[k], rel = o0 + k - w0;
      if (f0 === f1 && rel >= f0 && !caret && b) caret = b;
      if (!b) { sameL.push(null); focL.push(null); continue; }
      while (si < same.length && same[si][1] <= rel) si++;
      sameL.push(si < same.length && same[si][0] <= rel ? b : null);
      focL.push(rel >= f0 && rel < f1 ? b : null);
    }
    const H = 1000 * pg.aspect;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", `0 0 1000 ${H.toFixed(1)}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const rect = (b, cls, pad) => {
      const r = document.createElementNS(SVGNS, "rect");
      r.setAttribute("x", (b[0] * 1000 - pad).toFixed(1)); r.setAttribute("y", (b[1] * H - pad).toFixed(1));
      r.setAttribute("width", (b[2] * 1000 + 2 * pad).toFixed(1)); r.setAttribute("height", (b[3] * H + 2 * pad).toFixed(1));
      r.setAttribute("class", cls);
      svg.append(r);
      return r;
    };
    mergeBoxes(sameL).forEach(b => rect(b, "pm-same", 1));
    const foc = mergeBoxes(focL);
    foc.forEach(b => rect(b, "pm-focus", 3));
    if (caret) rect([caret[0] - 0.002, caret[1], 0.003, caret[3]], "pm-caret", 2);
    pg.el.append(svg);
    // 打開原件後先停在所選位置所在的頁；標注到了再把所選位置移到視區上部（使用者已自行翻動則不動）
    const fy = foc.length ? foc[0][1] : caret ? caret[1] : null;
    if (fy !== null && pg.n === fpage && !userMoved && !box.hidden) {
      box.scrollTop = pg.el.offsetTop + fy * pg.el.offsetHeight - box.clientHeight / 3;
      updPage();
    }
  }

  // 拖動平移（不觸發「拖入文件」）；觸控板捏合縮放；方向鍵、PageUp/PageDown 翻頁
  box.addEventListener("mousedown", e => {
    const r = box.getBoundingClientRect();
    if (e.button !== 0 || e.clientX - r.left > box.clientWidth || e.clientY - r.top > box.clientHeight) return;
    e.preventDefault();
    box.focus({ preventScroll: true });
    userMoved = true;
    const sx = e.clientX, sy = e.clientY, sl = box.scrollLeft, st = box.scrollTop;
    box.classList.add("grabbing");
    const move = ev => { box.scrollLeft = sl - (ev.clientX - sx); box.scrollTop = st - (ev.clientY - sy); };
    const up = () => { box.classList.remove("grabbing"); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  let pinch = 0;
  box.addEventListener("wheel", e => {
    userMoved = true;
    if (!e.ctrlKey) return;
    e.preventDefault();
    pinch += e.deltaY;
    if (Math.abs(pinch) > 30) { zoom(zi + (pinch < 0 ? 1 : -1)); pinch = 0; }
  }, { passive: false });
  box.addEventListener("keydown", e => {
    const k = e.key;
    if (k === "ArrowRight" || k === "PageDown") toPage(cur + 1);
    else if (k === "ArrowLeft" || k === "PageUp") toPage(cur - 1);
    else if (k === "Home") toPage(1);
    else if (k === "End") toPage(total);
    else if (k === "+" || k === "=") zoom(zi + 1);
    else if (k === "-" || k === "_") zoom(zi - 1);
    else if (k === "0") zoom(0);
    else { if (k === "ArrowUp" || k === "ArrowDown" || k === " ") userMoved = true; return; }
    e.preventDefault();
  });
  box.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; updPage(); }); });

  function open() {
    if (started) { box.focus({ preventScroll: true }); return; }
    started = true;
    zlab.textContent = "100%";
    box.scrollTop = pages[fpage - 1].el.offsetTop - 10;
    // 進入視區（上下各多一屏）停留片刻才載入：快速翻過的頁不請求；離開後卸下圖片，交還內存（取消未完成的請求）
    io = new IntersectionObserver(es => es.forEach(e => {
      const pg = pages[+e.target.dataset.n - 1];
      clearTimeout(pg.timer);
      if (e.isIntersecting) pg.timer = setTimeout(() => load(pg), 120);
      else if (pg.w) { pg.img.removeAttribute("src"); pg.w = 0; }
    }), { root: box, rootMargin: "100% 0px" });
    pages.forEach(pg => io.observe(pg.el));
    box.focus({ preventScroll: true });
  }
  // 當前頁連同標注存成 PNG（標注按畫面上的樣子畫進圖裡；「相同文字著色」關閉時不畫淡綠）
  async function snapshot() {
    const pg = pages[cur - 1];
    const res = await fetch(`/api/pageimg?id=${encodeURIComponent(id)}&p=${pg.n}&w=2000&t=${DK.token}`);
    if (!res.ok) throw new Error("取不到第 " + pg.n + " 頁的頁面圖");
    const url = URL.createObjectURL(await res.blob());
    try {
      const img = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error("頁面圖無法解碼")); im.src = url; });
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const g = cv.getContext("2d");
      g.drawImage(img, 0, 0);
      const svg = $("svg", pg.el);
      if (svg) {
        const vb = svg.viewBox.baseVal, sx = cv.width / vb.width, sy = cv.height / vb.height;
        const focus = getComputedStyle(box).getPropertyValue("--focus").trim() || "#c98a12";
        const showSame = !!box.closest(".show-same");
        for (const r of svg.querySelectorAll("rect")) {
          const x = +r.getAttribute("x") * sx, y = +r.getAttribute("y") * sy, w = +r.getAttribute("width") * sx, hh = +r.getAttribute("height") * sy;
          const c = r.getAttribute("class");
          if (c === "pm-same") { if (!showSame) continue; g.fillStyle = "rgba(64,150,92,.30)"; g.fillRect(x, y, w, hh); }
          else if (c === "pm-focus") { g.fillStyle = "rgba(201,138,18,.10)"; g.fillRect(x, y, w, hh); g.strokeStyle = focus; g.lineWidth = Math.max(2, cv.width / 700); g.strokeRect(x, y, w, hh); }
          else { g.fillStyle = focus; g.fillRect(x, y, w, hh); }
        }
      }
      return cv.toDataURL("image/png").split(",")[1];
    } finally { URL.revokeObjectURL(url); }
  }
  return { bar, box, open, snapshot, page: () => cur, started: () => started };
}

// ---------------------------------------------------------------- 原文上下文的匯出
// 每欄切成文字段：相同（與參照同）、所選位置；略去頁眉，分頁處標頁碼，無字處的所選位置記作 ‸
function ctxSegs(it) {
  const cps = Array.from(it.text), same = it.same || [], [f0, f1] = it.focus || [-1, -1];
  const out = [];
  let pg = it.page0, si = 0;
  const push = (text, sm, fc) => {
    const last = out[out.length - 1];
    if (last && last.same === sm && last.focus === fc) last.text += text;
    else out.push({ text, same: sm, focus: fc });
  };
  for (let i = 0; i <= cps.length; i++) {
    if (i === f0 && f0 === f1) push("‸", false, true);
    if (i === cps.length) break;
    const c = cps[i];
    if (c === "\x01") continue;
    while (si < same.length && same[si][1] <= i) si++;
    const sm = si < same.length && same[si][0] <= i && i < same[si][1], fc = i >= f0 && i < f1;
    if (c === "\f") { pg = (pg || 0) + 1; push(`\n〔第 ${pg} 頁〕\n`, false, false); continue; }
    push(c, sm, fc);
  }
  return out;
}
function ctxHead(L, x) {
  const it = L.its[x], src = L.srcs[x], t = T(src.id);
  const label = src.label || (t ? t.siglum + "　" + t.name : src.id);
  return label + "　" + locStr(it.loc, t) + (x === 0 && L.its.length > 1 ? "（參照）" : "");
}
function ctxPlainPanel(L, x) {
  return ctxSegs(L.its[x]).map(s => s.focus ? "【" + s.text + "】" : s.text).join("").replace(/】【/g, "");
}
function ctxPlain(L, md) {
  const out = [(md ? "# " : "") + L.title, "",
    `上下文 ±${L.pad} 字；【】＝所選位置（‸＝此處無字）` + (L.its.length > 1 ? "；與參照相同的文字在 Word 版中塗淡綠。" : "。"), ""];
  L.its.forEach((it, x) => out.push((md ? "## " : "") + ctxHead(L, x), "", ctxPlainPanel(L, x), ""));
  return out.join("\n");
}
function ctxExportItems(L) {
  const name = "原文上下文_" + fileSafe(L.title.replace(/^原文上下文[：:]?/, "") || L.its.map((it, x) => (T(L.srcs[x].id) || {}).siglum).join(""));
  const runs = it => ctxSegs(it).map(s => ({ text: s.text, hl: [s.same && "same", s.focus && "focus"].filter(Boolean).join(" ") }));
  const word = () => {
    const blocks = [{ t: "h", level: 0, text: L.title },
      { t: "p", size: 10, runs: [{ text: `上下文 ±${L.pad} 字。圖例：`, hl: "muted" },
        ...(L.its.length > 1 ? [{ text: "與參照相同", hl: "same" }, "　"] : []), { text: "所選位置", hl: "focus" }] }];
    if (L.its.length === 2)
      blocks.push({ t: "table", widths: [1, 1], header: [ctxHead(L, 0), ctxHead(L, 1)], rows: [[runs(L.its[0]), runs(L.its[1])]] });
    else L.its.forEach((it, x) => blocks.push({ t: "h", level: 2, text: ctxHead(L, x) }, { t: "p", runs: runs(it) }));
    saveOffice("docx", name + ".docx", { blocks, landscape: L.its.length === 2 });
  };
  const excel = () => {
    const flat = t => t.replace(/\n+/g, "");
    const rows = L.its.map((it, x) => {
      const segs = ctxSegs(it);
      const fi = segs.findIndex(s => s.focus), li = segs.length - 1 - [...segs].reverse().findIndex(s => s.focus);
      const part = (a, b) => flat(segs.slice(a, b).map(s => s.text).join(""));
      const t = T(L.srcs[x].id);
      return [t ? t.siglum : "", t ? t.name : "", locStr(it.loc, t), fi < 0 ? part(0, segs.length) : part(0, fi), fi < 0 ? "" : part(fi, li + 1), fi < 0 ? "" : part(li + 1, segs.length)];
    });
    saveOffice("xlsx", name + ".xlsx", { sheets: [{ name: "原文上下文", header: ["本", "名稱", "位置", "上文", "所選位置", "下文"], widths: [6, 24, 12, 50, 30, 50], rows }] });
  };
  const pdfs = L.panels.map((pn, x) => ({ pn, x })).filter(o => o.pn._pdfv && o.pn._pdfv.started() && !o.pn._pdfv.box.hidden);
  return [
    { label: "匯出：Word（淡綠＝相同，底線＝所選）", act: word },
    { label: "匯出：Excel（每本一行：上文、所選、下文）", act: excel },
    { label: "匯出：Markdown", act: () => saveText(name + ".md", ctxPlain(L, true), "text/markdown") },
    { label: "匯出：TXT", act: () => saveText(name + ".txt", ctxPlain(L, false)) },
    { label: "複製全部（【】＝所選位置）", act: () => copyAndTell(ctxPlain(L, false)) },
    pdfs.length && "-",
    ...pdfs.map(({ pn, x }) => {
      const t = T(L.srcs[x].id), pg = pn._pdfv.page();
      return { label: `存原件：${t ? t.siglum : ""} 第 ${pg} 頁（PNG，含標注）`, act: async () => saveBinary(`${name}_${t ? t.siglum : ""}_第${pg}頁.png`, await pn._pdfv.snapshot(), "image/png") };
    }),
  ];
}

// 兩本對讀的匯出
function pairExportMenu(btn) {
  menu(btn, [
    { label: "本段對照（Word，彩色）", act: () => exportPairDocx(false) },
    { label: "本段對照（Excel）", act: exportPairXlsx },
    { label: "本段對照（Markdown）", act: () => exportPairMD(false) },
    "-",
    { label: "全部段落對照（Word）", act: () => exportPairDocx(true) },
    { label: "全部段落對照（Markdown）", act: () => exportPairMD(true) },
    "-",
    { label: "平行段落列表（Excel）", act: exportPassagesXlsx },
    { label: "平行段落列表（CSV）", act: exportPassagesCSV },
  ]);
}
// 對照表的一側 → Word 文字片段（相同淡綠、此側獨有黃或藍；無字處用 ‸）
function sideRuns(segs, side) {
  const out = [];
  for (const [tag, text] of segs) {
    const t = plainRaw(text);
    if (tag === "=") out.push({ text: t, hl: "same" });
    else out.push(t ? { text: t, hl: side } : { text: "‸", hl: "muted" });
  }
  return out;
}
async function passageRows(i) {
  const R = S.pair;
  return (i === S.pairSel && S.pairRows) ? S.pairRows : api("passage", { a: R.a, b: R.b, i });
}
async function exportPairDocx(all) {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const blocks = [{ t: "h", level: 0, text: `對讀：${A.siglum}《${A.name}》與${B.siglum}《${B.name}》` },
    { t: "p", size: 10, runs: [{ text: `${sigName(A)} ${R.nA} 字，${pct(R.coverA)} 見於${sigName(B)}；${sigName(B)} ${R.nB} 字，${pct(R.coverB)} 見於${sigName(A)}。歸一方式：${$("#set-summary").textContent}。`, hl: "muted" }] },
    { t: "p", size: 10, runs: ["圖例：", { text: "兩本相同", hl: "same" }, "　", { text: A.siglum + "獨有", hl: "a" }, "　", { text: B.siglum + "獨有", hl: "b" }, "　", { text: "‸", hl: "muted" }, "＝此處無字"] }];
  const list = all ? R.passages.map(p => p.i) : [S.pairSel];
  for (const i of list) {
    const p = R.passages[i], d = await passageRows(i);
    blocks.push({ t: "h", level: 2, text: `段落 ${i + 1}：${A.siglum} ${locStr(p.locA, A)}–${locStr(p.locA2, A)} ↔ ${B.siglum} ${locStr(p.locB, B)}–${locStr(p.locB2, B)}${p.ord ? "" : "（次序不同）"}` },
      { t: "p", size: 10, runs: [{ text: `相同 ${d.stat.eq} 字，異文 ${d.stat.nvar} 處，相似度 ${pct(d.stat.sim)}`, hl: "muted" }] },
      { t: "table", widths: [1.1, 5, 5, 1.1], header: ["位置", A.siglum + "　" + A.name, B.siglum + "　" + B.name, "位置"],
        rows: d.rows.map(r => [locStr(r.la, A), sideRuns(r.a, "a"), sideRuns(r.b, "b"), locStr(r.lb, B)]) });
  }
  saveOffice("docx", `對讀_${A.siglum}${B.siglum}${all ? "_全部" : "_段" + (S.pairSel + 1)}.docx`, { blocks, landscape: true });
}
async function exportPairXlsx() {
  const R = S.pair, A = T(R.a), B = T(R.b), d = S.pairRows;
  if (!d) return;
  saveOffice("xlsx", `對讀_${A.siglum}${B.siglum}_段${S.pairSel + 1}.xlsx`, { sheets: [{ name: "段落" + (S.pairSel + 1),
    header: ["行", A.siglum + "位置", A.siglum + "（〔〕＝與另一本不同）", B.siglum + "位置", B.siglum + "（〔〕＝與另一本不同）"], widths: [5, 12, 60, 12, 60],
    rows: d.rows.map((r, x) => [x + 1, locStr(r.la, A), segPlain(r.a, ["〔", "〕"]), locStr(r.lb, B), segPlain(r.b, ["〔", "〕"])]) }] });
}
function exportPassagesXlsx() {
  const R = S.pair, A = T(R.a), B = T(R.b);
  saveOffice("xlsx", `平行段落_${A.siglum}${B.siglum}.xlsx`, { sheets: [{ name: "平行段落",
    header: ["段落", A.siglum + "起", A.siglum + "止", A.siglum + "字數", B.siglum + "起", B.siglum + "止", B.siglum + "字數", "完全相同字數", "相同比例（下限）", "次序", A.siglum + "開頭"],
    widths: [6, 12, 12, 8, 12, 12, 8, 10, 10, 8, 40],
    rows: R.passages.map(p => [p.i + 1, locStr(p.locA, A), locStr(p.locA2, A), p.la, locStr(p.locB, B), locStr(p.locB2, B), p.lb, p.m,
      Math.round(p.sim * 100) + "%", p.ord ? "一致" : "移位", p.pa]) }] });
}
function csvCell(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportPassagesCSV() {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const lines = [["段落", A.siglum + "起", A.siglum + "止", A.siglum + "字數", B.siglum + "起", B.siglum + "止", B.siglum + "字數",
    "完全相同字數", "次序", A.siglum + "開頭"].map(csvCell).join(",")];
  for (const p of R.passages)
    lines.push([p.i + 1, locStr(p.locA, A), locStr(p.locA2, A), p.la, locStr(p.locB, B), locStr(p.locB2, B), p.lb, p.m,
      p.ord ? "一致" : "移位", p.pa].map(csvCell).join(","));
  saveText(`平行段落_${A.siglum}_${B.siglum}.csv`, "﻿" + lines.join("\n"), "text/csv");
}
function segPlain(segs, mark) {
  return segs.map(([tag, text]) => {
    const t = text.replace(/[\f\x01]/g, "").replace(/\s+/g, "");
    return tag === "=" ? t : (mark[0] + t + mark[1]);
  }).join("");
}
async function exportPairMD(all) {
  const R = S.pair, A = T(R.a), B = T(R.b);
  const out = [`# 對讀：${A.siglum}《${A.name}》與${B.siglum}《${B.name}》`, "",
    `- ${sigName(A)}：${R.nA} 字，${pct(R.coverA)} 見於${sigName(B)}`,
    `- ${sigName(B)}：${R.nB} 字，${pct(R.coverB)} 見於${sigName(A)}`,
    `- 歸一方式：${$("#set-summary").textContent}`,
    `- 標記：〔〕內為兩本不同之處；〔〕內為空表示此本無字。`, ""];
  const list = all ? R.passages.map(p => p.i) : [S.pairSel];
  for (const i of list) {
    const p = R.passages[i];
    const d = (i === S.pairSel && S.pairRows) ? S.pairRows : await api("passage", { a: R.a, b: R.b, i });
    out.push(`## 段落 ${i + 1}：${A.siglum} ${locStr(p.locA, A)}–${locStr(p.locA2, A)} ↔ ${B.siglum} ${locStr(p.locB, B)}–${locStr(p.locB2, B)}${p.ord ? "" : "（次序不同）"}`, "");
    out.push(`相同 ${d.stat.eq} 字，異文 ${d.stat.nvar} 處，相似度 ${pct(d.stat.sim)}`, "");
    out.push(`| 位置 | ${A.siglum} | ${B.siglum} |`, "|---|---|---|");
    for (const r of d.rows)
      out.push(`| ${locStr(r.la, A)} | ${segPlain(r.a, ["〔", "〕"]).replace(/\|/g, "｜")} | ${segPlain(r.b, ["〔", "〕"]).replace(/\|/g, "｜")} |`);
    out.push("");
  }
  saveText(`對讀_${A.siglum}_${B.siglum}${all ? "_全部" : "_段" + (S.pairSel + 1)}.md`, out.join("\n"), "text/markdown");
}

// ================================================================ 多本對校
// 底本 ""＝未選；校本＝勾選的文本中、除底本和使用者關掉的以外（新勾選的文本自動加入）
function collIds() {
  const ok = onTexts().map(t => t.id);
  let base = S.ui.cbase;
  if (base === undefined || (base && !ok.includes(base))) base = ok[0] || "";
  const off = new Set(S.ui.cwitsOff || []);
  const wits = base ? ok.filter(w => w !== base && !off.has(w)) : [];
  return [base, wits];
}
let collTimer = null;
function collFollow(now) {
  clearTimeout(collTimer);
  collTimer = setTimeout(() => {
    const [base, wits] = collIds();
    if (base && wits.length) {
      const C = S.coll;
      const same = C && !C.seg && C.base === base && C.wits.length + C.bad.length === wits.length &&
        wits.every(w => C.wits.includes(w) || C.bad.includes(w));
      if (same && !S.collDirty && $("#view-coll .coll-pane")) renderCollBar();
      else runColl();
    } else {
      if (!(S.coll && S.coll.seg)) { S.coll = null; collSeq++; updating("coll", false); }
      renderCollEmpty();
    }
  }, now ? 0 : 350);
}

function renderCollBar() {
  const v = $("#view-coll");
  let bar = $(".bar", v);
  if (!bar) { bar = h("div", { class: "bar" }); v.prepend(bar); }
  bar.innerHTML = "";
  if (S.coll && S.coll.seg) {
    const q = S.coll.seg.query;
    bar.append(h("button", { class: "btn", onclick: () => switchTab("seg") }, "‹ 返回檢索結果"),
      h("span", {}, "檢索：", h("b", { style: "font-family:var(--serif)" }, "「" + (Array.from(q).length > 24 ? Array.from(q).slice(0, 24).join("") + "……" : q) + "」"),
        h("span", { class: "muted" }, `　${S.coll.all.length} 處`)),
      h("button", { class: "btn ghost", onclick: () => { S.coll = null; collFollow(true); } }, "改為全文對校"),
      h("span", { class: "sp" }),
      h("button", { class: "btn", onclick: e => llmMenu(e.currentTarget) }, "給 LLM ▾"),
      h("button", { class: "btn", onclick: e => collExportMenu(e.currentTarget) }, "匯出 ▾"));
    return;
  }
  if (onTexts().length < 2) { bar.append(h("span", { class: "muted" }, "請在左側勾選至少兩個文本。")); return; }
  const [base, wits] = collIds();
  const sel = h("select", { onchange: e => { saveUI({ cbase: e.target.value }); collFollow(); } }, h("option", { value: "" }, "（未選）"));
  for (const t of onTexts()) { const o = h("option", { value: t.id }, t.siglum + "　" + t.name); if (t.id === base) o.selected = true; sel.append(o); }
  const chips = h("div", { class: "wit-chips" });
  for (const t of onTexts()) {
    if (t.id === base) continue;
    const on = wits.includes(t.id);
    chips.append(h("button", { class: "wchip" + (on ? " on" : ""), title: t.name + (on ? "（點擊不參與）" : "（點擊加入）"), onclick: () => {
      const off = new Set(S.ui.cwitsOff || []);
      if (on) off.add(t.id); else off.delete(t.id);
      saveUI({ cwitsOff: [...off] }); renderCollBar(); collFollow();
    }, oncontextmenu: e => {
      e.preventDefault();
      menu(e, [
        { label: "設為底本", act: () => { saveUI({ cbase: t.id }); collFollow(true); } },
        { label: on ? "不參與對校" : "加入對校", act: () => {
          const off = new Set(S.ui.cwitsOff || []);
          if (on) off.add(t.id); else off.delete(t.id);
          saveUI({ cwitsOff: [...off] }); renderCollBar(); collFollow();
        } },
        "-",
        { label: "文本設定…", act: () => textDialog(t.id) },
      ]);
    } }, h("b", {}, t.siglum), t.name.length > 10 ? t.name.slice(0, 10) + "…" : t.name));
  }
  bar.append(h("span", { class: "lbl" }, "底本"), sel, h("span", { class: "lbl" }, "校本"), chips,
    h("span", { class: "sp" }));
  if (S.coll) {
    bar.append(h("button", { class: "btn", onclick: e => llmMenu(e.currentTarget) }, "給 LLM ▾"),
      h("button", { class: "btn", onclick: e => collExportMenu(e.currentTarget) }, "匯出 ▾"));
  }
}

function renderCollEmpty() {
  const v = $("#view-coll");
  v.innerHTML = "";
  renderCollBar();
  v.append(h("div", { class: "placeholder", html: `<h3>多本對校</h3>
    在上方選定底本和校本（左側勾選的文本都可作校本），即逐字對齊，列出全部異文，生成校勘記、異文表，並統計各本讀法的分合。<br>
    結果隨選擇而變；底本選「（未選）」或關掉全部校本即清空。<br>
    程序只負責<b>確定性</b>的部分：哪裡不同、各本怎麼讀、哪些本子讀法一致。<br>
    異文的性質、何者為正讀、是否「共同錯誤」，在「異文表」中由你（或交給 LLM）判斷，「統計」會據此重算。<br>
    雙擊校記、異文或底本中的標號，可看各本在該處的原文上下文（PDF 還可看原件，並在原件上標出所選位置與相同文字）。<br>
    <span class="muted">底本只是比對的參照系，統計對各本一視同仁。</span>` }));
}

let collSeq = 0;
async function runColl() {
  const [base, wits] = collIds();
  if (!base || !wits.length) return;
  const seq = ++collSeq;
  S.collDirty = false;
  const v = $("#view-coll");
  const keep = S.coll && !S.coll.seg && $(".coll-pane", v);
  let prog = () => {};
  if (keep) updating("coll", true);
  else {
    v.innerHTML = ""; renderCollBar();
    const body = h("div", { class: "coll-body" });
    v.append(body);
    prog = busy(body, "對齊中…");
  }
  try {
    const [r, mk] = await Promise.all([runJob(api("collate", { base, wits }), prog), api("getmarks?base=" + baseId(base))]);
    if (seq !== collSeq) return;
    S.coll = prepColl(r, wits);
    S.marks = mk.marks || {};
    applyReattach();
    updating("coll", false);
    renderColl();
  } catch (e) {
    if (e.cancelled || seq !== collSeq) return;
    updating("coll", false);
    S.coll = null;
    v.innerHTML = ""; renderCollBar();
    v.append(h("div", { class: "placeholder" }, e.message));
  }
}

// 整理後台結果：讀法按文本 id 索引，給校勘單位編號
function prepColl(r, wits) {
  const C = Object.assign({}, r);
  C.wits = wits.filter(w => r.info[w] && r.info[w].ok);
  C.bad = wits.filter(w => !(r.info[w] && r.info[w].ok));
  C.all = [r.base].concat(C.wits);
  let ns = 0, ng = 0;
  for (const L of C.loci) {
    const rd = {};
    for (const [k, v] of Object.entries(L.r)) rd[k === "_base" ? r.base : k] = v ? { g: v[0], n: v[1], loc: v[2], rs: v[3], re: v[4] } : null;
    L.rd = rd;
    if (L.kind === "sub") L.no = ++ns; else L.no = "形" + (++ng);
  }
  C.nsub = ns; C.ngra = ng;
  // 同文：各本相同的文字（後台按「哪幾本相同」分段）；只有底本一本的段落不算同文，不編號
  const fix = o => { const x = {}; for (const [k, v] of Object.entries(o || {})) x[k === "_base" ? r.base : k] = v; return x; };
  let no = 0;
  C.same = (r.same || []).map(g => {
    const st = fix(g.st), pat = C.all.map(w => st[w] || "-").join("");
    const neq = Array.from(pat).filter(c => c === "=").length;
    return Object.assign({}, g, { st, rr: fix(g.rr), pat, neq, no: neq >= 2 ? ++no : null });
  });
  return C;
}

function renderColl() {
  const C = S.coll, v = $("#view-coll");
  v.innerHTML = ""; renderCollBar();
  const bt = T(C.base);
  const sum = h("div", { class: "summary" });
  sum.append(h("span", { html: `底本 <b>${esc(sigName(bt))}</b>　實質異文 <b>${C.nsub}</b> 處，字形差異 <b>${C.ngra}</b> 處` }));
  for (const w of C.wits) {
    const i = C.info[w], t = T(w);
    sum.append(h("span", { title: `對應底本 ${locStr(i.locA, bt)}–${locStr(i.locA2, bt)}；${sigName(t)} ${locStr(i.locB, t)}–${locStr(i.locB2, t)}`,
      html: `<b>${esc(sigName(t))}</b> 覆蓋底本 ${pct(i.covBase, 0)}，相似 ${pct(i.sim)}` }));
  }
  for (const w of C.bad) sum.append(h("span", { style: "color:var(--accent)" }, sigName(T(w)) + " 與底本沒有可對齊的文字，已略去"));
  const mr = C.markReport;
  if (mr && mr.moved.length) sum.append(h("span", { class: "chip", title: "校本組合改變後，異文單位合併或拆分，標記已搬到對應的新單位" +
    (mr.review.length ? "；其中 " + mr.review.length + " 條的正讀需覆核（見備註）" : "") }, `${mr.moved.length} 條標記已重新對應`));
  if (mr && mr.lost.length) sum.append(h("button", { class: "chip warn", style: "border:0", onclick: lostMarksDialog }, `${mr.lost.length} 條標記暫無對應 ›`));
  v.append(sum);
  const subs = h("div", { class: "subtabs" });
  const seg = h("div", { class: "seg" });
  for (const [k, lab] of [["same", "同文"], ["vt", "異文"], ["app", "校記"], ["st", "統計"]])
    seg.append(h("button", { class: S.sub === k ? "on" : "", onclick: () => { S.sub = k; renderColl(); } }, lab));
  const gra = h("input", { type: "checkbox", onchange: e => { S.showGra = e.target.checked; renderColl(); } });
  gra.checked = S.showGra;
  subs.append(seg, h("span", { style: "width:14px" }), h("label", { class: "chk", title: "顯示繁簡、異體等字形差異" }, gra, "字形差異"));
  if (S.sub === "same") {
    const minSel = h("select", { style: "height:24px;font-size:12px", onchange: e => { saveUI({ sameMin: +e.target.value }); renderColl(); } },
      ...SAME_MINS.map(n => h("option", { value: n }, n === 1 ? "不限" : n + " 字以上")));
    minSel.value = sameMin();
    const sortSel = h("select", { style: "height:24px;font-size:12px", onchange: e => { S.sameSort = e.target.value; renderColl(); } },
      h("option", { value: "pos" }, "按底本順序"), h("option", { value: "len" }, "按字數"));
    sortSel.value = S.sameSort;
    subs.append(h("label", { class: "chk", style: "margin-left:10px" }, "同文段落 ", minSel), sortSel);
    if (S.sameFilter) subs.append(h("button", { class: "chip", style: "border:0;margin-left:10px;cursor:pointer", title: "取消篩選",
      onclick: () => { S.sameFilter = null; renderColl(); } }, "只看：" + patLabel(S.sameFilter, S.coll.all) + "　✕"));
    subs.append(h("span", { class: "muted", style: "margin-left:12px;font-size:11.5px" },
      "同＝歸一後逐字相同（字形差異不算不同）；點左側一種組合只看該組合；雙擊或回車：看各本原文"));
  }
  if (S.sub === "vt") {
    const f = h("select", { style: "height:24px;font-size:12px;margin-left:10px", onchange: e => { S.vtFilter = e.target.value; renderColl(); } },
      h("option", { value: "all" }, "全部"), h("option", { value: "todo" }, "未判斷"), h("option", { value: "done" }, "已判斷"),
      h("option", { value: "star" }, "指示性 ★"), h("option", { value: "tag" }, "有程序提示"));
    f.value = S.vtFilter;
    subs.append(f, h("span", { class: "muted", style: "margin-left:12px;font-size:11.5px" },
      "點某本的讀法＝定為正讀（再點取消）；★＝指示性錯誤（可用於譜系）"));
  }
  if (S.sub === "st") {
    const c = h("input", { type: "checkbox", onchange: e => { S.onlyStar = e.target.checked; renderColl(); } });
    c.checked = S.onlyStar;
    subs.append(h("label", { class: "chk", style: "margin-left:14px" }, c, "判讀統計只計 ★ 指示性錯誤"));
  }
  v.append(subs);
  const pane = h("div", { class: "coll-pane" });
  v.append(pane);
  if (S.sub === "same") renderSame(pane);
  else if (S.sub === "app") renderApp(pane);
  else if (S.sub === "vt") renderVT(pane);
  else renderStats(pane);
}

// ---- 同文表 ----
// 史源考察關心「哪幾本共有哪些文字」：以底本為座標，把各本（歸一後）逐字相同的文字按相同的本子組合分段。
// 左：同文分佈（各種組合共有多少字）；右：同文段落。另列「異於底本、而兩本以上相同」的讀法（如兩本共有的增文）。
const SAME_MINS = [1, 2, 4, 8, 16, 32, 64];
const sameMin = () => S.ui.sameMin || 8;
const ST_NAME = { "=": "同", x: "異", "-": "缺" };
function patLabel(pat, all) {
  const by = { "=": [], x: [], "-": [] };
  all.forEach((w, i) => by[pat[i]].push(T(w).siglum));
  return by["="].join("") + " 同" + (by.x.length ? "，" + by.x.join("") + " 異" : "") + (by["-"].length ? "，" + by["-"].join("") + " 缺" : "");
}
function patChips(pat, all) {
  return h("span", { class: "pat" }, ...all.map((w, i) => h("span", { class: "ps ps-" + ({ "=": "eq", x: "x", "-": "na" })[pat[i]],
    title: sigName(T(w)) + "：" + ST_NAME[pat[i]] }, T(w).siglum)));
}
function sameDist(C) {
  const m = new Map();
  let total = 0, solo = 0;
  for (const g of C.same) {
    if (!g.alt) total += g.n;
    if (g.neq < 2) { if (!g.alt) solo += g.n; continue; }
    let d = m.get(g.pat);
    if (!d) m.set(g.pat, d = { pat: g.pat, alt: g.alt, n: 0, segs: 0 });
    d.n += g.n; d.segs++;
  }
  return { rows: [...m.values()].sort((a, b) => b.n - a.n), total, solo };
}
function sameList(C) {
  const min = sameMin();
  const list = C.same.filter(g => g.neq >= 2 && g.n >= min && (!S.sameFilter || g.pat === S.sameFilter));
  if (S.sameSort === "len") list.sort((a, b) => b.n - a.n || a.s - b.s);
  return list;
}
// 段落的文字：底本段落取底本原文，異於底本的取其讀法；過長的只顯示頭尾
function sameText(C, g, max) {
  let t = g.alt ? g.text : sameCut(C)(g.rr[C.base][0] - C.raw0, g.rr[C.base][1] - C.raw0);
  t = t.replace(/\x01/g, "").replace(/[\f\n]+/g, " ").trim();
  if (!max) return t;
  const cps = Array.from(t);
  return cps.length <= max ? esc(t) : esc(cps.slice(0, max - 30).join("")) + `<span class="more">……（共 ${g.n.toLocaleString()} 字）……</span>` + esc(cps.slice(-24).join(""));
}
function sameCut(C) { return C._cut || (C._cut = cpSlicer(C.text)); }
const SAME_CTX = 40;
// 段落在底本中的前後文（平鋪成一行，略去頁眉）
function sameContext(C, g) {
  const cut = sameCut(C), n = C._cpn || (C._cpn = Array.from(C.text).length);
  const a = Math.max(0, g.rr[C.base][0] - C.raw0), b = Math.max(a, g.rr[C.base][1] - C.raw0);
  const flat = t => t.replace(/\x01/g, "").replace(/[\f\n]+/g, " ");
  return { before: (a > SAME_CTX ? "…" : "") + flat(cut(Math.max(0, a - SAME_CTX), a)).trimStart(),
    after: flat(cut(b, b + SAME_CTX)).trimEnd() + (b + SAME_CTX < n ? "…" : ""), base: flat(cut(a, b)) };
}
function sameCtxHTML(C, g) {
  const x = sameContext(C, g);
  const mid = g.alt
    ? (x.base.trim() ? `<del class="same-base" title="底本讀法">${esc(x.base)}</del>` : "") + `<mark class="same-hit alt">${esc(g.text)}</mark>`
    : `<mark class="same-hit">${sameText(C, g, 320)}</mark>`;
  return `<span class="same-ctx">${esc(x.before)}</span>${mid}<span class="same-ctx">${esc(x.after)}</span>`;
}
function openSameContext(g) {
  const C = S.coll;
  const order = C.all.filter(w => g.st[w] === "=").concat(C.all.filter(w => g.st[w] === "x"));
  const items = order.filter(w => g.rr[w]).map(w => ({ id: baseId(w), r0: g.rr[w][0], r1: g.rr[w][1],
    label: T(w).siglum + "　" + T(w).name + (g.st[w] === "x" ? "（此處不同）" : "") }));
  openContext(items, { title: `同文 ${g.no}：各本原文（${patLabel(g.pat, C.all)}）` });
}
function renderSame(pane) {
  const C = S.coll, bt = T(C.base);
  const D = sameDist(C);
  // 同文分佈
  const dist = h("div", { class: "same-dist" });
  dist.append(h("div", { class: "same-dh" }, h("b", {}, "同文分佈"),
    h("span", { class: "muted" }, `底本對校範圍 ${D.total.toLocaleString()} 字`)));
  const tb = h("tbody");
  for (const d of D.rows) {
    const tr = h("tr", { class: (S.sameFilter === d.pat ? "on" : "") + (d.alt ? " alt" : ""), "data-p": d.pat,
      title: patLabel(d.pat, C.all) + (d.alt ? "（底本讀法不同，這幾本彼此相同）" : "") + "\n點擊：只看這種組合（再點取消）",
      onclick: () => { S.sameFilter = S.sameFilter === d.pat ? null : d.pat; renderColl(); } },
      h("td", {}, patChips(d.pat, C.all), d.alt ? h("span", { class: "chip warn", style: "margin-left:6px" }, "異於底本") : null),
      h("td", { class: "num" }, d.n.toLocaleString()),
      h("td", { class: "num muted" }, d.segs + " 段"),
      h("td", { class: "bar" }, d.alt ? null : h("div", { class: "bw" },
        h("span", { class: "bt" }, h("i", { style: `width:${Math.max(1, Math.round(100 * d.n / (D.total || 1)))}%` })),
        h("span", {}, pct(d.n / (D.total || 1))))));
    tb.append(tr);
  }
  dist.append(h("table", { class: "same-dt" }, tb));
  dist.append(h("div", { class: "same-note muted" },
    `底本獨有（他本皆異或缺）${D.solo.toLocaleString()} 字。`, h("br"),
    "「同」：該本此處與表中其他「同」本逐字相同；「異」：有此處而文字不同或無此文字；「缺」：不在該本對應的範圍內。",
    h("br"), "「異於底本」：底本此處讀法不同，而標「同」的幾本彼此相同（如共有的增文、共同的誤字）——往往是判斷史源最直接的線索。"));
  // 同文段落
  const list = sameList(C);
  const wrap = h("div", { class: "vt-wrap same-wrap" });
  const head = "<tr><th>編號</th><th>位置</th><th>字數</th>" + C.all.map(w => `<th><span class="s">${esc(T(w).siglum)}</span></th>`).join("") + "<th>同文</th></tr>";
  const tbl = h("table", { class: "vt same-t", html: "<thead>" + head + "</thead><tbody></tbody>" });
  wrap.append(tbl);
  const body = $("tbody", tbl);
  const rowHTML = g => `<tr data-i="${C.same.indexOf(g)}"${g.no === S.sameHot ? ' class="hot"' : ""}>` +
    `<td class="no">${g.no}</td><td class="where">${esc(locStr(g.loc, bt))}</td><td class="num">${g.n.toLocaleString()}</td>` +
    C.all.map(w => `<td class="st st-${({ "=": "eq", x: "x", "-": "na" })[g.st[w] || "-"]}">${ST_NAME[g.st[w] || "-"]}</td>`).join("") +
    `<td class="same-txt">${g.alt ? '<span class="chip warn">異於底本</span> ' : ""}${sameCtxHTML(C, g)}</td></tr>`;
  let done = 0;
  const more = () => {
    let html = "";
    const end = Math.min(list.length, done + 300);
    for (; done < end; done++) html += rowHTML(list[done]);
    body.insertAdjacentHTML("beforeend", html);
  };
  more();
  if (!list.length) wrap.append(h("div", { class: "placeholder" }, S.sameFilter ? "這種組合沒有達到字數下限的段落" : "沒有符合條件的同文段落"));
  wrap.addEventListener("scroll", () => { if (done < list.length && wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 600) more(); });
  const segOf = tr => C.same[+tr.dataset.i];
  const setHot = tr => { S.sameHot = segOf(tr).no; $$("tr.hot", body).forEach(r => r.classList.toggle("hot", false)); tr.classList.add("hot"); };
  body.addEventListener("click", e => { const tr = e.target.closest("tr[data-i]"); if (tr) setHot(tr); });
  body.addEventListener("dblclick", e => {
    const tr = e.target.closest("tr[data-i]"); if (!tr) return;
    window.getSelection().removeAllRanges();
    openSameContext(segOf(tr));
  });
  listKeys(wrap, { items: () => $$("tr[data-i]", body), cur: () => $("tr.hot", body),
    go: tr => { setHot(tr); tr.scrollIntoView({ block: "nearest" }); },
    enter: tr => openSameContext(segOf(tr)),
    more: () => { if (done >= list.length) return false; more(); return true; } });
  const only = pat => [
    { label: S.sameFilter === pat ? "取消篩選（看全部組合）" : "只看這種組合：" + patLabel(pat, C.all), act: () => { S.sameFilter = S.sameFilter === pat ? null : pat; renderColl(); } },
  ];
  onCtx(body, e => {
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return null;
    setHot(tr);
    const g = segOf(tr), ctx = sameContext(C, g);
    return [
      { label: "看各本原文", act: () => openSameContext(g) },
      ...only(g.pat),
      "-",
      { label: "複製同文", act: () => copyAndTell(sameText(C, g)) },
      { label: "複製同文（含上下文、出處）", act: () => copyAndTell(`${T(C.base).siglum} ${locStr(g.loc, bt)}（${patLabel(g.pat, C.all)}）：${ctx.before}【${sameText(C, g)}】${ctx.after}`) },
    ];
  });
  onCtx(tb, e => {
    const tr = e.target.closest("tr[data-p]");
    if (!tr) return null;
    return [...only(tr.dataset.p), { label: "匯出這種組合的同文（Excel）", act: () => { S.sameFilter = tr.dataset.p; renderColl(); exportSameXlsx(); } }];
  });
  pane.append(h("div", { class: "same-pane" }, dist, wrap));
}

const visLoci = () => S.coll.loci.filter(L => L.kind === "sub" || S.showGra);
const markOf = L => S.marks[L.key];

// ---- 校記文字 ----
function shortRd(s) {
  const a = Array.from(s);
  return a.length > 14 ? a.slice(0, 5).join("") + "……" + a.slice(-5).join("") + "（" + a.length + "字）" : s;
}
function groupReadings(L, byGlyph) {
  const C = S.coll, base = L.rd[C.base];
  const groups = [];
  for (const w of C.wits) {
    const r = L.rd[w];
    if (!r) continue;
    const key = byGlyph ? r.g : r.n;
    if (key === (byGlyph ? base.g : base.n)) continue;
    let g = groups.find(x => x.key === key);
    if (!g) groups.push(g = { key, g: r.g, n: r.n, w: [] });
    g.w.push(w);
  }
  return groups;
}
function entryText(L) {
  const C = S.coll, base = L.rd[C.base];
  const gra = L.kind === "gra";
  const groups = groupReadings(L, gra || S.showGra);
  const sigs = ws => ws.map(w => sigName(T(w))).join("、");
  const parts = [];
  let lemma;
  if (!base.n) {
    const pre = Array.from(L.pre).slice(-2).join("");
    lemma = pre ? `「${pre}」下，` : `「${Array.from(L.post).slice(0, 2).join("")}」上，`;
    for (const g of groups) parts.push(`${sigs(g.w)}有「${shortRd(g.g)}」`);
  } else {
    lemma = `「${shortRd(base.g)}」，`;
    for (const g of groups) {
      let s;
      if (!g.n) s = `${sigs(g.w)}無`;
      else s = `${sigs(g.w)}作「${shortRd(g.g)}」`;
      if (g.n === base.n && g.g !== base.g) s += "（字形）";
      parts.push(s);
    }
  }
  const lac = C.wits.filter(w => !L.rd[w]);
  if (lac.length && parts.length) parts.push(sigs(lac) + "此處缺");
  return lemma + parts.join("，") + "。";
}
const TAGN = { "倒": "疑倒", "重": "疑重文", "跳": "疑跳脫", "諱": "疑諱", "闕": "闕字", "移": "移位" };
const TAGT = {
  "倒": "兩本用字相同而次序不同",
  "重": "多出的文字與緊鄰的文字相同（重文、衍文的常見形態）",
  "跳": "缺少的一段前後有相同的字（抄手目光從一處跳到另一處相同的字，致中間脫漏）",
  "諱": "差異的字在避諱字對照表中",
  "闕": "讀法中有 □ 等闕字符號",
  "移": "同一段文字在一處缺少、在另一處多出（移位）",
};
function tagChips(L) {
  return L.tags.map(([t, ws]) => `<span class="chip tg" title="${esc(TAGT[t] || "")}（${esc(ws.map(w => T(w) ? T(w).siglum : "?").join(""))}）">${TAGN[t] || t}</span>`).join("");
}

// ---- 校記視圖 ----
function renderApp(pane) {
  const C = S.coll, bt = T(C.base);
  const loci = visLoci();
  const left = h("div", { class: "basetext" });
  const right = h("div", { class: "app-list" });
  pane.append(left, right);
  // 底本正文
  const cut = cpSlicer(C.text);
  const pg = { p: C.page0 };
  let html = "", pos = 0;
  const seg = (a, b) => rawHTMLFast(cut(a, b), C.paged, pg);
  for (const L of loci) {
    const rs = L.rs - C.raw0, re = L.re - C.raw0;
    if (rs < pos) continue;
    html += seg(pos, rs);
    const cls = L.kind === "gra" ? " gra" : "";
    if (re > rs) html += `<span class="lem${cls}" data-k="${esc(L.key)}">${seg(rs, re)}</span>`;
    html += `<sup class="mk${cls}" data-k="${esc(L.key)}">${L.no}</sup>`;
    pos = Math.max(rs, re);
  }
  html += seg(pos, Infinity);
  left.innerHTML = html;
  // 校記
  let h2 = "";
  for (const L of loci) {
    const m = markOf(L);
    h2 += `<div class="app-e${m && m.ok != null ? " judged" : ""}" data-k="${esc(L.key)}"><span class="no${L.kind === "gra" ? " gra" : ""}">${L.kind === "sub" ? "〔" + cnum(L.no) + "〕" : L.no}</span>` +
      esc(entryText(L)) + `<span class="where">${esc(locStr(L.loc, bt))}</span>${tagChips(L)}` +
      `<button class="to-vt" data-k="${esc(L.key)}" title="在異文表中查看、判斷">表</button></div>`;
  }
  right.innerHTML = h2 || "<div class='placeholder'>沒有異文</div>";
  const hot = (k, scrollText, scrollList, key) => {
    $$(".hot", pane).forEach(e => e.classList.remove("hot"));
    $$(`[data-k="${CSS.escape(k)}"]`, pane).forEach(e => e.classList.add("hot"));
    // 用方向鍵時不用平滑捲動（連按會一直追不上）；校記只捲到剛好可見
    const how = key ? "auto" : "smooth";
    if (scrollText) { const e = $(`.mk[data-k="${CSS.escape(k)}"]`, left); if (e) e.scrollIntoView({ block: "center", behavior: how }); }
    if (scrollList) { const e = $(`.app-e[data-k="${CSS.escape(k)}"]`, right); if (e) e.scrollIntoView({ block: key ? "nearest" : "center", behavior: how }); }
  };
  const byKey = k => C.loci.find(L => L.key === k);
  const enter = el => openLocusContext(byKey(el.dataset.k));
  listKeys(right, { items: () => $$(".app-e", right), cur: () => $(".app-e.hot", right),
    go: el => hot(el.dataset.k, true, true, true), enter });
  const appMenu = e => {
    const el = e.target.closest("[data-k]");
    if (!el) return null;
    const L = byKey(el.dataset.k);
    if (!L) return null;
    hot(L.key, false, false);
    return [
      { label: "看各本原文", act: () => openLocusContext(L) },
      { label: "在異文表中查看、判斷", act: () => { S.sub = "vt"; S.vtFilter = "all"; renderColl(); setTimeout(() => focusRow(L.key), 30); } },
      "-",
      { label: "複製此條校記", act: () => copyAndTell(`${L.kind === "sub" ? "〔" + cnum(L.no) + "〕" : L.no}${entryText(L)}`) },
    ];
  };
  onCtx(left, appMenu);
  onCtx(right, appMenu);
  listKeys(left, { items: () => $$(".mk", left), cur: () => $(".mk.hot", left),
    go: el => hot(el.dataset.k, true, true, true), enter });
  left.addEventListener("click", e => { const m = e.target.closest("[data-k]"); if (m) hot(m.dataset.k, false, true); });
  right.addEventListener("click", e => {
    const tv = e.target.closest(".to-vt");
    if (tv) { S.sub = "vt"; S.vtFilter = "all"; renderColl(); setTimeout(() => focusRow(tv.dataset.k), 30); return; }
    const m = e.target.closest(".app-e"); if (m) hot(m.dataset.k, true, false);
  });
  const dbl = e => {
    const m = e.target.closest("[data-k]");
    if (m) { window.getSelection().removeAllRanges(); openLocusContext(byKey(m.dataset.k)); }
  };
  left.addEventListener("dblclick", dbl);
  right.addEventListener("dblclick", dbl);
}
function openLocusContext(L) {
  if (!L) return;
  const C = S.coll;
  const items = C.all.filter(w => L.rd[w]).map(w => ({ id: baseId(w), r0: L.rd[w].rs, r1: L.rd[w].re, label: T(w).siglum + "　" + T(w).name }));
  openContext(items, { title: `異文 ${L.no}：各本原文` });
}
function focusRow(k) {
  const tr = $(`tr[data-k="${CSS.escape(k)}"]`);
  if (tr) {
    S.vtHot = k;
    $$("tr.hot", tr.parentNode).forEach(r => r.classList.toggle("hot", false));
    tr.classList.add("hot"); tr.scrollIntoView({ block: "center" });
    const wrap = tr.closest(".vt-wrap");
    if (wrap) wrap.focus({ preventScroll: true });
  }
}

// ---- 異文表 ----
function rowVisible(L) {
  const m = markOf(L), f = S.vtFilter;
  if (f === "todo") return !(m && m.ok != null);
  if (f === "done") return !!(m && m.ok != null);
  if (f === "star") return !!(m && m.star);
  if (f === "tag") return L.tags.length > 0;
  return true;
}
function renderVT(pane) {
  const C = S.coll, bt = T(C.base);
  const wrap = h("div", { class: "vt-wrap" });
  pane.append(wrap);
  const loci = visLoci().filter(rowVisible);
  const head = "<tr><th>編號</th><th>位置</th><th>上下文（底本）</th>" +
    C.all.map(w => `<th><span class="s">${esc(T(w).siglum)}</span>${w === C.base ? " 底本" : ""}</th>`).join("") +
    "<th>提示</th><th title='指示性錯誤：不易獨立產生、可據以判定親緣'>★</th><th>備註</th></tr>";
  const tbl = h("table", { class: "vt", html: "<thead>" + head + "</thead><tbody></tbody>" });
  wrap.append(tbl);
  const tb = $("tbody", tbl);
  let done = 0;
  const rowHTML = L => {
    const m = markOf(L) || {};
    const base = L.rd[C.base];
    const ctx = esc(Array.from(L.pre).slice(-4).join("")) + "<em>" + esc(base.g || "‸") + "</em>" + esc(Array.from(L.post).slice(0, 4).join(""));
    let cells = "";
    for (const w of C.all) {
      const r = L.rd[w];
      let cls = "rd", txt;
      if (!r) { txt = "<span class='empty'>（缺）</span>"; cls += " na"; }
      else {
        txt = r.g ? esc(r.g) : "<span class='empty'>（無）</span>";
        if (m.ok != null) cls += r.n === m.ok ? " ok" : " wrong";
        else if (w !== C.base && r.n === base.n && r.g === base.g) cls += " same";
      }
      cells += `<td class="${cls}" data-w="${w}">${txt}</td>`;
    }
    return `<tr data-k="${esc(L.key)}"${L.key === S.vtHot ? ' class="hot"' : ""} title="雙擊編號、位置或上下文：看各本原文"><td class="no">${L.kind === "sub" ? L.no : esc(L.no)}</td><td class="where">${esc(locStr(L.loc, bt))}</td>` +
      `<td class="ctx">${ctx}</td>${cells}<td>${tagChips(L)}</td>` +
      `<td><button class="star${m.star ? " on" : ""}" title="指示性錯誤">${m.star ? "★" : "☆"}</button></td>` +
      `<td class="note-c"><input class="note" type="text" value="${esc(m.note || "")}" placeholder="性質、理由…">` +
      ((m.llm || m.ai) ? `<div class="ai-note">LLM：${esc(m.llm || m.ai)}</div>` : "") + "</td></tr>";
  };
  const more = () => {
    let html = "";
    const end = Math.min(loci.length, done + 300);
    for (; done < end; done++) html += rowHTML(loci[done]);
    tb.insertAdjacentHTML("beforeend", html);
  };
  more();
  if (!loci.length) wrap.append(h("div", { class: "placeholder" }, "沒有符合條件的異文"));
  wrap.addEventListener("scroll", () => { if (done < loci.length && wrap.scrollTop + wrap.clientHeight > wrap.scrollHeight - 600) more(); });
  const byKey = k => C.loci.find(L => L.key === k);
  const rerow = (tr, L) => { tr.outerHTML = rowHTML(L); };
  const setHot = tr => {
    S.vtHot = tr.dataset.k;
    $$("tr.hot", tb).forEach(r => r.classList.toggle("hot", false));
    tr.classList.add("hot");
  };
  listKeys(wrap, { items: () => $$("tr[data-k]", tb), cur: () => $("tr.hot", tb),
    go: tr => { setHot(tr); tr.scrollIntoView({ block: "nearest" }); },
    enter: tr => openLocusContext(byKey(tr.dataset.k)),
    more: () => { if (done >= loci.length) return false; more(); return true; } });
  tb.addEventListener("click", e => {
    const tr = e.target.closest("tr"); if (!tr) return;
    setHot(tr);
    const L = byKey(tr.dataset.k);
    const m = Object.assign({}, markOf(L) || {});
    const td = e.target.closest("td.rd");
    if (e.target.closest(".star")) {
      m.star = !m.star;
      setMark(L, m); rerow(tr, L);
    } else if (td && L.rd[td.dataset.w]) {
      const n = L.rd[td.dataset.w].n;
      m.ok = m.ok === n ? null : n;
      m.src = "user";
      setMark(L, m); rerow(tr, L);
    }
  });
  tb.addEventListener("dblclick", e => {
    if (!e.target.closest("td.ctx, td.no, td.where")) return;
    window.getSelection().removeAllRanges();
    openLocusContext(byKey(e.target.closest("tr").dataset.k));
  });
  onCtx(tb, e => {
    const tr = e.target.closest("tr[data-k]");
    if (!tr || e.target.closest("input.note")) return null;
    setHot(tr);
    const L = byKey(tr.dataset.k), m = markOf(L) || {};
    const td = e.target.closest("td.rd"), r = td && L.rd[td.dataset.w];
    const okTd = $("td.rd.ok", tr);
    return [
      r && { label: (m.ok === r.n ? "取消正讀：" : "定為正讀：") + `「${r.g || "（無）"}」（${T(td.dataset.w).siglum}）`, act: () => td.click() },
      !r && okTd && { label: "取消已定的正讀", act: () => okTd.click() },
      { label: m.star ? "取消指示性錯誤 ★" : "標為指示性錯誤 ★", act: () => { const b = $(".star", tr); if (b) b.click(); } },
      { label: "寫備註", act: () => { const n = $("input.note", tr); if (n) n.focus(); } },
      "-",
      { label: "看各本原文", act: () => openLocusContext(L) },
      { label: "在校記中查看", act: () => { S.sub = "app"; renderColl(); setTimeout(() => { const el = $(`.app-e[data-k="${CSS.escape(L.key)}"]`); if (el) { el.click(); el.scrollIntoView({ block: "center" }); } }, 30); } },
      "-",
      { label: "複製此行", act: () => copyAndTell(`${L.no}　${locStr(L.loc, bt)}　` + C.all.map(w => T(w).siglum + "：" + (L.rd[w] ? (L.rd[w].g || "（無）") : "（缺）")).join("　")) },
    ];
  });
  tb.addEventListener("change", e => {
    if (!e.target.classList.contains("note")) return;
    const L = byKey(e.target.closest("tr").dataset.k);
    const m = Object.assign({}, markOf(L) || {});
    m.note = e.target.value;
    setMark(L, m);
  });
}
// 判讀標記按「底本中的絕對位置＋底本讀法」記錄。加減校本後異文單位可能合併或拆分：
// 找到唯一重疊的新單位就搬過去（正讀按底本讀法的位置換算），找不到的保留並報告，不刪除。
function parseKey(k) {
  const i = k.indexOf(":"), j = k.indexOf(":", i + 1);
  return { s: +k.slice(0, i), e: +k.slice(i + 1, j), bn: k.slice(j + 1) };
}
function reattachMarks(C, marks) {
  const sub = C.loci.filter(L => L.kind === "sub");
  const have = new Set(sub.map(L => L.key));
  const spans = sub.map(L => Object.assign(parseKey(L.key), { L }));
  const lo = C.lo || 0, hi = lo + C.n;
  const moved = [], lost = [], review = [];
  for (const [k, m] of Object.entries(marks)) {
    if (have.has(k)) continue;
    const o = parseKey(k);
    if (isNaN(o.s) || o.e < lo || o.s > hi) continue;        // 不在這次對校的範圍內：不動
    const cands = spans.filter(c => (c.s < o.e && o.s < c.e) || (o.s === o.e && c.s <= o.s && o.s <= c.e) ||
      (c.s === c.e && o.s <= c.s && c.s <= o.e));
    if (cands.length !== 1 || marks[cands[0].L.key]) { lost.push([k, m]); continue; }
    const c = cands[0], L = c.L, nm = Object.assign({}, m);
    if (m.ok != null && m.ok !== "\u0000") {
      const cb = Array.from(c.bn), ob = Array.from(o.bn), off = o.s - c.s;
      let ok = null;
      if (off >= 0 && cb.slice(off, off + ob.length).join("") === o.bn)
        ok = cb.slice(0, off).join("") + m.ok + cb.slice(off + ob.length).join("");
      if (ok !== null && C.all.some(w => L.rd[w] && L.rd[w].n === ok)) nm.ok = ok;
      else { nm.ok = null; nm.note = ((m.note || "") + `（原定正讀「${m.ok}」需覆核）`).trim(); review.push(L.no); }
    }
    moved.push([k, L.key, nm]);
  }
  return { moved, lost, review };
}
function applyReattach() {
  const rep = reattachMarks(S.coll, S.marks);
  for (const [oldK, newK, m] of rep.moved) {
    delete S.marks[oldK]; S.marks[newK] = m;
    markQueue[oldK] = null; markQueue[newK] = m;
  }
  if (rep.moved.length) flushMarks();
  S.coll.markReport = rep;
}
function lostMarksDialog() {
  const rep = S.coll.markReport;
  const list = h("div", { class: "help", style: "font-size:13px;line-height:1.9;max-height:50vh;overflow:auto" });
  for (const [k, m] of rep.lost) {
    const o = parseKey(k);
    list.append(h("div", {}, `底本「${o.bn || "‸"}」（位置 ${o.s}）：`, m.ok != null ? `正讀「${m.ok === "\u0000" ? "皆非" : m.ok}」 ` : "",
      m.star ? "★ " : "", m.note || "", (m.llm || m.ai) ? "　LLM：" + (m.llm || m.ai) : ""));
  }
  dialog("暫無對應異文的判讀標記", [h("div", { class: "help", style: "margin-bottom:8px" },
    "這些標記所在的位置，在這次對校中找不到唯一對應的異文（多因校本有增減，或異文被拆分）。它們仍保存著，換回原來的校本組合即可再現。"), list],
    [{ label: "刪除這些標記", act: async () => {
      if (!await confirmDialog("刪除 " + rep.lost.length + " 條標記？", "刪除後無法恢復。")) return false;
      for (const [k] of rep.lost) { delete S.marks[k]; markQueue[k] = null; }
      flushMarks(); rep.lost = []; renderColl();
    } }, "|", { label: "關閉", cls: "primary" }], true);
}
let markQueue = {}, markTimer = null;
function setMark(L, m) {
  const empty = m.ok == null && !m.star && !m.note && !m.ai && !m.llm;
  if (empty) delete S.marks[L.key]; else S.marks[L.key] = m;
  markQueue[L.key] = empty ? null : m;
  clearTimeout(markTimer);
  markTimer = setTimeout(flushMarks, 300);
}
function flushMarks() {
  const q = markQueue; markQueue = {};
  if (!Object.keys(q).length) return;
  api("marks", { base: baseId(S.coll.base), set: q }).catch(fail);
}

// ---- 統計（純函數，便於測試） ----
function collStats(C, marks, onlyStar) {
  const ids = C.all;
  const sub = C.loci.filter(L => L.kind === "sub");
  const per = {}, agree = {}, both = {};
  for (const x of ids) { per[x] = { present: 0, single: 0, gra: 0, err: 0, judged: 0 }; agree[x] = {}; both[x] = {}; for (const y of ids) { agree[x][y] = 0; both[x][y] = 0; } }
  const patterns = {};
  for (const L of C.loci) if (L.kind === "gra") for (const x of ids) { const r = L.rd[x], b = L.rd[C.base]; if (r && x !== C.base && r.g !== b.g) per[x].gra++; }
  for (const L of sub) {
    const present = ids.filter(x => L.rd[x]);
    const groups = {};
    for (const x of present) { per[x].present++; (groups[L.rd[x].n] = groups[L.rd[x].n] || []).push(x); }
    const gl = Object.values(groups);
    for (const x of present) for (const y of present) { both[x][y]++; if (L.rd[x].n === L.rd[y].n) agree[x][y]++; }
    if (gl.length < 2) continue;
    if (gl.length === 2 && Math.min(gl[0].length, gl[1].length) === 1 && present.length > 2) {
      const lone = gl[0].length === 1 ? gl[0][0] : gl[1][0];
      per[lone].single++;
    }
    const key = gl.map(g => g.slice().sort((a, b) => ids.indexOf(a) - ids.indexOf(b))).sort((a, b) => b.length - a.length || ids.indexOf(a[0]) - ids.indexOf(b[0]));
    const k = key.map(g => g.join(",")).join("|");
    (patterns[k] = patterns[k] || { groups: key, n: 0, loci: [] }).n++;
    patterns[k].loci.push(L.no);
  }
  // 判讀後
  const shared = {}, sep = {};
  for (const x of ids) { sep[x] = {}; for (const y of ids) sep[x][y] = 0; }
  let judged = 0;
  for (const L of sub) {
    const m = marks[L.key];
    if (!m || m.ok == null) continue;
    if (onlyStar && !m.star) continue;
    judged++;
    const present = ids.filter(x => L.rd[x]);
    const wrong = present.filter(x => L.rd[x].n !== m.ok);
    const right = present.filter(x => L.rd[x].n === m.ok);
    for (const x of present) per[x].judged++;
    const eg = {};
    for (const x of wrong) { per[x].err++; (eg[L.rd[x].n] = eg[L.rd[x].n] || []).push(x); }
    for (const g of Object.values(eg)) {
      if (g.length < 2) continue;
      const k = g.join(",");
      (shared[k] = shared[k] || { group: g, n: 0, loci: [] }).n++;
      shared[k].loci.push(L.no);
    }
    for (const x of wrong) for (const y of right) sep[x][y]++;
  }
  // 可能的轉抄本：x 有 y 的全部錯誤（y 錯而 x 不錯的情形為零），且 x 另有錯誤
  const desc = [];
  if (judged) for (const x of ids) for (const y of ids) {
    if (x === y || per[y].err === 0) continue;
    if (sep[y][x] === 0 && sep[x][y] > 0 && both[x][y] > 0) desc.push({ copy: x, src: y, extra: sep[x][y], common: per[y].err });
  }
  return { per, agree, both, patterns: Object.values(patterns).sort((a, b) => b.n - a.n), shared: Object.values(shared).sort((a, b) => b.n - a.n), sep, judged, desc, nsub: sub.length };
}

// 譜系草圖：只把已判斷的共同錯誤畫出來。至少 minN 處的組，按處數由多到少收入，
// 與已收的組交錯（既不相交又不包含）者略去並列出；「乙抄自甲」型的兩本組畫成甲之下的虛線。
function stemmaSketch(C, st, minN) {
  const all = C.all;
  const groups = st.shared.filter(g => g.n >= minN && g.group.length < all.length)
    .map(g => ({ ids: g.group, set: new Set(g.group), n: g.n }))
    .sort((a, b) => b.n - a.n || b.ids.length - a.ids.length);
  const compat = (a, b) => { let k = 0; for (const x of a.set) if (b.set.has(x)) k++; return k === 0 || k === a.set.size || k === b.set.size; };
  const sel = [], conflicts = [];
  for (const g of groups) { const bad = sel.find(q => !compat(q, g)); if (bad) conflicts.push([g, bad]); else sel.push(g); }
  const copyOf = {};
  for (const d of st.desc) {
    const gi = sel.findIndex(g => g.set.size === 2 && g.set.has(d.copy) && g.set.has(d.src));
    if (gi >= 0 && !copyOf[d.src]) { sel.splice(gi, 1); copyOf[d.copy] = d.src; }
  }
  sel.sort((a, b) => b.set.size - a.set.size || b.n - a.n);
  const GREEK = "αβγδεζηθικλμνξπρστυφχψ";
  const root = { label: "ω", kids: [], set: new Set(all) };
  const nodes = sel.map((g, i) => ({ label: GREEK[i] || "x" + i, kids: [], n: g.n, set: g.set }));
  const parentOf = set => {
    let best = root;
    for (const nd of nodes) if (nd.set !== set && nd.set.size > set.size && [...set].every(x => nd.set.has(x)) && nd.set.size < best.set.size) best = nd;
    return best;
  };
  for (const nd of nodes) parentOf(nd.set).kids.push(nd);
  const leaf = {};
  for (const w of all) leaf[w] = { label: T(w).siglum, kids: [], wit: w };
  for (const w of all) {
    if (copyOf[w]) { leaf[w].copy = true; leaf[copyOf[w]].kids.push(leaf[w]); }
    else parentOf(new Set([w])).kids.push(leaf[w]);
  }
  const lines = [];
  const walk = (nd, d) => {
    lines.push("  ".repeat(d) + nd.label + (nd.n ? `（共同錯誤 ${nd.n} 處）` : "") + (nd.copy ? "（疑抄自上一行之本）" : "") +
      (nd === root ? "（現存各本的共同祖本，佚）" : ""));
    nd.kids.forEach(k => walk(k, d + 1));
  };
  walk(root, 0);
  // 佈局：葉子按深度優先順序排開，內部節點居中
  let xi = 0, maxD = 0;
  const lay = (nd, d) => {
    nd.d = d; maxD = Math.max(maxD, d);
    if (!nd.kids.length) nd.x = xi++;
    else { nd.kids.forEach(k => lay(k, d + 1)); nd.x = nd.wit ? nd.kids[0].x : nd.kids.reduce((a, k) => a + k.x, 0) / nd.kids.length; }
  };
  lay(root, 0);
  const W = Math.max(1, xi) * 72 + 40, Hh = (maxD + 1) * 62 + 24;
  const px = nd => 20 + nd.x * 72 + 36, py = nd => 22 + nd.d * 62;
  let svg = `<svg class="stemma" viewBox="0 0 ${W} ${Hh}" width="${W}" height="${Hh}">`;
  const edges = nd => nd.kids.forEach(k => {
    svg += `<line x1="${px(nd)}" y1="${py(nd) + 9}" x2="${px(k)}" y2="${py(k) - 11}" class="${k.copy ? "dash" : ""}"/>`;
    edges(k);
  });
  edges(root);
  const draw = nd => {
    if (nd.wit) svg += `<text x="${px(nd)}" y="${py(nd) + 5}" class="wit">${esc(nd.label)}</text>`;
    else {
      svg += `<circle cx="${px(nd)}" cy="${py(nd)}" r="3.5"/><text x="${px(nd) + 8}" y="${py(nd) - 4}" class="hyp">${nd.label}</text>`;
      if (nd.n) svg += `<text x="${px(nd) + 8}" y="${py(nd) + 11}" class="cnt">${nd.n}</text>`;
    }
    nd.kids.forEach(draw);
  };
  draw(root);
  svg += "</svg>";
  return { svg, text: lines.join("\n"), conflicts };
}

function renderStats(pane) {
  const C = S.coll, box = h("div", { class: "stats" });
  pane.append(box);
  const st = collStats(C, S.marks, S.onlyStar);
  const sg = id => `<span class="s">${esc(T(id).siglum)}</span>`;
  const gs = g => g.map(id => T(id).siglum).join("");
  let html = "<h3>一、各本概況</h3><table class='st'><tr><th>本子</th><th>名稱</th><th>對應底本</th><th>相似度</th><th>參與比較的異文</th><th>獨異讀法</th><th>字形差異</th></tr>";
  for (const x of C.all) {
    const t = T(x), i = C.info[x];
    html += `<tr><td>${sg(x)}</td><td class="l">${esc(t.name)}</td><td>${x === C.base ? "（底本）" : pct(i.covBase, 0)}</td><td>${x === C.base ? "" : pct(i.sim)}</td>` +
      `<td>${st.per[x].present}</td><td>${st.per[x].single}</td><td>${x === C.base ? "" : st.per[x].gra}</td></tr>`;
  }
  html += "</table><p class='note'>獨異讀法：只有這一本這樣讀、其餘各本一致的地方（三本以上時才計）。數目多，說明這本自身的改動或訛誤多；它們只能說明這本「單獨」與眾不同，不能用來推定與他本的親緣。</p>";
  html += "<h3>二、讀法相合率</h3><table class='st'><tr><th></th>" + C.all.map(x => `<th>${sg(x)}</th>`).join("") + "</tr>";
  for (const x of C.all) {
    html += `<tr><th>${sg(x)}</th>`;
    for (const y of C.all) {
      if (x === y) { html += "<td class='muted'>—</td>"; continue; }
      const v = st.both[x][y] ? st.agree[x][y] / st.both[x][y] : 0;
      html += `<td style="background:rgba(181,64,43,${(Math.max(0, v - .3) * .5).toFixed(3)})" title="${st.agree[x][y]}/${st.both[x][y]}">${pct(v, 0)}</td>`;
    }
    html += "</tr>";
  }
  html += "</table><p class='note'>在全部實質異文處，兩本讀法相同的比例。相合率高只說明關係近，<b>共享正確的讀法不證明同源</b>（那是從祖本繼承來的）；要看下面的分組與共同錯誤。</p>";
  html += "<h3>三、讀法分組（未經判斷）</h3><p class='note'>每處異文把各本分成幾組（同組讀法相同）。下表按出現次數排列各種分法；「甲乙｜丙丁」表示甲乙一組、丙丁一組。" +
    "若某一分法反覆出現、且多為不易獨立產生的差異，就提示存在這樣的家族。但程序不知道哪一組是對的：同樣的分法既可能是甲乙共同的錯誤，也可能是丙丁共同的錯誤。請到「異文表」中判斷。</p>";
  const pats = st.patterns.filter(p => p.groups.length >= 2);
  const maxn = pats.length ? pats[0].n : 1;
  html += "<table class='st'><tr><th>分組</th><th>次數</th><th>異文編號（前 20 個）</th></tr>";
  for (const p of pats.slice(0, 40)) {
    const nontriv = p.groups.filter(g => g.length >= 2).length >= 2 || (p.groups.length > 2 && p.groups[0].length >= 2);
    html += `<tr><td class="l" style="font-family:var(--serif);font-size:14px${nontriv ? ";font-weight:650" : ""}">${p.groups.map(gs).join("｜")}</td>` +
      `<td class="bar-c"><span class="barv" style="width:${Math.round(100 * p.n / maxn)}px"></span>${p.n}</td><td class="l muted">${p.loci.slice(0, 20).join("、")}${p.loci.length > 20 ? "…" : ""}</td></tr>`;
  }
  html += "</table>";
  html += "<h3>四、判讀後的統計（拉赫曼方法）</h3>";
  if (!st.judged) {
    html += "<p class='note'>還沒有判斷過的異文" + (S.onlyStar ? "（或判過但未標 ★）" : "") + "。到「異文表」裡：點選某一本的讀法定為正讀，並給不易獨立產生的錯誤標 ★；或用「給 LLM → 判讀稿」請 LLM 先判一遍，再把回答導入（須逐條覆核）。程序會據此計算共同錯誤與分離錯誤。</p>";
  } else {
    html += `<p class='note'>共 ${st.judged} 處已判斷${S.onlyStar ? "且標為指示性錯誤" : ""}。與「正讀」不同的讀法即視為錯誤。</p>`;
    html += "<table class='st'><tr><th>本子</th>" + C.all.map(x => `<th>${sg(x)}</th>`).join("") + "</tr><tr><th>錯誤數</th>" +
      C.all.map(x => `<td>${st.per[x].err}</td>`).join("") + "</tr></table>";
    html += "<h3 style='font-size:13px'>共同錯誤（Bindefehler，聯結性錯誤）</h3>";
    if (!st.shared.length) html += "<p class='note'>沒有兩本以上共有的錯誤。</p>";
    else {
      html += "<table class='st'><tr><th>共有錯誤的本子</th><th>處數</th><th>異文編號</th></tr>";
      for (const s of st.shared) html += `<tr><td class="l" style="font-family:var(--serif);font-size:14px">${gs(s.group)}</td><td>${s.n}</td><td class="l muted">${s.loci.join("、")}</td></tr>`;
      html += "</table><p class='note'>若干本共有的、不易獨立產生的錯誤，表示它們出自同一個已有此誤的本子（共同的次祖本）。互相包含的組（如「乙丙丁」與「丙丁」）對應譜系中的層級。不相容的組（如同時有「乙丙」和「丙丁」）提示交叉傳承（contamination）或誤判。</p>";
      const minN = S.ui.stemmaMin || 2;
      const sk = stemmaSketch(C, st, minN);
      html += `<h3 style='font-size:13px'>譜系草圖 <select id="stemma-min" style="height:22px;font-size:11.5px;margin-left:6px">` +
        [1, 2, 3, 5].map(n => `<option value="${n}"${n === minN ? " selected" : ""}>至少 ${n} 處共同錯誤</option>`).join("") + "</select></h3>" +
        `<div class="stemma-box">${sk.svg}<pre class="stemma-txt">${esc(sk.text)}</pre></div>` +
        "<p class='note'>這只是把上面的共同錯誤畫成樹：互相包含或不相交的組成為次祖本（希臘字母，數字為共同錯誤處數），虛線表示「疑抄自上一本」。它不是結論——譜系要由你根據錯誤的性質斟酌，" +
        "也可以用「給 LLM → 譜系討論稿」交給 LLM 評估。</p>";
      if (sk.conflicts.length)
        html += `<div class="hint">與草圖不相容而未畫入的組：${sk.conflicts.map(([g, b]) => `<b>${esc(gs(g.ids))}</b>（${g.n} 處，與 ${esc(gs(b.ids))} 交錯）`).join("；")}。可能是交叉傳承，或其中有判斷錯誤，值得逐條複查。</div>`;
    }
    html += "<h3 style='font-size:13px'>分離錯誤（Trennfehler）</h3><table class='st'><tr><th>此本有錯 ↓ ／ 彼本不錯 →</th>" + C.all.map(x => `<th>${sg(x)}</th>`).join("") + "</tr>";
    for (const x of C.all) html += `<tr><th>${sg(x)}</th>` + C.all.map(y => x === y ? "<td class='muted'>—</td>" : `<td>${st.sep[x][y] || ""}</td>`).join("") + "</tr>";
    html += "</table><p class='note'>某格為 N：N 處行首之本有錯而列首之本不錯。若這些錯誤是後人不易憑意改正的，列首之本就不可能抄自行首之本。</p>";
    if (st.desc.length) {
      html += "<h3 style='font-size:13px'>可能的轉抄本（codex descriptus）</h3>";
      for (const d of st.desc)
        html += `<div class="hint"><b>${esc(sigName(T(d.copy)))}</b> 含有 <b>${esc(sigName(T(d.src)))}</b> 的全部 ${d.common} 處錯誤，另有 ${d.extra} 處己誤：${esc(sigName(T(d.copy)))} 可能直接或間接抄自 ${esc(sigName(T(d.src)))}。若成立，校勘時可剔除（eliminatio codicum descriptorum）。需排除：兩本同出一個已佚之本的可能、樣本太少的偶然。</div>`;
    }
  }
  box.innerHTML = html;
  const sm = $("#stemma-min", box);
  if (sm) sm.addEventListener("change", e => { saveUI({ stemmaMin: +e.target.value }); renderColl(); });
}

// ---- 匯出 ----
function witList() {
  const C = S.coll;
  return C.all.map(w => {
    const t = T(w), i = C.info[w];
    const range = w === C.base ? "" : `，對應底本 ${locStr(i.locA, T(C.base))}–${locStr(i.locA2, T(C.base))}`;
    return `${sigName(t)}${w === C.base ? "（底本）" : ""}：${t.name}${t.pages ? "，頁 " + t.pages : ""}${range}`;
  });
}
function collExportMenu(btn) {
  menu(btn, [
    { label: "同文表（Excel：同文分佈＋同文段落）", act: exportSameXlsx },
    { label: "同文表（CSV）", act: exportSameCSV },
    "-",
    { label: "校勘記（Word：底本正文＋校記）", act: exportApparatusDocx },
    { label: "校勘記（純文本）", act: exportApparatus },
    { label: "異文表（Excel）", act: exportVTXlsx },
    { label: "異文表（CSV）", act: exportCSV },
    "-",
    { label: "TEI P5 XML（平行分段，含判讀）", act: exportTEI },
    { label: "對齊表（CollateX JSON 格式）", act: exportCollateX },
    "-",
    { label: "全部數據（JSON）", act: () => saveText("對校數據.json", JSON.stringify({ coll: S.coll, marks: S.marks, texts: S.coll.all.map(T) }, null, 1), "application/json") },
  ]);
}
function exportApparatus() {
  const C = S.coll, bt = T(C.base);
  const out = ["校勘記", "", ...witList(), "", "歸一方式：" + $("#set-summary").textContent, ""];
  for (const L of visLoci()) {
    const m = markOf(L);
    const no = L.kind === "sub" ? "〔" + cnum(L.no) + "〕" : "［" + L.no + "］";
    out.push(`${no}（${locStr(L.loc, bt)}）${entryText(L)}${m && m.note ? "　按：" + m.note : ""}`);
  }
  saveText(`校勘記_${bt.siglum}.txt`, out.join("\n"));
}
function exportTEI() {
  const C = S.coll, bt = T(C.base);
  const x = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const wid = w => "w" + (C.all.indexOf(w) + 1);
  const wits = ws => ws.map(w => "#" + wid(w)).join(" ");
  const cut = cpSlicer(C.text);
  let pg = C.page0;
  const txt = t => x(t.replace(/\x01/g, "")).replace(/\f/g, () => `<pb n="${pg = (pg || 0) + 1}"/>`)
    .replace(/\n{2,}/g, "</p>\n<p>").replace(/\n/g, C.paged ? "" : "<lb/>");
  let body = "<p>", pos = 0;
  for (const L of visLoci()) {
    const rs = L.rs - C.raw0, re = L.re - C.raw0;
    if (rs < pos) continue;
    body += txt(cut(pos, rs));
    const key = L.kind === "gra" ? (r => r.g) : (r => r.n);
    const groups = {};
    for (const w of C.all) { const r = L.rd[w]; if (r) (groups[key(r)] = groups[key(r)] || { g: r.g, n: r.n, w: [] }).w.push(w); }
    const bk = key(L.rd[C.base]);
    const m = markOf(L) || {};
    const lem = cut(rs, re).replace(/[\f\n\x01]/g, "");
    let app = `<app n="${L.no}" type="${L.kind === "sub" ? "substantive" : "orthographic"}"><lem wit="${wits(groups[bk].w)}">${x(lem)}</lem>`;
    for (const [k, g] of Object.entries(groups)) if (k !== bk) app += g.g ? `<rdg wit="${wits(g.w)}">${x(g.g)}</rdg>` : `<rdg wit="${wits(g.w)}"/>`;
    const lac = C.all.filter(w => !L.rd[w]);
    if (lac.length) app += `<rdg wit="${wits(lac)}" type="lacuna"/>`;
    if (L.tags.length) app += `<note type="hint">${x(L.tags.map(([t]) => TAGN[t] || t).join("、"))}</note>`;
    const okw = m.ok == null ? "" : (m.ok === "\u0000" ? "皆非" : C.all.filter(w => L.rd[w] && L.rd[w].n === m.ok).map(w => T(w).siglum).join(""));
    const j = [okw ? "正讀：" + okw : "", m.star ? "指示性錯誤" : "", m.note || "", (m.llm || m.ai) ? "LLM：" + (m.llm || m.ai) : ""].filter(Boolean).join("；");
    if (j) app += `<note type="judgment">${x(j)}</note>`;
    body += app + "</app>";
    pos = Math.max(rs, re);
  }
  body += txt(cut(pos, Infinity)) + "</p>";
  const listWit = C.all.map(w => `        <witness xml:id="${wid(w)}" n="${x(T(w).siglum)}">${x(T(w).name)}${w === C.base ? "（底本）" : ""}</witness>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>${x(bt.name)} 校勘${C.seg ? "（檢索：" + x(C.seg.query) + "）" : ""}</title></titleStmt>
      <publicationStmt><p>由「對勘」生成；異文為程序比對所得，判讀見各處 note。</p></publicationStmt>
      <sourceDesc>
        <listWit>
${listWit}
        </listWit>
      </sourceDesc>
    </fileDesc>
    <encodingDesc>
      <variantEncoding method="parallel-segmentation" location="internal"/>
      <p>${x("歸一方式：" + $("#set-summary").textContent + "。lem 為底本原文（含標點），rdg 為各本字形（不含標點）。")}</p>
    </encodingDesc>
  </teiHeader>
  <text>
    <body>
${body}
    </body>
  </text>
</TEI>
`;
  saveText(`校勘_${bt.siglum}.tei.xml`, xml, "application/xml");
}
function exportCollateX() {
  const C = S.coll;
  const cut = cpSlicer(C.text);
  const cov = w => w === C.base ? [0, C.n] : (C.info[w] && C.info[w].cov ? C.info[w].cov.slice(0, 2) : [0, 0]);
  const table = [];
  let rpos = 0, npos = 0;
  const shared = (r1, n1) => {
    const t = cut(rpos, r1).replace(/[\s\f\x01]+/g, "");
    if (t) table.push(C.all.map(w => { const [a, b] = cov(w); return a <= npos && n1 <= b ? [{ t }] : []; }));
  };
  for (const L of visLoci()) {
    const rs = L.rs - C.raw0, re = L.re - C.raw0;
    if (rs < rpos) continue;
    shared(rs, L.s);
    table.push(C.all.map(w => L.rd[w] && L.rd[w].g ? [{ t: L.rd[w].g, n: L.rd[w].n }] : []));
    rpos = Math.max(rs, re); npos = L.e;
  }
  shared(Infinity, C.n);
  const out = { witnesses: C.all.map(w => T(w).siglum), table, generator: "對勘", note: "共同部分取底本原文；異文處為各本字形，n 為歸一後的讀法。" };
  saveText(`對齊表_${T(C.base).siglum}.json`, JSON.stringify(out, null, 1), "application/json");
}
function okSigla(L, m) {
  const C = S.coll;
  if (!m || m.ok == null) return "";
  return m.ok === "\u0000" ? "皆非" : C.all.filter(w => L.rd[w] && L.rd[w].n === m.ok).map(w => T(w).siglum).join("") || "皆非";
}
function sameRows(C) {
  const bt = T(C.base);
  return sameList(C).map(g => { const x = sameContext(C, g); return [g.no, locStr(g.loc, bt), g.n, g.alt ? "異於底本" : "",
    ...C.all.map(w => ST_NAME[g.st[w] || "-"]), x.before, sameText(C, g), x.after]; });
}
function sameHeader(C) { return ["編號", "位置（底本）", "字數", "類別", ...C.all.map(w => T(w).siglum), "上文（底本）", "同文", "下文（底本）"]; }
function sameScopeNote() {
  const C = S.coll;
  return (sameMin() > 1 ? sameMin() + " 字以上" : "不限字數") + (S.sameFilter ? "，只含「" + patLabel(S.sameFilter, C.all) + "」" : "");
}
function exportSameXlsx() {
  const C = S.coll, bt = T(C.base), D = sameDist(C);
  saveOffice("xlsx", `同文表_${fileSafe(bt.siglum)}.xlsx`, { sheets: [
    { name: "同文分佈", header: ["組合", ...C.all.map(w => T(w).siglum), "異於底本", "字數", "段數", "佔底本對校範圍"],
      widths: [26, ...C.all.map(() => 6), 9, 9, 7, 12],
      rows: D.rows.map(d => [patLabel(d.pat, C.all), ...C.all.map((w, i) => ST_NAME[d.pat[i]]), d.alt ? "是" : "", d.n, d.segs,
        d.alt ? "" : Math.round(1000 * d.n / (D.total || 1)) / 10 + "%"]).concat([["底本獨有（他本皆異或缺）", ...C.all.map(() => ""), "", D.solo, "", Math.round(1000 * D.solo / (D.total || 1)) / 10 + "%"]]) },
    { name: "同文段落", header: sameHeader(C), widths: [6, 12, 7, 8, ...C.all.map(() => 5), 24, 80, 24], rows: sameRows(C) },
    { name: "各本", header: ["簡稱", "名稱", "說明"], widths: [8, 40, 60], rows: C.all.map(w => [T(w).siglum, T(w).name, witList()[C.all.indexOf(w)]]) }] });
  toast("同文段落：" + sameScopeNote());
}
function exportSameCSV() {
  const C = S.coll;
  const lines = [sameHeader(C).map(csvCell).join(",")].concat(sameRows(C).map(r => r.map(csvCell).join(",")));
  saveText(`同文表_${fileSafe(T(C.base).siglum)}.csv`, "\ufeff" + lines.join("\n"), "text/csv");
}
function exportVTXlsx() {
  const C = S.coll, bt = T(C.base);
  const rows = visLoci().map(L => {
    const m = markOf(L) || {};
    return [typeof L.no === "number" ? L.no : String(L.no), L.kind === "sub" ? "實質" : "字形", locStr(L.loc, bt), L.pre,
      ...C.all.map(w => L.rd[w] ? (L.rd[w].g || "（無）") : "（缺）"), L.post, L.tags.map(([t]) => TAGN[t] || t).join(" "),
      okSigla(L, m), m.star ? "★" : "", m.note || "", m.llm || m.ai || ""];
  });
  saveOffice("xlsx", `異文表_${fileSafe(bt.siglum)}.xlsx`, { sheets: [
    { name: "異文表", header: ["編號", "類別", "位置", "上文", ...C.all.map(w => T(w).siglum), "下文", "提示", "正讀", "指示性", "備註", "LLM"],
      widths: [6, 6, 11, 10, ...C.all.map(() => 14), 10, 10, 6, 6, 24, 30], rows },
    { name: "各本", header: ["簡稱", "名稱", "說明"], widths: [8, 40, 60], rows: C.all.map(w => [T(w).siglum, T(w).name, witList()[C.all.indexOf(w)]]) }] });
}
// 校勘記 Word：底本正文（異文處加底線、上標編號）＋按編號排列的校記
function exportApparatusDocx() {
  const C = S.coll, bt = T(C.base), loci = visLoci();
  const blocks = [{ t: "h", level: 0, text: `${bt.name} 校勘記` + (C.seg ? `（檢索：${C.seg.query}）` : "") },
    { t: "p", size: 10.5, runs: [{ text: witList().join("；") + "。", hl: "muted" }] },
    { t: "p", size: 10.5, runs: [{ text: "歸一方式：" + $("#set-summary").textContent + "。", hl: "muted" }] },
    { t: "h", level: 1, text: "底本正文" }];
  const cut = cpSlicer(C.text);
  let para = [], pg = C.page0;
  const flush = () => { if (para.length) blocks.push({ t: "p", runs: para, indent: 2 }); para = []; };
  const addText = (t, hl) => {
    t = t.replace(/\x01/g, "");
    const parts = t.split(/(\f|\n\n+|\n)/);
    for (const x of parts) {
      if (!x) continue;
      if (x === "\f") { pg = (pg || 0) + 1; para.push({ text: `〔${pg}頁〕`, hl: "muted" }); continue; }
      if (/^\n\n+$/.test(x) || (x === "\n" && !C.paged)) { flush(); continue; }
      if (x === "\n") continue;
      para.push(hl ? { text: x, hl } : x);
    }
  };
  let pos = 0;
  for (const L of loci) {
    const rs = L.rs - C.raw0, re = L.re - C.raw0;
    if (rs < pos) continue;
    addText(cut(pos, rs));
    if (re > rs) addText(cut(rs, re), L.kind === "gra" ? "gra" : "lem");
    para.push({ text: String(L.no), hl: "sup" });
    pos = Math.max(rs, re);
  }
  addText(cut(pos, Infinity));
  flush();
  blocks.push({ t: "h", level: 1, text: "校勘記" });
  for (const L of loci) {
    const m = markOf(L);
    const no = L.kind === "sub" ? "〔" + cnum(L.no) + "〕" : "［" + L.no + "］";
    blocks.push({ t: "p", runs: [{ text: no, b: true }, entryText(L), { text: "（" + locStr(L.loc, bt) + "）", hl: "muted" },
      ...(m && m.note ? ["　按：" + m.note] : [])] });
  }
  saveOffice("docx", `校勘記_${fileSafe(bt.siglum)}.docx`, { blocks });
}
function exportCSV() {
  const C = S.coll, bt = T(C.base);
  const head = ["編號", "類別", "位置", "上文", ...C.all.map(w => T(w).siglum), "下文", "提示", "正讀", "指示性", "備註", "LLM"];
  const lines = [head.map(csvCell).join(",")];
  for (const L of visLoci()) {
    const m = markOf(L) || {};
    const okw = m.ok == null ? "" : C.all.filter(w => L.rd[w] && L.rd[w].n === m.ok).map(w => T(w).siglum).join("") || "皆非";
    lines.push([L.no, L.kind === "sub" ? "實質" : "字形", locStr(L.loc, bt), L.pre,
      ...C.all.map(w => L.rd[w] ? (L.rd[w].g || "（無）") : "（缺）"), L.post,
      L.tags.map(([t]) => TAGN[t] || t).join(" "), okw, m.star ? "★" : "", m.note || "", m.llm || m.ai || ""].map(csvCell).join(","));
  }
  saveText(`異文表_${bt.siglum}.csv`, "﻿" + lines.join("\n"), "text/csv");
}

// ---- 給 LLM 的文檔 ----
// 不連接任何服務：生成自足的 Markdown 文檔（角色、任務、數據、回答格式），複製或存檔後交給任何 LLM；
// 判讀稿的回答可以貼回「導入」。
const ROLE_JUDGE = "請以精通中國古典文獻學、版本學與校勘學的學者身份回答，熟悉拉赫曼（Lachmann）方法與陳垣「校法四例」。" +
  "判斷要說明依據（字形、音韻、文義、上下文、史實、避諱、版本常例）；證據不足時如實填「存疑」或「?」，不要臆斷。用繁體中文回答。";
const ROLE_STEMMA = "請以精通版本學與校勘學的學者身份回答，熟悉拉赫曼方法及貝迪耶、帕斯誇利等人的批評。" +
  "下面的統計只是程序的計數，結論要由你根據異文本身斟酌；說明每一判斷的證據與強弱。用繁體中文回答。";
const ROLE_SOURCE = "請以精通中國史料學（史源學）與文獻學的學者身份回答。論證要具體到所引字句；判斷方向時說明依據，證據不足時直說。用繁體中文回答。";

function shareDoc(title, text, filename) {
  const long = text.length > 30000;
  const pre = h("pre", { class: "share-pre" }, long ? text.slice(0, 30000) + "\n\n……（預覽從略；複製或存檔時是全文）" : text);
  return dialog(title, [h("div", { class: "help", style: "margin-bottom:8px" },
    `共 ${text.length.toLocaleString()} 字（Markdown 格式）。複製後貼進任何 LLM 的對話框，或存為文件後上傳。` +
    (text.length > 60000 ? "內容較長，部分 LLM 可能一次處理不完，可縮小範圍分幾次。" : "")), pre], [
    { label: "存為 .md…", act: () => { saveText(filename + ".md", text, "text/markdown"); return false; } },
    { label: "存為 .txt…", act: () => { saveText(filename + ".txt", text); return false; } },
    "|", { label: "關閉" },
    { label: "複製", cls: "primary", act: async () => { const ok = await copyText(text); toast(ok ? "已複製，可貼給 LLM" : "複製失敗，請存為文件", !ok); return false; } }], "xwide");
}
function llmMenu(btn) {
  menu(btn, [
    { label: "判讀稿：請 LLM 判讀異文…", act: async () => {
      const loci = await scopeDialog("判讀稿：選擇要交給 LLM 的異文", "生成");
      if (loci) shareDoc("判讀稿", llmPrompt(loci), `異文判讀稿_${T(S.coll.base).siglum}`);
    } },
    { label: "史源分析稿（據同文分佈與同文段落）", act: () => shareDoc("史源分析稿", sourcePrompt(), `史源分析稿_${T(S.coll.base).siglum}`) },
    { label: "譜系討論稿（據已判斷的錯誤）", act: () => {
      const d = stemmaPrompt();
      if (d) shareDoc("譜系討論稿", d, `譜系討論稿_${T(S.coll.base).siglum}`);
    } },
    "-",
    { label: "導入 LLM 的判讀回答…", act: llmImport },
  ]);
}
// 選擇範圍：全部、未判斷、異文表當前篩選、編號區間
function scopeDialog(title, okLabel) {
  const C = S.coll;
  const sub = C.loci.filter(L => L.kind === "sub");
  const todo = sub.filter(L => !(markOf(L) && markOf(L).ok != null));
  const filt = visLoci().filter(rowVisible).filter(L => L.kind === "sub");
  const from = h("input", { type: "text", value: "1", style: "width:64px" });
  const to = h("input", { type: "text", value: String(Math.min(sub.length, 150)), style: "width:64px" });
  let choice = sub.length > 200 ? "range" : "all";
  const opt = (v, lab, n, extra) => {
    const r = h("input", { type: "radio", name: "scope", value: v, onchange: () => { choice = v; } });
    r.checked = v === choice;
    return h("label", {}, r, h("span", {}, lab, extra || null, n != null ? h("small", {}, n + " 條") : null));
  };
  const body = [h("div", { class: "radio-list" },
    opt("all", "全部實質異文", sub.length), opt("todo", "尚未判斷的", todo.length),
    opt("filter", "異文表當前篩選（" + ({ all: "全部", todo: "未判斷", done: "已判斷", star: "★", tag: "有提示" }[S.vtFilter] || "全部") + "）", filt.length),
    opt("range", "編號 ", null, h("span", {}, from, " 至 ", to))),
    h("div", { class: "help" }, "LLM 一次判讀一兩百條較穩妥：異文多時可按編號分幾次，每次的回答都可以導入。")];
  return dialog(title, body, [{ label: "取消", value: null }, { label: okLabel, cls: "primary", act: () => {
    let loci = sub;
    if (choice === "todo") loci = todo;
    else if (choice === "filter") loci = filt;
    else if (choice === "range") { const a = +from.value || 1, b = +to.value || sub.length; loci = sub.filter(L => L.no >= a && L.no <= b); }
    if (!loci.length) { toast("所選範圍內沒有異文", true); return false; }
    return loci;
  } }]);
}
function llmPrompt(loci) {
  const C = S.coll, bt = T(C.base);
  const sig = C.all.map(w => T(w).siglum);
  const st = collStats(C, {}, false);
  const out = [];
  out.push("# 異文判讀稿", "", ROLE_JUDGE, "",
    "以下異文表由文本比對程序「對勘」自動生成。程序只做了確定性的工作：統一簡繁異體、忽略標點，把各本逐字對齊，列出各處讀法，並統計各本讀法的分合。它**沒有**判斷任何讀法的正誤。", "");
  if (C.seg) out.push("各「本」是用「檢索」找到的同一句（段）話在不同文獻中的記載片段（見各本說明中的位置），請把它們當作同一段文字的不同傳本或不同轉述來判讀。", "", "檢索句：「" + C.seg.query + "」", "");
  out.push("## 各本", "", ...witList().map(x => "- " + x), "",
    "## 比對方式", "", "- " + $("#set-summary").textContent + "；字形（繁簡、異體）不同而字相同者不列。",
    "- 「（無）」表示此本此處沒有文字；「（缺）」表示此本不包含這一部分，不算異文。",
    "- 「程序提示」只是字面規則的結果（疑倒＝同字異序；疑重文＝多出的字與鄰近文字相同；疑跳脫＝缺文前後有相同的字；疑諱＝差異字在避諱表中；移位＝同一段文字在一處缺、一處多），未必成立。", "",
    "## 請你做的事", "",
    "1. **性質**：逐條判斷異文的性質，如：形近而訛、音近而訛、脫文、衍文、倒文、涉上下文而誤、跳脫（同字跳行）、避諱改字、俗字異體、虛詞增減、有意改寫（刪節、潤色、立場改動）、其他。",
    "2. **擬定正讀**：哪一本（哪幾本）的讀法更可能是原貌。填本子的簡稱（如「" + sig.slice(0, 2).join("") + "」）；都不可取填「皆非」並在理由中寫出擬改之字；無法判斷填「?」。",
    "3. **指示性錯誤**：按拉赫曼方法，只有不易由不同抄手各自獨立產生、也不易被後人憑常識改正的錯誤（Leitfehler），才能用來證明本子之間的親緣（共同錯誤 Bindefehler）或獨立（分離錯誤 Trennfehler）。常見的虛詞增減、簡單形近字、避諱改字、異體字通常不算。填「是／否／存疑」。",
    "4. **譜系討論**：根據判為「是」的錯誤，討論各本的親緣，給出可能的版本譜系（stemma，用縮進的文字樹即可），並指出：可能的轉抄本（可剔除者）、交叉傳承（contamination）的跡象、證據不足之處。注意共享的正確讀法不能證明親緣。", "",
    "## 回答格式", "", "請先輸出一個 Markdown 表格，每條異文一行，保留原編號，不合併、不省略；五欄依次為：", "",
    "| 編號 | 性質 | 擬定正讀 | 指示性錯誤 | 理由 |", "|---|---|---|---|---|", "| 1 | 形近而訛 | " + sig[0] + " | 否 | …… |", "",
    "表格之後再寫譜系討論。（這張表會被程序讀回，請保持格式。）", "",
    "## 異文表（本稿 " + loci.length + " 條）", "",
    "| 編號 | 位置 | 底本上下文 | " + sig.join(" | ") + " | 程序提示 |",
    "|" + "---|".repeat(4 + sig.length));
  const cell = x => String(x).replace(/\|/g, "｜");
  for (const L of loci) {
    const b = L.rd[C.base];
    const ctx = Array.from(L.pre).slice(-6).join("") + "【" + (b.g || "‸") + "】" + Array.from(L.post).slice(0, 6).join("");
    out.push(`| ${L.no} | ${locStr(L.loc, bt)} | ${cell(ctx)} | ` +
      C.all.map(w => L.rd[w] ? cell(L.rd[w].g || "（無）") : "（缺）").join(" | ") + ` | ${L.tags.map(([t]) => TAGN[t] || t).join("、")} |`);
  }
  out.push("", "## 程序統計（僅供參考）", "", "讀法分組（未經判斷，按次數）：", "");
  for (const pt of st.patterns.slice(0, 15)) out.push(`- ${pt.groups.map(g => g.map(id => T(id).siglum).join("")).join("｜")}：${pt.n} 處`);
  return out.join("\n");
}
function parseLLMReply(text, C) {
  const loci = C.loci.filter(L => L.kind === "sub");
  const byNo = {};
  for (const L of loci) byNo[L.no] = L;
  const sigOf = C.all.map(w => [w, T(w).siglum]).sort((a, b) => b[1].length - a[1].length);
  const res = [];
  for (const line of text.split(/\n/)) {
    if (!/^\s*[|｜]/.test(line)) continue;
    const cells = line.trim().replace(/^[|｜]|[|｜]$/g, "").split(/[|｜]/).map(x => x.trim());
    if (cells.length < 4) continue;
    const no = parseInt(cells[0].replace(/[^\d]/g, ""), 10);
    const L = byNo[no];
    if (!L) continue;
    const [, nature, okCell, sigCell, ...rest] = cells;
    const m = { src: "llm", llm: [nature, rest.join("｜")].filter(Boolean).join("：") };
    const okc = okCell.replace(/本/g, "");
    if (/皆非|都不|俱誤|皆誤/.test(okc)) m.ok = "\u0000";
    else if (!/^[?？]|不明|無法/.test(okc)) {
      for (const [w, sg] of sigOf) {
        if (okc.includes(sg) && L.rd[w]) { m.ok = L.rd[w].n; break; }
      }
    }
    m.star = /^是/.test(sigCell);
    res.push([L, m]);
  }
  // 同一條出現多次（分幾次判讀、或回答中舉例）：取最後一次
  const last = new Map();
  for (const x of res) last.set(x[0].key, x);
  return [...last.values()];
}
function importParsed(rs) {
  for (const [L, m] of rs) {
    const old = markOf(L) || {};
    const nm = Object.assign({}, old, { ok: m.ok != null ? m.ok : old.ok, star: m.star, llm: m.llm, src: "llm" });
    delete nm.ai;
    setMark(L, nm);
  }
  flushMarks();
  toast(`已導入 ${rs.length} 條判讀；請在異文表中逐條覆核`);
  S.sub = "st"; renderColl();
}
function llmImport() {
  const ta = h("textarea", { rows: 16, placeholder: "把 LLM 的回答整個貼在這裡（程序會找出其中的表格行：| 編號 | 性質 | 擬定正讀 | 指示性錯誤 | 理由 |）" });
  dialog("導入 LLM 的判讀回答", [ta, h("div", { class: "help", style: "margin-top:6px" },
    "導入後：「擬定正讀」→ 正讀；「指示性錯誤：是」→ ★；性質和理由寫入 LLM 欄。你自己寫的備註保留不動。導入的結果只是參考，請逐條覆核。")],
  [{ label: "取消" }, { label: "導入", cls: "primary", act: () => {
    const rs = parseLLMReply(ta.value, S.coll);
    if (!rs.length) { toast("沒有找到可識別的表格行", true); return false; }
    importParsed(rs);
  } }], true);
}
// 史源分析稿：同文分佈＋並非各本皆同的同文段落（最能看出誰與誰共有文字）＋異於底本的共同讀法
function sourcePrompt() {
  const C = S.coll, D = sameDist(C), min = sameMin();
  const cell = x => String(x).replace(/\|/g, "｜");
  const clip = (t, n) => { const a = Array.from(t); return a.length > n ? a.slice(0, n - 20).join("") + "……" + a.slice(-12).join("") : t; };
  const covering = g => C.all.filter(w => g.st[w] !== "-");
  const partial = C.same.filter(g => !g.alt && g.neq >= 2 && g.n >= min && covering(g).some(w => g.st[w] === "x"))
    .sort((a, b) => b.n - a.n).slice(0, 150);
  const alts = C.same.filter(g => g.alt).sort((a, b) => b.n - a.n).slice(0, 150);
  const seg = g => `| ${g.no} | ${locStr(g.loc, T(C.base))} | ${g.n} | ${cell(patLabel(g.pat, C.all))} | ${cell(clip(sameText(C, g), 160))} |`;
  return ["# 史源分析稿", "", ROLE_SOURCE, "", "## 各本", "", ...witList().map(x => "- " + x), "",
    "## 說明", "",
    "以底本為座標比對各本：「同」＝與其他標「同」的本子逐字相同（已做繁簡、異體歸一，忽略標點）；「異」＝該本此處有文字但不同，或沒有這些文字；「缺」＝不在該本對應的範圍內。程序只做逐字比對，不判斷先後與因襲方向。", "",
    `## 同文分佈（底本對校範圍共 ${D.total.toLocaleString()} 字）`, "",
    "| 組合 | 字數 | 段數 | 佔底本 |", "|---|---|---|---|",
    ...D.rows.map(d => `| ${cell(patLabel(d.pat, C.all))}${d.alt ? "（底本讀法不同，這幾本彼此相同）" : ""} | ${d.n} | ${d.segs} | ${d.alt ? "" : pct(d.n / (D.total || 1))} |`),
    `| 底本獨有（他本皆異或缺） | ${D.solo} | | ${pct(D.solo / (D.total || 1))} |`, "",
    `## 並非各本皆同的同文段落（${min} 字以上，按長度取前 ${partial.length} 段）`, "",
    "| 編號 | 位置（底本） | 字數 | 組合 | 同文 |", "|---|---|---|---|---|", ...(partial.length ? partial.map(seg) : ["| | | | 無 | |"]), "",
    `## 異於底本、而兩本以上相同的讀法（${alts.length} 處）`, "",
    "| 編號 | 位置（底本） | 字數 | 組合 | 讀法 |", "|---|---|---|---|---|", ...(alts.length ? alts.map(seg) : ["| | | | 無 | |"]), "",
    "## 請你做的事", "",
    "1. 據同文分佈，說明哪些本子之間共有他本所無的文字、共有多少，這些共有部分可能意味著甚麼（同出一源、彼此因襲、或各自獨立取材）。",
    "2. 逐條檢查「異於底本、而兩本以上相同」的讀法與較長的部分同文段落：哪些足以證明文字上的承襲關係，承襲的方向如何判斷，哪些可能只是巧合。",
    "3. 給出你認為最可能的史源關係（可用縮進的文字樹或箭頭表示），並指出證據薄弱、需要回到原書核查之處。",
    "4. 若還需要比對其他文獻（如更早的史料、官修書、文集）才能確定，請具體列出。"].join("\n");
}
function stemmaPrompt() {
  const C = S.coll, st = collStats(C, S.marks, S.onlyStar);
  if (!st.judged) { toast("還沒有已判斷（定了正讀）" + (S.onlyStar ? "且標 ★ " : "") + "的異文", true); return null; }
  const sig = C.all.map(w => T(w).siglum);
  const gs = g => g.map(id => T(id).siglum).join("");
  const cell = x => String(x).replace(/\|/g, "｜");
  const out = ["# 譜系討論稿", "", ROLE_STEMMA, "", "## 各本", "", ...witList().map(x => "- " + x), "",
    `## 已判斷的異文（${st.judged} 處${S.onlyStar ? "，只計標為指示性錯誤者" : ""}）`, "",
    "讀法後的 ✓ 表示與擬定正讀相同。", "",
    "| 編號 | 底本上下文 | " + sig.join(" | ") + " | 判讀備註 |", "|" + "---|".repeat(3 + sig.length)];
  for (const L of C.loci) {
    if (L.kind !== "sub") continue;
    const m = markOf(L);
    if (!m || m.ok == null || (S.onlyStar && !m.star)) continue;
    const b = L.rd[C.base];
    const ctx = Array.from(L.pre).slice(-6).join("") + "【" + (b.g || "‸") + "】" + Array.from(L.post).slice(0, 6).join("");
    out.push(`| ${L.no} | ${cell(ctx)} | ` + C.all.map(w => L.rd[w] ? cell((L.rd[w].g || "（無）") + (L.rd[w].n === m.ok ? " ✓" : "")) : "（缺）").join(" | ") +
      ` | ${cell([m.note, m.llm || m.ai].filter(Boolean).join("；"))} |`);
  }
  out.push("", "## 程序的計數", "", "各本錯誤數：" + C.all.map(x => T(x).siglum + " " + st.per[x].err).join("，"), "",
    "共同錯誤（持同一錯誤讀法的本子組）：", "", ...(st.shared.length ? st.shared.map(x => `- ${gs(x.group)}：${x.n} 處（編號 ${x.loci.join("、")}）`) : ["- 無"]), "",
    "分離錯誤（行本有錯而列本不錯的處數）：", "", "| | " + sig.join(" | ") + " |", "|" + "---|".repeat(1 + sig.length),
    ...C.all.map(x => `| ${T(x).siglum} | ` + C.all.map(y => x === y ? "—" : String(st.sep[x][y])).join(" | ") + " |"), "");
  if (st.desc.length) out.push("程序提示的可能轉抄本：", "", ...st.desc.map(d => `- ${T(d.copy).siglum} 含 ${T(d.src).siglum} 的全部 ${d.common} 處錯誤，另有 ${d.extra} 處`), "");
  const sk = stemmaSketch(C, st, S.ui.stemmaMin || 2);
  out.push("程序按共同錯誤畫出的草圖（只是把判斷畫出來，不是結論）：", "", "```", sk.text, "```", "");
  if (sk.conflicts.length) out.push("與草圖不相容而被略去的組（可能是交叉傳承或誤判）：" + sk.conflicts.map(([g, b]) => `${gs(g.ids)}（${g.n} 處，與 ${gs(b.ids)} 交錯）`).join("；"), "");
  out.push("## 請你做的事", "",
    "1. 逐組評估這些共同錯誤是否真能支持各組的親緣（是否可能各自獨立產生、或被後人改正）。",
    "2. 給出你認為最可能的版本譜系（縮進的文字樹），說明每一分支的依據；與程序草圖不同之處請說明理由。",
    "3. 指出交叉傳承的跡象、可剔除的轉抄本、證據薄弱之處。",
    "4. 若要進一步確證，還需要查核哪些異文、版本或外部信息。");
  return out.join("\n");
}
function llmPassage() {
  const R = S.pair, d = S.pairRows;
  if (!R || !d || S.pairSel < 0) return;
  const A = T(R.a), B = T(R.b), p = R.passages[S.pairSel];
  const out = ["# 平行段落分析稿", "", ROLE_SOURCE, "",
    `- ${A.siglum}：《${A.name}》，${locStr(p.locA, A)}–${locStr(p.locA2, A)}`,
    `- ${B.siglum}：《${B.name}》，${locStr(p.locB, B)}–${locStr(p.locB2, B)}`,
    `- 本段 ${A.siglum} ${d.stat.la} 字、${B.siglum} ${d.stat.lb} 字，完全相同 ${d.stat.eq} 字，異文 ${d.stat.nvar} 處（程序已統一簡繁異體、忽略標點）。`,
    `- 兩書全書：${A.siglum} 有 ${pct(R.coverA)} 的文字見於 ${B.siglum}，${B.siglum} 有 ${pct(R.coverB)} 見於 ${A.siglum}；平行段落 ${R.passages.length} 處` +
      (p.ord ? "。" : "；本段在兩書中的先後次序與其他段落不一致。"), "",
    `## 對照（每組兩行：第一行 ${A.siglum}，第二行 ${B.siglum}；〔〕內為兩本不同之處，〔〕為空表示該本此處無字）`, ""];
  for (const r of d.rows) out.push(segPlain(r.a, ["〔", "〕"]), segPlain(r.b, ["〔", "〕"]), "");
  out.push("## 請你分析", "",
    "1. 兩段文字是什麼關係：一方抄錄、節錄或改寫另一方，還是同出第三個來源？依據是什麼？",
    "2. 歸納系統性的改動：刪節、增補、改寫、稱謂與避諱、評價或立場的改變等，各舉具體字句為例。",
    "3. 哪些差異可以作為判斷抄錄方向的證據（例如一方的錯誤或不通之處可由另一方解釋）？",
    "4. 結論與不確定之處。");
  shareDoc("LLM 分析稿：平行段落 " + (p.i + 1), out.join("\n"), `平行段落分析稿_${A.siglum}${B.siglum}_${p.i + 1}`);
}

// ================================================================ 檢索
function renderSeg() {
  const v = $("#view-seg");
  v.innerHTML = "";
  const st = S.search || {};
  const q = h("textarea", { class: "seg-q", rows: 2, spellcheck: "false",
    placeholder: "輸入要追蹤的一句或一段話，例如：朕死無面目見祖宗於地下。簡繁、有無標點均可；各本中的異文、脫衍也找得到。" });
  q.value = st.query || S.ui.segQuery || "";
  const scope = h("select", {}, h("option", { value: "on" }, "勾選的文本"), h("option", { value: "all" }, "全部文本"));
  scope.value = S.ui.segScope || "on";
  const minIn = h("input", { type: "range", min: 30, max: 100, step: 1 });
  minIn.value = Math.round((S.ui.segMin || 0.6) * 100);
  const minOut = h("output", {}, minIn.value + "%");
  minIn.oninput = () => { minOut.textContent = minIn.value + "%"; };
  const mode = h("select", {}, h("option", { value: "sent" }, "延伸到所在句子"), h("option", { value: "chars" }, "前後固定字數"));
  mode.value = S.ui.segMode || "sent";
  const nIn = h("input", { type: "range", min: 0, max: 200, step: 5 });
  nIn.value = S.ui.segN != null ? S.ui.segN : 40;
  const nOut = h("output", {}, nIn.value + " 字");
  nIn.oninput = () => { nOut.textContent = nIn.value + " 字"; };
  let composing = false;
  q.addEventListener("compositionstart", () => { composing = true; });
  q.addEventListener("compositionend", () => { composing = false; segFollow(); });
  q.addEventListener("input", () => { if (!composing) segFollow(); });
  q.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); segFollow(true); }
    if (e.key === "Escape" && q.value) { e.preventDefault(); q.value = ""; segFollow(true); }
  });
  for (const el of [scope, mode]) el.addEventListener("change", () => segFollow(true));
  for (const el of [minIn, nIn]) el.addEventListener("change", () => segFollow(true));
  v.append(h("div", { class: "seg-top" }, q, h("div", { class: "seg-opts" },
    h("label", {}, "範圍 ", scope),
    h("label", { title: "與檢索句相比至少有多少相同（容許異文、脫衍）" }, "最低相似度 ", minIn, minOut),
    h("label", { title: "對校時，從命中處向外延伸的範圍；無標點的文本按字數" }, "對校片段 ", mode, "　至多 ", nIn, nOut),
    h("span", { class: "muted", style: "margin-left:auto;font-size:11.5px" }, "輸入即檢索；清空輸入框（或按 Esc）即清空結果"))));
  const res = h("div", { class: "seg-res show-same-able" + (S.ui.showSame === false ? "" : " show-same") });
  const foot = h("div", { class: "seg-foot" });
  v.append(res, foot);
  S.segUI = { q, scope, minIn, mode, nIn, res, foot };
  if (st.results && S.segDirty && q.value.trim()) { segFollow(true); return; }
  if (st.results) drawSearch();
  else res.append(h("div", { class: "placeholder", html: `<h3>檢索</h3>
    聚焦一句話或一段話：在各文本中找出它的對應文字（容許異文、脫衍、改寫），再把找到的幾處逐字對校。<br>
    例如追蹤崇禎遺詔「朕死無面目見祖宗於地下」在各種甲申史料中的不同說法。<br>
    <span class="muted">找到後：勾選要比較的幾處，點「參照」選定底本，再點「對校所選」；雙擊任一處看原文上下文。</span>` }));
}
let segTimer = null, searchSeq = 0;
function segFollow(now) {
  clearTimeout(segTimer);
  segTimer = setTimeout(() => {
    const U = S.segUI;
    if (!U) return;
    const query = U.q.value.trim();
    if (Array.from(query.replace(/[\s\p{P}]/gu, "")).length < 2) {
      if (S.search) { S.search = null; searchSeq++; saveUI({ segQuery: query }); renderSeg(); }
      return;
    }
    runSearch();
  }, now ? 0 : 600);
}
async function runSearch() {
  const U = S.segUI;
  const query = U.q.value.trim();
  if (!query) return;
  const seq = ++searchSeq;
  S.segDirty = false;
  const ids = (U.scope.value === "all" ? S.texts.filter(t => !t.err) : onTexts()).map(t => t.id);
  if (!ids.length) { toast("沒有可檢索的文本（請在左側勾選）", true); return; }
  const min = +U.minIn.value / 100;
  saveUI({ segQuery: query, segScope: U.scope.value, segMin: min, segMode: U.mode.value, segN: +U.nIn.value });
  U.foot.innerHTML = "";
  const prog = S.search ? (() => {}) : busy(U.res, "檢索中…");
  if (S.search) updating("seg", true);
  try {
    const r = await runJob(api("search", { q: query, ids, min, mode: U.mode.value, n: +U.nIn.value }), prog);
    if (seq !== searchSeq) return;
    updating("seg", false);
    // 默認：每本選相似度最高的一處；參照取第一本的最佳命中
    const sel = {};
    let base = null;
    for (const g of r.results) {
      if (!g.hits.length) continue;
      const best = g.hits.reduce((a, b) => (b.sim > a.sim ? b : a));
      sel[g.id + ":" + best.s] = true;
      if (!base) base = g.id + ":" + best.s;
    }
    S.search = { query, q: r.q, results: r.results, sel, base };
    drawSearch();
  } catch (e) {
    if (e.cancelled || seq !== searchSeq) return;
    updating("seg", false);
    S.search = null;
    U.res.innerHTML = "";
    U.res.append(h("div", { class: "placeholder" }, e.message));
  }
}
function segFind(k) {
  const st = S.search, x = k.lastIndexOf(":");
  const id = k.slice(0, x), s0 = +k.slice(x + 1);
  const g = st.results.find(g => g.id === id);
  return { id, hit: g && g.hits.find(hh => hh.s === s0) };
}
// 檢索結果的當前處（單擊或方向鍵選中；重畫時按 S.search.cur 保留）
function setCur(row) {
  S.search.cur = row.dataset.k;
  $$(".seg-hit.cur", S.segUI.res).forEach(r => r.classList.toggle("cur", false));
  row.classList.add("cur");
}
function drawSearch() {
  const U = S.segUI, st = S.search;
  if (!U.res.classList.contains("kbd-list"))
    listKeys(U.res, { items: () => $$(".seg-hit", U.res), cur: () => $(".seg-hit.cur", U.res),
      go: row => { setCur(row); row.scrollIntoView({ block: "nearest" }); },
      enter: row => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
      space: row => { const cb = $("input[type=checkbox]", row); if (cb) cb.click(); } });
  const top = U.res.scrollTop;
  U.res.innerHTML = "";
  let n = 0;
  U.res.append(h("div", { class: "seg-legend" }, sameToggle(() => U.res),
    h("span", { class: "legend" }, h("span", {}, h("i", { class: "focus-swatch" }), "命中處")),
    h("span", { class: "muted" }, "淡綠＝與檢索句相同的字；雙擊一處：看原文上下文（已選參照時與參照並排對照）")));
  for (const g of st.results) {
    const t = T(g.id);
    if (!t) continue;
    const box = h("div", { class: "seg-group" }, h("div", { class: "seg-gh" }, h("span", { class: "t-sig" }, t.siglum), h("b", {}, t.name),
      h("span", { class: "muted" }, g.error ? g.error : (g.hits.length ? `${g.hits.length} 處` : "未找到"))));
    for (const hit of g.hits) {
      n++;
      const k = g.id + ":" + hit.s;
      const cb = h("input", { type: "checkbox", title: "選入對校" });
      cb.checked = !!st.sel[k];
      cb.onchange = () => {
        if (cb.checked) st.sel[k] = true;
        else { delete st.sel[k]; if (st.base === k) st.base = Object.keys(st.sel)[0] || null; }
        drawSearch();
      };
      const rb = h("input", { type: "radio", name: "seg-base", title: "以此處為參照（底本）" });
      rb.checked = st.base === k;
      rb.onchange = () => { st.base = k; st.sel[k] = true; drawSearch(); };
      const row = h("div", { class: "seg-hit" + (st.sel[k] ? " on" : "") + (st.base === k ? " base" : "") + (st.cur === k ? " cur" : ""), "data-k": k },
        h("div", { class: "seg-hc" }, cb, h("label", { class: "chk muted", style: "font-size:11px" }, rb, "參照")),
        h("div", { class: "seg-hm" }, h("span", { class: "chip" + (hit.sim >= 0.95 ? "" : " warn"), title: "與檢索句的相似度" }, pct(hit.sim, 0)),
          h("span", { class: "muted" }, locStr(hit.loc, t)),
          h("button", { class: "btn ghost hit-more", title: "匯出、複製此處", onclick: e => { e.stopPropagation(); hitMenu(e.currentTarget, k); } }, "⋯")),
        h("div", { class: "seg-snip", html: ctxHTML(hit) }));
      row.addEventListener("click", e => { if (!e.target.closest("input,label,button")) setCur(row); });
      onCtx(row, () => {
        setCur(row);
        return [
          { label: st.base && st.base !== k ? "看原文上下文（與參照並排）" : "看原文上下文", act: () => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })) },
          { label: st.sel[k] ? "取消選入對校" : "選入對校", act: () => cb.click() },
          { label: st.base === k ? "已是參照（底本）" : "設為參照（底本）", act: () => { rb.checked = true; rb.dispatchEvent(new Event("change")); }, disabled: st.base === k },
          "-",
          ...hitItems(k).filter(x => x.label !== "看原文上下文"),
        ];
      });
      row.addEventListener("dblclick", e => {
        if (e.target.closest("input,label")) return;
        window.getSelection().removeAllRanges();
        const me = { id: g.id, r0: hit.r0 + hit.focus[0], r1: hit.r0 + hit.focus[1] };
        if (st.base && st.base !== k) {
          const b = segFind(st.base);
          if (b.hit) {
            openContext([{ id: b.id, r0: b.hit.r0 + b.hit.focus[0], r1: b.hit.r0 + b.hit.focus[1] }, me], { title: "原文上下文（左：參照）" });
            return;
          }
        }
        openContext([me], { title: "原文上下文" });
      });
      box.append(row);
    }
    U.res.append(box);
  }
  U.res.scrollTop = top;
  const nsel = Object.keys(st.sel).length;
  const b = st.base ? segFind(st.base) : null;
  U.foot.innerHTML = "";
  U.foot.append(h("span", {}, `共 ${n} 處，已選 `, h("b", {}, nsel), " 處",
    b && b.hit ? h("span", { class: "muted" }, `；參照：${T(b.id).siglum} ${locStr(b.hit.loc, T(b.id))}`) : null),
    h("span", { class: "sp" }),
    h("span", { class: "muted", style: "font-size:11.5px" }, "各處片段會按參照片段的範圍自動對準"),
    h("button", { class: "btn", onclick: e => searchExportMenu(e.currentTarget) }, "匯出 ▾"),
    h("button", { class: "btn primary", disabled: nsel < 2, onclick: runSegColl }, "對校所選"));
}
// 命中處：前文、命中（按與檢索句是否相同分段）、後文
function hitParts(hit) {
  const cps = Array.from(hit.text), [f0, f1] = hit.focus, same = hit.same || [];
  const inSame = i => same.some(([a, b]) => a <= i && i < b);
  const segs = [];
  for (let i = f0; i < f1; i++) {
    const c = cps[i];
    if (c === "\f" || c === "\x01" || c === "\n") continue;
    const sm = inSame(i) || !IS_CHAR.test(c);
    if (segs.length && segs[segs.length - 1][1] === sm) segs[segs.length - 1][0] += c;
    else segs.push([c, sm]);
  }
  return { before: plainRaw(cps.slice(0, f0).join("")), segs, after: plainRaw(cps.slice(f1).join("")) };
}
const hitMarked = hit => hitParts(hit).segs.map(([t, sm]) => sm ? t : "〔" + t + "〕").join("");
function searchItems(scope) {
  const st = S.search, out = [];
  for (const g of st.results) {
    const t = T(g.id);
    for (const hit of g.hits) {
      const k = g.id + ":" + hit.s;
      if (scope === "sel" && !st.sel[k]) continue;
      if (scope !== "all" && scope !== "sel" && scope !== k) continue;
      out.push({ t, g, hit, k, base: st.base === k, sel: !!st.sel[k] });
    }
  }
  return out;
}
function searchMeta() {
  const U = S.segUI;
  return `範圍：${U.scope.value === "all" ? "全部文本" : "勾選的文本"}；最低相似度 ${U.minIn.value}%；歸一方式：${$("#set-summary").textContent}。`;
}
function exportSearch(fmt, scope) {
  const st = S.search, items = searchItems(scope);
  if (!items.length) { toast("沒有可匯出的結果", true); return; }
  const single = items.length === 1 && scope !== "all" && scope !== "sel";
  const name = `檢索_${fileSafe(Array.from(st.query).slice(0, 12).join(""))}` + (single ? `_${items[0].t.siglum}` : "");
  const head = it => `${it.t.siglum}　${it.t.name}　${locStr(it.hit.loc, it.t)}　相似度 ${pct(it.hit.sim, 0)}` + (it.base ? "（參照）" : "");
  if (fmt === "txt") {
    const out = [`檢索：「${st.query}」`, searchMeta(), `共 ${items.length} 處。〔〕內為與檢索句不同的字；【】內為命中處。`, ""];
    items.forEach((it, x) => {
      const pp = hitParts(it.hit);
      out.push(`${x + 1}. ${head(it)}`, `   命中：${hitMarked(it.hit)}`, `   上下文：${pp.before}【${pp.segs.map(s => s[0]).join("")}】${pp.after}`, "");
    });
    saveText(name + ".txt", out.join("\n"));
  } else if (fmt === "docx") {
    const blocks = [{ t: "h", level: 0, text: `檢索：「${st.query}」` }, { t: "p", size: 10, runs: [{ text: searchMeta(), hl: "muted" }] },
      { t: "p", size: 10, runs: ["圖例：", { text: "命中處與檢索句相同", hl: "same focus" }, "　", { text: "命中處與檢索句不同", hl: "a focus" }, "　", { text: "上下文", hl: "muted" }] }];
    items.forEach((it, x) => {
      const pp = hitParts(it.hit);
      blocks.push({ t: "h", level: 2, text: `${x + 1}. ${head(it)}` },
        { t: "p", runs: [{ text: pp.before, hl: "muted" }, ...pp.segs.map(([t, sm]) => ({ text: t, hl: (sm ? "same" : "a") + " focus" })), { text: pp.after, hl: "muted" }] });
    });
    saveOffice("docx", name + ".docx", { blocks });
  } else {
    saveOffice("xlsx", name + ".xlsx", { sheets: [{ name: "檢索結果",
      header: ["序", "本子", "名稱", "位置", "相似度", "命中文字", "與檢索句的差異（〔〕）", "上下文", "已選", "參照"],
      widths: [5, 6, 30, 12, 8, 30, 34, 70, 6, 6],
      rows: items.map((it, x) => { const pp = hitParts(it.hit); return [x + 1, it.t.siglum, it.t.name, locStr(it.hit.loc, it.t), Math.round(it.hit.sim * 100) + "%",
        pp.segs.map(s => s[0]).join(""), hitMarked(it.hit), pp.before + "【" + pp.segs.map(s => s[0]).join("") + "】" + pp.after, it.sel ? "✓" : "", it.base ? "✓" : ""]; }) },
      { name: "說明", rows: [["檢索句", st.query], ["條件", searchMeta()], ["共計", items.length + " 處"]], widths: [10, 90] }] });
  }
}
function searchExportMenu(btn) {
  const n = Object.keys(S.search.sel).length, all = searchItems("all").length;
  menu(btn, [
    { label: `全部 ${all} 處：Word`, act: () => exportSearch("docx", "all") },
    { label: `全部 ${all} 處：Excel`, act: () => exportSearch("xlsx", "all") },
    { label: `全部 ${all} 處：TXT`, act: () => exportSearch("txt", "all") },
    "-",
    { label: `已選 ${n} 處：Word`, act: () => exportSearch("docx", "sel") },
    { label: `已選 ${n} 處：Excel`, act: () => exportSearch("xlsx", "sel") },
    { label: `已選 ${n} 處：TXT`, act: () => exportSearch("txt", "sel") },
    "-",
    { label: `LLM 分析稿（已選 ${n} 處）`, act: searchPrompt },
  ]);
}
function hitMenu(btn, k) { menu(btn, hitItems(k)); }
function hitItems(k) {
  const it = searchItems(k)[0];
  return ([
    { label: "匯出此處：Word", act: () => exportSearch("docx", k) },
    { label: "匯出此處：TXT", act: () => exportSearch("txt", k) },
    { label: "複製此處（含上下文）", act: async () => {
      const pp = hitParts(it.hit);
      const ok = await copyText(`${it.t.siglum}《${it.t.name}》${locStr(it.hit.loc, it.t)}：${pp.before}【${pp.segs.map(x => x[0]).join("")}】${pp.after}`);
      toast(ok ? "已複製" : "複製失敗", !ok);
    } },
    { label: "看原文上下文", act: () => openContext([{ id: it.g.id, r0: it.hit.r0 + it.hit.focus[0], r1: it.hit.r0 + it.hit.focus[1] }], { title: "原文上下文" }) },
  ]);
}
function searchPrompt() {
  const st = S.search, items = searchItems("sel");
  if (!items.length) { toast("請先勾選要分析的幾處", true); return; }
  const out = ["# 檢索結果分析稿", "", ROLE_SOURCE, "",
    `檢索句：「${st.query}」`, "", `程序（對勘）在各文本中找出這句話的近似出現處（容許異文、脫衍；已統一簡繁異體、忽略標點），下面是選出的 ${items.length} 處。` +
    "「命中」中〔〕內為與檢索句不同的字；「上下文」中【】內為命中處。", "", "## 各處文字", ""];
  items.forEach((it, x) => {
    const pp = hitParts(it.hit);
    out.push(`### ${x + 1}. ${it.t.siglum}《${it.t.name}》${locStr(it.hit.loc, it.t)}（相似度 ${pct(it.hit.sim, 0)}）`, "",
      `- 命中：${hitMarked(it.hit)}`, `- 上下文：${pp.before}【${pp.segs.map(s => s[0]).join("")}】${pp.after}`, "");
  });
  out.push("## 請你分析", "",
    "1. 這幾處記載是什麼關係：一方抄錄或轉述另一方，還是同出一源？依據是什麼？",
    "2. 逐處比較措辭的差異，區分有意改動（刪節、潤色、避諱、稱謂、立場）與可能的傳抄、排印或 OCR 錯誤。",
    "3. 哪一種說法可能最接近原始文本？說明理由。",
    "4. 不確定之處，以及還需要查核哪些版本或材料。");
  shareDoc("LLM 分析稿：檢索結果", out.join("\n"), `檢索分析稿_${fileSafe(Array.from(st.query).slice(0, 12).join(""))}`);
}

async function runSegColl() {
  const st = S.search;
  const keys = Object.keys(st.sel);
  if (keys.length < 2) return;
  const order = [st.base && st.sel[st.base] ? st.base : keys[0]].concat(keys.filter(k => k !== st.base));
  const items = order.map(segFind).filter(x => x.hit);
  const segs = items.map(({ id, hit }) => ({ id, lo: hit.xs, hi: hit.xe }));
  S.coll = null;
  switchTab("coll");
  const v = $("#view-coll");
  v.innerHTML = "";
  const body = h("div", { class: "coll-body" });
  v.append(body);
  const prog = busy(body, "對齊各處片段…");
  try {
    const [r, mk] = await Promise.all([runJob(api("collate", { base: segs[0], wits: segs.slice(1), fit: true }), prog),
      api("getmarks?base=" + items[0].id)]);
    const ids = [r.base].concat(Object.keys(r.info));
    const count = {};
    ids.forEach((sid, x) => {
      const tid = baseId(sid), t = T(tid) || {};
      count[tid] = (count[tid] || 0) + 1;
      const hit = items[x] && items[x].hit;
      S.segs[sid] = { id: sid, tid, siglum: t.siglum + (count[tid] > 1 ? count[tid] : ""),
        name: (t.name || "") + (hit ? "（" + locStr(hit.loc, t) + "）" : ""), ext: t.ext, paged: t.paged, pages: "" };
    });
    S.coll = prepColl(r, Object.keys(r.info));
    S.coll.seg = { query: st.query };
    S.marks = mk.marks || {};
    applyReattach();
    S.sub = "same";
    S.sameFilter = null;
    renderColl();
  } catch (e) { body.innerHTML = ""; body.append(h("div", { class: "placeholder" }, e.message)); }
}

// ================================================================ 總覽
function renderOver() {
  const v = $("#view-over");
  v.innerHTML = "";
  const ids = onTexts().map(t => t.id);
  const bar = h("div", { class: "bar" },
    h("span", { class: "muted" }, ids.length < 2 ? "在左側勾選至少兩個文本，即兩兩比對" : `左側勾選的 ${ids.length} 本兩兩比對，共 ${ids.length * (ids.length - 1) / 2} 對；勾選一變即重算`));
  v.append(bar);
  const body = h("div", { class: "over-body" });
  v.append(body);
  const sameIds = S.over && S.over.ids.length === ids.length && ids.every(x => S.over.ids.includes(x));
  if (ids.length >= 2 && !(sameIds && !S.overDirty)) { runOver(); return; }
  if (ids.length < 2) { S.over = null; overSeq++; }
  if (!S.over) body.append(h("div", { class: "placeholder", html: "<h3>總覽</h3>一次比較多個文本，看清楚誰和誰有大量相同文字、各自佔對方多少。<br>點表中任一格，即轉到這兩本的「兩本對讀」。<br><span class='muted'>比例不對稱往往有意義：甲 90% 見於乙而乙只有 20% 見於甲，說明甲的內容幾乎全在乙中（乙節抄、引用了甲，或甲是乙的節本），方向仍需你判斷。</span>" }));
  else drawOver(body);
}
let overSeq = 0;
async function runOver() {
  const ids = onTexts().map(t => t.id);
  const seq = ++overSeq;
  S.overDirty = false;
  const body = $("#view-over .over-body");
  const prog = busy(body, "比對中…");
  try {
    const r = await runJob(api("overview", { ids }), prog);
    if (seq !== overSeq) return;
    S.over = r; drawOver(body);
  } catch (e) {
    if (e.cancelled || seq !== overSeq) return;
    body.innerHTML = ""; body.append(h("div", { class: "placeholder" }, e.message));
  }
}
function drawOver(body) {
  const O = S.over, ids = O.ids.filter(T);
  body.innerHTML = "";
  const cov = (x, y) => { const a = O.cells[x + "|" + y]; if (a) return [a[0], a[2]]; const b = O.cells[y + "|" + x]; return b ? [b[1], b[2]] : [0, 0]; };
  const tbl = h("table", { class: "mx" });
  tbl.append(h("tr", {}, h("th", {}, "行本中見於列本的比例"), ids.map(y => h("th", { title: T(y).name }, h("span", { class: "s" }, T(y).siglum)))));
  for (const x of ids) {
    const tr = h("tr", {}, h("th", { style: "text-align:left" }, h("span", { class: "s" }, T(x).siglum), T(x).name.slice(0, 16)));
    for (const y of ids) {
      if (x === y) { tr.append(h("td", { class: "self" }, "—")); continue; }
      const [v, n] = cov(x, y);
      tr.append(h("td", { class: "cell", style: `background:rgba(181,64,43,${(v * .45).toFixed(3)})`, title: `${T(x).name} 有 ${pct(v)} 的文字見於 ${T(y).name}（${n} 段）`,
        onclick: () => { saveUI({ pa: x, pb: y }); switchTab("pair"); runPair(); },
        oncontextmenu: e => {
          e.preventDefault();
          menu(e, [
            { label: `兩本對讀：${T(x).siglum} 在左、${T(y).siglum} 在右`, act: () => { saveUI({ pa: x, pb: y }); switchTab("pair"); runPair(); } },
            { label: `兩本對讀：${T(y).siglum} 在左、${T(x).siglum} 在右`, act: () => { saveUI({ pa: y, pb: x }); switchTab("pair"); runPair(); } },
          ]);
        } }, v ? pct(v, 0) : "·"));
    }
    tbl.append(tr);
  }
  body.append(tbl, h("p", { class: "muted", style: "font-size:12px;margin-top:10px" }, "按當前的「比對設定」計算。點任一格查看兩本的平行段落。"));
}

// ================================================================ 方法說明
async function renderGuide() {
  const v = $("#view-guide");
  if (v.dataset.loaded) return;
  const r = await fetch("/static/guide.html");
  v.innerHTML = "<div class='guide'><article>" + await r.text() + "</article></div>";
  v.dataset.loaded = "1";
}

// ================================================================ 標籤頁
function switchTab(tab) {
  S.tab = tab;
  saveUI({ tab });
  $$("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + tab));
  if (tab === "pair") { if (!$("#view-pair .bar")) renderPairEmpty(); pairFollow(true); }
  if (tab === "coll") {
    if (S.coll && S.coll.seg) renderCollBar();
    else { if (!$("#view-coll .bar")) renderCollEmpty(); collFollow(true); }
  }
  if (tab === "over") renderOver();
  if (tab === "seg") renderSeg();
  if (tab === "guide") renderGuide().catch(fail);
}

// ================================================================ 啟動
async function init() {
  $$("#tabs button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("#add-file").addEventListener("click", async () => {
    if (Native.ok()) addPaths(await Native.call("pickFiles"));
    else $("#file-input").click();
  });
  $("#file-input").addEventListener("change", e => { uploadFiles(Array.from(e.target.files)); e.target.value = ""; });
  $("#add-paste").addEventListener("click", pasteDialog);
  $("#open-settings").addEventListener("click", settingsDialog);
  // 右鍵：文本列表（空白處＝加入文件）；別處只在輸入框、選中的文字上保留系統菜單（拷貝、查詢）
  onCtx($("#texts"), e => {
    const el = e.target.closest(".text-item");
    if (el) return T(el.dataset.id) ? textMenu(T(el.dataset.id)) : null;
    return [{ label: "加入文件…", act: () => $("#add-file").click() }, { label: "貼上文字…", act: () => $("#add-paste").click() }];
  });
  document.addEventListener("contextmenu", e => {
    if (e.defaultPrevented || e.target.closest("input, textarea, select, [contenteditable]")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;
    e.preventDefault();
  });
  // 拖入文件
  // 頁面內部發起的拖動（如拖動圖片、選中的文字）不算拖入文件：WebKit 拖圖片時也會帶上 Files 類型
  let depth = 0, innerDrag = false;
  document.addEventListener("mousedown", () => { innerDrag = false; }, true);
  document.addEventListener("dragstart", () => { innerDrag = true; }, true);
  document.addEventListener("dragend", () => { innerDrag = false; }, true);
  const isFiles = e => !innerDrag && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  // App 外殼直接交來拖入文件的路徑（按原路徑加入，不複製）
  window.dkDropPaths = paths => { depth = 0; $("#drop").hidden = true; addPaths(paths); };
  window.addEventListener("dragenter", e => { if (!isFiles(e)) return; e.preventDefault(); depth++; $("#drop").hidden = false; });
  window.addEventListener("dragover", e => { if (isFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", e => { if (!isFiles(e)) return; if (--depth <= 0) { depth = 0; $("#drop").hidden = true; } });
  window.addEventListener("drop", e => {
    if (!isFiles(e)) return;
    e.preventDefault(); depth = 0; $("#drop").hidden = true;
    uploadFiles(Array.from(e.dataTransfer.files));
  });
  window.addEventListener("resize", () => { if (S.pair && S.pairUI && S.tab === "pair") drawPlot(); });
  try { await loadState(); } catch (e) { fail(e); }
  switchTab(S.ui.tab || "pair");
}

if (IS_NODE) module.exports = { collStats, parseLLMReply, cnum, S, stemmaSketch };
else init();
