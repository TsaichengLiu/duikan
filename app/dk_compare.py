# -*- coding: utf-8 -*-
"""兩本對讀（平行段落 + 對照表）與多本對校（異文、校記、分組統計所需數據）。

這裡只產生確定性的結果：哪裡相同、哪裡不同、各本讀作什麼、哪些本子讀法一致。
異文的性質、正誤、是否為「共同錯誤」都留給使用者（或 AI）判斷。
"""
import bisect

from dk_align import align, global_anchors, lis_flags, passages


# ================================================================ 公用
def _tail(P, i):
    """第 i 字之後、下一字之前的標點（不跨行），用於片段結尾。"""
    raw = P.raw
    e = P.pos[i] + 1
    lim = P.pos[i + 1] if i + 1 < len(P.pos) else len(raw)
    while e < lim and raw[e] not in "\n\f" and e - P.pos[i] < 4:
        e += 1
    return e


def _rawspan(P, s, e, region_end):
    """原文中第 s 字到第 e 字之前（含其間的標點、換行、分頁）。"""
    if s >= e:
        return ""
    a = P.pos[s]
    if e >= region_end or e >= len(P.pos):
        b = _tail(P, e - 1)
    else:
        b = P.pos[e]
    return P.raw[a:b]


def _gmarks(A, B, a0, a1, b0, b1, nz, startA, startB):
    """相同段內原字形不同的位置：[[A中偏移, B中偏移, 類別, A字, B字], ...]"""
    ga, gb = A.gl[a0:a1], B.gl[b0:b1]
    if ga == gb:
        return []
    out = []
    for x in range(a1 - a0):
        if ga[x] != gb[x]:
            out.append([A.pos[a0 + x] - startA, B.pos[b0 + x] - startB,
                        nz.kind(ga[x], gb[x]), A.raw[A.pos[a0 + x]], B.raw[B.pos[b0 + x]]])
    return out


def raw_range(P, s, e):
    """norm [s, e) → 原文範圍 [r0, r1)（含其後緊隨的標點）。空範圍給插入點。"""
    if e > s:
        return [P.pos[s], _tail(P, e - 1)]
    r = P.pos[s] if s < len(P.pos) else P.raw_at(len(P.pos))
    return [r, r]


def _union_len(spans):
    tot, cur_s, cur_e = 0, None, None
    for s, e in sorted(spans):
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                tot += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        tot += cur_e - cur_s
    return tot


# ================================================================ 兩本對讀
def pair_compare(A, B, prm, detail=True, max_runs=12000, runs=None):
    runs, ps = passages(A.norm, B.norm, prm, runs)
    nA, nB = len(A), len(B)
    res = {
        "nA": nA, "nB": nB,
        "coverA": _union_len([(p.a0, p.a1) for p in ps]) / float(nA or 1),
        "coverB": _union_len([(p.b0, p.b1) for p in ps]) / float(nB or 1),
        "npass": len(ps),
    }
    if not detail:
        return res, ps
    inorder = lis_flags([p.b0 for p in ps])
    if len(runs) > max_runs:
        keep = sorted(runs, key=lambda r: -r[2])[:max_runs]
        keep.sort()
    else:
        keep = runs
    res["runs"] = [list(r) for r in keep]
    res["nruns"] = len(runs)
    out = []
    for x, p in enumerate(ps):
        la, lb = p.a1 - p.a0, p.b1 - p.b0
        out.append({
            "i": x, "a0": p.a0, "a1": p.a1, "b0": p.b0, "b1": p.b1,
            "m": p.matched, "la": la, "lb": lb,
            "sim": round(p.matched / float(max(la, lb) or 1), 3),
            "locA": A.loc(p.a0), "locA2": A.loc(p.a1 - 1),
            "locB": B.loc(p.b0), "locB2": B.loc(p.b1 - 1),
            "ord": inorder[x],
            "pa": A.glyphs(p.a0, min(p.a1, p.a0 + 24)),
            "pb": B.glyphs(p.b0, min(p.b1, p.b0 + 24)),
            "ra": raw_range(A, p.a0, p.a1), "rb": raw_range(B, p.b0, p.b1),
        })
    res["passages"] = out
    return res, ps


def passage_rows(A, B, p, nz, ctx=0):
    """一個平行段落的逐字對齊結果，排成對照表的行。"""
    ops = align(A.norm, B.norm, p.a0, p.a1, p.b0, p.b1, p.runs)
    return build_rows(A, B, ops, nz), _opstats(ops)


def _opstats(ops):
    eq = sum(op[2] - op[1] for op in ops if op[0] == "=")
    la = sum(op[2] - op[1] for op in ops)
    lb = sum(op[4] - op[3] for op in ops)
    nv = sum(1 for op in ops if op[0] == "~")
    return {"eq": eq, "la": la, "lb": lb, "nvar": nv,
            "sim": round(2.0 * eq / float(la + lb or 1), 3)}


def build_rows(A, B, ops, nz, target=26, hard=80):
    if not ops:
        return []
    a_lo, a_hi = ops[0][1], ops[-1][2]
    b_lo, b_hi = ops[0][3], ops[-1][4]
    brk = set(A.breaks(a_lo, a_hi))
    if len(brk) * 120 < (a_hi - a_lo):
        # A 沒有句讀時，借用 B 的句讀（經相同段換算到 A 的位置）
        bb = B.breaks(b_lo, b_hi)
        for op in ops:
            if op[0] != "=":
                continue
            x0 = bisect.bisect_left(bb, op[3])
            x1 = bisect.bisect_right(bb, op[4])
            for q in bb[x0:x1]:
                brk.add(op[1] + q - op[3])
    brk = sorted(brk)
    rows, cur = [], []
    cur_len = 0

    for op in ops:
        tag, a0, a1, b0, b1 = op
        if tag == "~":
            cur.append(op)
            cur_len += max(a1 - a0, b1 - b0)
            continue
        s = a0
        while s < a1:
            x = bisect.bisect_right(brk, s)
            nb = brk[x] if x < len(brk) and brk[x] <= a1 else None
            limit = s + max(hard - cur_len, 1)
            if nb is not None and nb <= limit:
                p = nb
            elif limit < a1:
                p = limit
            else:
                p = a1
            cur.append(["=", s, p, b0 + s - a0, b0 + p - a0])
            cur_len += p - s
            s = p
            if (p == nb and cur_len >= target) or (p == limit and p < a1 and p != nb):
                rows.append(cur)
                cur, cur_len = [], 0
    if cur:
        rows.append(cur)

    out = []
    for row in rows:
        ra, rb = [], []
        for tag, a0, a1, b0, b1 in row:
            ta = _rawspan(A, a0, a1, a_hi)
            tb = _rawspan(B, b0, b1, b_hi)
            if tag == "=":
                m = _gmarks(A, B, a0, a1, b0, b1, nz, A.pos[a0], B.pos[b0])
                ra.append(["=", ta, [[x[0], x[2], x[4]] for x in m]])
                rb.append(["=", tb, [[x[1], x[2], x[3]] for x in m]])
            else:
                ra.append(["~", ta, []])
                rb.append(["~", tb, []])
        first, last = row[0], row[-1]
        out.append({"a": ra, "b": rb, "la": A.loc(first[1]), "lb": B.loc(first[3]),
                    "ra": raw_range(A, first[1], last[2]), "rb": raw_range(B, first[3], last[4])})
    return out


# ================================================================ 多本對校
def _merge_spans(spans):
    """把各本的差異範圍合併成「校勘單位」。插入點 p 與 [s, e] 相接即併入；同一插入點只屬一個單位。"""
    out = []
    for s, e in sorted(set(spans)):
        if out:
            cs, ce, ie = out[-1]
            touch = (cs <= s <= ce) if s == e else (s < ce or (s == ce and ie))
            if touch:
                ne = max(ce, e)
                if s == e:
                    nie = s == ne or (ie and ne == ce)
                else:
                    nie = ie and ne == ce
                out[-1] = [cs, ne, nie]
                continue
        out.append([s, e, s == e])
    return [(s, e) for s, e, _ in out]


class _Wit(object):
    def __init__(self, wid, P, ops, cov):
        self.wid, self.P, self.ops, self.cov = wid, P, ops, cov
        self.starts = [op[1] for op in ops]

    def bpos(self, p, right):
        a0c, a1c = self.cov[0], self.cov[1]
        if p < a0c or p > a1c:
            return None
        x = bisect.bisect_right(self.starts, p) - 1
        vals = []
        while x >= 0:
            tag, a0, a1, b0, b1 = self.ops[x]
            if a1 < p:
                break
            if a0 <= p:
                if tag == "=":
                    vals.append(b0 + p - a0)
                elif a0 == a1:
                    vals.append(b1 if right else b0)
                elif p == a1:
                    vals.append(b1)
                else:
                    vals.append(b0)
            x -= 1
        if not vals:
            return None
        return max(vals) if right else min(vals)


def _tags(base, s, e, rd, bihui, moved):
    """確定性的提示標記（只是「疑」，供判斷參考）。"""
    tags = {}
    bn = base.norm[s:e]
    bg = base.gl[s:e]

    def add(t, w):
        tags.setdefault(t, []).append(w)

    for wid, r in rd.items():
        if r is None or wid == "_base":
            continue
        n, g = r[1], r[3]
        if n == bn:
            if g != bg and bihui and len(g) == len(bg):
                d = [(x, y) for x, y in zip(bg, g) if x != y]
                if d and all(pr in bihui for pr in d):
                    add("諱", wid)
            continue
        if len(n) >= 2 and len(n) == len(bn) and sorted(n) == sorted(bn):
            add("倒", wid)
        if any(c in "□■〓〼" for c in g + bg):
            add("闕", wid)
        if bihui and len(g) == len(bg):
            d = [(x, y) for x, y in zip(bg, g) if x != y]
            if d and all(pr in bihui for pr in d):
                add("諱", wid)
        # 一方多出的部分
        if not bn and n:
            extra, at, src = n, s, base.norm
        elif not n and bn:
            extra, at, src = bn, None, None
        else:
            extra = None
        if extra is not None:
            L = len(extra)
            if src is not None:          # 校本多出：是否重複了相鄰文字（疑重文），或底本疑跳脫
                if src[max(0, at - L):at] == extra or src[at:at + L] == extra:
                    add("重", wid)
                elif L >= 4 and (src[max(0, at - 2):at] == extra[-2:] or src[at:at + 2] == extra[:2]):
                    add("跳", wid)
            else:                        # 校本缺少：底本此處是否重複相鄰文字，或同字跳脫
                src = base.norm
                if src[max(0, s - L):s] == extra or src[e:e + L] == extra:
                    add("重", wid)
                elif L >= 4 and (src[max(0, s - 2):s] == src[e - 2:e] or src[s:s + 2] == src[e:e + 2]):
                    add("跳", wid)
        if (wid, s) in moved:
            add("移", wid)
    return [[t, ws] for t, ws in tags.items()]


def collate(base, base_id, wits, nz, prm, bihui=None, progress=None):
    """wits：[(wid, Prepared)]。返回校勘單位及各本讀法。"""
    W = []
    info = {}
    spans = []          # 實質差異（字不同、有無）
    gspans = []         # 只是字形不同
    for x, (wid, P) in enumerate(wits):
        if progress:
            progress(x, len(wits), wid)
        chain, cov = global_anchors(base.norm, P.norm, prm)
        if not chain:
            info[wid] = {"ok": False}
            continue
        a0, a1, b0, b1 = cov
        ops = align(base.norm, P.norm, a0, a1, b0, b1, chain)
        w = _Wit(wid, P, ops, cov)
        W.append(w)
        nsub = 0
        for op in ops:
            if op[0] == "~":
                spans.append((op[1], op[2]))
                nsub += 1
            else:
                ga, gb = base.gl[op[1]:op[2]], P.gl[op[3]:op[4]]
                if ga != gb:
                    for d in range(op[2] - op[1]):
                        if ga[d] != gb[d]:
                            gspans.append(op[1] + d)
        st = _opstats(ops)
        info[wid] = {"ok": True, "cov": [a0, a1, b0, b1],
                     "locA": base.loc(a0), "locA2": base.loc(a1 - 1),
                     "locB": P.loc(b0), "locB2": P.loc(b1 - 1),
                     "covBase": (a1 - a0) / float(len(base) or 1),
                     "covWit": (b1 - b0) / float(len(P) or 1),
                     "sim": st["sim"], "nchg": nsub}
    # 移位：某本在一處缺少、在另一處多出的同一段文字
    moved = set()
    for w in W:
        dels = [(op[1], base.norm[op[1]:op[2]]) for op in w.ops
                if op[0] == "~" and op[3] == op[4] and op[2] - op[1] >= 6]
        inss = [(op[1], w.P.norm[op[3]:op[4]]) for op in w.ops
                if op[0] == "~" and op[1] == op[2] and op[4] - op[3] >= 6]
        for pd, d in dels:
            for pi, t in inss:
                if (len(d) >= 6 and d in t) or (len(t) >= 6 and t in d):
                    moved.add((w.wid, pd))
                    moved.add((w.wid, pi))
    # 校勘單位：先合併實質差異；字形差異若落在實質單位之內即併入，否則相鄰的連成一個單位，
    # 但不跨過別本的插入點，也不「認領」相鄰的插入（插入屬於實質單位）。
    units = [(s, e, True) for s, e in _merge_spans(spans)]
    ins_pts = set(s for s, e in spans if s == e)
    starts = [u[0] for u in units]
    g_ok = []
    for p in sorted(set(gspans)):
        x = bisect.bisect_right(starts, p) - 1
        inside = False
        for y in (x, x + 1):
            if 0 <= y < len(units):
                us, ue, _ = units[y]
                if us < p + 1 and p < ue:
                    inside = True
        if not inside:
            g_ok.append(p)
    gunits = []
    for p in g_ok:
        if gunits and gunits[-1][1] == p and p not in ins_pts:
            gunits[-1][1] = p + 1
        else:
            gunits.append([p, p + 1])
    units += [(s, e, False) for s, e in gunits]
    units.sort(key=lambda u: (u[0], u[1]))
    loci = []
    for s, e, own in units:
        rd = {}
        bg = base.glyphs(s, e)
        rd["_base"] = (bg, base.norm[s:e], s, base.gl[s:e])
        for w in W:
            # 實質單位包含其邊界上的插入；字形單位不包含
            L = w.bpos(s, not own)
            R = w.bpos(e, own)
            if L is None or R is None or R < L:
                rd[w.wid] = None
            else:
                rd[w.wid] = (w.P.glyphs(L, R), w.P.norm[L:R], L, w.P.gl[L:R])
        present = [r for r in rd.values() if r is not None]
        sub = len(set(r[1] for r in present)) > 1
        gra = len(set(r[3] for r in present)) > 1
        if not sub and not gra:
            continue
        mv = set()
        for w in W:
            if (w.wid, s) in moved:
                mv.add((w.wid, s))
        tags = _tags(base, s, e, rd, bihui, mv)
        r_out = {}
        for wid, r in rd.items():
            if r is None:
                r_out[wid] = None
            else:
                wp = base if wid == "_base" else next(w.P for w in W if w.wid == wid)
                L0 = r[2]
                rr = raw_range(wp, L0, L0 + len(r[1])) if len(wp) else [0, 0]
                r_out[wid] = [r[0], r[1], wp.loc(L0) if len(wp) else None, rr[0], rr[1]]
        rs = base.pos[s] if s < len(base) else base.raw_at(len(base))
        re_ = _tail(base, e - 1) if e > s else rs
        loci.append({
            "s": s, "e": e, "rs": rs, "re": re_,
            "kind": "sub" if sub else "gra",
            "pre": base.glyphs(max(0, s - 4), s), "post": base.glyphs(e, e + 4),
            "loc": base.loc(s), "r": r_out, "tags": tags,
            "key": "%d:%d:%s" % (base.lo + s, base.lo + e, base.norm[s:e]),
        })
    # 底本顯示範圍：各本覆蓋範圍的並集
    covs = [w.cov for w in W]
    if covs:
        r0 = min(c[0] for c in covs)
        r1 = max(c[1] for c in covs)
    else:
        r0, r1 = 0, len(base)
    same = agreements(base, W, loci, r0, r1)
    raw0 = base.pos[r0] if r0 < len(base) else 0
    raw1 = _tail(base, r1 - 1) if r1 > r0 else raw0
    # 往前帶上本行開頭的標點，往後到本行末
    return {
        "base": base_id, "n": len(base), "lo": base.lo, "info": info, "loci": loci,
        "text": base.raw[raw0:raw1], "raw0": raw0,
        "page0": base.loc(r0)[0], "paged": base.paged, "same": same,
    }


def agreements(base, W, loci, r0, r1):
    """同文：各本（歸一後）逐字相同的文字，按「哪幾本相同」分段。以底本為座標。

    返回 [{s, e, n, alt, st, rr, loc, text?}]：
      st  各本狀態 {本: "=" 同 / "x" 異（有此處而文字不同、或無此文字）/ "-" 缺（不在該本覆蓋範圍內）}，底本記作 "_base"；
      alt 0：底本 [s, e) 中 st 為 "=" 的各本逐字相同（字形差異不算不同）；
          1：底本此處讀法不同，而另有兩本以上讀法相同（如兩本共有的增文），text 為其讀法；
      rr  各本對應的原文範圍（缺者不列），供看上下文；n 為字數（不計標點）。
    """
    wids = [w.wid for w in W]
    # 實質異文單位（含插入點）：誰與底本不同
    subs = [L for L in loci if L["kind"] == "sub"]
    starts = [L["s"] for L in subs if L["e"] > L["s"]]
    spans = [L for L in subs if L["e"] > L["s"]]
    ins_at = {}
    for L in subs:
        if L["e"] == L["s"]:
            who = set(wid for wid in wids if L["r"].get(wid) and L["r"][wid][1])
            if who:
                ins_at.setdefault(L["s"], set()).update(who)
    cuts = {r0, r1}
    for w in W:
        cuts.update(c for c in (w.cov[0], w.cov[1]) if r0 <= c <= r1)
    for L in subs:
        cuts.update(c for c in (L["s"], L["e"]) if r0 <= c <= r1)
    cuts = sorted(cuts)

    def status(p, q):
        x = bisect.bisect_right(starts, p) - 1
        L = spans[x] if x >= 0 and spans[x]["s"] <= p and q <= spans[x]["e"] else None
        st = {"_base": "="}
        for w in W:
            if p < w.cov[0] or q > w.cov[1]:
                st[w.wid] = "-"
            elif L is not None:
                r = L["r"].get(w.wid)
                st[w.wid] = "-" if r is None else ("=" if r[1] == L["r"]["_base"][1] else "x")
            else:
                st[w.wid] = "="
        return st

    out = []
    runs = []
    for p, q in zip(cuts, cuts[1:]):
        if q <= p:
            continue
        st = status(p, q)
        if runs and runs[-1][2] == st and not (ins_at.get(p, set()) & set(k for k, v in st.items() if v == "=")):
            runs[-1][1] = q             # 狀態相同、中間又沒有其中某本的增文：連成一段
        else:
            runs.append([p, q, st])
    for p, q, st in runs:
        rr = {"_base": raw_range(base, p, q)}
        for w in W:
            if st[w.wid] == "-":
                continue
            a, b = w.bpos(p, True), w.bpos(q, False)
            if a is not None and b is not None and b >= a:
                rr[w.wid] = raw_range(w.P, a, b)
        out.append({"s": p, "e": q, "n": q - p, "alt": 0, "st": st, "rr": rr, "loc": base.loc(p)})
    # 異於底本、而兩本以上相同的讀法
    for L in subs:
        bn = L["r"]["_base"][1]
        groups = {}
        for wid in wids:
            r = L["r"].get(wid)
            if r is not None and r[1] and r[1] != bn:
                groups.setdefault(r[1], []).append(wid)
        for norm, members in groups.items():
            if len(members) < 2:
                continue
            st = {"_base": "x"}
            rr = {"_base": [L["rs"], L["re"]]}
            for wid in wids:
                r = L["r"].get(wid)
                st[wid] = "-" if r is None else ("=" if wid in members else "x")
                if r is not None:
                    rr[wid] = [r[3], r[4]]
            first = L["r"][members[0]]
            out.append({"s": L["s"], "e": L["e"], "n": len(norm), "alt": 1, "st": st, "rr": rr,
                        "loc": L["loc"], "text": first[0]})
    out.sort(key=lambda g: (g["s"], g["alt"], g["e"]))
    return out
