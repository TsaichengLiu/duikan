# -*- coding: utf-8 -*-
"""原文預覽（上下文對齊）與句段檢索。都是確定性的字串運算。

context_windows  幾個文本各取一段上下文，與第一本逐字對齊，標出相同的文字
find_phrase      在文本中找一句話的近似出現處（容許異文、脫衍；簡繁異體、標點已先歸一）
"""
import bisect

from dk_align import align, best_chain, find_runs
from dk_compare import _tail, raw_range


# ================================================================ 原文預覽
def _window(P, r0, r1, pad):
    """原文 [r0, r1) 前後各擴 pad 字（按「字」計，不計標點）→ (norm lo, hi, 原文 w0, w1)。"""
    n = len(P.pos)
    if not n:
        return 0, 0, 0, len(P.raw)
    a = bisect.bisect_left(P.pos, r0)
    b = bisect.bisect_left(P.pos, r1)
    lo = max(0, a - pad)
    hi = min(n, max(b, a) + pad)
    w0 = P.pos[lo] if lo < n else len(P.raw)
    # 往前帶上本行開頭（不跨行、最多 30 字），讀起來完整些
    k = w0
    while k > 0 and P.raw[k - 1] not in "\n\f" and w0 - k < 30 and lo == 0:
        k -= 1
    w0 = k
    w1 = _tail(P, hi - 1) if hi > 0 else w0
    return lo, hi, w0, max(w1, r1)


def _ranges(P, idxs, w0):
    """一組 norm 下標 → 原文相對範圍（相鄰的字連成一段，中間的標點一併算入）。"""
    out = []
    for i in sorted(idxs):
        a, b = P.pos[i] - w0, P.pos[i] + 1 - w0
        if out and i == out[-1][2] + 1:
            out[-1][1] = b
            out[-1][2] = i
        else:
            out.append([a, b, i])
    return [[a, b] for a, b, _ in out]


def _pair_ops(A, alo, ahi, B, blo, bhi):
    sa, sb = A.norm[alo:ahi], B.norm[blo:bhi]
    runs = find_runs(sa, sb, 3, maxfreq=0) if min(len(sa), len(sb)) >= 3 else []
    chain = [(i + alo, j + blo, L) for i, j, L in best_chain(runs)]
    return align(A.norm, B.norm, alo, ahi, blo, bhi, chain)


def context_windows(items, pad):
    """items：[(P, r0, r1)]，第一個為參照。返回每本的上下文、焦點、與參照相同的範圍。"""
    wins = [_window(P, r0, r1, pad) for P, r0, r1 in items]
    P0, (alo, ahi, _, _) = items[0][0], wins[0]
    base_same = None
    sames = [None] * len(items)
    opsx = [None] * len(items)
    for x in range(1, len(items)):
        P, (blo, bhi, w0, _) = items[x][0], wins[x]
        ops = _pair_ops(P0, alo, ahi, P, blo, bhi)
        opsx[x] = [[t, a0 - alo, a1 - alo, b0 - blo, b1 - blo] for t, a0, a1, b0, b1 in ops]
        a_eq, b_eq = set(), set()
        for tag, a0, a1, b0, b1 in ops:
            if tag == "=":
                a_eq.update(range(a0, a1))
                b_eq.update(range(b0, b1))
        sames[x] = _ranges(P, b_eq, w0)
        base_same = a_eq if base_same is None else (base_same & a_eq)
    if len(items) > 1:
        sames[0] = _ranges(P0, base_same or set(), wins[0][2])
    out = []
    for x, ((P, r0, r1), (lo, hi, w0, w1), same) in enumerate(zip(items, wins, sames)):
        o = {"text": P.raw[w0:w1], "w0": w0, "focus": [r0 - w0, r1 - w0], "same": same or [],
             "page0": P.page_at(w0), "paged": P.paged, "loc": P.loc(bisect.bisect_left(P.pos, r0)),
             # 供各欄互相對應：窗口內每個字（不計標點）在原文片段中的位置；與參照的對齊塊（窗口內的字序）
             "npos": [P.pos[i] - w0 for i in range(lo, hi)]}
        if opsx[x] is not None:
            o["ops"] = opsx[x]
        out.append(o)
    return out


# ================================================================ 句段檢索
def _myers_ends(q, t, maxd):
    """Myers 位向量近似匹配：q 全部、t 中任意一段，返回編輯距離 ≤ maxd 的局部最優結束位置 [(j, d)]。"""
    m = len(q)
    full = (1 << m) - 1
    hb = 1 << (m - 1)
    peq = {}
    for i, c in enumerate(q):
        peq[c] = peq.get(c, 0) | (1 << i)
    Pv, Mv, score = full, 0, m
    found = []
    for j, c in enumerate(t):
        Eq = peq.get(c, 0)
        Xv = Eq | Mv
        Xh = ((((Eq & Pv) + Pv) & full) ^ Pv) | Eq
        Ph = Mv | (~(Xh | Pv) & full)
        Mh = Pv & Xh
        if Ph & hb:
            score += 1
        elif Mh & hb:
            score -= 1
        Ph = (Ph << 1) & full
        Mh = (Mh << 1) & full
        Pv = Mh | (~(Xv | Ph) & full)
        Mv = Ph & Xv
        if score <= maxd:
            found.append((j, score))
    # 相近的結束位置屬同一處：每處取距離最小者（同分取最早）
    best = []
    gap = max(2, m // 2)
    for j, d in found:
        if best and j - best[-1][2] <= gap:
            if d < best[-1][1]:
                best[-1][0], best[-1][1] = j, d
            best[-1][2] = j
        else:
            best.append([j, d, j])
    return [(j, d) for j, d, _ in best]


def _start_of(q, t, end, d):
    """已知 q 在 t 中以 end 結尾、距離 d，用小範圍動態規劃找起點。"""
    m = len(q)
    s0 = max(0, end + 1 - m - d)
    seg = t[s0:end + 1]
    n = len(seg)
    # 反向：q 倒序與 seg 倒序做全局-半全局對齊（seg 的起點自由）
    # 同樣距離的起點有好幾個時（如「天亡我何渡為」對「天之亡我我何渡為」），取對上的字最多的，
    # 再同時取最短的——不把檢索句開頭的字當作脫文。距離與相同字數都沿路徑相加，逐格按此次序取優即可。
    qr, sr = q[::-1], seg[::-1]
    prev = list(range(m + 1))
    prevm = [0] * (m + 1)
    best_j, best_v, best_m = 0, prev[m], 0
    for j in range(1, n + 1):
        cur = [j] + [0] * m
        curm = [0] * (m + 1)
        cj = sr[j - 1]
        for i in range(1, m + 1):
            eq = qr[i - 1] == cj
            c, cm = prev[i - 1] + (0 if eq else 1), prevm[i - 1] + (1 if eq else 0)
            if prev[i] + 1 < c or (prev[i] + 1 == c and prevm[i] > cm):
                c, cm = prev[i] + 1, prevm[i]
            if cur[i - 1] + 1 < c or (cur[i - 1] + 1 == c and curm[i - 1] > cm):
                c, cm = cur[i - 1] + 1, curm[i - 1]
            cur[i], curm[i] = c, cm
        if cur[m] < best_v or (cur[m] == best_v and curm[m] > best_m):
            best_v, best_j, best_m = cur[m], j, curm[m]
        prev, prevm = cur, curm
    return end + 1 - best_j


def find_phrase(P, q, min_sim=0.6, max_hits=12):
    """返回 [(s, e, d)]：P.norm[s:e] 與 q 的編輯距離 d，相似度 1 - d/len(q) ≥ min_sim。"""
    m = len(q)
    T = P.norm
    if not m or not T:
        return []
    maxd = int(m * (1 - min_sim))
    k = 1 if m <= 4 else (2 if m < 16 else 3)
    band = max(8, m // 3)
    votes = {}
    for qi in range(0, m - k + 1):
        g = q[qi:qi + k]
        j = T.find(g)
        hits = 0
        while j >= 0 and hits < 20000:
            key = (j - qi) // band
            votes[key] = votes.get(key, 0) + 1
            hits += 1
            j = T.find(g, j + 1)
    need = max(1, int((m - k + 1) * min_sim * 0.5))
    cands = sorted([b for b, v in votes.items() if v >= need], key=lambda b: -votes[b])[:200]
    if not cands:
        return []
    # 相鄰候選合併成窗口
    spans = []
    for b in sorted(cands):
        s = max(0, b * band - maxd - band)
        e = min(len(T), b * band + band + m + maxd + band)
        if spans and s <= spans[-1][1]:
            spans[-1][1] = max(spans[-1][1], e)
        else:
            spans.append([s, e])
    hits = []
    for s, e in spans:
        for j, d in _myers_ends(q, T[s:e], maxd):
            end = s + j
            st = _start_of(q, T, end, d)
            hits.append((st, end + 1, d))
    hits.sort(key=lambda h: (h[2], h[0]))
    out = []
    for h in hits:
        if all(h[1] <= o[0] or h[0] >= o[1] for o in out):
            out.append(h)
        if len(out) >= max_hits:
            break
    out.sort()
    return out


def extend(P, s, e, mode, n):
    """把命中範圍擴展為要對校的片段：sent 到前後句末標點（至多 n 字），chars 前後各 n 字。"""
    L = len(P)
    if mode == "sent":
        brk = P.breaks(max(0, s - n), min(L, e + n) + 1)
        before = [b for b in brk if b <= s]
        after = [b for b in brk if b >= e]
        s2 = before[-1] if before else max(0, s - n)
        e2 = after[0] if after else min(L, e + n)
        return s2, e2
    return max(0, s - n), min(L, e + n)


def phrase_hits(P, q, min_sim, ctx_mode, ctx_n, max_hits=12):
    """命中 + 片段範圍 + 預覽用的上下文（命中處與檢索句相同的字標出）。"""
    res = []
    for s, e, d in find_phrase(P, q, min_sim, max_hits):
        xs, xe = extend(P, s, e, ctx_mode, ctx_n)
        # 檢索句與命中處逐字對齊，標出相同的字
        same = set()
        sub = _qa_ops(q, P.norm[s:e])
        for tag, a0, a1, b0, b1 in sub:
            if tag == "=":
                same.update(range(s + b0, s + b1))
        r0, r1 = raw_range(P, xs, xe)
        f0, f1 = raw_range(P, s, e)
        res.append({"s": s, "e": e, "xs": xs, "xe": xe, "d": d, "sim": round(1 - d / float(len(q)), 3),
                    "loc": P.loc(s), "r0": r0, "r1": r1, "text": P.raw[r0:r1],
                    "focus": [f0 - r0, f1 - r0], "same": _ranges(P, same, r0),
                    "glyphs": P.glyphs(s, e), "page0": P.page_at(r0), "paged": P.paged})
    return res


def _qa_ops(a, b):
    from dk_align import _dp, _merge
    if not a or not b:
        return []
    if len(a) * len(b) <= 90000:
        return _merge(_dp(a, b, 0, len(a), 0, len(b)))
    runs = find_runs(a, b, 2, maxfreq=0)
    return align(a, b, 0, len(a), 0, len(b), best_chain(runs))


class _Win(object):
    """把一段歸一字串包成 find_phrase 能用的樣子。"""
    def __init__(self, norm):
        self.norm = norm


def fit_segment(qnorm, P, lo, hi):
    """在 P 的 [lo, hi) 附近找與參照片段 qnorm 最相應的一段（範圍以參照為準，免得各本截取長短不一）。"""
    L = len(qnorm)
    if L < 4:
        return lo, hi
    w0 = max(0, lo - L)
    w1 = min(len(P), hi + L)
    best = None
    for sim in (0.5, 0.3, 0.15):
        hits = find_phrase(_Win(P.norm[w0:w1]), qnorm, sim, 3)
        if hits:
            best = min(hits, key=lambda h: h[2])
            break
    if not best:
        return lo, hi
    return w0 + best[0], w0 + best[1]
