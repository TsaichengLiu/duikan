#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""對勘 —— 同源文本比對工具（本地服務）。

用法：python3 server.py [--port 5918] [--data 目錄]
"""
import argparse
import bisect
import difflib
import gc
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from dk_align import PRESETS, params, preset_of, seeds  # noqa: E402
from dk_compare import collate, pair_compare, passage_rows  # noqa: E402
from dk_extract import Extractor, INDEXABLE  # noqa: E402
from dk_search import context_windows, fit_segment, phrase_hits  # noqa: E402
from dk_norm import Normalizer, Prepared, parse_pairs, slice_pages  # noqa: E402

STATIC = os.path.join(HERE, "static")
VERSION = "1.0"
SIGLA = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥"

DEFAULT_BIHUI = """# 避諱字對照：每行「本字 改字」，比對時遇到這些字的差異會標「疑諱」（只作提示，不影響對齊）。
# 以下為常見例子，請按研究對象增刪。
玄 元   # 清聖祖玄燁
燁 煜 曄
胤 允   # 清世宗胤禛
禛 禎 正
弘 宏   # 清高宗弘曆
曆 歷
琰 琬   # 清仁宗顒琰
寧 甯   # 清宣宗旻寧
淳 湻   # 清穆宗載淳
丘 邱   # 孔子諱（雍正三年起）
校 較 挍  # 明熹宗由校
洛 雒   # 明光宗常洛
"""

DEFAULT_SETTINGS = {
    "level": "full",        # exact / st / full
    "keep_alnum": False,    # 是否比對阿拉伯數字與西文
    "skip_notes": False,    # 是否忽略括號裡的夾注
    "skip_heads": True,     # 是否忽略 PDF 的頁眉頁腳
    # 平行段落的參數（可在設定或「兩本對讀」中用滑桿調整）
    "k": 5, "gap": 80, "min": 24, "dens": 0.2, "maxfreq": 30,
    "custom": "",           # 視同字
    "bihui": DEFAULT_BIHUI,
}


class UserError(Exception):
    pass


def log(*a):
    sys.stderr.write(time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a) + "\n")


# ================================================================ 工作區
class Workspace(object):
    def __init__(self, data_dir, cache_dir, helper, readonly=False):
        # readonly：給 MCP 服務等旁路讀者用——不清理磁盤、不寫 workspace.json，與正在運行的對勘互不干擾
        self.readonly = readonly
        self.dir = data_dir
        self.files = os.path.join(data_dir, "files")
        self.cache = os.path.join(cache_dir, "text")
        for d in ((self.cache,) if readonly else (self.dir, self.files, self.cache)):
            os.makedirs(d, exist_ok=True)
        self.path = os.path.join(data_dir, "workspace.json")
        self.lock = threading.RLock()
        self.extractor = Extractor(helper)
        self.raw = {}          # id → 原文
        self.prep = {}         # (id, 設定) → Prepared
        self.pairs = {}        # (a, b, 設定, 參數) → (結果, 段落)
        self.seeds = {}        # (a, b, 設定, k, maxfreq) → 種子；只改 gap/min/dens 時可直接重用
        self.colls = {}
        self.nz = None
        self.nz_key = None
        self.last_use = time.time()
        self.load()
        if not readonly:
            self.prune_disk()

    # ---- 持久化 ----
    def load(self):
        d = {}
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as f:
                    d = json.load(f)
            except Exception:
                traceback.print_exc()
                if self.readonly:
                    raise UserError("對勘的工作區文件讀不了（可能正在寫入），請稍後再試")
                os.replace(self.path, self.path + ".broken")
        self.texts = d.get("texts", [])
        s = dict(DEFAULT_SETTINGS)
        saved = d.get("settings", {})
        if "sens" in saved and "k" not in saved:          # 舊版：三檔敏感度 → 具體參數
            saved.update(PRESETS.get(saved["sens"]) or {})
        saved.pop("sens", None)
        for k in [k for k in saved if k.startswith("llm_")]:   # 已取消的 LLM 直連設定
            saved.pop(k)
        s.update(saved)
        s.update(params(s))
        self.settings = s
        self.marks = d.get("marks", {})
        self.ui = d.get("ui", {})

    def save(self):
        if self.readonly:
            return
        with self.lock:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "texts": self.texts, "settings": self.settings,
                           "marks": self.marks, "ui": self.ui}, f, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)

    def text(self, tid):
        for t in self.texts:
            if t["id"] == tid:
                return t
        raise UserError("找不到這個文本（可能已被移除）")

    def next_siglum(self):
        used = set(t.get("siglum") for t in self.texts)
        for c in SIGLA:
            if c not in used:
                return c
        return "本%d" % (len(self.texts) + 1)

    # ---- 抽取 ----
    def _cache_path(self, path):
        st = os.stat(path)
        key = "%s|%d|%d|%d" % (path, st.st_size, int(st.st_mtime), 3)
        return os.path.join(self.cache, hashlib.sha1(key.encode("utf-8")).hexdigest() + ".txt")

    def extract(self, path):
        cp = self._cache_path(path)
        if os.path.exists(cp):
            with open(cp, encoding="utf-8") as f:
                return f.read()
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        status, text = self.extractor.extract(path, ext, os.path.getsize(path))
        if status == 0:
            raise UserError("不支持這種格式：%s" % os.path.basename(path))
        if status == 2:
            raise UserError("「%s」沒有可抽取的文字（掃描版 PDF 需要先做 OCR）" % os.path.basename(path))
        if status == 3:
            raise UserError("「%s」抽取失敗：%s" % (os.path.basename(path), text))
        if status == 4:
            raise UserError("「%s」太大" % os.path.basename(path))
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        # 先寫臨時文件再改名：對勘與 MCP 服務可能同時抽取同一文件，誰也不會讀到寫了一半的緩存
        tmp = "%s.%d.tmp" % (cp, os.getpid())
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, cp)
        return text

    def get_raw(self, t):
        with self.lock:
            r = self.raw.get(t["id"])
        if r is not None:
            return r
        p = t["path"]
        if not os.path.exists(p):
            raise UserError("找不到原文件：%s" % p)
        r = self.extract(p)
        with self.lock:
            self.raw[t["id"]] = r
            # 原文緩存不超過約 2000 萬字（空閒時整個清空）
            while sum(len(v) for v in self.raw.values()) > 20000000 and len(self.raw) > 1:
                self.raw.pop(next(iter(self.raw)))
        return r

    def add_path(self, path, name=None, copy=False, orig=None):
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(path):
            raise UserError("不是文件：%s" % path)
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext not in INDEXABLE:
            raise UserError("不支持這種格式：%s" % os.path.basename(path))
        raw = self.extract(path)
        tid = uuid.uuid4().hex[:10]
        t = {"id": tid, "name": name or os.path.splitext(os.path.basename(path))[0],
             "siglum": self.next_siglum(), "path": path, "ext": ext, "on": True,
             "pages": "", "start": "", "end": "", "added": int(time.time()), "uploaded": copy}
        if copy and orig:
            t["orig"] = orig            # 拖入時的原文件名：日後據此找回原文件
        with self.lock:
            self.raw[tid] = raw
            self.texts.append(t)
            self.save()
        return t

    # ---- 拖入的副本與原文件 ----
    # 網頁拿不到拖入文件的位置，只能上傳內容，對勘便在 files/ 裡存一份副本（文件名是隨機的）。
    # 這裡按原文件名在聚焦（Spotlight）裡找原文件，大小與內容完全相同才算，找到就改回指向原文件、刪去副本。
    @staticmethod
    def _sha1(path):
        h = hashlib.sha1()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def is_copy(self, t):
        return bool(t.get("uploaded") and not t.get("pasted") and t["path"].startswith(self.files + os.sep))

    def find_original(self, t):
        if not self.is_copy(t) or not os.path.isfile(t["path"]):
            return None
        want = t.get("orig") or "%s.%s" % (t["name"], t["ext"])
        try:
            out = subprocess.run(["/usr/bin/mdfind", "-name", want], stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, timeout=20).stdout.decode("utf-8", "replace").splitlines()
        except (subprocess.SubprocessError, OSError):
            return None
        size, h = os.path.getsize(t["path"]), None
        for p in out:
            if (os.path.basename(p) != want or p.startswith(self.dir + os.sep) or "/.Trash/" in p
                    or not os.path.isfile(p) or os.path.getsize(p) != size):
                continue
            h = h or self._sha1(t["path"])
            if self._sha1(p) == h:
                return p
        return None

    def relink(self, tid, path):
        """把文本的來源改為 path（找回的原文件，或用戶指定的文件）；原來的副本隨即刪除。返回內容是否相同。"""
        path = os.path.abspath(os.path.expanduser(path))
        if not os.path.isfile(path):
            raise UserError("不是文件：%s" % path)
        ext = os.path.splitext(path)[1].lower().lstrip(".")
        if ext not in INDEXABLE:
            raise UserError("不支持這種格式：%s" % os.path.basename(path))
        with self.lock:
            t = self.text(tid)
            if t.get("pasted"):
                raise UserError("貼上的文字沒有原文件")
            old = t["path"]
            same = os.path.isfile(old) and os.path.getsize(old) == os.path.getsize(path) and self._sha1(old) == self._sha1(path)
            was_copy = self.is_copy(t)
            t.update(path=path, ext=ext, uploaded=False)
            t.pop("orig", None)
            if not same:                 # 換成了內容不同的文件：抽取與比對都要重算
                t.pop("meta", None)
                self.raw.pop(tid, None)
                self._drop(tid)
            self.save()
        if was_copy and old != path:
            try:
                os.remove(old)
            except OSError:
                pass
        return same

    def relink_all(self):
        """啟動時在背景把能找回原文件的副本都改回原文件。"""
        for t in [t for t in list(self.texts) if self.is_copy(t)]:
            try:
                p = self.find_original(t)
                if p:
                    self.relink(t["id"], p)
                    log("找回原文件：%s → %s" % (t["name"], p))
            except Exception:  # noqa
                traceback.print_exc()

    def add_paste(self, name, content):
        content = (content or "").replace("\r\n", "\n").replace("\r", "\n")
        if not content.strip():
            raise UserError("內容是空的")
        tid = uuid.uuid4().hex[:10]
        p = os.path.join(self.files, tid + ".txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        t = {"id": tid, "name": (name or "").strip() or ("貼上的文字 " + time.strftime("%m-%d %H:%M")),
             "siglum": self.next_siglum(), "path": p, "ext": "txt", "on": True,
             "pages": "", "start": "", "end": "", "added": int(time.time()), "uploaded": True,
             "pasted": True}
        with self.lock:
            self.raw[tid] = content
            self.texts.append(t)
            self.save()
        return t

    def remove(self, tid):
        with self.lock:
            t = self.text(tid)
            self.texts = [x for x in self.texts if x["id"] != tid]
            self.raw.pop(tid, None)
            self.marks.pop(tid, None)      # 以此為底本的判讀標記（文本移除後再無用處）
            self._drop(tid)
            self.save()
        if t.get("uploaded") and t["path"].startswith(self.files + os.sep):
            try:
                os.remove(t["path"])
            except OSError:
                pass
        self.prune_disk()

    def _drop(self, tid):
        for cache in (self.prep, self.pairs, self.seeds):
            for k in [k for k in cache if tid in k[:2]]:
                del cache[k]
        self.colls.clear()

    # ---- 磁盤與內存的清理 ----
    def _wanted_cache(self):
        out = set()
        for t in self.texts:
            try:
                out.add(os.path.basename(self._cache_path(t["path"])))
            except OSError:
                pass
        return out

    def prune_disk(self):
        """刪去不再對應任何文本的抽取緩存（文件改過、文本移除後留下的舊版本），以及 files/ 中無主的文件。"""
        removed = 0
        with self.lock:
            keep = self._wanted_cache()
            owned = set(os.path.basename(t["path"]) for t in self.texts
                        if t["path"].startswith(self.files + os.sep))
        for d, keepset in ((self.cache, keep), (self.files, owned)):
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for n in names:
                p = os.path.join(d, n)
                if n not in keepset and os.path.isfile(p) and time.time() - os.path.getmtime(p) > 60:
                    try:
                        os.remove(p)
                        removed += 1
                    except OSError:
                        pass
        if removed:
            log("清理磁盤：刪去 %d 個無用文件" % removed)
        return removed

    def usage(self):
        def size(d):
            tot = 0
            for root, _, fs in os.walk(d):
                for f in fs:
                    try:
                        tot += os.path.getsize(os.path.join(root, f))
                    except OSError:
                        pass
            return tot
        return {"cache": size(self.cache), "files": size(self.files),
                "workspace": os.path.getsize(self.path) if os.path.exists(self.path) else 0}

    def clear_cache(self):
        """清空抽取緩存（需要時重新抽取）。"""
        n = 0
        for f in os.listdir(self.cache):
            try:
                os.remove(os.path.join(self.cache, f))
                n += 1
            except OSError:
                pass
        return n

    def release(self):
        """空閒時釋放全部計算緩存，內存交還系統；再用時重算（整本書約 2 秒）。"""
        with self.lock:
            had = bool(self.raw or self.prep or self.pairs or self.seeds or self.colls)
            self.raw, self.prep, self.pairs, self.seeds, self.colls = {}, {}, {}, {}, {}
        if had:
            gc.collect()
            log("空閒，已釋放計算緩存")
        return had

    # ---- 預處理 ----
    def skey(self):
        s = self.settings
        return json.dumps([s["level"], s["keep_alnum"], s["skip_notes"], s.get("skip_heads"), s["custom"]],
                          ensure_ascii=False)

    def normalizer(self):
        k = json.dumps([self.settings["level"], self.settings["custom"]], ensure_ascii=False)
        with self.lock:
            if self.nz_key != k:
                self.nz = Normalizer(self.settings["level"], self.settings["custom"])
                self.nz_key = k
            return self.nz

    def prepared(self, tid):
        t = self.text(tid)
        key = (tid, self.skey() + "|%s|%s|%s" % (t.get("pages"), t.get("start"), t.get("end")))
        with self.lock:
            P = self.prep.get(key)
        if P is not None:
            return P
        raw = self.get_raw(t)
        nz = self.normalizer()
        try:
            sub, p0 = slice_pages(raw, t.get("pages"))
        except ValueError as e:
            raise UserError("「%s」：%s" % (t["name"], e))
        paged = t.get("ext") == "pdf" or "\f" in raw
        s = self.settings
        P = Prepared(sub, nz, keep_alnum=s["keep_alnum"], skip_notes=s["skip_notes"],
                     page_base=p0, paged=paged, skip_heads=s.get("skip_heads"))
        lo, hi = 0, len(P)
        if t.get("start"):
            i, _ = P.find(nz, t["start"], 0, s["keep_alnum"])
            if i < 0:
                raise UserError("「%s」中找不到起始文字「%s」" % (t["name"], t["start"]))
            lo = i
        if t.get("end"):
            i, L = P.find(nz, t["end"], lo, s["keep_alnum"])
            if i < 0:
                raise UserError("「%s」中找不到結束文字「%s」" % (t["name"], t["end"]))
            hi = i + L
        if (lo, hi) != (0, len(P)):
            P = P.restrict(lo, hi)
        with self.lock:
            self.prep[key] = P
            # 不超過 24 個、合計不超過約 600 萬字（每字約 10 字節）
            while len(self.prep) > 1 and (len(self.prep) > 24 or sum(len(x) for x in self.prep.values()) > 6000000):
                self.prep.pop(next(iter(self.prep)))
        return P

    def info(self, t):
        """文本信息（字數、頁數）。算過的記在 t["meta"]，啟動時不必重新抽取、歸一。"""
        d = dict(t)
        mk = "m2|" + self.skey() + self._rk(t["id"])
        meta = t.get("meta") or {}
        if meta.get("k") != mk or not os.path.exists(t["path"]):
            try:
                P = self.prepared(t["id"])
                tp = None
                if P.paged:
                    pg = set(bisect.bisect_right(P.page_starts, o) for o in P.pos)
                    tp = len(pg)
                meta = {"k": mk, "n": len(P), "paged": P.paged, "textpages": tp, "nheads": P.nheads,
                        "npages": len(P.page_starts) if P.paged else None,
                        "loc0": P.loc(0), "loc1": P.loc(len(P) - 1), "err": None}
            except UserError as e:
                meta = {"k": None, "err": str(e)}
            except Exception as e:  # noqa
                traceback.print_exc()
                meta = {"k": None, "err": "%s: %s" % (type(e).__name__, e)}
            with self.lock:
                if meta.get("k"):
                    t["meta"] = meta
                    self.save()
        d.pop("meta", None)
        d.update(dict((k, v) for k, v in meta.items() if k != "k"))
        return d

    # ---- 比對 ----
    def prm(self):
        return params(self.settings)

    def pair(self, a, b):
        prm = self.prm()
        base = self.skey() + self._rk(a) + self._rk(b)
        key = (a, b, base + json.dumps(prm, sort_keys=True))
        with self.lock:
            r = self.pairs.get(key)
        if r is not None:
            return r
        A, B = self.prepared(a), self.prepared(b)
        runs = self.seeds_for(a, b)
        r = pair_compare(A, B, prm, runs=runs)
        with self.lock:
            self.pairs[key] = r
            while len(self.pairs) > 12:
                self.pairs.pop(next(iter(self.pairs)))
        return r

    def seeds_for(self, a, b):
        """兩本之間的全部種子片段（按 k、maxfreq 緩存；只改 gap/min/dens 時可重用）。"""
        prm = self.prm()
        skey = (a, b, self.skey() + self._rk(a) + self._rk(b) + "|%d|%d" % (prm["k"], prm["maxfreq"]))
        with self.lock:
            runs = self.seeds.get(skey)
        if runs is None:
            A, B = self.prepared(a), self.prepared(b)
            runs = seeds(A.norm, B.norm, prm)
            with self.lock:
                self.seeds[skey] = runs
                while len(self.seeds) > 3:
                    self.seeds.pop(next(iter(self.seeds)))
        return runs

    def _rk(self, tid):
        t = self.text(tid)
        return "|%s|%s|%s" % (t.get("pages"), t.get("start"), t.get("end"))

    def overview(self, ids, progress):
        n = len(ids)
        cells = {}
        total = n * (n - 1) // 2
        done = 0
        prm = self.prm()
        for x in range(n):
            for y in range(x + 1, n):
                progress("比對 %d/%d" % (done + 1, total), done / float(total or 1))
                A, B = self.prepared(ids[x]), self.prepared(ids[y])
                res, ps = pair_compare(A, B, prm, detail=False)
                cells["%s|%s" % (ids[x], ids[y])] = [res["coverA"], res["coverB"], res["npass"]]
                done += 1
        return {"ids": ids, "cells": cells}

    def _item(self, x):
        """文本 id，或句段 {"id", "lo", "hi"}（對該文本歸一字串的一段）→ (id, Prepared, 名稱)。"""
        if isinstance(x, dict):
            P = self.prepared(x["id"])
            lo, hi = int(x["lo"]), int(x["hi"])
            if not (0 <= lo < hi <= len(P)):
                raise UserError("片段範圍不對")
            return "%s@%d-%d" % (x["id"], lo, hi), P.restrict(lo, hi), self.text(x["id"])["siglum"]
        return x, self.prepared(x), self.text(x)["siglum"]

    def collation(self, base, wits, progress):
        ids = [base] + wits
        key = json.dumps([ids, self.skey(), self.prm(), self.settings["bihui"]]
                         + [self._rk(x["id"] if isinstance(x, dict) else x) for x in ids], ensure_ascii=False)
        with self.lock:
            r = self.colls.get(key)
        if r is not None:
            return r
        bid, B, _ = self._item(base)
        items = [self._item(w) for w in wits]
        W = [(wid, P) for wid, P, _ in items]
        names = dict((wid, sg) for wid, P, sg in items)
        nz = self.normalizer()

        def prog(x, n, wid):
            progress("對齊 %s（%d/%d）" % (names.get(wid, "?"), x + 1, n), x / float(n or 1))
        r = collate(B, bid, W, nz, self.prm(), parse_pairs(self.settings["bihui"]), prog)
        with self.lock:
            self.colls = {key: r}
        return r


# ================================================================ 後台任務
class Jobs(object):
    """後台任務。一次只算一個（免得內存疊加）；同一組（如拖動滑桿時的「兩本對讀」）中
    還在排隊的舊任務會被新任務取代；結果只交付一次，交付後即丟棄。"""

    def __init__(self):
        self.jobs = {}
        self.lock = threading.Lock()
        self.run_lock = threading.Lock()

    def busy(self):
        with self.lock:
            return any(j["state"] in ("queued", "running") for j in self.jobs.values())

    def start(self, fn, label="", group=None, exclusive=True):
        """exclusive=False：不佔計算鎖，fn 可接受 cancelled 參數。"""
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "state": "queued", "msg": label, "frac": 0.0, "result": None,
               "error": None, "t": time.time(), "group": group, "cancel": False}
        with self.lock:
            if group:
                for j in self.jobs.values():
                    if j["group"] == group and j["state"] == "queued":
                        j["cancel"] = True
            self.jobs[jid] = job
            for k in [k for k, j in self.jobs.items()
                      if j["state"] not in ("queued", "running") and time.time() - j["t"] > 300]:
                del self.jobs[k]

        def progress(msg, frac=None):
            job["msg"] = msg
            if frac is not None:
                job["frac"] = frac

        def body():
            if job["cancel"]:
                job["state"] = "cancelled"
                job["t"] = time.time()
                return
            job["state"] = "running"
            t0 = time.time()
            try:
                if exclusive:
                    job["result"] = fn(progress)
                else:
                    job["result"] = fn(progress, lambda: job["cancel"])
                job["state"] = "done"
            except UserError as e:
                job["error"] = str(e)
                job["state"] = "cancelled" if job["cancel"] else "error"
            except Exception as e:  # noqa
                traceback.print_exc()
                job["error"] = "%s: %s" % (type(e).__name__, e)
                job["state"] = "error"
            job["secs"] = round(time.time() - t0, 2)
            job["t"] = time.time()
            if App.ws:
                App.ws.last_use = time.time()
            log("job", label, job["state"], job["secs"], "s")

        def run():
            if exclusive:
                with self.run_lock:
                    body()
            else:
                body()
        threading.Thread(target=run, daemon=True).start()
        return {"job": jid}

    def cancel(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if j and j["state"] in ("queued", "running"):
                j["cancel"] = True
        return {"ok": True}

    def get(self, jid):
        with self.lock:
            j = self.jobs.get(jid)
            if not j:
                raise UserError("任務已過期")
            out = dict((k, v) for k, v in j.items() if k not in ("result", "cancel"))
            if j["state"] == "done":
                out["result"] = j["result"]
                j["result"] = None
                j["state"] = "delivered"
        return out


# ================================================================ HTTP
class App(object):
    ws = None
    jobs = None
    token = ""
    native = False
    verbose = False


class Handler(BaseHTTPRequestHandler):
    server_version = "DuiKan/" + VERSION
    protocol_version = "HTTP/1.1"
    timeout = 30

    def log_message(self, fmt, *a):
        if App.verbose:
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        return host in ("127.0.0.1", "localhost", "::1")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _authed(self, qs):
        t = self.headers.get("X-DK-Token") or (qs.get("t") or [""])[0]
        return secrets.compare_digest(t, App.token)

    def _rawbody(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        if not self._host_ok():
            return self._json({"error": "forbidden host"}, 403)
        u = urllib.parse.urlsplit(self.path)
        path = u.path
        qs = urllib.parse.parse_qs(u.query)
        try:
            if method == "GET" and path in ("/", "/index.html"):
                with open(os.path.join(STATIC, "index.html"), encoding="utf-8") as f:
                    html = f.read()
                html = html.replace("__DK_TOKEN__", App.token).replace("__DK_NATIVE__", "1" if App.native else "0")
                return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
            if method == "GET" and path.startswith("/static/"):
                return self._static(path[8:])
            if method == "GET" and path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            if not self._authed(qs):
                return self._json({"error": "unauthorized"}, 401)
            App.ws.last_use = time.time()
            if path.startswith("/api/"):
                p = dict((k, v[-1]) for k, v in qs.items())
                if path == "/api/upload" and method == "POST":
                    return self._json(self.api_upload(p, self._rawbody()))
                if path == "/api/pageimg" and method == "GET":
                    return self._pageimg(p)
                raw = self._rawbody() if method == "POST" else b""
                body = json.loads(raw.decode("utf-8")) if raw else {}
                fn = getattr(self, "api_" + path[5:].replace("/", "_"), None)
                if fn is None:
                    return self._json({"error": "no such api"}, 404)
                return self._json(fn(p, body))
            return self._json({"error": "not found"}, 404)
        except UserError as e:
            return self._json({"error": str(e)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:  # noqa
            traceback.print_exc()
            try:
                return self._json({"error": "%s: %s" % (type(e).__name__, e)}, 500)
            except Exception:
                return

    def _static(self, rel):
        rel = urllib.parse.unquote(rel)
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        ext = os.path.splitext(full)[1]
        ctype = {".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png"}.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    # ---------------------------------------------------------------- 文本
    def api_state(self, p, b):
        ws = App.ws
        return {"version": VERSION, "texts": [ws.info(t) for t in ws.texts],
                "settings": ws.settings, "defaults": DEFAULT_SETTINGS, "ui": ws.ui, "presets": PRESETS,
                "pdf": bool(ws.extractor.helper or ws.extractor.pdftotext)}

    def api_add(self, p, b):
        paths = b.get("paths") or []
        ws = App.ws

        def run(progress):
            added, errors = [], []
            for x, path in enumerate(paths):
                progress("抽取 %s（%d/%d）" % (os.path.basename(path), x + 1, len(paths)), x / float(len(paths)))
                try:
                    added.append(ws.info(ws.add_path(path)))
                except UserError as e:
                    errors.append(str(e))
            return {"added": added, "errors": errors}
        return App.jobs.start(run, "加入文件")

    def api_upload(self, p, data):
        name = os.path.basename(p.get("name") or "未命名")
        ext = os.path.splitext(name)[1].lower().lstrip(".")
        if ext not in INDEXABLE:
            raise UserError("不支持這種格式：%s" % name)
        ws = App.ws
        path = os.path.join(ws.files, uuid.uuid4().hex[:10] + "." + ext)
        with open(path, "wb") as f:
            f.write(data)

        def run(progress):
            progress("抽取 %s" % name)
            try:
                t = ws.add_path(path, os.path.splitext(name)[0], copy=True, orig=name)
            except UserError:
                os.remove(path)
                raise
            return {"added": [ws.info(t)], "errors": []}
        return App.jobs.start(run, "上傳文件")

    def api_paste(self, p, b):
        ws = App.ws
        return ws.info(ws.add_paste(b.get("name"), b.get("content")))

    def api_update(self, p, b):
        ws = App.ws
        with ws.lock:
            t = ws.text(b["id"])
            for k in ("name", "siglum", "on", "pages", "start", "end", "note"):
                if k in b:
                    v = b[k]
                    if isinstance(v, str):
                        v = v.strip()
                    if k == "siglum":
                        if not v:
                            raise UserError("簡稱不能為空")
                        if any(x["siglum"] == v and x["id"] != t["id"] for x in ws.texts):
                            raise UserError("簡稱「%s」已被使用" % v)
                    t[k] = v
            if any(k in b for k in ("pages", "start", "end")):
                ws._drop(t["id"])
            ws.save()
        return ws.info(t)

    def api_remove(self, p, b):
        App.ws.remove(b["id"])
        return {"ok": True}

    def api_reorder(self, p, b):
        ws = App.ws
        with ws.lock:
            order = dict((tid, x) for x, tid in enumerate(b.get("ids") or []))
            ws.texts.sort(key=lambda t: order.get(t["id"], 1e9))
            ws.save()
        return {"ok": True}

    def api_preview(self, p, b):
        ws = App.ws
        P = ws.prepared(p["id"])
        s = int(p.get("from") or 0)
        n = int(p.get("len") or 3000)
        s = max(0, min(s, len(P) - 1))
        e = min(len(P), s + n)
        if not len(P):
            return {"text": "", "n": 0}
        r0 = P.pos[s]
        r1 = P.pos[e] if e < len(P) else P.raw_at(len(P))
        return {"text": P.raw[r0:r1], "n": len(P), "from": s, "to": e,
                "loc": P.loc(s), "page0": P.loc(s)[0], "paged": P.paged}

    def _source(self, tid):
        """文本的來源文件；拖入時保存的副本先試著找回原文件。"""
        ws = App.ws
        t = ws.text(tid)
        relinked = False
        if ws.is_copy(t):
            p = ws.find_original(t)
            if p:
                ws.relink(tid, p)
                relinked = True
        return t, {"ok": True, "copy": ws.is_copy(t), "relinked": relinked, "text": ws.info(t)}

    def api_reveal(self, p, b):
        t, r = self._source(b["id"])
        subprocess.run(["/usr/bin/open", "-R", t["path"]], timeout=15)   # 等它結束，不留殭屍進程
        return r

    def api_open(self, p, b):
        t, r = self._source(b["id"])
        subprocess.run(["/usr/bin/open", t["path"]], timeout=15)
        return r

    def api_relink(self, p, b):
        ws = App.ws
        same = ws.relink(b["id"], b["path"])
        return {"same": same, "text": ws.info(ws.text(b["id"]))}

    # ---------------------------------------------------------------- 設置
    def api_settings(self, p, b):
        ws = App.ws
        with ws.lock:
            for k in DEFAULT_SETTINGS:
                if k in b:
                    ws.settings[k] = b[k]
            if b.get("preset") in PRESETS:
                ws.settings.update(PRESETS[b["preset"]])
            if b.get("reset"):
                ws.settings = dict(DEFAULT_SETTINGS)
            ws.settings.update(params(ws.settings))
            ws.save()
        if b.get("prm_only"):          # 只改段落參數：不必重算各文本信息
            return {"settings": ws.settings, "preset": preset_of(ws.prm())}
        return {"settings": ws.settings, "preset": preset_of(ws.prm()), "texts": [ws.info(t) for t in ws.texts]}

    def api_usage(self, p, b):
        return App.ws.usage()

    def api_clearcache(self, p, b):
        n = App.ws.clear_cache()
        App.ws.release()
        return {"removed": n, "usage": App.ws.usage()}

    def api_ui(self, p, b):
        ws = App.ws
        with ws.lock:
            ws.ui.update(b)
            ws.save()
        return {"ok": True}

    # ---------------------------------------------------------------- 比對
    def api_job(self, p, b):
        return App.jobs.get(p.get("id", ""))

    def api_overview(self, p, b):
        ids = b.get("ids") or []
        if len(ids) < 2:
            raise UserError("至少要勾選兩個文本")
        return App.jobs.start(lambda prog: App.ws.overview(ids, prog), "總覽", group="over")

    def api_pair(self, p, b):
        a, bb = b["a"], b["b"]
        if a == bb:
            raise UserError("請選兩個不同的文本")

        def run(progress):
            progress("尋找平行段落")
            res, ps = App.ws.pair(a, bb)
            return dict(res, prm=App.ws.prm())
        return App.jobs.start(run, "兩本對讀", group="pair")

    def api_passage(self, p, b):
        ws = App.ws
        res, ps = ws.pair(b["a"], b["b"])
        i = int(b["i"])
        if not 0 <= i < len(ps):
            raise UserError("段落不存在")
        rows, st = passage_rows(ws.prepared(b["a"]), ws.prepared(b["b"]), ps[i], ws.normalizer())
        return {"rows": rows, "stat": st}

    def api_runs(self, p, b):
        """點圖放大時：可見範圍內的種子片段（最長的至多 12000 段）。"""
        runs = App.ws.seeds_for(b["a"], b["b"])
        x0, x1, y0, y1 = (float(b[k]) for k in ("x0", "x1", "y0", "y1"))
        vis = [r for r in runs if r[0] < x1 and r[0] + r[2] > x0 and r[1] < y1 and r[1] + r[2] > y0]
        n = len(vis)
        if n > 12000:
            vis = sorted(vis, key=lambda r: -r[2])[:12000]
        return {"runs": [list(r) for r in vis], "n": n}

    def api_locs(self, p, b):
        """若干文本中若干字的位置（頁、行）。"""
        ws = App.ws
        out = []
        for it in b.get("items") or []:
            P = ws.prepared(it["id"])
            n = len(P)
            out.append([P.loc(max(0, min(n - 1, int(i)))) for i in it.get("idx") or []])
        return {"locs": out}

    def api_collate(self, p, b):
        base = b["base"]
        wits = [w for w in (b.get("wits") or []) if w != base]
        if b.get("fit") and isinstance(base, dict):
            # 句段對勘：各本片段按參照片段的範圍對準
            ws = App.ws
            q = ws.prepared(base["id"]).norm[int(base["lo"]):int(base["hi"])]
            fitted = []
            for w in wits:
                if isinstance(w, dict):
                    lo, hi = fit_segment(q, ws.prepared(w["id"]), int(w["lo"]), int(w["hi"]))
                    w = dict(w, lo=lo, hi=hi)
                fitted.append(w)
            wits = fitted
        if not wits:
            raise UserError("至少要有一個校本")
        return App.jobs.start(lambda prog: App.ws.collation(base, wits, prog), "多本對校", group="coll")

    # ---------------------------------------------------------------- 原文預覽
    def api_context(self, p, b):
        ws = App.ws
        pad = max(20, min(3000, int(b.get("pad") or 300)))
        items = []
        for it in b.get("items") or []:
            P = ws.prepared(it["id"])
            r0, r1 = int(it["r0"]), int(it["r1"])
            items.append((P, max(0, r0), max(r0, r1)))
        if not items:
            raise UserError("沒有要預覽的位置")
        out = context_windows(items, pad)
        for it, o in zip(b["items"], out):
            t = ws.text(it["id"])
            o["id"] = it["id"]
            o["pdf"] = t.get("ext") == "pdf" and bool(ws.extractor.helper)
            if o["pdf"]:
                o["pages"] = ws.get_raw(t).count("\f") + 1   # 原件總頁數（不受頁碼範圍設定影響）
        return {"items": out}

    # ---- 原件：頁面圖與逐字位置 ----
    # 都由 dkhelper 現算，只在內存裡留最近幾頁（頁面圖總共不超過 PAGE_CACHE_BYTES），空閒時連同計算緩存一起釋放。
    # 同時最多跑兩個 dkhelper：快速翻過幾百頁時不會一下起幾十個進程；超時的進程由 subprocess 殺掉，不留孤兒。
    _pngs = {}
    _boxes = {}
    _png_lock = threading.Lock()
    _helper_slots = threading.BoundedSemaphore(2)

    @classmethod
    def _run_helper(cls, args):
        with cls._helper_slots:
            return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    @classmethod
    def _cache_get(cls, store, key):
        with cls._png_lock:
            v = store.pop(key, None)
            if v is not None:
                store[key] = v                  # 最近用過的排到最後
            return v

    @classmethod
    def _cache_put(cls, store, key, value, max_items, max_bytes):
        with cls._png_lock:
            store.pop(key, None)
            store[key] = value
            total = sum(len(v) for v in store.values())
            while len(store) > 1 and (len(store) > max_items or total > max_bytes):
                total -= len(store.pop(next(iter(store))))

    @classmethod
    def drop_page_caches(cls):
        with cls._png_lock:
            had = bool(cls._pngs or cls._boxes)
            cls._pngs.clear()
            cls._boxes.clear()
        return had

    # 原件上的標注：一頁文字層的逐字位置，對回原文偏移。
    # 返回 {"o0": 本頁在原文中的起點, "boxes": [[x, y, w, h] 或 0, …]}（坐標為萬分之一），與原文本頁逐字對應。

    def api_pageboxes(self, p, b):
        ws = App.ws
        tid = b.get("id") or p.get("id", "")
        page = int(b.get("p") or p.get("p") or 1)
        t = ws.text(tid)
        if t.get("ext") != "pdf" or not ws.extractor.helper:
            return {"o0": 0, "boxes": []}
        P = ws.prepared(tid)
        k = page - P.page_base
        if not P.paged or k < 0 or k >= len(P.page_starts):
            return {"o0": 0, "boxes": []}
        o0 = P.page_starts[k]
        o1 = P.page_starts[k + 1] - 1 if k + 1 < len(P.page_starts) else len(P.raw)
        seg = P.raw[o0:o1]
        key = (t["path"], page)
        js = Handler._cache_get(Handler._boxes, key)      # 緩存 dkhelper 輸出的 JSON 原文（比解析後的列表小得多）
        if js is None:
            try:
                r = Handler._run_helper([ws.extractor.helper, "boxes", t["path"], str(page)])
                js = r.stdout if r.returncode == 0 else b""
            except (subprocess.SubprocessError, OSError):
                js = b""
            Handler._cache_put(Handler._boxes, key, js, 24, 8 * 1024 * 1024)
        try:
            d = json.loads(js.decode("utf-8")) if js else {}
        except ValueError:
            d = {}
        return {"o0": o0, "boxes": align_boxes(seg, d.get("s") or "", d.get("b") or [])}

    def _pageimg(self, p):
        ws = App.ws
        t = ws.text(p.get("id", ""))
        if t.get("ext") != "pdf" or not ws.extractor.helper:
            return self._json({"error": "沒有原件可預覽"}, 404)
        page = int(p.get("p") or 1)
        width = max(400, min(2400, int(p.get("w") or 1400)))
        key = (t["path"], page, width)
        data = Handler._cache_get(Handler._pngs, key)
        if data is None:
            try:   # 直接從 stdout 取 PNG，不寫臨時文件
                r = Handler._run_helper([ws.extractor.helper, "render", t["path"], str(page), "-", str(width)])
            except (subprocess.SubprocessError, OSError) as e:
                return self._json({"error": str(e)[:200]}, 404)
            if r.returncode != 0 or not r.stdout:
                return self._json({"error": r.stderr.decode("utf-8", "replace")[:200]}, 404)
            data = r.stdout
            Handler._cache_put(Handler._pngs, key, data, 24, PAGE_CACHE_BYTES)
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        # 不讓 WebKit 存進磁盤緩存：每次啟動令牌不同，存了也不會再用，只會越積越多
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- 句段對勘
    def api_search(self, p, b):
        ws = App.ws
        ids = [i for i in (b.get("ids") or []) if i]
        query = b.get("q") or ""
        nz = ws.normalizer()
        from dk_norm import CONTENT_ALNUM_RE, CONTENT_RE
        rx = CONTENT_ALNUM_RE if ws.settings["keep_alnum"] else CONTENT_RE
        q = "".join(rx.findall(nz.norm(query)))
        if len(q) < 2:
            raise UserError("請輸入至少兩個字")
        if len(q) > 400:
            raise UserError("檢索句太長（%d 字）；句段對勘適合一句到一段話，長篇請用「兩本對讀」" % len(q))
        mins = max(0.2, min(1.0, float(b.get("min") or 0.6)))
        mode = "sent" if b.get("mode") == "sent" else "chars"
        n = max(0, min(600, int(b.get("n") or 40)))

        def run(progress):
            res = []
            for x, tid in enumerate(ids):
                t = ws.text(tid)
                progress("檢索 %s（%d/%d）" % (t["siglum"], x + 1, len(ids)), x / float(len(ids) or 1))
                try:
                    P = ws.prepared(tid)
                except UserError as e:
                    res.append({"id": tid, "error": str(e), "hits": []})
                    continue
                res.append({"id": tid, "hits": phrase_hits(P, q, mins, mode, n)})
            return {"q": q, "query": query, "results": res}
        return App.jobs.start(run, "句段檢索", group="search")

    # ---------------------------------------------------------------- Word / Excel
    def api_office(self, p, b):
        import base64
        import dk_office
        fmt = b.get("fmt")
        if fmt == "docx":
            data = dk_office.docx(b.get("blocks") or [], landscape=bool(b.get("landscape")))
        elif fmt == "xlsx":
            data = dk_office.xlsx(b.get("sheets") or [])
        else:
            raise UserError("不支持的格式")
        return {"b64": base64.b64encode(data).decode("ascii"), "size": len(data)}

    def api_marks(self, p, b):
        ws = App.ws
        with ws.lock:
            base = b["base"]
            m = ws.marks.setdefault(base, {})
            for k, v in (b.get("set") or {}).items():
                if v is None:
                    m.pop(k, None)
                else:
                    m[k] = v
            ws.save()
            return {"marks": m}

    def api_getmarks(self, p, b):
        return {"marks": App.ws.marks.get(p.get("base", ""), {})}


PAGE_CACHE_BYTES = 32 * 1024 * 1024   # 原件頁面圖在內存裡最多留 32 MB


def align_boxes(seg, s, b):
    """文字層逐字位置（按 UTF-16 單位）→ 原文 seg 逐字（按碼位）。
    原文抽取時做過 \\r\\n→\\n、去掉 \\x00、頁內 \\f→\\n，這裡照做一遍再對齊；
    兩邊不完全一致時（如頁眉換成了 \\x01）用最長公共片段對齊，對不上的字不標。"""
    chars, boxes = [], []
    u = 0
    n = len(s)
    for i, c in enumerate(s):
        box = b[u] if u < len(b) else 0
        u += 2 if ord(c) > 0xFFFF else 1
        if c == "\x00" or (c == "\r" and i + 1 < n and s[i + 1] == "\n"):
            continue
        if c in "\r\f":
            c = "\n"
        chars.append(c)
        boxes.append(box)
    text = "".join(chars)
    if text == seg:
        return boxes
    if len(text) == len(seg) and all(x == y or x == "\x01" for x, y in zip(seg, text)):
        # 只有頁眉換成了 \x01（長度不變）；頁眉不參與比對，也不標
        return [0 if x == "\x01" else bx for x, bx in zip(seg, boxes)]
    out = [0] * len(seg)
    sm = difflib.SequenceMatcher(None, seg, text, autojunk=False)
    for a, j, size in sm.get_matching_blocks():
        out[a:a + size] = boxes[j:j + size]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5918)
    ap.add_argument("--data", default=os.path.expanduser("~/Library/Application Support/DuiKan"))
    ap.add_argument("--cache", default=os.path.expanduser("~/Library/Caches/DuiKan"))
    ap.add_argument("--helper", default="")
    ap.add_argument("--token", default="")
    ap.add_argument("--native", action="store_true")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()
    App.ws = Workspace(a.data, a.cache, a.helper or None)
    App.jobs = Jobs()
    App.token = a.token or secrets.token_hex(16)
    App.native = a.native
    App.verbose = a.verbose
    srv = None
    for port in [a.port] + list(range(a.port + 1, a.port + 20)):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if srv is None:
        sys.exit("沒有可用的端口")
    srv.daemon_threads = True

    def housekeeping():
        # 空閒 5 分鐘：釋放計算緩存；每 6 小時：清理磁盤上的無用文件
        last_prune = time.time()
        while True:
            time.sleep(60)
            try:
                ws = App.ws
                if time.time() - ws.last_use > 300 and not App.jobs.busy():
                    ws.release()
                    if Handler.drop_page_caches():
                        log("空閒，已釋放原件頁面緩存")
                if time.time() - last_prune > 6 * 3600:
                    ws.prune_disk()
                    last_prune = time.time()
            except Exception:
                traceback.print_exc()
    threading.Thread(target=housekeeping, daemon=True).start()
    threading.Thread(target=App.ws.relink_all, daemon=True).start()
    url = "http://127.0.0.1:%d/?t=%s" % (srv.server_address[1], App.token)
    print("DUIKAN_READY " + url, flush=True)
    log("serving", url.split("?")[0], "data", a.data)
    if a.native:
        # 父進程（App 外殼）退出時 stdin 關閉，隨之退出
        def watch():
            try:
                while sys.stdin.read(1):
                    pass
            except Exception:
                pass
            os._exit(0)
        threading.Thread(target=watch, daemon=True).start()
    elif not a.no_browser:
        subprocess.Popen(["/usr/bin/open", url])
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    if os.environ.get("MallocSpaceEfficient") != "1" and sys.platform == "darwin":
        os.environ["MallocSpaceEfficient"] = "1"
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except OSError:
            pass
    main()
