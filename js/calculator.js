/*
 * Projection & redemption calculator.
 * Every SIP instalment / lump sum is its own lot with its own purchase date, so holding period,
 * exit load and tax treatment are worked out per lot.
 *
 * Value chain for each lot (amounts in ₹):
 *   vGross = amount × (1 + R)^(days/365)                     R   = assumed return BEFORE expense ratio
 *   vTer   = amount × (1 + R − TER)^(days/365)               NAV return after the fund's expense ratio
 *   vNav   = (amount − purchase costs) × (1 + R − TER)^t     units actually bought after stamp duty etc.
 *   exit   = vNav × exit-load %                              (if still inside the exit-load window)
 *   cash   = vNav − exit − sell-side charges − STT
 *   net    = Σ cash − capital-gains tax (computed portfolio-wide so losses net off and the ₹1.25L exemption is shared)
 * Identity checked in tests:  vGross − net = TER impact + purchase costs + exit load + sell charges + STT + tax + other.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./tax-engine.js'));
  else root.Calc = factory(root.FinUtil, root.TaxEngine);
})(typeof self !== 'undefined' ? self : this, function (U, TaxEngine) {
  'use strict';

  /** Build dated contributions: optional lump sum on the start date + monthly SIP until (not including) the end date. */
  function contributions({ lumpsum = 0, sip = 0, startDate, endDate, stepUpPct = 0 }) {
    const out = [];
    const start = U.parseDate(startDate), end = U.parseDate(endDate);
    if (!start || !end || end <= start) return out;
    if (lumpsum > 0) out.push({ date: U.iso(start), amount: lumpsum, kind: 'Lump sum' });
    if (sip > 0) {
      for (let k = 0; k < 1200; k++) {
        const d = U.addMonths(start, k);
        if (d >= end) break;
        const amt = sip * Math.pow(1 + (stepUpPct || 0) / 100, Math.floor(k / 12));
        out.push({ date: U.iso(d), amount: amt, kind: `SIP #${k + 1}` });
      }
    }
    return out;
  }

  /** Exit-load % applicable to a lot held `days` days. Tiers: [{days, pct}] ascending; freePct = % of units exempt. */
  function exitLoadPct(exitLoad, days) {
    if (!exitLoad || !exitLoad.tiers || !exitLoad.tiers.length) return 0;
    const tiers = [...exitLoad.tiers].sort((a, b) => a.days - b.days);
    const t = tiers.find(t => days <= t.days);
    if (!t) return 0;
    return (t.pct / 100) * (1 - (exitLoad.freePct || 0) / 100);
  }

  function isEquity(taxClass) { return taxClass === 'equity_oriented'; }

  /**
   * Project one holding.
   * h: { taxClass, listed, exitLoad, grossReturnPct, terPct, contributions, navFactor? }
   *    navFactor(buyDateISO) → actual NAV(end)/NAV(buy) for historical (actual-NAV) mode.
   */
  function projectHolding(h, endDate, levies, charges) {
    const end = U.iso(endDate);
    const R = (h.grossReturnPct || 0) / 100, TER = (h.terPct || 0) / 100;
    const etf = !!h.listed;
    const ec = (charges && charges.etf) || {};
    const lv = levies || {};
    const lots = [];
    for (const c of h.contributions) {
      const days = U.daysBetween(c.date, end);
      if (days < 0) continue;
      const t = days / 365;
      let g, n;
      if (h.navFactor) {
        n = h.navFactor(c.date);
        if (n == null || !isFinite(n)) { n = NaN; g = NaN; }
        else g = n * Math.pow(1 + TER, t);              // estimate of pre-expense value (expenses are already inside NAV)
      } else {
        g = Math.pow(1 + R, t);
        n = Math.pow(Math.max(0, 1 + R - TER), t);
      }
      const amt = c.amount;
      let stamp = 0, txn = 0, buyDetail = {};
      if (etf) {
        const brok = ec.brokeragePerOrder || 0;
        const exch = amt * (ec.exchangeTxnPct || 0) / 100;
        const sebi = amt * (lv.sebiTurnoverFeePct || 0) / 100;
        const gst = (brok + exch + sebi) * (lv.gstOnServicesPct || 0) / 100;
        const spread = amt * (ec.bidAskSpreadPctPerSide || 0) / 100;
        stamp = amt * (lv.stampDutyDeliveryBuyPct || 0) / 100;
        txn = brok + exch + sebi + gst + spread;
        buyDetail = { brok, exch, sebi, gst, spread };
      } else {
        const sd = (lv.stampDutyMFPurchasePct || 0) / 100;
        stamp = amt * sd / (1 + sd);                     // stamp duty is deducted from the amount before units are allotted
      }
      const invested = Math.max(0, amt - stamp - txn);
      const vGross = amt * g, vTer = amt * n, vNav = invested * n;
      const elPct = exitLoadPct(h.exitLoad, days);
      const exit = vNav * elPct;
      lots.push({ date: c.date, kind: c.kind, amount: amt, days, stamp, txn, buyDetail, invested, vGross, vTer, vNav, exitPct: elPct, exit, stampEffect: stamp * n, txnEffect: txn * n });
    }

    // Sell side (one redemption order for the whole holding)
    const vNavTot = U.sum(lots, l => l.vNav), exitTot = U.sum(lots, l => l.exit);
    let sellDeductible = 0, stt = 0, sellDetail = {};
    if (lots.length && vNavTot > 0) {
      if (etf) {
        const sv = vNavTot;
        const brok = ec.brokeragePerOrder || 0;
        const exch = sv * (ec.exchangeTxnPct || 0) / 100;
        const sebi = sv * (lv.sebiTurnoverFeePct || 0) / 100;
        const gst = (brok + exch + sebi) * (lv.gstOnServicesPct || 0) / 100;
        const spread = sv * (ec.bidAskSpreadPctPerSide || 0) / 100;
        const dp = ec.dpChargePerSellDay || 0;
        sellDeductible = brok + exch + sebi + gst + spread + dp;
        stt = sv * (isEquity(h.taxClass) ? (lv.sttEquityDeliveryPct || 0) : (lv.sttNonEquityETFPct || 0)) / 100;
        sellDetail = { brok, exch, sebi, gst, spread, dp };
      } else if (isEquity(h.taxClass)) {
        stt = (vNavTot - exitTot) * (lv.sttEquityMFRedemptionPct || 0) / 100;
      }
    }
    lots.forEach(l => {
      const share = vNavTot > 0 ? l.vNav / vNavTot : 0;
      l.sellCharges = sellDeductible * share;
      l.stt = stt * share;
      l.proceedsForTax = l.vNav - l.exit - l.sellCharges;   // STT is not deductible
      l.cash = l.proceedsForTax - l.stt;
      l.cost = l.amount;
    });

    const s = k => U.sum(lots, l => l[k]);
    return {
      lots, sellDetail,
      invested: s('amount'), vGross: s('vGross'), vTer: s('vTer'), vNav: vNavTot,
      stamp: s('stamp'), txnBuy: s('txn'), stampEffect: s('stampEffect'), txnEffect: s('txnEffect'),
      exit: exitTot, sellCharges: sellDeductible, stt, cashPreTax: s('cash')
    };
  }

  /**
   * Project a whole portfolio to `endDate`.
   * p: { holdings: [{ id, name, taxClass, listed, exitLoad, amount, sipAmount, grossReturnPct, terPct, navFactor? }],
   *      startDate, endDate, stepUpPct, rules, settings, taxProfile, inflationPct }
   */
  function projectPortfolio(p) {
    const levies = p.rules.statutoryLevies, charges = p.settings.charges;
    const start = U.iso(p.startDate), end = U.iso(p.endDate);
    const years = U.yearsBetween(start, end);
    const per = p.holdings.map(h => {
      const contribs = h.contributions || contributions({ lumpsum: h.amount || 0, sip: h.sipAmount || 0, startDate: start, endDate: end, stepUpPct: p.stepUpPct || 0 });
      const r = projectHolding(Object.assign({}, h, { contributions: contribs }), end, levies, charges);
      r.holding = h;
      // annual demat AMC for ETFs (charged per account; attributed once if any ETF is held)
      return r;
    });

    // Portfolio-wide tax so that losses set off and the 112A exemption is shared.
    const taxLots = [];
    per.forEach((r, hi) => r.lots.forEach((l, li) => taxLots.push({
      id: `${hi}:${li}`, label: `${r.holding.name} — ${l.kind}`, taxClass: r.holding.taxClass,
      buyDate: l.date, sellDate: end, cost: l.cost, proceeds: l.proceedsForTax, _h: hi, _l: li
    })));
    const tax = taxLots.length ? TaxEngine.computeTax(p.rules, taxLots, p.taxProfile) : { lots: [], years: [], tax: 0, baseTax: 0, surcharge: 0, cess: 0, exemptionUsed: 0, totalGain: 0, stGain: 0, ltGain: 0, notes: [] };
    tax.lots.forEach(t => {
      const lot = per[t._h].lots[t._l];
      lot.tax = t.taxAllocated || 0; lot.gain = t.gain; lot.term = t.cls.term; lot.taxRate = t.rate; lot.section = t.cls.section;
      lot.taxKind = t.cls.kind; lot.ruleSet = t.cls.ruleSetId;
    });
    per.forEach(r => {
      r.tax = U.sum(r.lots, l => l.tax || 0);
      r.gain = U.sum(r.lots, l => l.gain || 0);
      r.ltGain = U.sum(r.lots.filter(l => l.term === 'LT'), l => l.gain);
      r.stGain = U.sum(r.lots.filter(l => l.term === 'ST'), l => l.gain);
      r.net = r.cashPreTax - r.tax;
    });

    const anyEtf = p.holdings.some(h => h.listed && ((h.amount || 0) > 0 || (h.sipAmount || 0) > 0));
    const other = anyEtf ? ((charges.etf && charges.etf.annualDematAmc) || 0) * Math.max(0, years) : 0;

    const S = k => U.sum(per, r => r[k]);
    const invested = S('invested'), vGross = S('vGross'), vTer = S('vTer'), vNav = S('vNav');
    const net = S('cashPreTax') - tax.tax - other;
    const losses = {
      fundExpenses: vGross - vTer,
      purchaseStampDuty: S('stampEffect'),
      purchaseTransaction: S('txnEffect'),
      exitLoad: S('exit'),
      sellTransaction: S('sellCharges'),
      stt: S('stt'),
      capitalGainsTax: tax.tax,
      other
    };
    const totalLost = U.sum(Object.values(losses));

    // Cash flows for XIRR
    const flowMap = {};
    per.forEach(r => r.lots.forEach(l => { flowMap[l.date] = (flowMap[l.date] || 0) - l.amount; }));
    const flows = Object.keys(flowMap).sort().map(d => ({ date: d, amount: flowMap[d] }));
    const netXirr = U.xirr(flows.concat([{ date: end, amount: net }]));
    const grossXirr = U.xirr(flows.concat([{ date: end, amount: vGross }]));
    const realNet = net / Math.pow(1 + (p.inflationPct || 0) / 100, Math.max(0, years));

    return {
      startDate: start, endDate: end, years, perHolding: per, tax,
      invested, vGross, vTer, vNav, net, realNet,
      grossProfit: vGross - invested, netProfit: net - invested,
      losses, totalLost, retainedPct: vGross > 0 ? net / vGross : NaN,
      netXirr, grossXirr, flows,
      groupedLosses: {
        fundExpenses: losses.fundExpenses,
        transactionCosts: losses.purchaseTransaction + losses.sellTransaction,
        exitLoads: losses.exitLoad,
        governmentTaxes: losses.capitalGainsTax + losses.stt + losses.purchaseStampDuty,
        other: losses.other
      }
    };
  }

  /** Allocation check: rows [{pct, amount}] against capital. */
  function allocationCheck(rows, capital) {
    const totalPct = U.round(U.sum(rows, r => +r.pct || 0), 4);
    const totalAmt = U.sum(rows, r => +r.amount || 0);
    const ok = rows.length > 0 && Math.abs(totalPct - 100) < 0.01;
    return { totalPct, totalAmt, ok, unallocated: capital - totalAmt, message: ok ? '' : rows.length === 0 ? 'Add at least one fund.' : `Allocation totals ${totalPct.toFixed(2)}% — it must equal 100%.` };
  }

  /** Validate top-level inputs; returns a list of human-readable errors (empty = valid). */
  function validateInputs(s) {
    const e = [];
    if (!isFinite(s.capital) || s.capital < 0) e.push('Initial investment must be zero or a positive amount.');
    if (!isFinite(s.sip) || s.sip < 0) e.push('Monthly SIP must be zero or a positive amount.');
    if ((s.capital || 0) === 0 && (s.sip || 0) === 0) e.push('Enter an initial investment or a monthly SIP — both are zero.');
    const st = U.parseDate(s.startDate), en = U.parseDate(s.endDate);
    if (!st) e.push('Investment date is invalid.');
    if (!en) e.push('Redemption date is invalid.');
    if (st && en && en <= st) e.push('Redemption date must be after the investment date.');
    if (!isFinite(s.inflationPct) || s.inflationPct < -5 || s.inflationPct > 30) e.push('Inflation must be between −5% and 30%.');
    return e;
  }

  return { contributions, exitLoadPct, projectHolding, projectPortfolio, allocationCheck, validateInputs };
});
