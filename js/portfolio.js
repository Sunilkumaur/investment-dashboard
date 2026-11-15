/*
 * Actual-portfolio tracker: transaction ledger, FIFO lot matching, realized vs unrealized gains,
 * tax on realized gains (by FY) and an estimate of tax if everything were redeemed today.
 * Stored only in this browser's localStorage. Nothing is sent anywhere.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./tax-engine.js'));
  else root.Portfolio = factory(root.FinUtil, root.TaxEngine);
})(typeof self !== 'undefined' ? self : this, function (U, TaxEngine) {
  'use strict';
  const KEY = 'siird.portfolio.v1';

  function load(storage) { try { const v = JSON.parse(storage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function save(storage, txns) { try { storage.setItem(KEY, JSON.stringify(txns)); return true; } catch (e) { return false; } }

  /** Fill in the missing one of amount / units / nav and validate. Returns {txn, errors}. */
  function normalise(t) {
    const e = [];
    const x = Object.assign({}, t);
    x.type = (x.type || 'BUY').toUpperCase();
    x.amount = x.amount === '' || x.amount == null ? null : +x.amount;
    x.units = x.units === '' || x.units == null ? null : +x.units;
    x.nav = x.nav === '' || x.nav == null ? null : +x.nav;
    x.exitLoad = +x.exitLoad || 0;
    if (!U.parseDate(x.date)) e.push('Date is required.');
    if (!x.fundName) e.push('Fund name is required.');
    if (!x.taxClass) e.push('Tax class is required.');
    const known = [x.amount, x.units, x.nav].filter(v => v != null && isFinite(v) && v > 0).length;
    if (known < 2) e.push('Enter at least two of amount, units and NAV.');
    if (known >= 2) {
      if (x.units == null) x.units = x.amount / x.nav;
      else if (x.nav == null) x.nav = x.amount / x.units;
      else if (x.amount == null) x.amount = x.units * x.nav - (x.type === 'SELL' ? x.exitLoad : 0);
    }
    [x.amount, x.units, x.nav].forEach(v => { if (v != null && (!isFinite(v) || v <= 0)) e.push('Amount, units and NAV must be positive numbers.'); });
    x.date = U.iso(x.date);
    x.key = x.schemeCode ? String(x.schemeCode) : x.fundName.trim().toLowerCase();
    return { txn: x, errors: [...new Set(e)] };
  }

  /**
   * Compute holdings and gains.
   * latest: { [key]: { nav, date, source } }  (key = schemeCode string)
   */
  function compute(txns, latest, rules, taxProfile, today = U.todayISO()) {
    const byKey = {};
    const errors = [];
    [...txns].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.type === 'BUY' ? -1 : 1)).forEach(t => {
      const h = byKey[t.key] = byKey[t.key] || { key: t.key, name: t.fundName, schemeCode: t.schemeCode, taxClass: t.taxClass, lots: [], realized: [], flows: [] };
      if (t.type === 'BUY') {
        h.lots.push({ date: t.date, units: t.units, costPerUnit: t.amount / t.units, txnId: t.id });
        h.flows.push({ date: t.date, amount: -t.amount });
      } else {
        let remaining = t.units;
        const held = U.sum(h.lots, l => l.units);
        if (remaining > held + 1e-6) { errors.push(`${t.fundName}: sale on ${t.date} of ${t.units.toFixed(3)} units exceeds ${held.toFixed(3)} units held.`); remaining = held; }
        const proceedsPerUnit = t.amount / t.units;   // amount = net proceeds after exit load (deductible)
        while (remaining > 1e-9 && h.lots.length) {
          const lot = h.lots[0];
          const take = Math.min(lot.units, remaining);
          h.realized.push({ buyDate: lot.date, sellDate: t.date, units: take, cost: take * lot.costPerUnit, proceeds: take * proceedsPerUnit, taxClass: h.taxClass, name: h.name });
          lot.units -= take; remaining -= take;
          if (lot.units <= 1e-9) h.lots.shift();
        }
        h.flows.push({ date: t.date, amount: t.amount });
      }
    });

    const holdings = Object.values(byKey).map(h => {
      const units = U.sum(h.lots, l => l.units);
      const cost = U.sum(h.lots, l => l.units * l.costPerUnit);
      const L = latest[h.key] || (h.schemeCode && latest[String(h.schemeCode)]);
      const value = L && isFinite(L.nav) ? units * L.nav : null;
      return Object.assign(h, { units, cost, nav: L ? L.nav : null, navDate: L ? L.date : null, navSource: L ? L.source : null, value, unrealized: value != null ? value - cost : null });
    });

    const realizedLots = holdings.flatMap(h => h.realized.map((r, i) => Object.assign({ id: `${h.key}:${i}`, label: h.name }, r)));
    const realizedTax = realizedLots.length ? TaxEngine.computeTax(rules, realizedLots, taxProfile) : null;

    const openLots = holdings.filter(h => h.nav != null).flatMap(h => h.lots.filter(l => l.units > 1e-9).map((l, i) => ({
      id: `${h.key}:o${i}`, label: h.name, taxClass: h.taxClass, buyDate: l.date, sellDate: today, cost: l.units * l.costPerUnit, proceeds: l.units * h.nav
    })));
    const unrealizedTax = openLots.length ? TaxEngine.computeTax(rules, openLots, taxProfile) : null;

    const invested = U.sum(holdings, h => h.cost);
    const valued = holdings.filter(h => h.value != null);
    const value = U.sum(valued, h => h.value);
    const flows = holdings.flatMap(h => h.flows);
    if (value > 0) flows.push({ date: today, amount: value });
    const missingNav = holdings.filter(h => h.units > 1e-9 && h.nav == null).map(h => h.name);

    return {
      holdings, errors, missingNav,
      invested, value, unrealized: value - U.sum(valued, h => h.cost),
      realizedGain: realizedTax ? realizedTax.totalGain : 0, realizedTax,
      unrealizedTax, estRedemption: value - (unrealizedTax ? unrealizedTax.tax : 0),
      xirr: U.xirr(flows)
    };
  }

  const CSV_COLS = ['id', 'type', 'date', 'fundName', 'schemeCode', 'taxClass', 'amount', 'units', 'nav', 'exitLoad', 'note'];
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function toCSV(rows, cols) { return [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\r\n'); }
  function transactionsCSV(txns) { return toCSV(txns, CSV_COLS); }
  function holdingsCSV(res) {
    return toCSV(res.holdings.map(h => ({ fund: h.name, schemeCode: h.schemeCode || '', units: h.units.toFixed(4), invested: h.cost.toFixed(2), nav: h.nav ?? '', navDate: h.navDate ?? '', value: h.value != null ? h.value.toFixed(2) : '', unrealized: h.unrealized != null ? h.unrealized.toFixed(2) : '' })),
      ['fund', 'schemeCode', 'units', 'invested', 'nav', 'navDate', 'value', 'unrealized']);
  }
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    const [head, ...body] = rows.filter(r => r.some(c => c.trim() !== ''));
    if (!head) return [];
    return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
  }

  return { KEY, load, save, normalise, compute, transactionsCSV, holdingsCSV, parseCSV };
});
