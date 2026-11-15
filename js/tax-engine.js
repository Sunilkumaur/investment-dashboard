/*
 * Indian capital-gains tax engine for mutual funds, ETFs and listed G-Secs.
 * ALL rates, thresholds, holding periods and effective dates come from config/tax-rules.json.
 * Nothing about the law is hard-coded here: this file only knows how to apply a rule set.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'));
  else root.TaxEngine = factory(root.FinUtil);
})(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  /** Pick the rule set in force on a transfer date. */
  function ruleSetFor(rules, sellDate) {
    const d = U.iso(sellDate);
    const sets = rules.ruleSets;
    const found = sets.find(rs => (!rs.effectiveFrom || d >= rs.effectiveFrom) && (!rs.effectiveTo || d <= rs.effectiveTo));
    if (found) return { rs: found, outOfRange: false };
    // Before the earliest rule set: use it but flag. After the last: impossible (last is open-ended).
    return { rs: sets[0], outOfRange: true };
  }

  /** Classify one lot: short/long term, applicable rate & section under the rule set for its sell date. */
  function classify(rules, lot) {
    const buy = U.iso(lot.buyDate), sell = U.iso(lot.sellDate);
    const { rs, outOfRange } = ruleSetFor(rules, sell);
    const entries = rs.classes[lot.taxClass];
    if (!entries) throw new Error(`Unknown tax class "${lot.taxClass}" in rule set ${rs.id}`);
    const rule = entries.find(e => (!e.acquiredFrom || buy >= e.acquiredFrom) && (!e.acquiredTo || buy <= e.acquiredTo));
    if (!rule) throw new Error(`No rule for ${lot.taxClass} acquired ${buy} in ${rs.id}`);
    let term;
    if (rule.alwaysShortTerm) term = 'ST';
    else term = sell > U.iso(U.addMonths(buy, rule.ltAfterMonths)) ? 'LT' : 'ST';   // "held for MORE than N months"
    const t = term === 'LT' ? rule.lt : rule.st;
    return {
      term, kind: t.kind, rate: t.rate, isSlab: t.rate === 'slab', indexation: !!t.indexation,
      exemptionPool: t.exemptionPool || null, section: t.section,
      ltAfterMonths: rule.ltAfterMonths ?? null, alwaysShortTerm: !!rule.alwaysShortTerm,
      ruleSetId: rs.id, ruleSetLabel: rs.label, ruleSetCurrent: !!rs.current || !rs.effectiveTo,
      exemptionAmount: rs.equity112AExemption, outOfRange
    };
  }

  function indexedCost(rules, cost, buyDate, sellDate) {
    const cii = rules.costInflationIndex && rules.costInflationIndex.values || {};
    const b = cii[String(U.fyStart(buyDate))], s = cii[String(U.fyStart(sellDate))];
    if (!b || !s) return { cost, applied: false };
    return { cost: cost * s / b, applied: true, ratio: s / b };
  }

  /**
   * Compute tax on a set of redeemed lots.
   * lots: [{ id, label, taxClass, buyDate, sellDate, cost, proceeds }]
   *   cost     = cost of acquisition (amount paid, incl. stamp duty/brokerage on purchase)
   *   proceeds = full value of consideration less deductible transfer expenses (exit load, brokerage; NOT STT)
   * profile: { slabRatePct, cessPct, surchargePct, exemptionMultiplier, overrides: { eqST, eqLT, otherLT, exemption } }
   *   overrides apply only to the CURRENT (open-ended) rule set — for "what if the law changes" analysis.
   */
  function computeTax(rules, lots, profile) {
    const P = Object.assign({ slabRatePct: rules.defaults.slabRatePct, cessPct: rules.defaults.cessPct, surchargePct: 0, exemptionMultiplier: 1, overrides: {} }, profile || {});
    const ov = P.overrides || {};
    const cap = rules.specialRateSurchargeCapPct;
    const notes = new Set();

    const detailed = lots.map(l => {
      const c = classify(rules, l);
      let rate = c.isSlab ? P.slabRatePct : c.rate;
      if (c.ruleSetCurrent) {
        if (c.kind === 'eqST' && isFinite(ov.eqST)) rate = ov.eqST;
        if (c.kind === 'eqLT' && isFinite(ov.eqLT)) rate = ov.eqLT;
        if (c.kind === 'otherLT' && isFinite(ov.otherLT)) rate = ov.otherLT;
      }
      let costBasis = l.cost, idx = null;
      if (c.indexation) {
        idx = indexedCost(rules, l.cost, l.buyDate, l.sellDate);
        costBasis = idx.cost;
        if (!idx.applied) notes.add('Cost Inflation Index unavailable for a lot — indexation not applied (tax may be overstated).');
      }
      if (c.outOfRange) notes.add('A redemption date falls before the earliest configured rule set; the earliest set was used.');
      const gain = l.proceeds - costBasis;
      return Object.assign({}, l, { cls: c, rate, costBasis, indexation: idx, gain, holdingDays: U.daysBetween(l.buyDate, l.sellDate) });
    });

    // Group by financial year of transfer (exemption and set-off work per FY).
    const byFY = {};
    detailed.forEach(d => { const fy = U.fyStart(d.sellDate); (byFY[fy] = byFY[fy] || []).push(d); });

    const fyResults = Object.keys(byFY).sort().map(fy => {
      const items = byFY[fy];
      const buckets = {};
      items.forEach(d => {
        const key = `${d.cls.term}|${d.cls.kind}|${d.rate}|${d.cls.exemptionPool || ''}|${d.cls.ruleSetId}`;
        const b = buckets[key] = buckets[key] || {
          key, term: d.cls.term, kind: d.cls.kind, rate: d.rate, isSlab: d.cls.isSlab, pool: d.cls.exemptionPool,
          section: d.cls.section, ruleSetId: d.cls.ruleSetId, ruleSetLabel: d.cls.ruleSetLabel, current: d.cls.ruleSetCurrent,
          exemptionAmount: d.cls.exemptionAmount, gross: 0, lots: []
        };
        b.gross += d.gain; b.lots.push(d);
      });
      const list = Object.values(buckets);
      list.forEach(b => { b.net = b.gross; b.setOffUsed = 0; });

      // Set-off (Sec 70/74 principles): ST loss → any gain; LT loss → LT gains only.
      let stLoss = 0, ltLoss = 0;
      list.forEach(b => { if (b.net < 0) { if (b.term === 'ST') stLoss -= b.net; else ltLoss -= b.net; b.net = 0; } });
      const steps = [];
      const absorb = (loss, targets, label) => {
        for (const b of targets) {
          if (loss <= 0) break;
          const use = Math.min(loss, b.net);
          if (use > 0) { b.net -= use; b.setOffUsed += use; loss -= use; steps.push(`${label} of ${U.inr(use)} set off against ${b.term === 'ST' ? 'short' : 'long'}-term gains taxed at ${b.rate}%`); }
        }
        return loss;
      };
      // Highest-rate gains first (a taxpayer may choose the most favourable order). Pool (112A) gains last because they enjoy the exemption.
      const order = arr => arr.filter(b => b.net > 0).sort((a, b) => (a.pool ? 1 : 0) - (b.pool ? 1 : 0) || b.rate - a.rate);
      ltLoss = absorb(ltLoss, order(list.filter(b => b.term === 'LT')), 'Long-term loss');
      stLoss = absorb(stLoss, order(list), 'Short-term loss');

      // 112A exemption (per FY). Multiplier approximates spreading redemption over N financial years.
      const poolBuckets = list.filter(b => b.pool === '112A' && b.net > 0);
      let exemptionAvail = 0;
      if (poolBuckets.length) {
        let ex = poolBuckets[0].exemptionAmount;
        if (poolBuckets[0].current && isFinite(ov.exemption)) ex = ov.exemption;
        exemptionAvail = ex * Math.max(1, P.exemptionMultiplier || 1);
      }
      let exLeft = exemptionAvail;
      list.forEach(b => {
        b.exemption = 0;
        if (b.pool === '112A' && b.net > 0 && exLeft > 0) { b.exemption = Math.min(b.net, exLeft); exLeft -= b.exemption; }
        b.taxable = Math.max(0, b.net - b.exemption);
        b.baseTax = b.taxable * b.rate / 100;
        const sPct = b.isSlab ? P.surchargePct : Math.min(P.surchargePct, cap);
        b.surchargePct = sPct;
        b.surcharge = b.baseTax * sPct / 100;
        b.cess = (b.baseTax + b.surcharge) * P.cessPct / 100;
        b.tax = b.baseTax + b.surcharge + b.cess;
      });

      // Allocate each bucket's tax to its lots in proportion to positive gains (for per-fund display only).
      list.forEach(b => {
        const pos = U.sum(b.lots, l => Math.max(0, l.gain));
        b.lots.forEach(l => { l.taxAllocated = pos > 0 ? b.tax * Math.max(0, l.gain) / pos : 0; });
      });

      const tot = k => U.sum(list, b => b[k]);
      return {
        fy: +fy, fyLabel: U.fyLabel(+fy), buckets: list, steps,
        exemptionAvailable: exemptionAvail, exemptionUsed: exemptionAvail - exLeft,
        unabsorbedSTLoss: stLoss, unabsorbedLTLoss: ltLoss,
        baseTax: tot('baseTax'), surcharge: tot('surcharge'), cess: tot('cess'), tax: tot('tax'),
        stGain: U.sum(list.filter(b => b.term === 'ST'), b => b.gross), ltGain: U.sum(list.filter(b => b.term === 'LT'), b => b.gross)
      };
    });

    if (fyResults.some(f => f.unabsorbedSTLoss > 0 || f.unabsorbedLTLoss > 0)) notes.add('Unabsorbed capital losses can be carried forward for 8 years if the return is filed on time (not applied here).');
    if (detailed.some(d => d.cls.ruleSetCurrent && U.iso(d.sellDate) > U.todayISO())) notes.add('Future redemptions assume the current law continues unchanged.');
    if (detailed.some(d => d.cls.isSlab)) notes.add(`Slab-rate gains use your marginal rate of ${P.slabRatePct}% (editable). Section 87A rebate and basic exemption are not applied.`);

    const t = k => U.sum(fyResults, f => f[k]);
    return {
      lots: detailed, years: fyResults,
      baseTax: t('baseTax'), surcharge: t('surcharge'), cess: t('cess'), tax: t('tax'),
      exemptionUsed: t('exemptionUsed'),
      totalGain: U.sum(detailed, d => d.gain),
      stGain: t('stGain'), ltGain: t('ltGain'),
      notes: [...notes], profile: P
    };
  }

  return { ruleSetFor, classify, computeTax, indexedCost };
});
