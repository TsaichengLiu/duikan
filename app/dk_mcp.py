#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""對勘的本地 MCP 服務（stdio；JSON-RPC 2.0，每行一條消息）。

讓 LLM 直接用對勘做確定性的比對：找平行段落、逐字對校、列同文與異文、近似檢索一句話、讀原文。
- 用對勘的文本列表、歸一設定和抽取緩存（~/Library/Application Support/DuiKan），結果與界面一致；
- 只讀：不寫工作區、不改設定、不清理磁盤，對勘開著也能用（對勘改了列表或設定，下次調用自動重讀）；
- 也可直接給文件的絕對路徑或幾段文字來比，不必先加進對勘；
- 只在 LLM 客戶端的會話期間運行，標準輸入一關閉就退出；不常駐、不聯網、不需要 API key；
  兩分鐘沒有調用即釋放計算緩存。

註冊到 Claude Code：
  claude mcp add --scope user duikan -- /usr/bin/python3 -B /Applications/對勘.app/Contents/Resources/app/dk_mcp.py
"""
import gc
import hashlib
import json
import os
import select
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from dk_align import params  # noqa: E402
from dk_compare import collate, passage_rows  # noqa: E402
from dk_extract import INDEXABLE  # noqa: E402
from dk_norm import CONTENT_ALNUM_RE, CONTENT_RE, Prepared, parse_pairs  # noqa: E402
from dk_search import phrase_hits  # noqa: E402
from server import SIGLA, UserError, Workspace  # noqa: E402

NAME, TITLE, VERSION = "duikan", "對勘", "1.0"
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
IDLE_RELEASE = 120
MAX_OUT = 60000               # 一次回答最多這麼多字，過長的截斷並說明如何翻頁
LEVEL_LABEL = {"exact": "只認原字形", "st": "簡繁互通", "full": "簡繁異體互通"}
TAGN = {"倒": "疑倒", "重": "疑重文", "跳": "疑跳脫", "諱": "疑諱", "闕": "闕字", "移": "移位"}
ST_NAME = {"=": "同", "x": "異", "-": "缺"}

INSTRUCTIONS = (
    "對勘：同源文本的比對工具（史源考察、版本校勘），簡體、繁體、異體字互通，忽略標點。"
    "程序只做確定性的部分（對齊、列出同異），判斷留給你。"
    "list_texts 看對勘裡有哪些文本（甲乙丙等簡稱、id、範圍）；文本參數可用簡稱、id、名稱，或任何 PDF／Word／TXT 的絕對路徑。"
    "search 在各本裡近似檢索一句話；compare_two 找兩本的平行段落，passage 看其中一段的逐字對照；"
    "collate 多本對校列異文，shared_text 列各本共有的文字（同文，史源考察最重要的證據）；"
    "compare_strings 直接比幾段文字（如兩處引文）；read_text 讀原文。"
    "結果裡【】是所選或命中之處，〔〕是與對方不同的文字，〔‸〕表示此處無字；"
    "「第 N 頁」是 PDF 的頁序，不一定是書上印的頁碼。offset 是原文字符位置，可直接交給 read_text。"
)

_TEXT = {"type": "string", "description": "文本：對勘裡的簡稱（如 甲）、id、名稱，或文件的絕對路徑"}
_TEXTS = {"type": "array", "items": {"type": "string"},
          "description": "多個文本（簡稱、id、名稱或絕對路徑）；不給則用對勘裡勾選的文本"}
_RO = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}

TOOLS = [
    {"name": "list_texts", "title": "列出文本與設定",
     "description": "列出對勘裡的文本（簡稱、名稱、id、格式、字數、頁數或段數、比對範圍、是否勾選）以及當前的歸一、比對設定。",
     "inputSchema": {"type": "object", "properties": {}},
     "annotations": _RO},
    {"name": "read_text", "title": "讀原文",
     "description": ("讀一個文本抽取出的原文（含標點）。PDF 可按頁讀：pages 如 \"12\" 或 \"12-15\"；"
                     "也可按字符位置讀：offset、length（其他工具給出的 offset 可直接用）。一次最多 20000 字。"),
     "inputSchema": {"type": "object", "properties": {
         "text": _TEXT,
         "pages": {"type": "string", "description": "頁碼或頁碼範圍（PDF 的第幾頁）"},
         "offset": {"type": "integer", "minimum": 0, "description": "從第幾個字符開始（默認 0）"},
         "length": {"type": "integer", "minimum": 100, "maximum": 20000, "default": 6000}},
         "required": ["text"]},
     "annotations": _RO},
    {"name": "search", "title": "近似檢索一句話",
     "description": ("在各本裡找一句話（或一小段）的出處與異文：容許異文、脫字、衍字，簡繁異體互通，不計標點。"
                     "返回每處的位置、相似度和上下文，命中處用【】，其中與檢索句不同的字用〔〕。"),
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "要找的句子，2–400 字"},
         "texts": _TEXTS,
         "min_similarity": {"type": "number", "minimum": 0.3, "maximum": 1.0, "default": 0.75,
                            "description": "相似度下限（1 − 編輯距離 ÷ 字數）"},
         "context": {"type": "integer", "minimum": 0, "maximum": 300, "default": 40, "description": "前後各帶多少字"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 30, "default": 10, "description": "每本最多列幾處"}},
         "required": ["query"]},
     "annotations": _RO},
    {"name": "compare_two", "title": "兩本對讀：平行段落",
     "description": ("找兩本之間的平行段落（兩本都有、文字大體相同的段落）：各本有多少見於對方、每段的起止位置、"
                     "長度、相同比例、次序是否一致（移位）。用 passage 看某段的逐字對照。"),
     "inputSchema": {"type": "object", "properties": {
         "a": _TEXT, "b": _TEXT,
         "sort": {"type": "string", "enum": ["a", "b", "length", "diff"], "default": "a",
                  "description": "a／b＝按該本的順序；length＝按長度；diff＝差異多的在前"},
         "offset": {"type": "integer", "minimum": 0, "default": 0},
         "limit": {"type": "integer", "minimum": 1, "maximum": 300, "default": 40}},
         "required": ["a", "b"]},
     "annotations": _RO},
    {"name": "passage", "title": "兩本對讀：一段的逐字對照",
     "description": "compare_two 列出的某一段平行段落的逐字對照，按句排成兩行一組，不同之處用〔〕標出。",
     "inputSchema": {"type": "object", "properties": {
         "a": _TEXT, "b": _TEXT,
         "number": {"type": "integer", "minimum": 1, "description": "段落編號（compare_two 結果中的 #）"},
         "offset": {"type": "integer", "minimum": 0, "default": 0, "description": "從第幾行開始"},
         "limit": {"type": "integer", "minimum": 1, "maximum": 400, "default": 120, "description": "最多列幾行"}},
         "required": ["a", "b", "number"]},
     "annotations": _RO},
    {"name": "collate", "title": "多本對校：異文",
     "description": ("以一本為底本，與其他各本逐字對校，列出每處異文：位置、底本上下文、各本讀法（同／讀法／缺）、"
                     "程序提示（疑倒、疑跳脫、疑諱等）及用戶在對勘裡已做的判讀（正讀、★ 指示性錯誤、備註）。"),
     "inputSchema": {"type": "object", "properties": {
         "base": dict(_TEXT, description="底本；不給則用對勘界面裡選的底本"),
         "witnesses": dict(_TEXTS, description="校本；不給則用對勘裡勾選的其餘文本"),
         "include_glyph": {"type": "boolean", "default": False, "description": "是否也列只有字形不同（繁簡、異體）之處"},
         "offset": {"type": "integer", "minimum": 0, "default": 0},
         "limit": {"type": "integer", "minimum": 1, "maximum": 400, "default": 80}}},
     "annotations": _RO},
    {"name": "shared_text", "title": "多本對校：同文",
     "description": ("以底本為座標，列出各本逐字相同的文字按「哪幾本相同」分段：先給同文分佈（每種組合共有多少字），"
                     "再列同文段落（含底本上下文）。另列底本讀法不同而兩本以上彼此相同的文字（共有的增文、改字），"
                     "這往往是判斷誰承襲誰最直接的證據。"),
     "inputSchema": {"type": "object", "properties": {
         "base": dict(_TEXT, description="底本；不給則用對勘界面裡選的底本"),
         "witnesses": dict(_TEXTS, description="其他各本；不給則用對勘裡勾選的其餘文本"),
         "min_length": {"type": "integer", "minimum": 1, "maximum": 1000, "default": 8, "description": "同文段落的字數下限"},
         "only_partial": {"type": "boolean", "default": True,
                          "description": "只列並非各本皆同的段落（各本皆同的通常不是史源考察的重點）"},
         "sort": {"type": "string", "enum": ["position", "length"], "default": "length"},
         "context": {"type": "integer", "minimum": 0, "maximum": 200, "default": 30},
         "offset": {"type": "integer", "minimum": 0, "default": 0},
         "limit": {"type": "integer", "minimum": 1, "maximum": 300, "default": 60}}},
     "annotations": _RO},
    {"name": "compare_strings", "title": "直接比幾段文字",
     "description": ("不經對勘的文本列表，直接比對 2–12 段文字（如一句引文的幾種版本、兩段記載）：第一段為底本，"
                     "列出各處異文、各段的相同比例和同文分佈。簡繁異體互通，忽略標點。"),
     "inputSchema": {"type": "object", "properties": {
         "texts": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 12},
         "labels": {"type": "array", "items": {"type": "string"}, "description": "各段的名稱（默認 甲乙丙…）"},
         "include_glyph": {"type": "boolean", "default": False}},
         "required": ["texts"]},
     "annotations": _RO},
]


# ======================================================================= 小工具
class ToolError(Exception):
    pass


def _int(v, lo, hi, default):
    try:
        v = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def loc_str(loc, t):
    if not loc:
        return ""
    p, line = loc
    if p is not None:
        return "%s頁%s行" % (p, line)
    unit = "段" if t and t.get("ext") in ("doc", "docx", "rtf", "odt", "epub", "html", "htm") else "行"
    return "第%s%s" % (line, unit)


def flat(s):
    """原文片段平鋪成一行：去頁眉記號，換頁換行都不保留。"""
    return s.replace("\x01", "").replace("\f", "").replace("\r", "").replace("\n", "")


def clip(s, n):
    return s if len(s) <= n else s[:n - 12] + "……" + s[-8:]


def tname(t):
    return "%s《%s》" % (t.get("siglum", ""), t.get("name", ""))


def finish(lines):
    out = "\n".join(lines)
    if len(out) > MAX_OUT:
        out = out[:MAX_OUT] + "\n……（輸出過長，已截斷；請用 offset／limit 分批取）"
    return out


def find_helper():
    for c in (os.path.join(HERE, "..", "bin", "dkhelper"), "/Applications/對勘.app/Contents/Resources/bin/dkhelper"):
        if os.path.exists(c):
            return os.path.abspath(c)
    return None


# ======================================================================= 服務
class Service(object):
    def __init__(self, data, cache):
        self.data, self.cache = data, cache
        self._ws = None
        self.mtime = None
        self.virtual = {}          # 直接給路徑的文件：只在本進程裡當作文本，不寫進對勘
        self.last = time.time()
        self.released = True

    @property
    def ws(self):
        path = os.path.join(self.data, "workspace.json")
        mt = os.path.getmtime(path) if os.path.exists(path) else None
        if self._ws is None:
            self._ws = Workspace(self.data, self.cache, find_helper(), readonly=True)
            self.mtime = mt
            self._ws.texts.extend(self.virtual.values())
        elif mt != self.mtime:
            self._ws.load()          # 對勘改了文本列表或設定：重讀（各計算緩存的鍵含設定與範圍，自然失效）
            self.mtime = mt
            self._ws.texts.extend(self.virtual.values())
        self.released = False
        return self._ws

    def idle(self):
        if self._ws is not None and not self.released and time.time() - self.last > IDLE_RELEASE:
            self._ws.release()
            gc.collect()
            self.released = True

    def call(self, name, a):
        fn = getattr(self, "t_" + name, None) if name in set(t["name"] for t in TOOLS) else None
        if fn is None:
            return {"content": [{"type": "text", "text": "沒有這個工具：%s" % name}], "isError": True}
        try:
            return {"content": [{"type": "text", "text": fn(a or {})}]}
        except (ToolError, UserError) as e:
            return {"content": [{"type": "text", "text": str(e)}], "isError": True}
        except Exception as e:  # noqa
            traceback.print_exc(file=sys.stderr)
            return {"content": [{"type": "text", "text": "出錯：%s: %s" % (type(e).__name__, e)}], "isError": True}
        finally:
            self.last = time.time()

    # ---------------------------------------------------------------- 文本
    def tid(self, ref):
        ws = self.ws
        ref = str(ref or "").strip()
        if not ref:
            raise ToolError("請給出文本（簡稱、id、名稱或文件的絕對路徑）")
        for t in ws.texts:
            if ref in (t["id"], t.get("siglum")):
                return t["id"]
        named = [t for t in ws.texts if t.get("name") == ref]
        if len(named) == 1:
            return named[0]["id"]
        if ref.startswith(("/", "~")):
            path = os.path.abspath(os.path.expanduser(ref))
            if not os.path.isfile(path):
                raise ToolError("找不到文件：%s" % path)
            ext = os.path.splitext(path)[1].lower().lstrip(".")
            if ext not in INDEXABLE:
                raise ToolError("不支持這種格式：%s" % os.path.basename(path))
            vid = "f" + hashlib.sha1(path.encode("utf-8")).hexdigest()[:9]
            if vid not in self.virtual:
                t = {"id": vid, "name": os.path.splitext(os.path.basename(path))[0], "siglum": "外%d" % (len(self.virtual) + 1),
                     "path": path, "ext": ext, "on": False, "pages": "", "start": "", "end": "", "virtual": True}
                self.virtual[vid] = t
                ws.texts.append(t)
            return vid
        part = [t for t in ws.texts if ref in t.get("name", "")]
        if len(part) == 1:
            return part[0]["id"]
        have = "、".join(tname(t) for t in ws.texts if not t.get("virtual")) or "（對勘裡還沒有文本）"
        raise ToolError("找不到文本「%s」%s。對勘裡現有：%s；也可以直接給文件的絕對路徑。"
                        % (ref, "（有 %d 個名稱含此字樣）" % len(part) if part else "", have))

    def T(self, tid):
        return self.ws.text(tid)

    def checked(self):
        return [t["id"] for t in self.ws.texts if t.get("on") and not t.get("virtual") and not t.get("err")]

    def coll_ids(self, a):
        ws = self.ws
        ids = self.checked()
        if a.get("base"):
            base = self.tid(a["base"])
        else:
            base = ws.ui.get("cbase") if ws.ui.get("cbase") in ids else (ids[0] if ids else None)
        if not base:
            raise ToolError("請給出底本（對勘裡也沒有勾選的文本）")
        if a.get("witnesses"):
            wits = [self.tid(w) for w in a["witnesses"]]
        else:
            off = set(ws.ui.get("cwitsOff") or [])
            wits = [x for x in ids if x != base and x not in off]
        wits = [w for x, w in enumerate(wits) if w != base and w not in wits[:x]]
        if not wits:
            raise ToolError("至少要有一個校本")
        return base, wits

    def settings_line(self):
        s = self.ws.settings
        bits = [LEVEL_LABEL.get(s["level"], s["level"]), "比對數字西文" if s["keep_alnum"] else "不計數字西文"]
        if s.get("skip_notes"):
            bits.append("略去括號夾注")
        if s.get("skip_heads"):
            bits.append("略去 PDF 頁眉頁腳")
        if (s.get("custom") or "").strip():
            bits.append("有自定的視同字")
        return "歸一：%s；不計標點。" % "，".join(bits)

    # ---------------------------------------------------------------- 工具
    def t_list_texts(self, a):
        ws = self.ws
        s = ws.settings
        texts = [t for t in ws.texts if not t.get("virtual")]
        lines = ["對勘裡有 %d 個文本（勾選 %d 個；比對時默認用勾選的）。" % (len(texts), len(self.checked())),
                 self.settings_line(),
                 "平行段落參數：種子 %d 字、段內空隙至多 %d 字、段落至少 %d 字、密度 %.2f。" % (s["k"], s["gap"], s["min"], s["dens"]), ""]
        cb = ws.ui.get("cbase")
        for t in texts:
            d = ws.info(t)
            bits = ["id=%s" % t["id"], t.get("ext", "")]
            if d.get("err"):
                bits.append("（%s）" % d["err"])
            else:
                bits.append("%s 字" % format(d.get("n", 0), ","))
                if d.get("paged") and d.get("npages"):
                    bits.append("%d 頁" % d["npages"])
                bits.append("%s–%s" % (loc_str(d.get("loc0"), t), loc_str(d.get("loc1"), t)))
            if t.get("pages"):
                bits.append("只比頁 %s" % t["pages"])
            if t.get("start"):
                bits.append("起「%s」" % t["start"])
            if t.get("end"):
                bits.append("止「%s」" % t["end"])
            bits.append("勾選" if t.get("on") else "未勾選")
            if t["id"] == cb:
                bits.append("多本對校底本")
            lines.append("- %s　%s" % (tname(t), " · ".join(b for b in bits if b)))
            lines.append("  %s" % ("貼上的文字" if t.get("pasted") else t.get("path", "")))
        if not texts:
            lines.append("（還沒有文本。可以直接給文件路徑或文字來比：compare_two、collate 等的文本參數接受絕對路徑，compare_strings 接受文字。）")
        return finish(lines)

    def t_read_text(self, a):
        ws = self.ws
        t = self.T(self.tid(a.get("text")))
        raw = ws.get_raw(t)
        n = _int(a.get("length"), 100, 20000, 6000)
        if a.get("pages"):
            spec = str(a["pages"]).replace("－", "-").replace("—", "-").replace("–", "-").strip()
            pages = raw.split("\f")
            try:
                p0, _, p1 = spec.partition("-")
                p0 = int(p0)
                p1 = int(p1) if p1 else p0
            except ValueError:
                raise ToolError("pages 的格式應為「12」或「12-15」")
            if not (1 <= p0 <= p1 <= len(pages)):
                raise ToolError("頁碼超出範圍（共 %d 頁）" % len(pages))
            body = "\n".join("〔第 %d 頁〕\n%s" % (p, pages[p - 1].replace("\x01", "")) for p in range(p0, p1 + 1))
            more = len(body) > n
            head = "%s　第 %d–%d 頁（共 %d 頁）" % (tname(t), p0, p1, len(pages))
            return finish([head, "", body[:n] + ("\n……（未完，可縮小頁碼範圍或加大 length）" if more else "")])
        off = _int(a.get("offset"), 0, len(raw), 0)
        end = min(len(raw), off + n)
        seg = raw[off:end]
        page = raw.count("\f", 0, off) + 1
        out = []
        for i, part in enumerate(seg.split("\f")):
            if i:
                page += 1
                out.append("\n〔第 %d 頁〕\n" % page)
            out.append(part)
        head = "%s　字符 %d–%d（共 %d 字符%s）" % (tname(t), off, end, len(raw),
                                              "；從第 %d 頁起" % (raw.count("\f", 0, off) + 1) if "\f" in raw else "")
        tail = "\n……（下一段：offset=%d）" % end if end < len(raw) else ""
        return finish([head, "", "".join(out).replace("\x01", "") + tail])

    def t_search(self, a):
        ws = self.ws
        query = a.get("query") or ""
        nz = ws.normalizer()
        rx = CONTENT_ALNUM_RE if ws.settings["keep_alnum"] else CONTENT_RE
        q = "".join(rx.findall(nz.norm(query)))
        if len(q) < 2:
            raise ToolError("請給出至少兩個字的檢索句")
        if len(q) > 400:
            raise ToolError("檢索句太長（%d 字）；長篇請用 compare_two" % len(q))
        mins = max(0.3, min(1.0, float(a.get("min_similarity") or 0.75)))
        ctx = _int(a.get("context"), 0, 300, 40)
        lim = _int(a.get("limit"), 1, 30, 10)
        ids = [self.tid(x) for x in (a.get("texts") or [])] or self.checked() or \
            [t["id"] for t in ws.texts if not t.get("virtual")]
        if not ids:
            raise ToolError("沒有可檢索的文本：請在 texts 裡給出文件路徑，或先在對勘裡加入文本")
        lines, total = [], 0
        for tid in ids:
            t = self.T(tid)
            try:
                P = ws.prepared(tid)
            except UserError as e:
                lines += ["## %s：%s" % (tname(t), e), ""]
                continue
            hits = phrase_hits(P, q, mins, "chars", ctx, max_hits=lim)
            total += len(hits)
            lines.append("## %s：%s" % (tname(t), "%d 處" % len(hits) if hits else "未找到"))
            for x, h in enumerate(hits, 1):
                text, (f0, f1) = h["text"], h["focus"]
                same = set()
                for s0, s1 in h.get("same") or []:
                    same.update(range(s0, s1))
                mid, diff = [], False
                for i in range(f0, f1):
                    c = text[i]
                    d = i not in same and bool(rx.match(nz.norm(c)) if c.strip() else False)
                    if d != diff:
                        mid.append("〔" if d else "〕")
                        diff = d
                    mid.append(c)
                if diff:
                    mid.append("〕")
                lines.append("%d. %s　相似 %d%%　offset %d–%d" % (x, loc_str(h["loc"], t), round(h["sim"] * 100),
                                                               h["r0"] + f0, h["r0"] + f1))
                lines.append("   %s【%s】%s" % (flat(text[:f0]), flat("".join(mid)), flat(text[f1:])))
            lines.append("")
        head = ["檢索「%s」（歸一後 %d 字），相似度 ≥ %d%%：共 %d 處。%s" % (query.strip(), len(q), round(mins * 100), total,
                                                                  self.settings_line()),
                "【】＝命中處，其中〔〕＝與檢索句不同的字。", ""]
        return finish(head + lines)

    def _pair(self, a):
        A, B = self.tid(a.get("a")), self.tid(a.get("b"))
        if A == B:
            raise ToolError("a 與 b 是同一個文本")
        res, ps = self.ws.pair(A, B)
        return A, B, res, ps

    def t_compare_two(self, a):
        A, B, res, ps = self._pair(a)
        ta, tb = self.T(A), self.T(B)
        P = list(res["passages"])
        k = a.get("sort") or "a"
        if k == "b":
            P.sort(key=lambda p: p["b0"])
        elif k == "length":
            P.sort(key=lambda p: -p["m"])
        elif k == "diff":
            P.sort(key=lambda p: p["sim"])
        off = _int(a.get("offset"), 0, len(P), 0)
        lim = _int(a.get("limit"), 1, 300, 40)
        nout = sum(1 for p in P if not p["ord"])
        lines = ["%s %s 字，其中 %d%% 見於%s；%s %s 字，其中 %d%% 見於%s。" % (
                     tname(ta), format(res["nA"], ","), round(res["coverA"] * 100), tb["siglum"],
                     tname(tb), format(res["nB"], ","), round(res["coverB"] * 100), ta["siglum"]),
                 "平行段落 %d 處%s。%s" % (len(P), "，其中 %d 處次序與%s不同（移位）" % (nout, ta["siglum"]) if nout else "",
                                         self.settings_line()),
                 "以下按%s列第 %d–%d 段（# 為段落編號，passage 用它看逐字對照）：" % (
                     {"a": ta["siglum"] + "的順序", "b": tb["siglum"] + "的順序", "length": "長度", "diff": "差異多少"}.get(k, ""),
                     off + 1, min(len(P), off + lim)), ""]
        for p in P[off:off + lim]:
            lines.append("#%d　%s %s–%s（%d 字）↔ %s %s–%s（%d 字）　相同 ≥%d%%%s" % (
                p["i"] + 1, ta["siglum"], loc_str(p["locA"], ta), loc_str(p["locA2"], ta), p["la"],
                tb["siglum"], loc_str(p["locB"], tb), loc_str(p["locB2"], tb), p["lb"], round(p["sim"] * 100),
                "　移位" if not p["ord"] else ""))
            lines.append("   %s 開頭：%s……　offset %d–%d ↔ %d–%d" % (ta["siglum"], p["pa"], p["ra"][0], p["ra"][1], p["rb"][0], p["rb"][1]))
        if off + lim < len(P):
            lines += ["", "……還有 %d 段（offset=%d）" % (len(P) - off - lim, off + lim)]
        return finish(lines)

    def t_passage(self, a):
        A, B, res, ps = self._pair(a)
        i = _int(a.get("number"), 1, 1 << 30, 1) - 1
        if not 0 <= i < len(ps):
            raise ToolError("沒有第 %d 段（共 %d 段）" % (i + 1, len(ps)))
        ws = self.ws
        ta, tb = self.T(A), self.T(B)
        rows, st = passage_rows(ws.prepared(A), ws.prepared(B), ps[i], ws.normalizer())
        p = res["passages"][i]
        off = _int(a.get("offset"), 0, len(rows), 0)
        lim = _int(a.get("limit"), 1, 400, 120)

        def side(segs):
            out = []
            for tag, text, _ in segs:
                s = "".join(flat(text).split())
                out.append(s if tag == "=" else "〔%s〕" % (s or "‸"))
            return "".join(out)
        lines = ["段落 #%d：%s %s–%s ↔ %s %s–%s；%s %d 字、%s %d 字，相同 %d 字，異文 %d 處，相似度 %d%%%s。" % (
                     i + 1, ta["siglum"], loc_str(p["locA"], ta), loc_str(p["locA2"], ta), tb["siglum"],
                     loc_str(p["locB"], tb), loc_str(p["locB2"], tb), ta["siglum"], st["la"], tb["siglum"], st["lb"],
                     st["eq"], st["nvar"], round(st["sim"] * 100), "；這段在兩本中的次序不一致（移位）" if not p["ord"] else ""),
                 "〔〕＝與另一本不同的文字，〔‸〕＝此處無字（另一本有）。共 %d 行，以下第 %d–%d 行：" % (len(rows), off + 1, min(len(rows), off + lim)), ""]
        for r in rows[off:off + lim]:
            lines.append("%s %s：%s" % (ta["siglum"], loc_str(r["la"], ta), side(r["a"])))
            lines.append("%s %s：%s" % (tb["siglum"], loc_str(r["lb"], tb), side(r["b"])))
            lines.append("")
        if off + lim < len(rows):
            lines.append("……還有 %d 行（offset=%d）" % (len(rows) - off - lim, off + lim))
        return finish(lines)

    def _collation(self, a):
        base, wits = self.coll_ids(a)
        r = self.ws.collation(base, wits, lambda *x: None)
        bad = [w for w in wits if not (r["info"].get(w) or {}).get("ok")]
        wits = [w for w in wits if w not in bad]
        return base, wits, bad, r

    def _coll_head(self, base, wits, bad, r):
        bt = self.T(base)
        lines = ["底本 %s；%s" % (tname(bt), self.settings_line())]
        for w in wits:
            i, t = r["info"][w], self.T(w)
            lines.append("- %s：對應底本 %s–%s，覆蓋底本 %d%%，相似 %d%%" % (
                tname(t), loc_str(i["locA"], bt), loc_str(i["locA2"], bt), round(i["covBase"] * 100), round(i["sim"] * 100)))
        for w in bad:
            lines.append("- %s：與底本沒有可對齊的文字，已略去" % tname(self.T(w)))
        return lines

    def t_collate(self, a):
        base, wits, bad, r = self._collation(a)
        return self._apparatus(base, wits, bad, r, a, lambda w: self.T(w), self.ws.marks.get(base, {}))

    def _apparatus(self, base, wits, bad, r, a, T, marks, head=None):
        allw = [base] + wits
        sig = lambda w: T(w).get("siglum", "")  # noqa: E731
        loci, ns, ng = [], 0, 0
        for L in r["loci"]:
            if L["kind"] == "sub":
                ns += 1
                no = str(ns)
            else:
                ng += 1
                no = "形%d" % ng
            if L["kind"] == "sub" or a.get("include_glyph"):
                loci.append((no, L))
        off = _int(a.get("offset"), 0, len(loci), 0)
        lim = _int(a.get("limit"), 1, 400, 80)
        bt = T(base)
        lines = (head if head is not None else self._coll_head(base, wits, bad, r)) + [
            "實質異文 %d 處，字形差異 %d 處%s。以下第 %d–%d 處；「同」＝與底本相同，「缺」＝不在該本範圍內，「（無）」＝該本無此字。" % (
                ns, ng, "" if a.get("include_glyph") else "（未列，include_glyph 可列出）", off + 1, min(len(loci), off + lim)), ""]
        for no, L in loci[off:off + lim]:
            b = L["r"]["_base"]
            rd = []
            for w in allw:
                x = b if w == base else L["r"].get(w)
                if x is None:
                    v = "缺"
                elif w != base and x[1] == b[1] and x[0] == b[0]:
                    v = "同"
                else:
                    v = x[0] or "（無）"
                rd.append("%s：%s" % (sig(w), v))
            ext = []
            tags = ["%s（%s）" % (TAGN.get(tg, tg), "".join(sig(w) for w in ws if w != "_base")) for tg, ws in (L.get("tags") or [])]
            if tags:
                ext.append("提示：" + "、".join(tags))
            m = marks.get(L["key"]) if marks else None
            if m:
                bits = []
                if m.get("ok") is not None:
                    who = [sig(w) for w in allw if (b if w == base else L["r"].get(w)) and (b if w == base else L["r"][w])[1] == m["ok"]]
                    bits.append("正讀＝%s" % ("".join(who) or m["ok"]))
                if m.get("star"):
                    bits.append("★ 指示性錯誤")
                if m.get("note"):
                    bits.append("備註：" + m["note"])
                if m.get("llm") or m.get("ai"):
                    bits.append("LLM：" + (m.get("llm") or m.get("ai")))
                if bits:
                    ext.append("判讀：" + "；".join(bits))
            lines.append("〔%s〕%s　%s〔%s〕%s　%s" % (no, loc_str(L["loc"], bt), L["pre"], b[0] or "‸", L["post"], "　".join(rd)))
            if ext:
                lines.append("   " + "　".join(ext))
        if off + lim < len(loci):
            lines += ["", "……還有 %d 處（offset=%d）" % (len(loci) - off - lim, off + lim)]
        return finish(lines)

    def t_shared_text(self, a):
        base, wits, bad, r = self._collation(a)
        return self._shared(base, wits, bad, r, a, lambda w: self.T(w))

    def _shared(self, base, wits, bad, r, a, T, head=None):
        allw = [base] + wits
        sig = lambda w: T(w).get("siglum", "")  # noqa: E731
        segs = []
        for g in r.get("same") or []:
            st = dict((base if k == "_base" else k, v) for k, v in g["st"].items())
            pat = "".join(st.get(w, "-") for w in allw)
            segs.append(dict(g, st=st, pat=pat, neq=pat.count("=")))

        def label(pat):
            by = {"=": [], "x": [], "-": []}
            for w, c in zip(allw, pat):
                by[c].append(sig(w))
            return "".join(by["="]) + " 同" + ("，%s 異" % "".join(by["x"]) if by["x"] else "") + ("，%s 缺" % "".join(by["-"]) if by["-"] else "")
        dist, total, solo = {}, 0, 0
        for g in segs:
            if not g["alt"]:
                total += g["n"]
            if g["neq"] < 2:
                if not g["alt"]:
                    solo += g["n"]
                continue
            d = dist.setdefault(g["pat"], [0, 0, g["alt"]])
            d[0] += g["n"]
            d[1] += 1
        lines = (head if head is not None else self._coll_head(base, wits, bad, r)) + ["", "## 同文分佈（底本對校範圍 %s 字）" % format(total, ",")]
        for pat, (n, k, alt) in sorted(dist.items(), key=lambda x: -x[1][0]):
            lines.append("- %s：%s 字，%d 段%s" % (label(pat), format(n, ","), k,
                                                "（底本讀法不同，這幾本彼此相同）" if alt else "，佔底本 %d%%" % round(100.0 * n / (total or 1))))
        lines.append("- 底本獨有（他本皆異或缺）：%s 字" % format(solo, ","))
        mn = _int(a.get("min_length"), 1, 1000, 8)
        part = a.get("only_partial", True) is not False
        lst = [g for g in segs if g["neq"] >= 2 and g["n"] >= mn and
               (not part or g["alt"] or any(g["st"].get(w) == "x" for w in allw))]
        if (a.get("sort") or "length") == "length":
            lst.sort(key=lambda g: (-g["n"], g["s"]))
        off = _int(a.get("offset"), 0, len(lst), 0)
        lim = _int(a.get("limit"), 1, 300, 60)
        ctx = _int(a.get("context"), 0, 200, 30)
        text, raw0, bt = r["text"], r["raw0"], T(base)
        lines += ["", "## 同文段落（%d 字以上%s，共 %d 段；以下第 %d–%d 段）" % (
            mn, "，不含各本皆同者" if part else "", len(lst), off + 1, min(len(lst), off + lim)),
            "【】＝同文；前後為底本上下文。「異於底本」者【】內是那幾本共有的讀法，〔底本作…〕是底本的讀法。", ""]
        for x, g in enumerate(lst[off:off + lim], off + 1):
            s0, s1 = g["rr"]["_base"][0] - raw0, g["rr"]["_base"][1] - raw0
            before = flat(text[max(0, s0 - ctx):max(0, s0)]) if ctx else ""
            after = flat(text[max(0, s1):max(0, s1) + ctx]) if ctx else ""
            if g["alt"]:
                bread = flat(text[max(0, s0):max(0, s1)])
                mid = ("〔底本作%s〕" % (bread or "‸")) + "【%s】" % g["text"]
            else:
                mid = "【%s】" % clip(flat(text[max(0, s0):max(0, s1)]), 600)
            lines.append("%d. %s　%s 字　%s%s" % (x, loc_str(g["loc"], bt), format(g["n"], ","), label(g["pat"]),
                                              "　異於底本" if g["alt"] else ""))
            lines.append("   %s%s%s" % (before, mid, after))
        if off + lim < len(lst):
            lines += ["", "……還有 %d 段（offset=%d）" % (len(lst) - off - lim, off + lim)]
        return finish(lines)

    def t_compare_strings(self, a):
        texts = [str(x) for x in (a.get("texts") or []) if str(x).strip()]
        if not 2 <= len(texts) <= 12:
            raise ToolError("請給出 2–12 段文字")
        ws = self.ws
        labels = [str(x).strip() for x in (a.get("labels") or [])]
        labels = [labels[i] if i < len(labels) and labels[i] else SIGLA[i] for i in range(len(texts))]
        s = ws.settings
        nz = ws.normalizer()
        P = [Prepared(t, nz, keep_alnum=s["keep_alnum"], skip_notes=s["skip_notes"]) for t in texts]
        short = min(len(p) for p in P)
        if short < 2:
            raise ToolError("每段至少要有兩個字")
        prm = ws.prm()
        if short < 200:                       # 短文字用最寬的錨點參數，否則找不到可對齊之處
            prm = params(dict(prm, k=2 if short < 60 else 3, min=4, dens=0.02, gap=200))
        ids = [str(i) for i in range(len(texts))]
        r = collate(P[0], ids[0], [(ids[i], P[i]) for i in range(1, len(texts))], nz, prm, parse_pairs(s["bihui"]))
        info = dict((i, {"siglum": labels[int(i)], "name": labels[int(i)]}) for i in ids)
        T = lambda w: info[w]  # noqa: E731
        wits = [i for i in ids[1:] if (r["info"].get(i) or {}).get("ok")]
        bad = [i for i in ids[1:] if i not in wits]
        head = ["比對 %d 段文字，以「%s」為底本；%s" % (len(texts), labels[0], self.settings_line())]
        for w in wits:
            i = r["info"][w]
            head.append("- %s：覆蓋底本 %d%%，相似 %d%%" % (labels[int(w)], round(i["covBase"] * 100), round(i["sim"] * 100)))
        for w in bad:
            head.append("- %s：與底本沒有可對齊的文字（可能是不同的內容），已略去" % labels[int(w)])
        if not wits:
            return finish(head)
        out = self._apparatus(ids[0], wits, [], r, dict(a, limit=400), T, {}, head=head)
        shared = self._shared(ids[0], wits, [], r, {"min_length": 2, "only_partial": True, "context": 10, "limit": 60}, T, head=[])
        return finish([out, "", shared])


# ======================================================================= JSON-RPC
def send(msg):
    sys.stdout.buffer.write(json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def handle(svc, msg):
    if not isinstance(msg, dict):
        return send({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid Request"}})
    mid, method = msg.get("id"), msg.get("method")
    if method is None:
        return
    params_ = msg.get("params") or {}
    try:
        if method == "initialize":
            pv = params_.get("protocolVersion")
            res = {"protocolVersion": pv if pv in PROTOCOLS else PROTOCOLS[0],
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": NAME, "title": TITLE, "version": VERSION},
                   "instructions": INSTRUCTIONS}
        elif method == "ping":
            res = {}
        elif method == "tools/list":
            res = {"tools": TOOLS}
        elif method == "tools/call":
            res = svc.call(params_.get("name"), params_.get("arguments") or {})
        elif method.startswith("notifications/"):
            return
        else:
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found: %s" % method}})
            return
    except Exception as e:  # noqa
        traceback.print_exc(file=sys.stderr)
        if mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)}})
        return
    if mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "result": res})


def main():
    # 與後台服務相同：讓分配器及時歸還已釋放的大塊內存
    if sys.platform == "darwin" and os.environ.get("MallocSpaceEfficient") != "1":
        env = dict(os.environ, MallocSpaceEfficient="1")
        os.execve(sys.executable, [sys.executable, "-B", os.path.abspath(__file__)] + sys.argv[1:], env)
    args = sys.argv[1:]
    data = os.environ.get("DUIKAN_DATA") or os.path.expanduser("~/Library/Application Support/DuiKan")
    cache = os.environ.get("DUIKAN_CACHE") or os.path.expanduser("~/Library/Caches/DuiKan")
    if "--data" in args[:-1]:
        data = args[args.index("--data") + 1]
    if "--cache" in args[:-1]:
        cache = args[args.index("--cache") + 1]
    svc = Service(data, cache)
    fd = sys.stdin.fileno()
    buf = b""
    while True:
        ready, _, _ = select.select([fd], [], [], 30)
        if not ready:
            svc.idle()
            continue
        chunk = os.read(fd, 1 << 16)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
            except ValueError:
                send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            for m in (msg if isinstance(msg, list) else [msg]):
                handle(svc, m)


if __name__ == "__main__":
    main()
