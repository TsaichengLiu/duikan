# -*- coding: utf-8 -*-
"""模擬一個已知譜系的抄本傳承，檢驗對齊與分組統計能否還原。

    O（祖本，佚）
    ├── α（佚）── A ── E（E 抄自 A）
    │          └── B
    └── β（佚）── C（改成簡體）
               └── D（無標點）

用法：python3 tests/sim_tradition.py <文本文件>
"""
import json
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "app"))

from dk_norm import Normalizer, Prepared, CONTENT_RE, _data  # noqa: E402
from dk_align import params  # noqa: E402
from dk_compare import collate, pair_compare, passage_rows  # noqa: E402

FULL = _data()["full"]
INV = {}
for ch, rep in FULL.items():
    INV.setdefault(rep, []).append(ch)
    INV.setdefault(rep, []).append(rep)


def content_idx(s):
    return [m.start() for m in CONTENT_RE.finditer(s)]


def copy(text, rng, n, log, name):
    s = text
    for _ in range(n):
        idx = content_idx(s)
        i = rng.choice(idx[10:-10])
        kind = rng.choice(["sub", "sub", "omit", "saut", "ditto", "trans", "glyph"])
        if kind == "sub":
            c = rng.choice(idx)
            if s[c] == s[i]:
                continue
            s = s[:i] + s[c] + s[i + 1:]
        elif kind == "omit":
            L = rng.randint(1, 3)
            s = s[:i] + s[i + L:]
        elif kind == "saut":
            big = s[i:i + 2]
            j = s.find(big, i + 6, i + 60)
            if j < 0 or not CONTENT_RE.match(big[0]):
                continue
            s = s[:i] + s[j:]
        elif kind == "ditto":
            L = rng.randint(2, 4)
            s = s[:i + L] + s[i:i + L] + s[i + L:]
        elif kind == "trans":
            if not (CONTENT_RE.match(s[i + 1]) and s[i] != s[i + 1]):
                continue
            s = s[:i] + s[i + 1] + s[i] + s[i + 2:]
        elif kind == "glyph":
            rep = FULL.get(s[i], s[i])
            alts = [c for c in set(INV.get(rep, [])) if c != s[i]]
            if not alts:
                continue
            s = s[:i] + rng.choice(sorted(alts)) + s[i + 1:]
        log.append((name, kind))
    return s


def main():
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    O = raw[200000:206000]
    rng = random.Random(7)
    log = []
    alpha = copy(O, rng, 12, log, "α")
    beta = copy(O, rng, 12, log, "β")
    A = copy(alpha, rng, 6, log, "A")
    B = copy(alpha, rng, 6, log, "B")
    C = copy(beta, rng, 6, log, "C")
    D = copy(beta, rng, 6, log, "D")
    E = copy(A, rng, 4, log, "E")
    nz = Normalizer("full")
    st = _data()["st"]
    C = C.translate(str.maketrans(st))                       # 簡體
    D = re.sub(r"[，。、；：「」『』《》（）“”？！\s]", "", D)   # 無標點
    texts = {"O": O, "A": A, "B": B, "C": C, "D": D, "E": E}
    P = dict((k, Prepared(v, nz)) for k, v in texts.items())
    prm = params("normal")
    import time
    t = time.time()
    res = collate(P["O"], "O", [(k, P[k]) for k in "ABCDE"], nz, prm)
    print("collate %.2fs, loci %d" % (time.time() - t, len(res["loci"])))
    for k, v in res["info"].items():
        print(k, v.get("sim"), v.get("nchg"), "cov %.3f %.3f" % (v.get("covBase", 0), v.get("covWit", 0)))
    print("errors simulated:", len(log))
    # 分組模式（底本 O = 祖本，其讀法即「正讀」）
    pat = {}
    shared = {}
    for L in res["loci"]:
        if L["kind"] != "sub":
            continue
        groups = {}
        for w, r in L["r"].items():
            if r is None or w == "_base":
                continue
            groups.setdefault(r[1], []).append(w)
        ok = L["r"]["_base"][1]
        for rd, ws in groups.items():
            if rd != ok:
                key = "".join(sorted(ws))
                shared[key] = shared.get(key, 0) + 1
    print("錯誤分組（模擬真值：ABE≈12, CD≈12, AE≈6, B/C/D≈6, E≈4）：")
    for k, v in sorted(shared.items(), key=lambda x: -x[1]):
        print("  ", k, v)
    tags = {}
    for L in res["loci"]:
        for t, ws in L["tags"]:
            tags[t] = tags.get(t, 0) + 1
    print("tags", tags)
    kinds = {}
    for _, k in log:
        kinds[k] = kinds.get(k, 0) + 1
    print("simulated kinds", kinds)
    # 兩本對讀
    t = time.time()
    pr, ps = pair_compare(P["A"], P["C"], prm)
    print("pair A~C: %.2fs passages %d coverA %.3f coverB %.3f" % (time.time() - t, len(ps), pr["coverA"], pr["coverB"]))
    rows, stt = passage_rows(P["A"], P["C"], ps[0], nz)
    print(stt, len(rows))
    for r in rows[:4]:
        print(" A:", "".join(("[%s]" % x[1] if x[0] == "~" else x[1]) for x in r["a"]).replace("\n", ""))
        print(" C:", "".join(("[%s]" % x[1] if x[0] == "~" else x[1]) for x in r["b"]).replace("\n", ""))
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
