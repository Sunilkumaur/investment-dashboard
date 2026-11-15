#!/usr/bin/env python3
"""
Local server for the Smart Indian Investment Research & Wealth Dashboard.

* Serves the dashboard (project root) as static files.
* /api/health                     -> {"ok": true}
* /api/nav/latest?codes=1,2,3     -> latest NAVs from AMFI's official NAVAll.txt (cached 6 h)
* /api/nav/history/<schemeCode>   -> full NAV history via mfapi.in (cached 12 h on disk)
* /api/search?q=text              -> scheme search over the cached AMFI file

Standard library only (no pip install). Binds to 127.0.0.1 so nothing is exposed to your network.
No API keys are used: AMFI and mfapi.in are free, public, key-less sources.
If an upstream source fails, the last good copy is served with "stale": true and its timestamp.

Run:  python backend/server.py            (then open http://127.0.0.1:8000/)
      python backend/server.py --port 8080
"""
import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
AMFI_URL = "https://www.amfiindia.com/spages/NAVAll.txt"
MFAPI_URL = "https://api.mfapi.in/mf/{}"
AMFI_TTL = 6 * 3600
HIST_TTL = 12 * 3600
UA = "Mozilla/5.0 (compatible; local-investment-dashboard/1.0)"

os.makedirs(CACHE, exist_ok=True)
_lock = threading.Lock()
_amfi = {"fetched": 0.0, "rows": {}, "stale": False, "error": None}


def _now_iso(ts=None):
    return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).isoformat()


def _download(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # follows the AMFI 302 redirect
        return r.read()


def _parse_amfi(text):
    rows = {}
    for line in text.splitlines():
        parts = line.split(";")
        if len(parts) < 8 or not parts[0].strip().isdigit():
            continue
        code, isin1, isin2, name = parts[0].strip(), parts[1].strip(), parts[2].strip(), parts[3].strip()
        plan, option, nav, date = parts[4].strip(), parts[5].strip(), parts[6].strip(), parts[7].strip()
        try:
            navf = float(nav)
        except ValueError:
            continue
        rows[code] = {"schemeCode": int(code), "schemeName": " – ".join(x for x in (name, plan, option) if x),
                      "isin": isin1 if isin1 != "-" else None, "nav": navf, "date": date}
    return rows


def amfi_rows():
    """Return parsed AMFI NAV rows, refreshing the cache when older than AMFI_TTL."""
    path = os.path.join(CACHE, "NAVAll.txt")
    with _lock:
        if _amfi["rows"] and time.time() - _amfi["fetched"] < AMFI_TTL:
            return _amfi
        try:
            raw = _download(AMFI_URL).decode("utf-8", "replace")
            rows = _parse_amfi(raw)
            if len(rows) < 1000:
                raise ValueError("AMFI file looks truncated (%d rows)" % len(rows))
            with open(path, "w", encoding="utf-8") as f:
                f.write(raw)
            _amfi.update(fetched=time.time(), rows=rows, stale=False, error=None)
        except Exception as e:  # serve last good copy, clearly marked stale
            if os.path.exists(path):
                with open(path, encoding="utf-8") as f:
                    _amfi.update(rows=_parse_amfi(f.read()), fetched=os.path.getmtime(path), stale=True, error=str(e))
            else:
                _amfi.update(stale=True, error=str(e))
        return _amfi


def nav_history(code):
    path = os.path.join(CACHE, "hist_%s.json" % code)
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < HIST_TTL:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data["fetchedAt"], data["stale"] = _now_iso(os.path.getmtime(path)), False
        return data
    try:
        data = json.loads(_download(MFAPI_URL.format(code), timeout=30))
        if not data.get("data"):
            raise ValueError("empty history")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        data["fetchedAt"], data["stale"] = _now_iso(), False
        return data
    except Exception as e:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            data["fetchedAt"], data["stale"], data["error"] = _now_iso(os.path.getmtime(path)), True, str(e)
            return data
        raise


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") or self.path.startswith("/config/") else "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/api/health":
                return self._json({"ok": True, "time": _now_iso()})
            if u.path == "/api/nav/latest":
                codes = [c for c in (q.get("codes", [""])[0]).split(",") if c.strip().isdigit()][:200]
                a = amfi_rows()
                navs = {c: a["rows"][c] for c in codes if c in a["rows"]}
                return self._json({"source": AMFI_URL, "fetchedAt": _now_iso(a["fetched"]) if a["fetched"] else None,
                                   "stale": a["stale"], "error": a["error"], "navs": navs,
                                   "missing": [c for c in codes if c not in navs]})
            m = re.fullmatch(r"/api/nav/history/(\d{3,7})", u.path)
            if m:
                return self._json(nav_history(m.group(1)))
            if u.path == "/api/search":
                term = (q.get("q", [""])[0]).lower().strip()
                if len(term) < 3:
                    return self._json({"results": []})
                words = term.split()
                res = [r for r in amfi_rows()["rows"].values() if all(w in r["schemeName"].lower() for w in words)][:40]
                return self._json({"results": [{"schemeCode": r["schemeCode"], "schemeName": r["schemeName"]} for r in res]})
            if u.path.startswith("/api/"):
                return self._json({"error": "not found"}, 404)
        except Exception as e:
            return self._json({"error": str(e)}, 502)
        if u.path.startswith("/backend/"):          # never serve backend source/cache as static files
            return self._json({"error": "forbidden"}, 403)
        return super().do_GET()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print("Dashboard: http://%s:%d/   (Ctrl+C to stop)" % (args.host, args.port))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
