/*
 * Net worth engine: values every asset and liability, projects them forward, estimates what you would
 * actually get if you liquidated (penalties, selling costs, capital-gains tax), and finds money leaks.
 * Pure functions — no DOM — so it is unit-tested in Node and runs unchanged on GitHub Pages.
 *
 * Asset record: { id, type, name, ...type-specific fields }  (types listed in TYPES below)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./util.js'), require('./tax-engine.js'));
  else root.NetWorth = factory(root.FinUtil, root.TaxEngine);
})(typeof self !== 'undefined' ? self : this, function (U, TaxEngine) {
  'use strict';

  const CLASSES = {
    cash: 'Cash & bank', fd: 'Fixed deposits', gold: 'Gold', property: 'Property', scheme: 'PPF / EPF / NPS & small savings',
    stock: 'Stocks & ETFs', mf: 'Mutual funds (tracked)', plan: 'Planned investment (simulator)', insurance: 'Insurance / ULIP', other: 'Other', loan: 'Loans & cards'
  };
  const TYPE_CLASS = { cash: 'cash', savings: 'cash', fd: 'fd', gold: 'gold', property: 'property', scheme: 'scheme', stock: 'stock', mf: 'mf', projected: 'plan', insurance: 'insurance', other: 'other', loan: 'loan' };
  /** A 'projected' asset gets its numbers from ctx.projectors[id](date) → { value, contrib, costs, lots:[{buyDate,cost,proceeds,taxClass}], notes } */
  const projected = (a, d, ctx) => (ctx.projectors && ctx.projectors[a.id] ? ctx.projectors[a.id](d) : null);
  const COMPOUND_N = { monthly: 12, quarterly: 4, 'half-yearly': 2, yearly: 1 };
  const PURITY = { 24: 1, 22: 22 / 24, 18: 18 / 24, 14: 14 / 24 };

  const num = (v, d = 0) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  const yrs = (a, b) => Math.max(0, U.yearsBetween(a, b));
  const effTaxRate = ctx => (ctx.slabRatePct / 100) * (1 + (ctx.surchargePct || 0) / 100) * (1 + (ctx.cessPct ?? 4) / 100);
  const fdN = a => COMPOUND_N[a.compounding] || 4;

  // ------------------------------------------------------------------ FD
  function fdValue(a, date) {
    const P = num(a.principal), r = num(a.ratePct) / 100, n = fdN(a);
    const start = U.iso(a.startDate), mat = a.maturityDate ? U.iso(a.maturityDate) : null, d = U.iso(date);
    if (!start || d < start) return P;
    if (a.compounding === 'payout') return P;
    const end = mat && d > mat ? mat : d;
    const atEnd = P * Math.pow(1 + r / n, n * yrs(start, end));
    if (mat && d > mat && a.reinvest !== false) return atEnd * Math.pow(1 + r / n, n * yrs(mat, d));
    return atEnd;
  }
  const fdEffYield = a => a.compounding === 'payout' ? num(a.ratePct) / 100 : Math.pow(1 + num(a.ratePct) / 100 / fdN(a), fdN(a)) - 1;

  // ------------------------------------------------------------------ gold
  function goldPrice(a, date, ctx) {
    const base = num(a.pricePerGram);
    const today = ctx.today, d = U.iso(date);
    const g = (ctx.goldGrowthPct ?? 8) / 100;
    const nav = ctx.goldNav; // function(date) -> NAV on/before date, or null
    let priceToday = base;
    if (a.autoTrack !== false && nav && a.priceDate) {
      const n0 = nav(a.priceDate), n1 = nav(ctx.goldLatestDate || today);
      if (n0 && n1) priceToday = base * n1 / n0;
      if (d <= (ctx.goldLatestDate || today)) { const nd = nav(d); if (n0 && nd) return base * nd / n0; }
      return priceToday * Math.pow(1 + g, yrs(today, d));        // latest known price, projected only beyond today
    }
    return priceToday * Math.pow(1 + g, yrs(today, d));
  }
  function goldGrams(a) { return num(a.grams) * (a.form === 'sgb' ? 1 : (PURITY[a.purity] || 1)); }

  // ------------------------------------------------------------------ loans & insurance helpers
  function loanBalance(a, date) {
    const B = num(a.outstanding), i = num(a.ratePct) / 100 / 12, emi = num(a.emi);
    const k = Math.max(0, Math.round(yrs(a.asOf || date, date) * 12));
    if (!(emi > 0) || k === 0) return B;
    if (i === 0) return Math.max(0, B - emi * k);
    const bal = B * Math.pow(1 + i, k) - emi * (Math.pow(1 + i, k) - 1) / i;
    return Math.max(0, bal);
  }
  function loanMonthsLeft(a) {
    const B = num(a.outstanding), i = num(a.ratePct) / 100 / 12, emi = num(a.emi);
    if (!(emi > 0)) return null;
    if (i === 0) return Math.ceil(B / emi);
    if (emi <= B * i) return Infinity;
    return Math.ceil(-Math.log(1 - B * i / emi) / Math.log(1 + i));
  }
  function policyIrr(a) {
    if (!['endowment', 'moneyback'].includes(a.kind) || !a.startDate || !a.maturityDate || !(num(a.maturityValue) > 0) || !(num(a.annualPremium) > 0)) return null;
    const flows = [];
    const term = Math.min(num(a.premiumYears) || Infinity, Math.floor(yrs(a.startDate, a.maturityDate)));
    for (let k = 0; k < term; k++) flows.push({ date: U.iso(U.addYears(a.startDate, k)), amount: -num(a.annualPremium) });
    flows.push({ date: U.iso(a.maturityDate), amount: num(a.maturityValue) + num(a.moneybackReceived) });
    const r = U.xirr(flows);
    return isFinite(r) ? r : null;
  }

  // ------------------------------------------------------------------ value at a date
  /** Value of an asset on `date` (today = current value) plus future contributions included in it. */
  function valueAt(a, date, ctx) {
    const today = ctx.today, d = U.iso(date), t = yrs(today, d), sc = ctx.scen || 'm', G = ctx.nw.defaults.growth;
    switch (a.type) {
      case 'cash': return { value: num(a.amount), contrib: 0 };
      case 'savings': return { value: num(a.balance) * Math.pow(1 + num(a.ratePct) / 100, t), contrib: 0 };
      case 'fd': return { value: fdValue(a, d), contrib: 0 };
      case 'gold': return { value: goldGrams(a) * goldPrice(a, d, ctx), contrib: 0 };
      case 'property': {
        const ap = (a.appreciationPct !== '' && a.appreciationPct != null ? num(a.appreciationPct) : G.property[sc]) / 100;
        return { value: num(a.currentValue) * Math.pow(1 + ap, yrs(a.valuationDate || today, d)), contrib: 0 };
      }
      case 'scheme': {
        const sch = ctx.nw.schemes[a.scheme] || {};
        const r = (a.ratePct !== '' && a.ratePct != null ? num(a.ratePct) : sch.ratePct || 0) / 100, C = num(a.annualContribution);
        const tc = a.maturityDate ? Math.min(t, yrs(today, a.maturityDate)) : t;
        const B = num(a.balance) * Math.pow(1 + r, t);
        const contribFV = r > 0 ? C * (Math.pow(1 + r, tc) - 1) / r * Math.pow(1 + r, t - tc) : C * tc;
        return { value: B + contribFV, contrib: C * tc };
      }
      case 'stock': {
        const e = (a.expectedReturnPct !== '' && a.expectedReturnPct != null ? num(a.expectedReturnPct) : G.stocks[sc]) / 100;
        return { value: num(a.quantity) * num(a.currentPrice) * Math.pow(1 + e, t), contrib: 0 };
      }
      case 'mf': return { value: num(a.value) * Math.pow(1 + num(a.growthPct) / 100, t), contrib: 0 };
      case 'projected': { const p = projected(a, d, ctx); return { value: p ? p.value : 0, contrib: p ? p.contrib : 0 }; }
      case 'loan': return { value: -loanBalance(Object.assign({}, a, { asOf: a.asOf || today }), d), contrib: 0 };
      case 'insurance': {
        if (a.kind === 'term') return { value: 0, contrib: 0 };
        const sv = num(a.surrenderValue), prem = num(a.annualPremium);
        const payEnd = a.startDate && num(a.premiumYears) ? U.iso(U.addYears(a.startDate, num(a.premiumYears))) : (a.maturityDate || d);
        const premYears = Math.max(0, Math.min(t, yrs(today, payEnd)));
        if (a.kind === 'ulip') {
          const e = ((a.expectedReturnPct !== '' && a.expectedReturnPct != null ? num(a.expectedReturnPct) : G.ulip[sc]) - num(a.chargesPct)) / 100;
          const fv = sv * Math.pow(1 + e, t) + (e !== 0 ? prem * (Math.pow(1 + e, premYears) - 1) / e : prem * premYears);
          return { value: fv, contrib: prem * premYears };
        }
        const mat = a.maturityDate ? U.iso(a.maturityDate) : null, mv = num(a.maturityValue);
        if (!mat || !(mv > 0)) return { value: sv, contrib: prem * premYears };
        if (d >= mat) return { value: mv, contrib: prem * premYears };
        const T = yrs(today, mat);
        const g = sv > 0 && T > 0 ? Math.pow(mv / sv, 1 / T) - 1 : 0;
        return { value: sv > 0 ? sv * Math.pow(1 + g, t) : mv * t / (T || 1), contrib: prem * premYears };
      }
      case 'other': {
        const g = num(a.growthPct) / 100;
        return { value: num(a.value) * Math.pow(1 + g, t), contrib: 0 };
      }
      default: return { value: 0, contrib: 0 };
    }
  }

  // ------------------------------------------------------------------ liquidation
  /**
   * Value every asset on `date` and estimate what you'd receive if you sold/closed everything that day.
   * Capital-gains lots (stocks, mutual funds, gold) are taxed TOGETHER so set-off and the ₹1.25L equity
   * exemption are shared correctly; property is taxed separately using the cheaper of the two options.
   */
  function evaluate(assets, date, ctx) {
    const d = U.iso(date), today = ctx.today, rate = effTaxRate(ctx), D = ctx.nw.defaults;
    const rows = [], cgLots = [];
    const profile = { slabRatePct: ctx.slabRatePct, cessPct: ctx.cessPct ?? 4, surchargePct: ctx.surchargePct || 0, exemptionMultiplier: 1, overrides: ctx.taxOverrides || {} };
    for (const a of assets) {
      const v = valueAt(a, d, ctx);
      const row = { asset: a, cls: TYPE_CLASS[a.type], value: v.value, contrib: v.contrib, costs: 0, tax: 0, notes: [], liquidity: 'Liquid' };
      switch (a.type) {
        case 'cash': break;
        case 'savings': row.tax = Math.max(0, v.value - num(a.balance)) * rate; if (row.tax) row.notes.push('Tax at slab on future interest (80TTA/80TTB deductions not applied).'); break;
        case 'fd': {
          const mat = a.maturityDate ? U.iso(a.maturityDate) : null;
          if (mat && d < mat && a.compounding !== 'payout') {
            const P = num(a.principal), r = num(a.ratePct) / 100, n = fdN(a), p = num(a.penaltyPct, D.fdPrematurePenaltyPct) / 100;
            const pen = P * Math.pow(1 + Math.max(0, r - p) / n, n * yrs(a.startDate, d));
            row.costs = Math.max(0, v.value - pen); row.liquidity = 'Liquid with penalty';
            if (row.costs) row.notes.push(`Premature closure: rate cut by ${(p * 100).toFixed(2)}%.`);
          } else if (mat && d < mat) row.liquidity = 'Liquid with penalty';
          const futureInt = d > today ? Math.max(0, v.value - valueAt(a, today, ctx).value) : 0;
          row.tax = futureInt * rate;
          row.notes.push(a.compounding === 'payout' ? 'Interest is paid out (not added to value); it is taxable at slab each year.' : 'Interest is taxable at slab every year as it accrues; tax shown is on interest from today onward.');
          break;
        }
        case 'gold': {
          const form = a.form || 'physical';
          const dedPct = a.buybackPct !== '' && a.buybackPct != null ? num(a.buybackPct) : form === 'jewellery' ? D.jewelleryBuybackDeductionPct : form === 'digital' ? D.digitalGoldSpreadPct : form === 'sgb' ? 0 : D.coinBuybackDeductionPct;
          row.costs = v.value * dedPct / 100;
          if (row.costs) row.notes.push(`${dedPct}% buy-back deduction / spread assumed.`);
          if (form === 'sgb') {
            const maturity = a.purchaseDate ? U.iso(U.addYears(a.purchaseDate, 8)) : null;
            if (maturity && d >= maturity) row.notes.push('SGB redeemed with RBI at maturity: capital gain exempt for individuals.');
            else { cgLots.push({ id: a.id, taxClass: 'sgb', buyDate: a.purchaseDate || today, sellDate: d, cost: num(a.purchaseCost), proceeds: v.value - row.costs }); row.liquidity = 'Exchange sale (thin volumes) / RBI window after 5 yrs'; }
          } else if (a.purchaseDate && num(a.purchaseCost) > 0) cgLots.push({ id: a.id, taxClass: 'physical_gold', buyDate: a.purchaseDate, sellDate: d, cost: num(a.purchaseCost), proceeds: v.value - row.costs });
          else row.notes.push('Purchase cost/date missing — capital-gains tax not estimated.');
          break;
        }
        case 'property': {
          row.liquidity = 'Illiquid (months to sell)';
          row.costs = v.value * num(a.sellCostPct, D.propertySellCostPct) / 100;
          if (a.purchaseDate && num(a.purchaseCost) > 0) {
            const lot = { id: a.id, buyDate: a.purchaseDate, sellDate: d, cost: num(a.purchaseCost), proceeds: v.value - row.costs };
            const t1 = TaxEngine.computeTax(ctx.rules, [Object.assign({ taxClass: 'immovable_property' }, lot)], profile);
            const t2 = TaxEngine.computeTax(ctx.rules, [Object.assign({ taxClass: 'immovable_property_idx' }, lot)], profile);
            const useIdx = t2.tax < t1.tax;
            row.tax = Math.min(t1.tax, t2.tax);
            row.taxDetail = useIdx ? t2 : t1;
            if (t2.lots[0].cls.indexation && t2.lots[0].cls.term === 'LT') row.notes.push(`Both options checked: 12.5% without indexation = ₹${Math.round(t1.tax).toLocaleString('en-IN')}, 20% with indexation = ₹${Math.round(t2.tax).toLocaleString('en-IN')}; the lower is used.`);
            if (t2.notes.some(n => /Cost Inflation Index unavailable/.test(n))) row.notes.push('CII not available for one of the years — indexed option not computable.');
          } else row.notes.push('Purchase cost/date missing — tax not estimated.');
          if (a.subtype === 'self-occupied') row.notes.push('Self-occupied home: counted in net worth but not in liquid net worth.');
          break;
        }
        case 'scheme': {
          const sch = ctx.nw.schemes[a.scheme] || {};
          row.liquidity = `Locked — ${sch.lockIn || 'see scheme rules'}`;
          if (!sch.taxFree) { row.tax = Math.max(0, v.value - num(a.balance) - v.contrib) * rate; if (row.tax) row.notes.push('Interest/returns taxable at slab.'); }
          if (a.scheme === 'NPS') row.notes.push('At 60: 60% lump sum tax-free; 40% must buy an annuity (pension taxed as income).');
          if (sch.note) row.notes.push(sch.note);
          break;
        }
        case 'stock': {
          const cost = num(a.quantity) * num(a.avgPrice);
          const eq = (a.taxClass || 'equity_oriented') === 'equity_oriented';
          row.costs = v.value * D.stockSellCostPct / 100;
          const stt = eq ? v.value * 0.001 : 0;
          if (a.buyDate && cost > 0) cgLots.push({ id: a.id, taxClass: a.taxClass || 'equity_oriented', buyDate: a.buyDate, sellDate: d, cost, proceeds: v.value - (row.costs - stt) });
          else row.notes.push('Buy date/price missing — tax not estimated.');
          break;
        }
        case 'mf': {
          const tot = num(a.value);
          (a.lots || []).forEach((l, i) => { const share = tot > 0 ? l.value / tot : 0; cgLots.push({ id: `${a.id}#${i}`, parent: a.id, taxClass: a.taxClass, buyDate: l.buyDate, sellDate: d, cost: l.cost, proceeds: v.value * share }); });
          row.notes.push('From “My portfolio” transactions; exit loads not included.');
          break;
        }
        case 'projected': {
          const p = projected(a, d, ctx);
          if (p) {
            row.costs = p.costs || 0;
            (p.lots || []).forEach((l, i) => cgLots.push({ id: `${a.id}#${i}`, parent: a.id, taxClass: l.taxClass, buyDate: l.buyDate, sellDate: d, cost: l.cost, proceeds: l.proceeds }));
            (p.notes || []).forEach(n => row.notes.push(n));
          }
          row.liquidity = 'Liquid (mutual funds, T+1–T+3)';
          break;
        }
        case 'loan': row.liquidity = 'Liability'; break;
        case 'insurance': {
          row.liquidity = a.kind === 'term' ? 'Protection only (no cash value)' : 'Surrender value (penalty built in)';
          if (a.kind !== 'term') row.notes.push('Assumed tax-free under Sec 10(10D) — not available if annual premium > 10% of sum assured, or ULIP premium > ₹2.5L / other policies > ₹5L a year (policies after 2021/2023).');
          break;
        }
        case 'other': if (a.liquid === false || a.liquid === 'false') row.liquidity = 'Illiquid'; row.notes.push('No tax or selling cost estimated.'); break;
      }
      rows.push(row);
    }
    if (cgLots.length) {
      const t = TaxEngine.computeTax(ctx.rules, cgLots, profile);
      t.lots.forEach(l => { const r = rows.find(x => x.asset.id === (l.parent || l.id)); if (r) r.tax += l.taxAllocated || 0; });
      rows.cgTax = t;
    }
    rows.forEach(r => { r.net = r.value - r.costs - r.tax; });
    return rows;
  }

  /** Totals for a set of evaluated rows. */
  function totals(rows) {
    const assets = rows.filter(r => r.value > 0), liabs = rows.filter(r => r.value < 0);
    const isLiquid = r => /^Liquid/.test(r.liquidity) && r.value > 0;
    const byClass = {};
    rows.forEach(r => { byClass[r.cls] = (byClass[r.cls] || 0) + r.value; });
    return {
      assets: U.sum(assets, r => r.value), liabilities: -U.sum(liabs, r => r.value),
      netWorth: U.sum(rows, r => r.value),
      liquidNetWorth: U.sum(rows.filter(isLiquid), r => r.value) + U.sum(liabs, r => r.value),
      afterLiquidation: U.sum(rows, r => r.net),
      costs: U.sum(rows, r => r.costs), tax: U.sum(rows, r => r.tax), contrib: U.sum(rows, r => r.contrib),
      liquidAssets: U.sum(rows.filter(isLiquid), r => r.value),
      byClass
    };
  }

  /** Net-worth path: values at today + each year up to `years` (and the exact end date). */
  function forecast(assets, ctx, endDate) {
    const out = [];
    const N = Math.max(1, Math.ceil(Math.round(yrs(ctx.today, endDate) * 12) / 12 - 1e-9));
    for (let y = 0; y <= N; y++) {
      const d = y === N ? U.iso(endDate) : U.iso(U.addMonths(ctx.today, y * 12));
      const rows = evaluate(assets, d, ctx), T = totals(rows);
      out.push({ year: y === N ? U.round(yrs(ctx.today, endDate), 2) : y, date: d, ...T, real: T.netWorth / Math.pow(1 + (ctx.inflationPct || 0) / 100, yrs(ctx.today, d)) });
    }
    return out;
  }

  // ------------------------------------------------------------------ money leaks
  /**
   * Identify money leaks: money losing value, earning less than a comparable safe option, or costing more than needed.
   * Each leak: { key, title, detail, annual (₹/yr estimate), severity: 'leak'|'risk'|'info', ids[] }
   */
  function leaks(assets, ctx) {
    const out = [], D = ctx.nw.defaults, P = ctx.profile || {};
    const infl = (ctx.inflationPct ?? 5) / 100, rate = effTaxRate(ctx);
    const liqYield = (ctx.liquidYieldPct ?? 6.5) / 100;
    const expenses = num(P.monthlyExpenses), months = num(P.emergencyMonths, D.emergencyMonths), hiDebt = num(P.highDebtPct, D.highInterestDebtPct) / 100;
    const of = t => assets.filter(a => a.type === t);
    const val = a => valueAt(a, ctx.today, ctx).value;
    const cash = U.sum(of('cash'), val), savings = U.sum(of('savings'), val);
    const need = expenses * months;

    // 1. idle cash
    const cashKeep = expenses > 0 ? expenses : 10000;
    if (cash > cashKeep) out.push({ key: 'cash', severity: 'leak', ids: of('cash').map(a => a.id), title: 'Idle cash losing value to inflation', annual: (cash - cashKeep) * infl,
      detail: `₹${Math.round(cash).toLocaleString('en-IN')} in cash; about ₹${Math.round(cashKeep).toLocaleString('en-IN')} (${expenses > 0 ? 'one month of expenses' : 'a basic float'}) is reasonable to keep. The rest loses ~${(infl * 100).toFixed(1)}% a year in purchasing power.` });

    // 2. savings balance above emergency fund
    if (expenses > 0) {
      const excess = Math.max(0, savings - Math.max(0, need - cash));
      const wRate = savings > 0 ? U.sum(of('savings'), a => val(a) * num(a.ratePct)) / savings / 100 : 0;
      if (excess > 0 && wRate < liqYield) out.push({ key: 'savings', severity: 'leak', ids: of('savings').map(a => a.id), title: 'Savings-account money beyond your emergency fund', annual: excess * (liqYield - wRate) * (1 - rate),
        detail: `₹${Math.round(excess).toLocaleString('en-IN')} sits above your ${months}-month emergency fund at ~${(wRate * 100).toFixed(2)}%, vs ~${(liqYield * 100).toFixed(2)}% for a liquid fund (after tax at your slab, both taxed alike).` });
    } else out.push({ key: 'noexp', severity: 'info', ids: [], title: 'Enter monthly expenses to check idle money and emergency cover', annual: 0, detail: 'Without your monthly expenses the dashboard cannot tell how much cash and savings is a sensible buffer.' });

    // 3. FDs losing to inflation after tax / matured FDs
    of('fd').forEach(a => {
      const mat = a.maturityDate ? U.iso(a.maturityDate) : null;
      const v = val(a);
      if (mat && ctx.today > mat && a.reinvest === false) { out.push({ key: 'fd-mat-' + a.id, severity: 'leak', ids: [a.id], title: `Matured FD “${a.name || a.bank || 'FD'}” not reinvested`, annual: v * infl, detail: `Matured on ${mat}; if the money is idle it loses ~${(infl * 100).toFixed(1)}% a year to inflation.` }); return; }
      const post = fdEffYield(a) * (1 - rate);
      if (post < infl) out.push({ key: 'fd-' + a.id, severity: 'leak', ids: [a.id], title: `FD “${a.name || a.bank || 'FD'}” earns less than inflation after tax`, annual: v * (infl - post),
        detail: `${num(a.ratePct)}% pre-tax → ${(post * 100).toFixed(2)}% after tax at your slab, below ${(infl * 100).toFixed(1)}% inflation: a real loss of ${((infl - post) * 100).toFixed(2)}% a year.` });
    });

    // 4. expensive debt  5. negative carry
    const lowYield = Math.max(0, savings - Math.max(0, need - cash)) + U.sum(of('fd'), val);
    const fdPost = of('fd').length ? U.sum(of('fd'), a => val(a) * fdEffYield(a)) / Math.max(1, U.sum(of('fd'), val)) * (1 - rate) : liqYield * (1 - rate);
    let lowLeft = lowYield;
    of('loan').forEach(a => {
      const r = num(a.ratePct) / 100, B = num(a.outstanding);
      if (!(B > 0)) return;
      if (a.kind === 'credit_card' || r >= hiDebt) {
        out.push({ key: 'debt-' + a.id, severity: 'leak', ids: [a.id], title: `Expensive debt: ${a.name || a.kind}`, annual: B * r,
          detail: `₹${Math.round(B).toLocaleString('en-IN')} at ${(r * 100).toFixed(1)}% costs about ₹${Math.round(B * r).toLocaleString('en-IN')} a year in interest — more than most safe investments earn.${a.kind === 'credit_card' ? ' Revolving card balances are usually the costliest debt you can hold.' : ''}` });
      } else if (lowLeft > 0 && r > fdPost + 0.01) {
        const amt = Math.min(lowLeft, B); lowLeft -= amt;
        out.push({ key: 'carry-' + a.id, severity: 'leak', ids: [a.id], title: `Paying ${(r * 100).toFixed(1)}% on “${a.name || a.kind}” while FDs/savings earn ~${(fdPost * 100).toFixed(1)}% after tax`, annual: amt * (r - fdPost),
          detail: `Up to ₹${Math.round(amt).toLocaleString('en-IN')} of low-yield money could offset this loan (check prepayment charges and any tax benefit on the loan first).` });
      }
    });

    // 6. insurance-investment policies
    of('insurance').forEach(a => {
      if (a.kind === 'endowment' || a.kind === 'moneyback') {
        const irr = policyIrr(a), bench = (P.insuranceBenchmarkPct ?? D.insuranceBenchmarkPct) / 100;
        if (irr != null && irr < bench) out.push({ key: 'ins-' + a.id, severity: 'leak', ids: [a.id], title: `Low-return policy “${a.name || a.kind}”: ${(irr * 100).toFixed(2)}% a year`, annual: num(a.surrenderValue) * (bench - irr),
          detail: `Premiums of ₹${num(a.annualPremium).toLocaleString('en-IN')}/yr growing to ₹${num(a.maturityValue).toLocaleString('en-IN')} is an IRR of ${(irr * 100).toFixed(2)}%, below PPF's ${(bench * 100).toFixed(1)}% (tax-free). Surrendering has costs — compare the surrender value with paid-up value before deciding.` });
        if (irr == null) out.push({ key: 'ins-n-' + a.id, severity: 'info', ids: [a.id], title: `Add start/maturity date, premium and maturity value for “${a.name || a.kind}” to check its return`, annual: 0, detail: '' });
      }
      if (a.kind === 'ulip' && num(a.chargesPct) > 0) out.push({ key: 'ulip-' + a.id, severity: 'leak', ids: [a.id], title: `ULIP charges on “${a.name || 'ULIP'}”`, annual: num(a.surrenderValue) * num(a.chargesPct) / 100, detail: `${num(a.chargesPct)}% a year in fund-management, mortality and admin charges.` });
    });

    // 7. gold storage
    of('gold').forEach(a => { if (num(a.lockerFee) > 0) out.push({ key: 'locker-' + a.id, severity: 'leak', ids: [a.id], title: `Locker / storage fee for “${a.name || 'gold'}”`, annual: num(a.lockerFee), detail: 'Gold ETFs, gold funds or SGBs carry no storage cost (SGBs also pay 2.5% interest).' }); });

    // 8. property holding cost
    of('property').forEach(a => {
      if (a.subtype === 'self-occupied') return;
      const gap = num(a.annualCosts) - num(a.annualRent);
      if (gap > 0) out.push({ key: 'prop-' + a.id, severity: 'leak', ids: [a.id], title: `Holding cost on “${a.name || a.subtype}” exceeds its income`, annual: gap, detail: `Costs ₹${num(a.annualCosts).toLocaleString('en-IN')}/yr vs rent ₹${num(a.annualRent).toLocaleString('en-IN')}/yr. Returns rely entirely on price appreciation.` });
    });

    // 9. costly mutual funds (tracked)
    of('mf').forEach(a => {
      const extra = num(a.ter) - num(a.catDefaultTer);
      if (a.plan === 'Regular' || extra > 0.3) {
        const x = a.plan === 'Regular' && !(extra > 0) ? D.regularPlanExtraTerPct : extra;
        out.push({ key: 'mf-' + a.id, severity: 'leak', ids: [a.id], title: `High-cost fund: ${a.name}`, annual: num(a.value) * x / 100, detail: `${a.plan === 'Regular' ? 'Regular plan (includes distributor commission). ' : ''}Expense ratio ~${x.toFixed(2)}% a year above a typical Direct plan in its category.` });
      }
    });

    // 10. emergency fund shortfall (risk)
    if (expenses > 0) {
      const liquid = cash + savings + U.sum(of('fd'), val) + U.sum(of('mf').filter(a => a.category === 'liquid' || a.category === 'arbitrage'), val);
      if (liquid < need) out.push({ key: 'emergency', severity: 'risk', ids: [], title: 'Emergency fund below target', annual: 0, detail: `Liquid money (cash, savings, FDs, liquid/arbitrage funds) ₹${Math.round(liquid).toLocaleString('en-IN')} covers ${(liquid / expenses).toFixed(1)} months vs your ${months}-month target (₹${Math.round(need).toLocaleString('en-IN')}).` });
    }
    // 11. concentration
    const rows = evaluate(assets, ctx.today, ctx), T = totals(rows);
    if (T.assets > 0) {
      const [cls, v] = Object.entries(T.byClass).filter(([k]) => k !== 'loan').sort((a, b) => b[1] - a[1])[0] || [];
      if (v / T.assets > 0.6) out.push({ key: 'conc', severity: 'risk', ids: [], title: `${(v / T.assets * 100).toFixed(0)}% of your assets are in ${CLASSES[cls]}`, annual: 0, detail: 'Heavy concentration in one asset class raises the impact of a single bad outcome.' });
    }
    const order = { leak: 0, risk: 1, info: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity] || b.annual - a.annual);
  }

  return { CLASSES, TYPE_CLASS, valueAt, evaluate, totals, forecast, leaks, fdValue, fdEffYield, goldPrice, loanBalance, loanMonthsLeft, policyIrr };
});
