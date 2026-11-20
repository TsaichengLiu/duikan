# -*- coding: utf-8 -*-
"""文本預處理：字形歸一、去標點，並記住每個字在原文中的位置。

歸一是「一字對一字」的（字表沿用通檢），所以對齊時用歸一後的字串，
顯示時仍可逐字找回原文字形；原文字形不同而歸一後相同的地方另記為「字形差異」，不會丟失。
"""
import bisect
import json
import os
import re
import unicodedata
from array import array

HERE = os.path.dirname(os.path.abspath(__file__))
VARIANTS = os.path.join(HERE, "data", "variants.json")

# 逐字比對的文字：漢字（含擴展區、部首、兼容區）、々〆〇、假名、諺文
CJK_RANGES = (
    (0x2E80, 0x2FDF), (0x3005, 0x3007), (0x3021, 0x3029), (0x3040, 0x30FF),
    (0x31F0, 0x31FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
    (0xAC00, 0xD7AF), (0x20000, 0x3FFFF),
)
CJK_CLASS = "".join("%s-%s" % (re.escape(chr(a)), re.escape(chr(b))) for a, b in CJK_RANGES)
# 闕字、墨釘等佔位符：算作一個字
PLACEHOLDERS = "□■〓〼"
CONTENT_RE = re.compile("[%s%s]" % (CJK_CLASS, PLACEHOLDERS))
CONTENT_ALNUM_RE = re.compile("[%s%s0-9a-z]" % (CJK_CLASS, PLACEHOLDERS))
# 連續的「字」：按段取用，免得為每個字各建一個字串對象（整本書可省數十 MB）
CONTENT_RUN_RE = re.compile("[%s%s]+" % (CJK_CLASS, PLACEHOLDERS))
CONTENT_ALNUM_RUN_RE = re.compile("[%s%s0-9a-z]+" % (CJK_CLASS, PLACEHOLDERS))
# 括號裡的夾注（可選擇忽略）
NOTE_RE = re.compile(r"[（(〔][^（）()〔〕\n\f]{0,300}[）)〕]")
# 分句：用於排版對照表
SENT_END = set("。！？；：!?;")

LEVELS = ("exact", "st", "full")


def is_cjk(ch):
    o = ord(ch)
    for a, b in CJK_RANGES:
        if a <= o <= b:
            return True
    return False


def _base_map():
    """與字形無關的歸一：大小寫、全角 ASCII、全角空格、康熙部首與兼容漢字（多為 PDF 編碼問題）。"""
    m = {}
    for o in range(0x41, 0x5B):
        m[chr(o)] = chr(o + 32)
    for o in range(0xFF01, 0xFF5F):
        m[chr(o)] = chr(o - 0xFEE0).lower()
    m["　"] = " "
    for o in list(range(0x2F00, 0x2FD6)) + list(range(0x2E80, 0x2EF4)) + \
            list(range(0xF900, 0xFB00)) + list(range(0x2F800, 0x2FA20)):
        ch = chr(o)
        n = unicodedata.normalize("NFKC", ch)
        if len(n) == 1 and n != ch and is_cjk(n):
            m[ch] = n
    return m


_DATA = None


def _data():
    global _DATA
    if _DATA is None:
        with open(VARIANTS, encoding="utf-8") as f:
            _DATA = json.load(f)
    return _DATA


class _DSU(object):
    def __init__(self):
        self.p = {}

    def find(self, x):
        p = self.p
        p.setdefault(x, x)
        r = x
        while p[r] != r:
            r = p[r]
        while p[x] != r:
            p[x], x = r, p[x]
        return r

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if (ord(rb) > 0xFFFF, ord(rb)) < (ord(ra) > 0xFFFF, ord(ra)):
                ra, rb = rb, ra
            self.p[rb] = ra


def parse_groups(text):
    """每行一組，行內所有漢字視為同一字。# 之後為註釋。"""
    groups = []
    for line in (text or "").splitlines():
        line = line.split("#", 1)[0]
        chars = [c for c in line if is_cjk(c)]
        if len(set(chars)) >= 2:
            groups.append(chars)
    return groups


def parse_pairs(text):
    """避諱表：每行「本字 改字……」，返回無序字對集合。"""
    pairs = set()
    for g in parse_groups(text):
        for c in g[1:]:
            pairs.add((g[0], c))
            pairs.add((c, g[0]))
    return pairs


def _with_groups(m, groups):
    d = _DSU()
    for ch, rep in m.items():
        d.union(rep, ch)
    for g in groups:
        for c in g[1:]:
            d.union(g[0], c)
    out = {}
    for ch in list(d.p):
        r = d.find(ch)
        if r != ch:
            out[ch] = r
    return out


class Normalizer(object):
    """level：exact 精確（只統一全半角、大小寫）、st 簡繁、full 異體。custom：自定義「視同」字組。"""

    def __init__(self, level="full", custom=""):
        if level not in LEVELS:
            level = "full"
        data = _data()
        base = _base_map()
        st = dict(base)
        st.update(data["st"])
        full = dict(base)
        full.update(data["full"])
        self.level = level
        self.base, self.st, self.full = base, st, full
        m = {"exact": base, "st": st, "full": full}[level]
        groups = parse_groups(custom)
        if groups:
            merged = dict(base)
            merged.update(_with_groups(m, groups))
            m = merged
        self.map = m
        self.table = str.maketrans(m)
        self.base_table = str.maketrans(base)

    def norm(self, s):
        return s.translate(self.table)

    def kind(self, a, b):
        """兩個原文字形不同、歸一後相同的字屬於哪類：st 繁簡、full 異體、custom 視同。"""
        if self.st.get(a, a) == self.st.get(b, b):
            return "st"
        if self.full.get(a, a) == self.full.get(b, b):
            return "full"
        return "custom"


_HEAD_STRIP = re.compile(r"[\s0-9０-９\.．·•\-—–_/|｜第頁页]+")


def running_heads(raw):
    """PDF 的頁眉頁腳：每頁首尾兩行中，去掉數字後在三頁以上（且不少於總頁數 2%）重複出現的行。
    返回這些行在原文中的範圍 [(起, 止)]。"""
    pages = raw.split("\f")
    n = len(pages)
    if n < 3:
        return []
    cand = []
    cnt = {}
    off = 0
    for pg in pages:
        lines = []
        p = 0
        for ln in pg.split("\n"):
            if ln.strip():
                lines.append((off + p, off + p + len(ln), ln))
            p += len(ln) + 1
        seen = set()
        for s, e, ln in lines[:2] + lines[-2:]:
            if s in seen:
                continue
            seen.add(s)
            key = _HEAD_STRIP.sub("", ln)
            if 0 < len(key) <= 40:
                cand.append((s, e, key))
                cnt[key] = cnt.get(key, 0) + 1
        off += len(pg) + 1
    need = max(3, int(n * 0.02))
    return [(s, e) for s, e, k in cand if cnt[k] >= need]


def _mask(s, ranges, ch):
    """把 s 中若干範圍換成同樣長度的 ch（按段拼接，不逐字拆開）。"""
    out, last = [], 0
    for a, b in sorted(ranges):
        if a < last:
            a = last
        if b <= a:
            continue
        out.append(s[last:a])
        out.append(ch * (b - a))
        last = b
    out.append(s[last:])
    return "".join(out)


class Prepared(object):
    """一個文本歸一後的形態。

    raw   原文（PDF 頁與頁之間是 \\f）
    norm  歸一並去掉標點、空白後的字串（只含「字」）
    pos   norm[i] 在 raw 中的位置
    gl    norm[i] 對應的原文字形（只做全半角、大小寫統一），與 norm 等長
    """

    def __init__(self, raw, nz, keep_alnum=False, skip_notes=False, page_base=1, paged=False,
                 skip_heads=False):
        self.page_base = page_base
        self.paged = paged
        self.nheads = 0
        mapped = raw.translate(nz.table)
        if skip_notes:
            mapped = NOTE_RE.sub(lambda m: "\x00" * len(m.group()), mapped)
        if skip_heads and paged:
            heads = running_heads(raw)
            if heads:
                # 頁眉不參與比對；顯示時也略去（換成 \x01，長度不變，位置不亂）
                mapped = _mask(mapped, heads, "\x00")
                raw = _mask(raw, heads, "\x01")
                self.nheads = len(heads)
        self.raw = raw
        rx = CONTENT_ALNUM_RUN_RE if keep_alnum else CONTENT_RUN_RE
        graw = raw.translate(nz.base_table)
        pos = array("i")
        nparts, gparts = [], []
        for m in rx.finditer(mapped):
            a, b = m.span()
            pos.extend(range(a, b))
            nparts.append(m.group())
            gparts.append(graw[a:b])
        graw = None
        self.pos = pos
        self.norm = "".join(nparts)
        self.gl = "".join(gparts)
        self.page_starts = [0] + [m.end() for m in re.finditer("\f", raw)]
        self.line_starts = [0] + [m.end() for m in re.finditer("[\n\f]", raw)]
        self.lo = 0
        self.hi = len(self.norm)

    # ---- 範圍 ----
    def find(self, nz, needle, start=0, keep_alnum=False):
        """在歸一字串中找一段文字（同樣歸一、去標點），返回下標或 -1。"""
        rx = CONTENT_ALNUM_RE if keep_alnum else CONTENT_RE
        n = "".join(rx.findall(nz.norm(needle)))
        if not n:
            return -1, 0
        return self.norm.find(n, start), len(n)

    def restrict(self, lo, hi):
        """只取 norm[lo:hi]（原文與位置表不變，頁碼行碼因此保持原樣）。"""
        v = Prepared.__new__(Prepared)
        v.__dict__.update(self.__dict__)
        v.norm = self.norm[lo:hi]
        v.gl = self.gl[lo:hi]
        v.pos = self.pos[lo:hi]
        v.lo, v.hi = self.lo + lo, self.lo + hi
        return v

    def __len__(self):
        return len(self.norm)

    # ---- 位置 ----
    def raw_at(self, i):
        """norm 下標 i 在原文中的起點；i == len 時為最後一字之後（含緊隨其後的標點）。"""
        if i < len(self.pos):
            return self.pos[i]
        if not self.pos:
            return 0
        e = self.pos[-1] + 1
        raw = self.raw
        while e < len(raw) and raw[e] not in "\n\f" and not CONTENT_RE.match(raw[e]) \
                and e - self.pos[-1] < 4:
            e += 1
        return e

    def loc(self, i):
        """norm 下標 → (頁, 行)。非分頁文本頁為 None。"""
        if not self.pos:
            return [None, 1]
        o = self.pos[min(max(i, 0), len(self.pos) - 1)]
        li = bisect.bisect_right(self.line_starts, o) - 1
        if self.paged:
            pi = bisect.bisect_right(self.page_starts, o) - 1
            first = bisect.bisect_left(self.line_starts, self.page_starts[pi])
            return [self.page_base + pi, li - first + 1]
        return [None, li + 1]

    def page_at(self, o):
        """原文偏移 → 頁碼（非分頁文本為 None）。"""
        if not self.paged:
            return None
        return self.page_base + bisect.bisect_right(self.page_starts, o) - 1

    def glyphs(self, s, e):
        """原文字形（不含標點）。"""
        raw, pos = self.raw, self.pos
        return "".join(raw[pos[i]] for i in range(max(s, 0), min(e, len(pos))))

    def breaks(self, s, e):
        """[s, e) 內哪些位置之前有句末標點或分段（用於分行排版）。"""
        out = []
        raw, pos = self.raw, self.pos
        for i in range(max(s, 1), min(e, len(pos))):
            seg = raw[pos[i - 1] + 1:pos[i]]
            if seg and (any(c in SENT_END for c in seg) or "\n\n" in seg or "\f" in seg):
                out.append(i)
        return out


def slice_pages(raw, spec):
    """頁碼範圍「12-30」「12-」「-30」「12」→ (子文本, 起始頁)。"""
    spec = (spec or "").strip().replace("－", "-").replace("—", "-").replace("–", "-").replace("~", "-")
    if not spec:
        return raw, 1
    m = re.match(r"^(\d*)\s*-\s*(\d*)$", spec) or re.match(r"^(\d+)$", spec)
    if not m:
        raise ValueError("頁碼範圍的格式應為「12-30」")
    pages = raw.split("\f")
    if m.re.groups == 1:
        a = b = int(m.group(1))
    else:
        a = int(m.group(1)) if m.group(1) else 1
        b = int(m.group(2)) if m.group(2) else len(pages)
    a = max(1, a)
    b = min(len(pages), b)
    if a > b:
        raise ValueError("頁碼範圍超出文件頁數（共 %d 頁）" % len(pages))
    return "\f".join(pages[a - 1:b]), a
