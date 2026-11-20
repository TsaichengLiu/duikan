# -*- coding: utf-8 -*-
"""對齊：全是確定性的字串運算，不做任何「判斷」。

1. find_runs      兩個歸一字串之間長度 ≥ k 的完全相同片段（沿對角線取極大）
2. chain_passages 把同一走向、間隔不大的片段串成「平行段落」（可處理移位、節錄、增補）
3. best_chain     在所有片段中取一條兩邊順序都一致、總長最大的鏈（用於同一文本不同版本的通校）
4. align          以鏈上片段為錨點，錨點之間用更短的片段或編輯距離逐字對齊，得出「同／異」序列

ops 的格式：[tag, a0, a1, b0, b1]，tag 為 "=" 相同、"~" 有異（a0 == a1 為 B 多出，b0 == b1 為 B 缺）。
"""
import bisect

DPMAX = 40000          # 逐字動態規劃的最大格數（約 200×200 字）


# ---------------------------------------------------------------- 片段
def find_runs(A, B, k, maxfreq=30):
    """返回 [(i, j, L)]：A[i:i+L] == B[j:j+L]，L ≥ k，按 i 排序。

    在兩本中出現都超過 maxfreq 次的 k 字串（套語）不作種子，免得組合爆炸；它們之後由逐字對齊補回。
    索引以 k 字串的哈希值（整數）為鍵，不保留字串本身：整本書的峰值內存因此少一大半；
    每段的起點再核對一次原字，排除哈希碰撞。
    """
    nA, nB = len(A), len(B)
    if nA < k or nB < k:
        return []
    swap = nB > nA
    if swap:                       # 給較短的一本建索引
        A, B, nA, nB = B, A, nB, nA
    h = hash
    idx = {}
    get = idx.get
    for j in range(nB - k + 1):
        g = h(B[j:j + k])
        v = get(g)
        if v is None:
            idx[g] = j
        elif v.__class__ is int:
            idx[g] = [v, j]
        else:
            v.append(j)
    if maxfreq:
        for g in [g for g, v in idx.items() if v.__class__ is list and len(v) > maxfreq]:
            del idx[g]
        cnt = {}
        cget = cnt.get
        for i in range(nA - k + 1):
            g = h(A[i:i + k])
            if g in idx:
                cnt[g] = cget(g, 0) + 1
        for g, c in cnt.items():
            if c > maxfreq:
                del idx[g]
        cnt = None
    runs = []
    active = {}                    # 對角線 d = j - i → [起點 i, 最後一個 i]
    for i in range(nA - k + 1):
        v = get(h(A[i:i + k]))
        if v is None:
            continue
        if v.__class__ is int:
            v = (v,)
        for j in v:
            d = j - i
            r = active.get(d)
            if r is not None and r[1] == i - 1:
                r[1] = i
            else:
                if A[i:i + k] != B[j:j + k]:      # 哈希碰撞
                    continue
                if r is not None:
                    runs.append((r[0], r[0] + d, r[1] - r[0] + k))
                active[d] = [i, i]
        if len(active) > 256 and not (i & 127):
            for d in [d for d, r in active.items() if r[1] < i]:
                r = active.pop(d)
                runs.append((r[0], r[0] + d, r[1] - r[0] + k))
    for d, r in active.items():
        runs.append((r[0], r[0] + d, r[1] - r[0] + k))
    idx = None
    if swap:
        runs = [(j, i, L) for i, j, L in runs]
    runs.sort()
    return runs


# ---------------------------------------------------------------- 平行段落
class Passage(object):
    __slots__ = ("a0", "a1", "b0", "b1", "matched", "runs")

    def __init__(self, i, j, L):
        self.a0, self.a1, self.b0, self.b1 = i, i + L, j, j + L
        self.matched = L
        self.runs = [(i, j, L)]

    def add(self, i, j, L):
        s = max(self.a1 - i, self.b1 - j, 0)
        if s >= L:
            return
        i, j, L = i + s, j + s, L - s
        self.runs.append((i, j, L))
        self.a1, self.b1 = i + L, j + L
        self.matched += L


def chain_passages(runs, gap):
    """把片段串成平行段落：兩邊都向前、空隙都不超過 gap 字的片段歸入同一段。"""
    done, active = [], []
    for (i, j, L) in runs:
        if active:
            keep = []
            for c in active:
                (done if c.a1 < i - gap else keep).append(c)
            active = keep
        best, bestd = None, None
        for c in active:
            da, db = i - c.a1, j - c.b1
            if da > gap or db > gap or da < -L or db < -L:
                continue
            if max(-da, -db, 0) >= L:
                continue
            dist = abs(da - db) + max(da, db, 0)
            if best is None or dist < bestd:
                best, bestd = c, dist
        if best is not None:
            best.add(i, j, L)
        else:
            active.append(Passage(i, j, L))
    done.extend(active)
    done.sort(key=lambda c: (c.a0, c.b0))
    return done


# ---------------------------------------------------------------- 最佳單鏈
def best_chain(runs):
    """兩邊都嚴格遞增、互不重疊、總長最大的片段鏈（加權最長遞增子序列，O(n log n)）。"""
    n = len(runs)
    if not n:
        return []
    by_start = sorted(range(n), key=lambda r: runs[r][0])
    by_end = sorted(range(n), key=lambda r: runs[r][0] + runs[r][2])
    ends = sorted(set(r[1] + r[2] for r in runs))
    m = len(ends)
    tv = [0] * (m + 1)
    tr = [-1] * (m + 1)
    dp = [0] * n
    prev = [-1] * n
    pi = 0
    for r in by_start:
        i, j, L = runs[r]
        while pi < n:
            q = by_end[pi]
            qi, qj, qL = runs[q]
            if qi + qL > i:
                break
            p = bisect.bisect_left(ends, qj + qL) + 1
            v = dp[q]
            while p <= m:
                if v > tv[p]:
                    tv[p], tr[p] = v, q
                p += p & -p
            pi += 1
        p = bisect.bisect_right(ends, j)
        best, br = 0, -1
        while p > 0:
            if tv[p] > best:
                best, br = tv[p], tr[p]
            p -= p & -p
        dp[r] = best + L
        prev[r] = br
    r = max(range(n), key=dp.__getitem__)
    out = []
    while r != -1:
        out.append(runs[r])
        r = prev[r]
    out.reverse()
    return out


# ---------------------------------------------------------------- 逐字對齊
def _dp(A, B, a0, a1, b0, b1):
    """編輯距離（替換、增、刪各計 1）逐字對齊，返回字級 ops。"""
    sa, sb = A[a0:a1], B[b0:b1]
    la, lb = len(sa), len(sb)
    W = lb + 1
    tr = bytearray((la + 1) * W)       # 0 斜（同或替換）1 上（A 多）2 左（B 多）
    for j in range(1, W):
        tr[j] = 2
    # 同樣的編輯距離有幾種走法時，取對上相同字最多的（如「曰天之亡」對「曰乃天亡」：
    # 取「乃」增、「天」同、「之」脫，而不是「天之」逐字替換成「乃天」）；仍相同時斜走優先。
    # 距離與相同字數都沿路徑相加，逐格按此次序取優，整體也是最優。
    prev = list(range(W))
    pm = [0] * W
    for i in range(1, la + 1):
        ca = sa[i - 1]
        cur = [i] + [0] * lb
        cm = [0] * W
        row = i * W
        tr[row] = 1
        for j in range(1, W):
            eq = ca == sb[j - 1]
            d, dm = prev[j - 1] + (0 if eq else 1), pm[j - 1] + (1 if eq else 0)
            u, um = prev[j] + 1, pm[j]
            l, lm = cur[j - 1] + 1, cm[j - 1]
            if (d < u or (d == u and dm >= um)) and (d < l or (d == l and dm >= lm)):
                cur[j], cm[j] = d, dm
            elif u < l or (u == l and um >= lm):
                cur[j], cm[j] = u, um
                tr[row + j] = 1
            else:
                cur[j], cm[j] = l, lm
                tr[row + j] = 2
        prev, pm = cur, cm
    out = []
    i, j = la, lb
    while i > 0 or j > 0:
        t = tr[i * W + j]
        if t == 0:
            i -= 1
            j -= 1
            tag = "=" if sa[i] == sb[j] else "~"
            out.append([tag, a0 + i, a0 + i + 1, b0 + j, b0 + j + 1])
        elif t == 1:
            i -= 1
            out.append(["~", a0 + i, a0 + i + 1, b0 + j, b0 + j])
        else:
            j -= 1
            out.append(["~", a0 + i, a0 + i, b0 + j, b0 + j + 1])
    out.reverse()
    return out


def _fill(A, B, a0, a1, b0, b1, out, levels):
    la, lb = a1 - a0, b1 - b0
    if la <= 0 and lb <= 0:
        return
    if la <= 0 or lb <= 0:
        out.append(["~", a0, a1, b0, b1])
        return
    if la * lb <= DPMAX:
        out.extend(_dp(A, B, a0, a1, b0, b1))
        return
    if levels:
        k = levels[0]
        runs = find_runs(A[a0:a1], B[b0:b1], k, maxfreq=0)
        chain = best_chain(runs)
        if chain:
            _walk(A, B, a0, a1, b0, b1, [(i + a0, j + b0, L) for i, j, L in chain], out, levels[1:])
            return
    out.append(["~", a0, a1, b0, b1])


def _walk(A, B, a0, a1, b0, b1, anchors, out, levels):
    pa, pb = a0, b0
    for (i, j, L) in anchors:
        s = max(pa - i, pb - j, 0)
        if s >= L:
            continue
        i, j, L = i + s, j + s, L - s
        if i + L > a1 or j + L > b1:
            break
        _fill(A, B, pa, i, pb, j, out, levels)
        out.append(["=", i, i + L, j, j + L])
        pa, pb = i + L, j + L
    _fill(A, B, pa, a1, pb, b1, out, levels)


def _merge(ops):
    out = []
    for op in ops:
        if op[1] == op[2] and op[3] == op[4]:
            continue
        if out and out[-1][0] == op[0] and out[-1][2] == op[1] and out[-1][4] == op[3]:
            out[-1][2], out[-1][4] = op[2], op[4]
        else:
            out.append(list(op))
    return out


def _cleanup(ops):
    """夾在兩段較大差異之間的一兩個偶合相同的字，併入差異（免得改寫段落被切成碎片）。"""
    changed = True
    while changed:
        changed = False
        for x in range(1, len(ops) - 1):
            e, p, q = ops[x], ops[x - 1], ops[x + 1]
            if e[0] != "=" or p[0] != "~" or q[0] != "~":
                continue
            L = e[2] - e[1]
            sp = max(p[2] - p[1], p[4] - p[3])
            sq = max(q[2] - q[1], q[4] - q[3])
            if L <= 2 and 2 * L < min(sp, sq):
                ops[x - 1:x + 2] = [["~", p[1], q[2], p[3], q[4]]]
                changed = True
                break
    return ops


def align(A, B, a0, a1, b0, b1, anchors, levels=(3, 2)):
    out = []
    _walk(A, B, a0, a1, b0, b1, anchors, out, levels)
    return _cleanup(_merge(out))


# ---------------------------------------------------------------- 參數
# k：種子長度；gap：同一段落內允許的最大空隙；min：段落至少要有多少字完全相同；
# dens：段內完全相同的字至少佔多少；maxfreq：在兩本中都出現超過此數的 k 字串不作種子
# 預設檔位，由「成段抄錄」到「短到幾個字的同文」。後三檔找短的同文：種子短、段落下限低，
# 段內空隙收緊、相同比例提高（免得把零散的巧合連成一段），套語上限收緊（在兩本中都反覆出現的
# 官銜、人名套語不作線索，只出現一兩次的片語不受影響）。實測：兩條幾百字的史料用「短句」「片語」
# 能找出十字、六字的同文；整書比對時「片語」約數百段、多為人名與任命，「詞語」雜訊較多。
PRESETS = {
    "strict": {"k": 6, "gap": 40, "min": 40, "dens": 0.3, "maxfreq": 20},
    "normal": {"k": 5, "gap": 80, "min": 24, "dens": 0.2, "maxfreq": 30},
    "loose": {"k": 4, "gap": 160, "min": 14, "dens": 0.12, "maxfreq": 60},
    "sentence": {"k": 4, "gap": 24, "min": 10, "dens": 0.3, "maxfreq": 12},
    "phrase": {"k": 3, "gap": 16, "min": 6, "dens": 0.35, "maxfreq": 8},
    "word": {"k": 3, "gap": 8, "min": 4, "dens": 0.4, "maxfreq": 3},
}
LIMITS = {"k": (2, 12, int), "gap": (5, 1000, int), "min": (4, 1000, int),
          "dens": (0.02, 0.9, float), "maxfreq": (2, 500, int)}


def params(src=None):
    """從設定（或預設名稱）得出一組合法的參數。"""
    if isinstance(src, str) or src is None:
        return dict(PRESETS.get(src) or PRESETS["normal"])
    out = dict(PRESETS["normal"])
    for key, (lo, hi, typ) in LIMITS.items():
        try:
            v = typ(src.get(key, out[key]))
        except (TypeError, ValueError):
            continue
        out[key] = min(hi, max(lo, v))
    return out


def preset_of(prm):
    for name, p in PRESETS.items():
        if all(abs(prm[k] - p[k]) < 1e-9 for k in p):
            return name
    return None


def _shadowed(ps):
    """兩邊都已落在強得多的段落之內的短段：多是書中套語、重出文字造成的交叉匹配，不是另一處平行文字。"""
    order = sorted(range(len(ps)), key=lambda x: -ps[x].matched)
    keep = []
    for x in order:
        p = ps[x]
        big = [q for q in keep if q.matched >= 3 * p.matched]
        in_a = any(q.a0 <= p.a0 and p.a1 <= q.a1 for q in big)
        in_b = any(q.b0 <= p.b0 and p.b1 <= q.b1 for q in big)
        if not (in_a and in_b):
            keep.append(p)
    keep.sort(key=lambda c: (c.a0, c.b0))
    return keep


def seeds(A, B, prm):
    return find_runs(A, B, prm["k"], prm["maxfreq"])


def passages(A, B, prm, runs=None):
    """runs 可以傳入已算好的種子（只改 gap/min/dens 時不必重算，拖動滑桿即時更新）。"""
    if runs is None:
        runs = seeds(A, B, prm)
    ps = [p for p in chain_passages(runs, prm["gap"])
          if p.matched >= prm["min"] and p.matched >= prm["dens"] * max(p.a1 - p.a0, p.b1 - p.b0)]
    return runs, _shadowed(ps)


def global_anchors(A, B, prm, ext=40, runs=None):
    """通校用：兩本之間順序一致的最佳錨點鏈及其覆蓋範圍（首尾差異不長時延伸到兩端）。"""
    runs, ps = passages(A, B, prm, runs)
    pool = [r for p in ps for r in p.runs]
    pool.sort()
    chain = best_chain(pool)
    if not chain:
        return [], None
    a0, b0 = chain[0][0], chain[0][1]
    a1, b1 = chain[-1][0] + chain[-1][2], chain[-1][1] + chain[-1][2]
    if a0 <= ext and b0 <= ext:
        a0, b0 = 0, 0
    if len(A) - a1 <= ext and len(B) - b1 <= ext:
        a1, b1 = len(A), len(B)
    return chain, (a0, a1, b0, b1)


def lis_flags(seq):
    """seq 中屬於最長遞增子序列的位置標 True（用來找出次序與另一本不同的段落）。"""
    n = len(seq)
    if not n:
        return []
    tails, tails_i, prev = [], [], [-1] * n
    for x, v in enumerate(seq):
        p = bisect.bisect_left(tails, v)
        if p == len(tails):
            tails.append(v)
            tails_i.append(x)
        else:
            tails[p] = v
            tails_i[p] = x
        prev[x] = tails_i[p - 1] if p else -1
    flags = [False] * n
    x = tails_i[-1]
    while x != -1:
        flags[x] = True
        x = prev[x]
    return flags
