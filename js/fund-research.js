/*
 * Fund research: metrics computed from real NAV history, multi-factor scoring and a
 * rule-based model-allocation builder. No metric here is typed in by hand — if the NAV
 * history is missing or too short, the metric is null and shown as "unavailable".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else root.FundResearch = factory(root.FinUtil);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  /** Binary search: last NAV point on or before `date`. hist = [{d:'YYYY-MM-DD', nav}] ascending. */
  function navOnOrBefore(hist, date) {
    const t = U.iso(date);
    let lo = 0, hi = hist.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (hist[m].d <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 ? hist[ans] : null;
  }

  function cagrBetween(hist, from, to, maxGapDays = 10) {
    const a = navOnOrBefore(hist, from), b = navOnOrBefore(hist, to);
    if (!a || !b || a.d === b.d) return null;
    if (U.daysBetween(a.d, U.iso(from)) > maxGapDays) return null;   // history doesn't reach back far enough
    const days = U.daysBetween(a.d, b.d);
    return Math.pow(b.nav / a.nav, 365 / days) - 1;
  }

  function maxDrawdown(points) {
    let peak = -Infinity, mdd = 0, peakD = null, trough = null, peakAt = null;
    for (const p of points) {
      if (p.nav > peak) { peak = p.nav; peakD = p.d; }
      const dd = p.nav / peak - 1;
      if (dd < mdd) { mdd = dd; trough = p.d; peakAt = peakD; }
    }
    return { mdd, peak: peakAt, trough };
  }

  /**
   * Detect unit splits / consolidations in a raw NAV series (e.g. GOLDBEES 1:100 on 23 Dec 2019)
   * — a one-day NAV change beyond ×0.5…×2 is not a market move for a mutual fund or ETF.
   * Earlier NAVs are rescaled so returns and drawdowns are continuous. Returns {hist, adjustments}.
   */
  function adjustSplits(hist, lo = 0.5, hi = 2) {
    if (!hist || hist.length < 2) return { hist: hist || [], adjustments: [] };
    const adjustments = [];
    for (let i = 1; i < hist.length; i++) {
      const r = hist[i].nav / hist[i - 1].nav;
      if (r < lo || r > hi) adjustments.push({ index: i, date: hist[i].d, ratio: r });
    }
    if (!adjustments.length) return { hist, adjustments };
    const out = hist.map(p => ({ d: p.d, nav: p.nav }));
    // walk backwards applying the cumulative factor to everything before each break
    let factor = 1, k = adjustments.length - 1;
    for (let i = out.length - 1; i >= 0; i--) {
      while (k >= 0 && i < adjustments[k].index) { factor *= adjustments[k].ratio; k--; }
      out[i].nav = out[i].nav * factor;
    }
    return { hist: out, adjustments: adjustments.map(a => ({ date: a.date, ratio: a.ratio })) };
  }

  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  /**
   * Compute research metrics from NAV history.
   * opts: { rfPct, windows:[{id,label,from,to}] }
   */
  function computeMetrics(hist, opts = {}) {
    const out = { available: false };
    if (!hist || hist.length < 2) return out;
    const last = hist[hist.length - 1], first = hist[0];
    const rf = (opts.rfPct ?? 6) / 100;
    out.available = true;
    out.latestNav = last.nav; out.latestDate = last.d; out.firstDate = first.d;
    out.historyYears = U.yearsBetween(first.d, last.d);
    const prev = hist[hist.length - 2];
    out.dayChange = prev ? last.nav / prev.nav - 1 : null;

    const r1 = navOnOrBefore(hist, U.addYears(last.d, -1));
    out.ret1y = (r1 && U.daysBetween(r1.d, U.iso(U.addYears(last.d, -1))) <= 10) ? last.nav / r1.nav - 1 : null;
    out.cagr3 = cagrBetween(hist, U.addYears(last.d, -3), last.d);
    out.cagr5 = cagrBetween(hist, U.addYears(last.d, -5), last.d);
    out.cagr10 = cagrBetween(hist, U.addYears(last.d, -10), last.d);

    // Volatility, Sharpe, Sortino over the last 3 years of daily NAVs
    const from3 = U.iso(U.addYears(last.d, -3));
    if (first.d <= from3) {
      const pts = hist.filter(p => p.d >= from3);
      const rets = [];
      for (let i = 1; i < pts.length; i++) rets.push(pts[i].nav / pts[i - 1].nav - 1);
      const obsPerYear = rets.length / U.yearsBetween(pts[0].d, last.d);
      const mean = U.sum(rets) / rets.length;
      const sd = Math.sqrt(U.sum(rets, r => (r - mean) ** 2) / (rets.length - 1));
      const rfD = Math.pow(1 + rf, 1 / obsPerYear) - 1;
      const dd = Math.sqrt(U.sum(rets, r => Math.min(0, r - rfD) ** 2) / rets.length);
      out.stdev3 = sd * Math.sqrt(obsPerYear);
      out.downsideDev3 = dd * Math.sqrt(obsPerYear);
      out.sharpe3 = out.cagr3 != null && out.stdev3 > 0 ? (out.cagr3 - rf) / out.stdev3 : null;
      out.sortino3 = out.cagr3 != null && out.downsideDev3 > 0 ? (out.cagr3 - rf) / out.downsideDev3 : null;
    } else { out.stdev3 = out.sharpe3 = out.sortino3 = null; }

    const from5 = U.iso(U.addYears(last.d, -5));
    out.maxDD5 = first.d <= from5 ? maxDrawdown(hist.filter(p => p.d >= from5)) : null;
    out.maxDDAll = maxDrawdown(hist);

    // Rolling 3-year CAGR sampled monthly
    const roll = [];
    for (let d = U.addYears(first.d, 3); U.iso(d) <= last.d; d = U.addMonths(d, 1)) {
      const c = cagrBetween(hist, U.addYears(d, -3), d);
      if (c != null) roll.push(c);
    }
    out.rolling3 = roll.length ? {
      count: roll.length, median: median(roll), min: Math.min(...roll), max: Math.max(...roll),
      pctPositive: roll.filter(r => r > 0).length / roll.length,
      pctAboveRf: roll.filter(r => r > rf).length / roll.length
    } : null;

    out.corrections = (opts.windows || []).map(w => {
      const a = navOnOrBefore(hist, w.from), b = navOnOrBefore(hist, w.to);
      const ok = a && b && U.daysBetween(a.d, w.from) <= 10 && a.d !== b.d;
      return { id: w.id, label: w.label, from: w.from, to: w.to, ret: ok ? b.nav / a.nav - 1 : null };
    });
    out.rfPctUsed = rf * 100;
    return out;
  }

  /** Percentile score 0–100 among peers; higher raw value = better. Ties share the average rank. n=1 → 50. */
  function percentileScores(values) {
    const idx = values.map((v, i) => ({ v, i })).filter(x => x.v != null && isFinite(x.v));
    const res = values.map(() => null);
    if (idx.length === 1) { res[idx[0].i] = 50; return res; }
    const sorted = [...idx].sort((a, b) => a.v - b.v);
    sorted.forEach((x, k) => {
      const ties = sorted.filter(y => y.v === x.v);
      const first = sorted.indexOf(ties[0]);
      const avgRank = first + (ties.length - 1) / 2;
      res[x.i] = 100 * avgRank / (sorted.length - 1);
    });
    return res;
  }

  /**
   * Score funds. items: [{ fund, category, metrics, terEffective (verified only) }]
   * Peers = same asset class. Returns items with .score = { total, components, missing[] }.
   */
  function scoreFunds(items, weights) {
    const groups = {};
    items.forEach((it, i) => { const g = it.category.assetClass; (groups[g] = groups[g] || []).push(i); });
    const raw = items.map(it => {
      const m = it.metrics || {};
      return {
        consistencyA: m.rolling3 ? m.rolling3.median : null,
        consistencyB: m.rolling3 ? m.rolling3.pctAboveRf : null,
        riskAdjusted: m.sortino3 ?? null,
        downside: m.maxDD5 ? m.maxDD5.mdd : null,
        cost: it.fund.ter != null ? -it.fund.ter : null,
        scaleA: it.fund.aumCr != null ? Math.log10(it.fund.aumCr) : null,
        scaleB: m.historyYears != null ? Math.min(10, m.historyYears) : null,
        return: m.cagr5 ?? m.cagr3 ?? null
      };
    });
    const comp = items.map(() => ({}));
    Object.values(groups).forEach(ids => {
      Object.keys(raw[0] || {}).forEach(k => {
        const sc = percentileScores(ids.map(i => raw[i][k]));
        ids.forEach((i, j) => { comp[i][k] = sc[j]; });
      });
    });
    const W = weights, wSum = U.sum(Object.values(W));
    items.forEach((it, i) => {
      const c = comp[i], missing = [];
      const avg = (a, b, label) => {
        if (a == null && b == null) { missing.push(label); return 50; }
        if (a == null) return b; if (b == null) return a; return (a + b) / 2;
      };
      const one = (v, label) => { if (v == null) { missing.push(label); return 50; } return v; };
      const components = {
        consistency: avg(c.consistencyA, c.consistencyB, 'consistency'),
        riskAdjusted: one(c.riskAdjusted, 'riskAdjusted'),
        downside: one(c.downside, 'downside'),
        cost: one(c.cost, 'cost'),
        scaleHistory: avg(c.scaleA, c.scaleB, 'scaleHistory'),
        return: one(c.return, 'return')
      };
      const total = U.sum(Object.keys(W), k => (components[k] ?? 50) * W[k]) / (wSum || 1);
      it.score = { total, components, missing };
    });
    return items;
  }

  /**
   * Build a model allocation for a risk profile.
   * ctx: { profile, capital, sip, horizonYears, items (scored), categories, rules: selectionRules, maxFunds, slabRatePct, roundTo }
   */
  function buildModelPortfolio(ctx) {
    const { profile, capital, sip, horizonYears, items, categories, rules } = ctx;
    const roundTo = rules.roundAmountsTo || 100;
    const notes = [];
    let sleeves = profile.sleeves.map(s => Object.assign({}, s, { pct: s.pct }));
    const reasonsFor = {};             // fundId -> rejection reasons
    const reject = (id, r) => { (reasonsFor[id] = reasonsFor[id] || []).push(r); };

    const eligibleCats = s => s.categories.filter(c => {
      const cat = categories[c];
      if (rules.excludeIfHorizonBelowCategoryMinHold && cat && horizonYears < cat.minHoldYears) return false;
      return true;
    });

    let picks = {};
    for (let iter = 0; iter < 6; iter++) {
      picks = {};
      let moved = false;
      for (const s of sleeves) {
        if (s.pct <= 0) continue;
        const cats = eligibleCats(s);
        const amount = capital * s.pct / 100, sipAmt = sip * s.pct / 100;
        let cands = items.filter(it => cats.includes(it.fund.category)).sort((a, b) => b.score.total - a.score.total);
        if (s.id === 'stability' && ctx.slabRatePct > (rules.preferLowerTaxDragForStabilityWhenSlabAbove ?? 100)) {
          cands = [...cands.filter(c => c.fund.category === 'arbitrage'), ...cands.filter(c => c.fund.category !== 'arbitrage')];
          notes.push(`Your slab rate (${ctx.slabRatePct}%) is above ${rules.preferLowerTaxDragForStabilityWhenSlabAbove}%, so arbitrage funds (taxed as equity: 12.5% LTCG after 12 months) are preferred over debt funds (taxed at slab) for the stability sleeve.`);
        }
        const pick = cands.find(it => {
          const f = it.fund, m = it.metrics || {};
          if ((m.historyYears ?? 0) < (rules.requireMinHistoryYears || 0)) return false;
          if (capital > 0) {
            if (f.minLumpsum == null && rules.requireVerifiedMinimum) return false;
            if (f.minLumpsum != null && f.minLumpsum > amount) return false;
          } else if (sip > 0) {
            if (f.minSip == null && rules.requireVerifiedMinimum) return false;
            if (f.minSip != null && f.minSip > sipAmt) return false;
          }
          return true;
        });
        if (!pick) {
          const target = sleeves.find(x => x.id === s.fallbackTo) || sleeves.find(x => x !== s && x.pct > 0);
          if (target && target !== s) {
            notes.push(`No eligible fund for "${s.label}" at ₹${Math.round(amount).toLocaleString('en-IN')} (minimum investment, history or horizon rules) — its ${s.pct}% moved to "${target.label}".`);
            target.pct += s.pct; s.pct = 0; moved = true; break;
          }
        } else picks[s.id] = pick;
      }
      if (!moved) break;
    }

    // Combine sleeves that picked the same fund
    const rowsMap = {};
    sleeves.filter(s => s.pct > 0 && picks[s.id]).forEach(s => {
      const it = picks[s.id], id = it.fund.id;
      rowsMap[id] = rowsMap[id] || { fundId: id, item: it, pct: 0, sleeves: [] };
      rowsMap[id].pct += s.pct; rowsMap[id].sleeves.push(s.label);
    });
    let rows = Object.values(rowsMap);

    // Round lump-sum amounts; remainder goes to the largest row so the total equals capital exactly.
    if (capital > 0 && rows.length) {
      rows.forEach(r => { r.amount = Math.floor(capital * r.pct / 100 / roundTo) * roundTo; });
      const rem = capital - U.sum(rows, r => r.amount);
      rows.sort((a, b) => b.pct - a.pct)[0].amount += rem;
      rows.forEach(r => { r.pct = r.amount / capital * 100; });
    } else rows.forEach(r => { r.amount = 0; });

    // Rejections for everything not chosen
    const chosen = new Set(rows.map(r => r.fundId));
    const allCats = new Set(profile.sleeves.flatMap(s => s.categories));
    items.forEach(it => {
      const f = it.fund, cat = categories[f.category];
      if (chosen.has(f.id)) return;
      if (!allCats.has(f.category)) reject(f.id, `${cat.label} is not part of the ${profile.label} model.`);
      else if (rules.excludeIfHorizonBelowCategoryMinHold && horizonYears < cat.minHoldYears) reject(f.id, `${cat.label} needs a ${cat.minHoldYears}+ year holding period; your horizon is ${horizonYears} years.`);
      const sleeve = sleeves.find(s => s.categories.includes(f.category) && picks[s.id]);
      if (sleeve) {
        const winner = picks[sleeve.id];
        if (winner.score.total >= it.score.total) {
          const weaker = Object.keys(it.score.components).filter(k => it.score.components[k] + 10 < winner.score.components[k]);
          reject(f.id, `Scored ${it.score.total.toFixed(0)} vs ${winner.fund.name.split('–')[0].trim()} at ${winner.score.total.toFixed(0)}${weaker.length ? ' — weaker on ' + weaker.join(', ') : ''}.`);
        }
        const amt = capital * sleeve.pct / 100;
        if (capital > 0 && f.minLumpsum != null && f.minLumpsum > amt) reject(f.id, `Minimum lump sum ₹${f.minLumpsum.toLocaleString('en-IN')} is above the ₹${Math.round(amt).toLocaleString('en-IN')} this sleeve would get.`);
      }
      if (capital > 0 && f.minLumpsum == null && rules.requireVerifiedMinimum) reject(f.id, 'Minimum investment not verified from a source.');
      if ((it.metrics?.historyYears ?? 0) < (rules.requireMinHistoryYears || 0)) reject(f.id, `Less than ${rules.requireMinHistoryYears} years of NAV history available.`);
      (f.flags || []).forEach(fl => reject(f.id, fl));
      if (!reasonsFor[f.id]) reject(f.id, 'Not needed: the model already covers this exposure with fewer funds.');
    });

    return { rows, rejected: Object.entries(reasonsFor).map(([fundId, reasons]) => ({ fundId, reasons: [...new Set(reasons)] })), notes: [...new Set(notes)], sleeves };
  }

  /** Human-readable reasons a fund was selected, built only from data. */
  function selectionRationale(it, peers, benchMetrics) {
    const f = it.fund, m = it.metrics || {}, out = [];
    const sameCat = peers.filter(p => p.fund.category === f.category);
    if (sameCat.length > 1) out.push(`Highest composite score (${it.score.total.toFixed(0)}/100) of ${sameCat.length} shortlisted funds in its category.`);
    else out.push(`Composite score ${it.score.total.toFixed(0)}/100.`);
    if (f.ter != null) out.push(`Expense ratio ${f.ter.toFixed(2)}% (source ${f.source.asOf || 'n/a'}).`);
    if (m.cagr5 != null) out.push(`5-yr CAGR ${(m.cagr5 * 100).toFixed(1)}%` + (benchMetrics && benchMetrics.cagr5 != null ? ` vs ${(benchMetrics.cagr5 * 100).toFixed(1)}% for the benchmark proxy.` : '.'));
    if (m.rolling3) out.push(`Rolling 3-yr CAGR median ${(m.rolling3.median * 100).toFixed(1)}%; beat the risk-free proxy in ${(m.rolling3.pctAboveRf * 100).toFixed(0)}% of ${m.rolling3.count} windows.`);
    if (m.maxDD5) out.push(`Worst fall in the last 5 years: ${(m.maxDD5.mdd * 100).toFixed(1)}% (${m.maxDD5.peak} → ${m.maxDD5.trough}).`);
    if (it.score.missing.length) out.push(`Data unavailable for: ${it.score.missing.join(', ')} (scored neutral).`);
    return out;
  }

  /**
   * Suggest a dashboard category from AMFI's scheme category text (mfapi meta.scheme_category)
   * and the scheme name. Always shown to the user for confirmation — never applied silently.
   */
  function guessCategory(schemeCategory, name) {
    const c = String(schemeCategory || '').toLowerCase(), n = String(name || '').toLowerCase();
    const has = (s, re) => re.test(s);
    if (has(c, /gold etf/) || (has(c, /etf/) && has(n, /gold|silver/))) return 'gold_etf';
    if (has(c, /fof|fund of fund/) && has(n, /gold|silver/)) return 'gold_fof';
    if (has(c, /overseas|international/) || has(n, /nasdaq|s&p 500|us equity|global|overseas|international|world|china|japan|hang seng/)) return 'international_fof';
    if (has(c, /elss/) || has(n, /elss|tax saver|taxsaver|long term equity/)) return 'elss';
    if (has(c, /arbitrage/)) return 'arbitrage';
    if (has(c, /liquid|overnight|money market|ultra short|low duration/)) return 'liquid';
    if (has(c, /gilt/) && !has(c, /index/)) return 'gilt';
    if (has(c, /corporate bond|banking and psu|banking & psu/)) return 'debt_corporate';
    if (has(c, /debt scheme|conservative hybrid|credit risk|floater|dynamic bond|short duration|medium duration|long duration/)) return 'debt_other';
    if (has(c, /aggressive hybrid/)) return 'aggressive_hybrid';
    if (has(c, /balanced advantage|dynamic asset|equity savings/)) return 'balanced_advantage';
    if (has(c, /multi asset/)) return 'multi_asset';
    if (has(c, /index|etf/)) {
      if (has(n, /g-sec|gsec|sdl|gilt|bond|crisil|psu|debt|treasury/)) return 'debt_other';
      if (has(n, /next 50/)) return 'index_next50';
      if (has(n, /smallcap|small cap|microcap|micro cap/)) return 'smallcap';
      if (has(n, /midcap|mid cap/)) return 'midcap';
      if (has(n, /nifty 50|sensex|nifty50/)) return 'index_largecap';
      if (has(n, /500|total market|nifty 200|nifty 100|largemidcap/)) return 'index_broad';
      return 'sectoral';
    }
    if (has(c, /sectoral|thematic/)) return 'sectoral';
    if (has(c, /small cap/)) return 'smallcap';
    if (has(c, /mid cap/) && !has(c, /large & mid|large and mid/)) return 'midcap';
    if (has(c, /large cap/) && !has(c, /mid/)) return 'largecap';
    if (has(c, /flexi cap/)) return 'flexi';
    if (has(c, /equity/)) return 'equity_other';
    return null;
  }

  return { guessCategory, adjustSplits, navOnOrBefore, cagrBetween, maxDrawdown, computeMetrics, percentileScores, scoreFunds, buildModelPortfolio, selectionRationale };
});
