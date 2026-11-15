/* Shared date, number and XIRR helpers. Works in the browser (window.FinUtil) and Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FinUtil = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;

  /** Parse 'YYYY-MM-DD', 'DD-MM-YYYY' or a Date into a UTC-midnight Date. Returns null if invalid. */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return mk(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);           // mfapi: DD-MM-YYYY
    if (m) return mk(+m[3], +m[2], +m[1]);
    m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);    // AMFI: 13-Nov-2026
    if (m) {
      const mi = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase());
      if (mi >= 0) return mk(+m[3], mi + 1, +m[1]);
    }
    return null;
    function mk(y, mo, d) {
      const dt = new Date(Date.UTC(y, mo - 1, d));
      return (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) ? dt : null;
    }
  }
  const iso = d => { d = parseDate(d); return d ? d.toISOString().slice(0, 10) : ''; };
  function todayISO() { const n = new Date(); return iso(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); }

  /** Add calendar months, clamping to month end (31 Jan + 1 month = 28/29 Feb). */
  function addMonths(d, n) {
    d = parseDate(d);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }
  const addYears = (d, n) => addMonths(d, Math.round(n * 12));
  const addDays = (d, n) => new Date(parseDate(d).getTime() + n * DAY);
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY);
  /** Indian financial year start year: FY 2026-27 → 2026. */
  function fyStart(d) { d = parseDate(d); return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; }
  const fyLabel = y => `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  const yearsBetween = (a, b) => daysBetween(a, b) / 365;

  /**
   * XIRR on dated cash flows (negative = money in, positive = money out). Actual/365.
   * Newton–Raphson with bisection fallback. Returns NaN if it cannot be solved.
   */
  function xirr(flows) {
    const fl = flows.filter(f => f && isFinite(f.amount) && f.amount !== 0).map(f => ({ t: parseDate(f.date), a: f.amount }));
    if (fl.length < 2 || !fl.some(f => f.a > 0) || !fl.some(f => f.a < 0)) return NaN;
    const t0 = Math.min(...fl.map(f => f.t));
    const y = fl.map(f => ({ y: (f.t - t0) / DAY / 365, a: f.a }));
    const npv = r => y.reduce((s, f) => s + f.a / Math.pow(1 + r, f.y), 0);
    const dnpv = r => y.reduce((s, f) => s - f.y * f.a / Math.pow(1 + r, f.y + 1), 0);
    let r = 0.1;
    for (let i = 0; i < 60; i++) {
      const v = npv(r), dv = dnpv(r);
      if (!isFinite(v) || !isFinite(dv) || dv === 0) break;
      const nr = r - v / dv;
      if (nr <= -0.9999 || !isFinite(nr)) break;
      if (Math.abs(nr - r) < 1e-10) return nr;
      r = nr;
    }
    let lo = -0.9999, hi = 10, flo = npv(lo), fhi = npv(hi);
    if (!(flo * fhi < 0)) return NaN;
    for (let i = 0; i < 300; i++) {
      const mid = (lo + hi) / 2, fm = npv(mid);
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  const round = (v, dp = 2) => { const f = Math.pow(10, dp); return Math.round((v + Number.EPSILON) * f) / f; };
  const sum = (arr, fn = x => x) => arr.reduce((s, x) => s + (fn(x) || 0), 0);

  function inr(v, dp = 0) {
    if (v == null || !isFinite(v)) return '—';
    const neg = v < 0; v = Math.abs(v);
    const s = v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return (neg ? '−' : '') + '₹' + s;
  }
  const pct = (v, dp = 2) => (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(dp) + '%';

  return { DAY, parseDate, iso, todayISO, addMonths, addYears, addDays, daysBetween, yearsBetween, fyStart, fyLabel, xirr, num, round, sum, inr, pct };
});
