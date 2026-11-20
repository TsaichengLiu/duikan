// 校本增減後異文單位合併：標記應搬到新單位，正讀按底本位置換算
const path = require("path");
const app = require(path.join(__dirname, "../app/static/app.js"));
const src = require("fs").readFileSync(path.join(__dirname, "../app/static/app.js"), "utf8");
eval(src.slice(src.indexOf("function parseKey"), src.indexOf("function applyReattach")).replace("function parseKey", "globalThis.parseKey = function").replace("function reattachMarks", "globalThis.reattachMarks = function"));
// 舊：底本 [10,11)「之」，乙作「也」（判為正讀「也」）；新：加入丙後合併為 [10,12)「之乎」，乙作「也乎」，丙作「之歟」
const L = { kind: "sub", key: "110:112:之乎", no: 3, rd: { A: { n: "之乎" }, B: { n: "也乎" }, C: { n: "之歟" } } };
const L2 = { kind: "sub", key: "150:151:人", no: 4, rd: { A: { n: "人" }, B: { n: "" }, C: { n: "人" } } };
const C = { lo: 100, n: 100, all: ["A", "B", "C"], loci: [L, L2] };
const marks = {
  "110:111:之": { ok: "也", star: true, note: "形近" },     // 應搬到 110:112，正讀換算為「也乎」
  "150:151:人": { ok: "人" },                                 // 原樣存在
  "170:171:夫": { ok: "天" },                                 // 範圍內但已無對應：報告
  "500:501:外": { ok: "外" },                                 // 不在本次範圍：不動
};
const r = reattachMarks(C, marks);
console.log(JSON.stringify(r));
const ok = r.moved.length === 1 && r.moved[0][1] === "110:112:之乎" && r.moved[0][2].ok === "也乎" && r.moved[0][2].star
  && r.lost.length === 1 && r.lost[0][0] === "170:171:夫";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
