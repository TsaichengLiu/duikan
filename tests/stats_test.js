// 用模擬傳承驗證「統計」：以祖本 O 為底本，其讀法即正讀
const fs = require("fs");
const path = require("path");
const app = require(path.join(__dirname, "../app/static/app.js"));
const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
app.S.texts = ["O", "A", "B", "C", "D", "E"].map(x => ({ id: x, siglum: x, name: x }));
const wits = ["A", "B", "C", "D", "E"];
// 與 prepColl 相同的整理
const C = Object.assign({}, r, { wits, all: ["O"].concat(wits) });
let ns = 0;
for (const L of C.loci) {
  L.rd = {};
  for (const [k, v] of Object.entries(L.r)) L.rd[k === "_base" ? "O" : k] = v ? { g: v[0], n: v[1], loc: v[2] } : null;
  L.no = L.kind === "sub" ? ++ns : "g";
}
const marks = {};
for (const L of C.loci) if (L.kind === "sub") marks[L.key] = { ok: L.rd.O.n, star: true };
const st = app.collStats(C, marks, true);
console.log("judged", st.judged);
console.log("shared errors:", st.shared.map(s => s.group.join("") + ":" + s.n).join("  "));
console.log("errors per witness:", wits.map(w => w + ":" + st.per[w].err).join(" "));
console.log("descriptus:", st.desc.map(d => `${d.copy} ⊇ ${d.src} (+${d.extra})`).join("; "));
console.log("sep E→A", st.sep.E.A, "A→E", st.sep.A.E);
console.log("top patterns:", st.patterns.slice(0, 5).map(p => p.groups.map(g => g.join("")).join("|") + ":" + p.n).join("  "));
const sk = app.stemmaSketch(C, st, 2);
console.log("stemma sketch:\n" + sk.text);
console.log("conflicts:", sk.conflicts.length, "svg bytes:", sk.svg.length);
// 期望：ω 下有 ABE 一支（其中 E 抄自 A）與 CD 一支
const lines = sk.text.split("\n").map(l => l.trim());
const ok = st.shared.some(s => s.group.join("") === "ABE") && st.shared.some(s => s.group.join("") === "CD")
  && st.desc.some(d => d.copy === "E" && d.src === "A")
  && /E（疑抄自/.test(sk.text) && lines.filter(l => /^[αβ]/.test(l)).length === 2;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
