/*
 * Financial data integration.
 * Order of preference for NAV data:
 *   1. Local Python backend (backend/server.py) — official AMFI NAVAll.txt for latest NAVs, and a
 *      disk-cached proxy of mfapi.in for history. No API keys are involved anywhere.
 *   2. mfapi.in directly from the browser (free, CORS-enabled mirror of AMFI data).
 *   3. The last successfully computed metrics saved in localStorage, clearly marked STALE.
 * Nothing is ever invented: if all three fail the value is "unavailable".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else root.DataService = factory(root.FinUtil);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  function create(settings, deps = {}) {
    const fetchImpl = deps.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const storage = deps.storage || safeStorage();
    const cfg = settings.data;
    const log = [];
    let backend = null; // null = unknown, true/false after probe

    function note(level, msg) { log.unshift({ at: new Date().toISOString(), level, msg }); if (log.length > 200) log.pop(); }

    async function getJSON(url, timeoutMs = 20000) {
      if (!fetchImpl) throw new Error('fetch unavailable');
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
      try {
        const r = await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { if (timer) clearTimeout(timer); }
    }

    async function probeBackend() {
      if (backend !== null) return backend;
      try { const h = await getJSON((cfg.backendBase || '') + '/api/health', 3000); backend = !!(h && h.ok); }
      catch (e) { backend = false; }
      note('info', backend ? 'Local backend detected — using official AMFI NAV file via backend.' : 'No local backend — fetching NAV history directly from mfapi.in.');
      return backend;
    }

    /** mfapi format → ascending [{d:'YYYY-MM-DD', nav:Number}] */
    function parseHistory(json) {
      if (!json || !Array.isArray(json.data)) return [];
      return json.data.map(p => ({ d: U.iso(p.date), nav: parseFloat(p.nav) }))
        .filter(p => p.d && isFinite(p.nav) && p.nav > 0)
        .sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    }

    async function getHistory(code) {
      const errors = [];
      if (await probeBackend()) {
        try {
          const j = await getJSON(`${cfg.backendBase || ''}/api/nav/history/${code}`);
          const hist = parseHistory(j);
          if (hist.length) return { code, hist, meta: j.meta || {}, source: j.stale ? 'backend cache (stale — upstream unreachable)' : 'backend → mfapi.in', fetchedAt: j.fetchedAt || new Date().toISOString(), upstreamStale: !!j.stale };
          errors.push('backend returned no data');
        } catch (e) { errors.push('backend: ' + e.message); }
      }
      try {
        const j = await getJSON(`${cfg.mfapiBase}${code}`);
        const hist = parseHistory(j);
        if (hist.length) return { code, hist, meta: j.meta || {}, source: 'mfapi.in', fetchedAt: new Date().toISOString() };
        errors.push('mfapi returned no data');
      } catch (e) { errors.push('mfapi: ' + e.message); }
      note('warn', `NAV history for ${code} unavailable (${errors.join('; ')}).`);
      return { code, hist: [], error: errors.join('; ') };
    }

    /** Official latest NAVs from AMFI NAVAll.txt via backend. Returns null when backend is absent. */
    async function getLatestOfficial(codes) {
      if (!(await probeBackend())) return null;
      try {
        const j = await getJSON(`${cfg.backendBase || ''}/api/nav/latest?codes=${codes.join(',')}`);
        if (j.stale) note('warn', `AMFI NAV file could not be refreshed; serving copy fetched ${j.fetchedAt}.`);
        return j;
      } catch (e) { note('warn', 'AMFI latest NAV via backend failed: ' + e.message); return null; }
    }

    async function searchSchemes(q) {
      if (!q || q.length < 3) return [];
      if (await probeBackend()) {
        try { const j = await getJSON(`${cfg.backendBase || ''}/api/search?q=${encodeURIComponent(q)}`); if (Array.isArray(j.results)) return j.results; } catch (e) { /* fall through */ }
      }
      try { const j = await getJSON(`${cfg.mfapiBase}search?q=${encodeURIComponent(q)}`); return (j || []).map(r => ({ schemeCode: r.schemeCode, schemeName: r.schemeName })); }
      catch (e) { note('warn', 'Scheme search failed: ' + e.message); return []; }
    }

    // ---- metrics cache (per-viewer convenience; derived data only, no personal data) ----
    function loadCache() { try { return JSON.parse(storage.getItem(cfg.metricsCacheKey) || '{}'); } catch (e) { return {}; } }
    function saveCache(c) { try { storage.setItem(cfg.metricsCacheKey, JSON.stringify(c)); } catch (e) { /* quota or disabled */ } }
    function cacheMetrics(code, entry) { const c = loadCache(); c[code] = entry; saveCache(c); }
    function cachedMetrics(code) { return loadCache()[code] || null; }

    function freshness(latestNavDate, fetchedAt, today = U.todayISO()) {
      const navAge = latestNavDate ? U.daysBetween(latestNavDate, today) : null;
      const fetchAgeH = fetchedAt ? (Date.now() - new Date(fetchedAt).getTime()) / 3600000 : null;
      return {
        navAgeDays: navAge,
        navStale: navAge == null || navAge > cfg.navStaleAfterDays,
        fetchAgeHours: fetchAgeH,
        cacheStale: fetchAgeH == null || fetchAgeH > cfg.cacheStaleAfterHours
      };
    }

    /** Run tasks with limited concurrency. */
    async function pool(items, n, fn) {
      const res = new Array(items.length); let i = 0;
      const workers = Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); } });
      await Promise.all(workers); return res;
    }

    return { getHistory, getLatestOfficial, searchSchemes, cacheMetrics, cachedMetrics, freshness, pool, log, probeBackend, parseHistory, isBackend: () => backend };
  }

  function safeStorage() {
    try { if (typeof localStorage !== 'undefined') { localStorage.getItem('x'); return localStorage; } } catch (e) { /* blocked */ }
    const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
  }

  return { create, safeStorage };
});
