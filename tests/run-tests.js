/*
 * Independent calculation tests. Run:  node tests/run-tests.js
 * Expected values are worked out by hand / closed-form formulas in this file, NOT by calling
 * the code under test a second time.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const U = require('../js/util.js');
const TaxEngine = require('../js/tax-engine.js');
const Calc = require('../js/calculator.js');
const FR = require('../js/fund-research.js');
const DS = require('../js/data-service.js');
const PF = require('../js/portfolio.js');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tax-rules.json'), 'utf8'));
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/settings.json'), 'utf8'));
const fundsCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/funds.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, detail = '') { if (cond) { pass++; } else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); } }
function near(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name, `got ${a}, expected ${b} (±${tol})`); }
function section(t) { console.log('\n▶ ' + t); }
const P0 = { slabRatePct: 20, cessPct: 4, surchargePct: 0, exemptionMultiplier: 1 };
const noCharges = { etf: { brokeragePerOrder: 0, exchangeTxnPct: 0, dpChargePerSellDay: 0, bidAskSpreadPctPerSide: 0 } };
const noLevies = { stampDutyMFPurchasePct: 0, stampDutyDeliveryBuyPct: 0, sttEquityMFRedemptionPct: 0, sttEquityDeliveryPct: 0, sttNonEquityETFPct: 0, gstOnServicesPct: 18, sebiTurnoverFeePct: 0 };
const rulesNoLevies = Object.assign({}, rules, { statutoryLevies: noLevies });
const settingsNoCharges = Object.assign({}, settings, { charges: noCharges });

function lot(taxClass, buy, sell, cost, proceeds) { return { id: buy + sell, taxClass, buyDate: buy, sellDate: sell, cost, proceeds }; }

// ---------------------------------------------------------------------------
section('1. ₹9,000 lump-sum projection, 5 / 7 / 10 years (no charges, no TER, no tax)');
for (const yrs of [5, 7, 10]) {
  const start = '2026-11-16', end = U.iso(U.addYears(start, yrs));
  const days = U.daysBetween(start, end);
  const expected = 9000 * Math.pow(1.12, days / 365);
  const r = Calc.projectPortfolio({
    holdings: [{ id: 'x', name: 'Test', taxClass: 'equity_oriented', exitLoad: null, amount: 9000, sipAmount: 0, grossReturnPct: 12, terPct: 0 }],
    startDate: start, endDate: end, rules: rulesNoLevies, settings: settingsNoCharges, taxProfile: Object.assign({}, P0, { overrides: { eqLT: 0 } })
  });
  near(r.vGross, expected, 0.01, `${yrs}y gross value = 9000×1.12^(${days}/365) = ${expected.toFixed(2)}`);
  near(r.net, expected, 0.01, `${yrs}y net equals gross when costs & tax are zero`);
  near(r.netXirr, Math.pow(expected / 9000, 365 / days) - 1, 1e-6, `${yrs}y XIRR equals 12% CAGR`);
}

// ---------------------------------------------------------------------------
section('2. Monthly SIP contributions & values');
{
  const c = Calc.contributions({ lumpsum: 0, sip: 1000, startDate: '2026-01-31', endDate: '2027-01-31' });
  ok(c.length === 12, '12 SIP instalments in one year', `got ${c.length}`);
  ok(c[1].date === '2026-02-28', 'month-end clamping: 31 Jan → 28 Feb', c[1].date);
  ok(c[11].date === '2026-12-31', 'last instalment 31 Dec', c[11].date);
  const end = '2027-01-31';
  const expected = U.sum(c, x => 1000 * Math.pow(1.10, U.daysBetween(x.date, end) / 365));
  const h = Calc.projectHolding({ taxClass: 'equity_oriented', exitLoad: null, grossReturnPct: 10, terPct: 0, contributions: c }, end, noLevies, noCharges);
  near(h.vGross, expected, 0.01, 'SIP future value = Σ instalment × 1.10^(days/365)');
  const su = Calc.contributions({ sip: 1000, startDate: '2026-01-01', endDate: '2028-01-01', stepUpPct: 10 });
  ok(su.length === 24 && su[12].amount === 1100 && su[11].amount === 1000, 'annual step-up of 10% applies from month 13');
}

// ---------------------------------------------------------------------------
section('3. Different return assumptions & expense ratios');
{
  const mk = (R, ter) => Calc.projectHolding({ taxClass: 'equity_oriented', grossReturnPct: R, terPct: ter, contributions: [{ date: '2026-01-01', amount: 9000 }] }, '2036-01-01', noLevies, noCharges);
  const d = U.daysBetween('2026-01-01', '2036-01-01');
  near(mk(12, 1).vTer, 9000 * Math.pow(1.11, d / 365), 0.01, 'TER 1% on 12% gross → NAV grows at 11%');
  near(mk(12, 1).vGross - mk(12, 1).vTer, 9000 * (Math.pow(1.12, d / 365) - Math.pow(1.11, d / 365)), 0.01, 'expense impact = gross − after-TER value');
  ok(mk(14, 0.5).vTer > mk(12, 0.5).vTer, 'higher return assumption → higher value');
  ok(mk(12, 0.2).vTer > mk(12, 1.0).vTer, 'lower expense ratio → higher value');
  near(mk(-5, 0).vGross, 9000 * Math.pow(0.95, d / 365), 0.01, 'negative return assumption handled');
}

// ---------------------------------------------------------------------------
section('4. Tax: equity-oriented funds (current law)');
{
  const t1 = TaxEngine.computeTax(rules, [lot('equity_oriented', '2026-12-01', '2031-12-01', 100000, 150000)], P0);
  near(t1.tax, 0, 0.001, 'LTCG ₹50,000 < ₹1.25L exemption → ₹0 tax');
  const t2 = TaxEngine.computeTax(rules, [lot('equity_oriented', '2026-12-01', '2031-12-01', 100000, 300000)], P0);
  near(t2.tax, (200000 - 125000) * 0.125 * 1.04, 0.01, 'LTCG ₹2L → 12.5% × ₹75,000 × 1.04 = ₹9,750');
  const t3 = TaxEngine.computeTax(rules, [lot('equity_oriented', '2026-12-01', '2027-06-01', 50000, 60000)], P0);
  near(t3.tax, 10000 * 0.20 * 1.04, 0.01, 'STCG ₹10,000 → 20% + cess = ₹2,080');
  const exact12 = TaxEngine.classify(rules, { taxClass: 'equity_oriented', buyDate: '2026-01-15', sellDate: '2027-01-15' });
  const over12 = TaxEngine.classify(rules, { taxClass: 'equity_oriented', buyDate: '2026-01-15', sellDate: '2027-01-16' });
  ok(exact12.term === 'ST' && over12.term === 'LT', 'exactly 12 months = short-term; 12 months + 1 day = long-term');
  const t4 = TaxEngine.computeTax(rules, [lot('equity_oriented', '2026-12-01', '2031-12-01', 100000, 300000)], Object.assign({}, P0, { exemptionMultiplier: 2 }));
  ok(t4.tax === 0, 'spreading over 2 FYs doubles exemption: ₹2L gain fully exempt (₹2.5L)');
  const t5 = TaxEngine.computeTax(rules, [lot('equity_oriented', '2026-12-01', '2031-12-01', 100000, 300000)], Object.assign({}, P0, { overrides: { eqLT: 15, exemption: 100000 } }));
  near(t5.tax, 100000 * 0.15 * 1.04, 0.01, 'what-if override (15% LTCG, ₹1L exemption) applies to current law');
}

section('5. Tax: debt, gold FoF, gold ETF, international, G-Sec');
{
  const d1 = TaxEngine.computeTax(rules, [lot('debt_specified', '2026-12-01', '2031-12-01', 10000, 20000)], P0);
  near(d1.tax, 10000 * 0.20 * 1.04, 0.01, 'debt fund bought 2026, held 5y → slab 20% (always short-term)');
  const d2 = TaxEngine.computeTax(rules, [lot('debt_specified', '2022-06-01', '2026-06-02', 10000, 20000)], P0);
  near(d2.tax, 10000 * 0.125 * 1.04, 0.01, 'debt fund bought before Apr 2023, held >24m, sold 2026 → 12.5% LTCG');
  const g1 = TaxEngine.computeTax(rules, [lot('commodity_fof', '2026-12-01', '2029-01-01', 10000, 20000)], P0);
  near(g1.tax, 10000 * 0.125 * 1.04, 0.01, 'gold FoF held 25 months → 12.5% LTCG, no exemption');
  const g2 = TaxEngine.computeTax(rules, [lot('commodity_fof', '2026-12-01', '2028-08-01', 10000, 20000)], P0);
  near(g2.tax, 10000 * 0.20 * 1.04, 0.01, 'gold FoF held 20 months → short-term at slab');
  const e1 = TaxEngine.computeTax(rules, [lot('listed_non_equity_etf', '2026-12-01', '2028-01-02', 10000, 20000)], P0);
  near(e1.tax, 10000 * 0.125 * 1.04, 0.01, 'gold ETF (listed) held 13 months → 12.5% LTCG');
  const i1 = TaxEngine.classify(rules, { taxClass: 'international_fof', buyDate: '2026-12-01', sellDate: '2028-12-02' });
  ok(i1.term === 'LT' && i1.rate === 12.5, 'international FoF >24 months → LT 12.5%');
  const s1 = TaxEngine.classify(rules, { taxClass: 'gsec_listed', buyDate: '2026-12-01', sellDate: '2028-01-02' });
  ok(s1.term === 'LT' && s1.rate === 12.5, 'listed G-Sec >12 months → LT 12.5%');
  const ot = TaxEngine.computeTax(rules, [lot('commodity_fof', '2026-12-01', '2029-01-01', 10000, 20000)], Object.assign({}, P0, { overrides: { otherLT: 20 } }));
  near(ot.tax, 10000 * 0.20 * 1.04, 0.01, 'what-if override for non-equity LTCG rate');
}

section('6. Tax rules by date (historical rule sets preserved)');
{
  const a = TaxEngine.classify(rules, { taxClass: 'commodity_fof', buyDate: '2023-06-01', sellDate: '2024-12-01' });
  ok(a.isSlab && a.ruleSetId === 'FA2024', 'gold FoF bought Jun 2023, sold Dec 2024 → old specified-MF definition → slab');
  const b = TaxEngine.classify(rules, { taxClass: 'commodity_fof', buyDate: '2023-06-01', sellDate: '2025-06-01' });
  ok(b.term === 'ST' && b.ruleSetId === 'FA2024-SMF', 'same fund sold 1 Jun 2025 (exactly 24 months) → short-term under amended definition');
  const c = TaxEngine.classify(rules, { taxClass: 'commodity_fof', buyDate: '2023-06-01', sellDate: '2025-07-01' });
  ok(c.term === 'LT' && c.rate === 12.5, 'sold Jul 2025 (>24 months) → 12.5% LTCG');
  const old = TaxEngine.computeTax(rules, [lot('equity_oriented', '2021-01-01', '2024-03-01', 100000, 300000)], P0);
  near(old.tax, (200000 - 100000) * 0.10 * 1.04, 0.01, 'equity sold Mar 2024 → old 10% LTCG above ₹1L');
  const oldSt = TaxEngine.computeTax(rules, [lot('equity_oriented', '2024-01-01', '2024-06-01', 10000, 20000)], P0);
  near(oldSt.tax, 10000 * 0.15 * 1.04, 0.01, 'equity STCG sold Jun 2024 → old 15%');
  const idx = TaxEngine.computeTax(rules, [lot('debt_specified', '2019-06-01', '2023-06-01', 100000, 140000)], P0);
  const idxCost = 100000 * 348 / 289;
  near(idx.tax, (140000 - idxCost) * 0.20 * 1.04, 0.01, 'pre-2023 debt sold FY23-24 → 20% with indexation (CII 348/289)');
  const cur = TaxEngine.classify(rules, { taxClass: 'equity_oriented', buyDate: '2026-05-01', sellDate: '2027-06-01' });
  ok(cur.ruleSetId === 'ITA2025' && /198/.test(cur.section), 'FY 2026-27 redemption uses Income-tax Act 2025 rule set (section 198)');
}

section('7. Set-off, surcharge cap, multiple FYs');
{
  const so = TaxEngine.computeTax(rules, [
    lot('debt_specified', '2026-01-01', '2026-12-01', 20000, 30000),       // +10,000 slab
    lot('equity_oriented', '2026-06-01', '2026-12-01', 20000, 15000)       // −5,000 ST loss
  ], P0);
  near(so.tax, 5000 * 0.20 * 1.04, 0.01, 'ST loss ₹5,000 set off against slab gain ₹10,000');
  const lt = TaxEngine.computeTax(rules, [
    lot('equity_oriented', '2026-01-01', '2026-12-01', 20000, 30000),      // +10,000 eq ST
    lot('commodity_fof', '2024-01-01', '2026-12-01', 20000, 15000)         // −5,000 LT loss
  ], P0);
  near(lt.tax, 10000 * 0.20 * 1.04, 0.01, 'LT loss cannot be set off against ST gain');
  ok(lt.years[0].unabsorbedLTLoss === 5000, 'unabsorbed LT loss reported for carry-forward');
  const sc = TaxEngine.computeTax(rules, [
    lot('equity_oriented', '2026-01-01', '2031-01-02', 0, 1125000),        // LTCG 11.25L → taxable 10L
    lot('debt_specified', '2026-01-01', '2031-01-02', 0, 100000)           // slab gain 1L
  ], Object.assign({}, P0, { slabRatePct: 30, surchargePct: 25 }));
  const expEq = 1000000 * 0.125 * 1.15 * 1.04, expSlab = 100000 * 0.30 * 1.25 * 1.04;
  near(sc.tax, expEq + expSlab, 0.01, 'surcharge capped at 15% on equity LTCG, full 25% on slab gains');
  const fy = TaxEngine.computeTax(rules, [
    lot('equity_oriented', '2026-01-01', '2028-03-15', 0, 125000),
    lot('equity_oriented', '2026-01-01', '2028-04-15', 0, 125000)
  ], P0);
  ok(fy.years.length === 2 && fy.tax === 0, 'redemptions in two FYs each get their own ₹1.25L exemption');
}

// ---------------------------------------------------------------------------
section('8. SIP taxation lot by lot');
{
  const end = '2027-06-15';
  const r = Calc.projectPortfolio({
    holdings: [{ id: 'eq', name: 'Eq', taxClass: 'equity_oriented', exitLoad: null, amount: 0, sipAmount: 1000, grossReturnPct: 12, terPct: 0 }],
    startDate: '2026-01-01', endDate: end, rules: rulesNoLevies, settings: settingsNoCharges, taxProfile: P0
  });
  const lots = r.perHolding[0].lots;
  const ltCount = lots.filter(l => l.term === 'LT').length, stCount = lots.filter(l => l.term === 'ST').length;
  // instalments 1 Jan 2026 … 1 Jun 2027 = 18. Long-term if bought on/before 14 Jun 2026 (more than 12 months before 15 Jun 2027): Jan–Jun 2026 = 6.
  ok(lots.length === 18, '18 SIP lots', String(lots.length));
  ok(ltCount === 6 && stCount === 12, '6 long-term lots, 12 short-term lots', `LT ${ltCount} ST ${stCount}`);
  const stGain = U.sum(lots.filter(l => l.term === 'ST'), l => l.gain);
  near(r.tax.tax, stGain * 0.20 * 1.04, 0.01, 'tax = 20% on ST lots only (LT lots under ₹1.25L exemption)');
}

// ---------------------------------------------------------------------------
section('9. Exit loads');
{
  near(Calc.exitLoadPct({ tiers: [{ days: 365, pct: 1 }] }, 200), 0.01, 1e-12, '1% within 365 days at day 200');
  near(Calc.exitLoadPct({ tiers: [{ days: 365, pct: 1 }] }, 366), 0, 1e-12, 'nil after 365 days');
  near(Calc.exitLoadPct({ tiers: [{ days: 365, pct: 2 }, { days: 730, pct: 1 }], freePct: 10 }, 400), 0.009, 1e-12, 'PPFAS-style: 1% on 90% of units in year 2 = 0.9%');
  near(Calc.exitLoadPct(null, 10), 0, 1e-12, 'unknown exit load → 0 (flagged in UI)');
  const h = Calc.projectHolding({ taxClass: 'equity_oriented', exitLoad: { tiers: [{ days: 365, pct: 1 }] }, grossReturnPct: 0, terPct: 0, contributions: [{ date: '2026-01-01', amount: 10000 }] }, '2026-07-20', noLevies, noCharges);
  near(h.exit, 100, 1e-9, 'exit load ₹100 on ₹10,000 redeemed within a year');
  near(h.lots[0].proceedsForTax, 9900, 1e-9, 'exit load reduces sale consideration for tax');
}

// ---------------------------------------------------------------------------
section('10. Redemption: stamp duty, STT, ETF charges and the gross → net identity');
{
  const end = '2036-11-16';
  const holdings = [
    { id: 'a', name: 'Nifty', taxClass: 'equity_oriented', exitLoad: null, amount: 4000, sipAmount: 500, grossReturnPct: 12, terPct: 0.2 },
    { id: 'b', name: 'Flexi', taxClass: 'equity_oriented', exitLoad: { tiers: [{ days: 365, pct: 2 }, { days: 730, pct: 1 }], freePct: 10 }, amount: 2500, sipAmount: 500, grossReturnPct: 12, terPct: 0.6 },
    { id: 'c', name: 'Gold ETF', taxClass: 'listed_non_equity_etf', listed: true, exitLoad: null, amount: 1500, sipAmount: 200, grossReturnPct: 8, terPct: 0.79 },
    { id: 'd', name: 'Gilt', taxClass: 'debt_specified', exitLoad: null, amount: 1000, sipAmount: 0, grossReturnPct: 7.5, terPct: 0.5 }
  ];
  const s2 = JSON.parse(JSON.stringify(settings)); s2.charges.etf.brokeragePerOrder = 20; s2.charges.etf.annualDematAmc = 300;
  const r = Calc.projectPortfolio({ holdings, startDate: '2026-11-16', endDate: end, rules, settings: s2, taxProfile: P0, inflationPct: 5 });
  near(r.vGross - r.net, r.totalLost, 0.005, 'gross − net = sum of every cost and tax (no double counting)');
  near(U.sum(Object.values(r.groupedLosses)), r.totalLost, 0.005, 'grouped loss categories add up to the total');
  const sd = 0.00005 / 1.00005;
  near(r.perHolding[0].lots[0].stamp, 4000 * sd, 1e-9, 'MF stamp duty 0.005% deducted from amount');
  const eqNav = r.perHolding[0].vNav;
  near(r.perHolding[0].stt, eqNav * 0.00001, 1e-6, 'STT 0.001% on equity MF redemption value');
  ok(r.perHolding[2].stt === 0, 'no STT on gold ETF');
  ok(r.perHolding[2].lots[0].txn > 20, 'ETF purchase includes ₹20 brokerage + GST + exchange + spread');
  ok(r.perHolding[3].stt === 0, 'no STT on debt funds');
  ok(r.losses.other === 300 * r.years, 'demat AMC counted as other cost');
  ok(r.net < r.vGross && r.net > r.invested, 'net between invested and gross for a positive-return case');
  near(r.realNet, r.net / Math.pow(1.05, r.years), 0.01, 'inflation-adjusted value');
}

// ---------------------------------------------------------------------------
section('11. Allocation totals & input validation');
{
  ok(Calc.allocationCheck([{ pct: 40 }, { pct: 35 }, { pct: 25 }], 9000).ok, '40+35+25 = 100% valid');
  const bad = Calc.allocationCheck([{ pct: 40 }, { pct: 35 }, { pct: 20 }], 9000);
  ok(!bad.ok && /95\.00%/.test(bad.message), 'allocation 95% flagged', bad.message);
  ok(!Calc.allocationCheck([], 9000).ok, 'empty allocation flagged');
  ok(Calc.validateInputs({ capital: 0, sip: 0, startDate: '2026-11-16', endDate: '2031-11-16', inflationPct: 5 }).length === 1, 'zero investment and zero SIP flagged');
  ok(Calc.validateInputs({ capital: -1, sip: 0, startDate: '2026-11-16', endDate: '2031-11-16', inflationPct: 5 }).some(e => /positive/.test(e)), 'negative capital rejected');
  ok(Calc.validateInputs({ capital: 9000, sip: 0, startDate: '2026-11-16', endDate: '2026-11-01', inflationPct: 5 }).some(e => /after/.test(e)), 'redemption before investment rejected');
  ok(Calc.validateInputs({ capital: 9000, sip: 0, startDate: 'abc', endDate: '2031-11-16', inflationPct: 5 }).some(e => /invalid/.test(e)), 'invalid date rejected');
  const z = Calc.projectPortfolio({ holdings: [{ id: 'z', name: 'Z', taxClass: 'equity_oriented', amount: 0, sipAmount: 0, grossReturnPct: 12, terPct: 0 }], startDate: '2026-11-16', endDate: '2031-11-16', rules, settings, taxProfile: P0 });
  ok(z.net === 0 && z.invested === 0 && z.tax.tax === 0 && isNaN(z.netXirr), 'zero investment → zero values, no crash, XIRR undefined');
}

// ---------------------------------------------------------------------------
section('12. Fund metrics from NAV history; missing data');
{
  // Synthetic NAV: exactly 10% per year compounding daily for 6 years (calendar days)
  const hist = []; const start = U.parseDate('2020-11-15');
  for (let i = 0; i <= 6 * 365 + 1; i++) { const d = U.addDays(start, i); hist.push({ d: U.iso(d), nav: 10 * Math.pow(1.10, i / 365) }); }
  const m = FR.computeMetrics(hist, { rfPct: 6, windows: settings.correctionWindows });
  near(m.cagr5, 0.10, 1e-4, '5-yr CAGR of a 10% series = 10%');
  near(m.cagr3, 0.10, 1e-4, '3-yr CAGR = 10%');
  ok(m.cagr10 === null, '10-yr CAGR unavailable with 6 years of history');
  near(m.maxDDAll.mdd, 0, 1e-12, 'monotonic series has zero drawdown');
  ok(m.rolling3 && Math.abs(m.rolling3.median - 0.10) < 1e-3 && m.rolling3.pctAboveRf === 1, 'rolling 3-yr CAGR all ≈10% and all above risk-free');
  const dd = FR.maxDrawdown([{ d: '1', nav: 100 }, { d: '2', nav: 120 }, { d: '3', nav: 60 }, { d: '4', nav: 130 }]);
  near(dd.mdd, -0.5, 1e-12, 'max drawdown 120 → 60 = −50%');
  const empty = FR.computeMetrics([], {});
  ok(empty.available === false, 'empty NAV history → metrics unavailable (no fabricated numbers)');
  const short = FR.computeMetrics(hist.slice(-200), { rfPct: 6 });
  ok(short.cagr3 === null && short.sharpe3 === null && short.maxDD5 === null, 'short history → 3/5-yr metrics null');
  const raw = [{ d: '2019-12-19', nav: 3300 }, { d: '2019-12-20', nav: 3358.6429 }, { d: '2019-12-23', nav: 33.7313 }, { d: '2019-12-24', nav: 34 }];
  const adj = FR.adjustSplits(raw);
  ok(adj.adjustments.length === 1 && adj.adjustments[0].date === '2019-12-23', 'GOLDBEES-style 1:100 split detected');
  near(adj.hist[1].nav, 3358.6429 * (33.7313 / 3358.6429), 1e-9, 'pre-split NAV rescaled to post-split units');
  near(adj.hist[3].nav, 34, 1e-12, 'post-split NAVs unchanged');
  ok(FR.maxDrawdown(adj.hist).mdd > -0.02, 'no artificial −99% drawdown after adjustment');
  ok(FR.adjustSplits(hist).adjustments.length === 0, 'normal series has no adjustments');
  const ps = FR.percentileScores([1, null, 3, 2]);
  ok(ps[0] === 0 && ps[1] === null && ps[2] === 100 && ps[3] === 50, 'percentile scoring with a missing value');
}

section('13. Recommendation engine respects minimums, horizon and 100% total');
{
  const cats = fundsCfg.categories;
  const items = fundsCfg.funds.map(f => ({ fund: f, category: cats[f.category], metrics: { historyYears: 8, cagr5: 0.1, cagr3: 0.1, sortino3: 1, maxDD5: { mdd: -0.2 }, rolling3: { median: 0.1, pctAboveRf: 0.8 } } }));
  FR.scoreFunds(items, settings.scoring.weights);
  for (const [pid, prof] of Object.entries(settings.profiles)) {
    for (const hz of [5, 10]) {
      const res = FR.buildModelPortfolio({ profile: prof, capital: 9000, sip: 0, horizonYears: hz, items, categories: cats, rules: settings.selectionRules, slabRatePct: 20 });
      const tot = U.sum(res.rows, r => r.amount);
      ok(tot === 9000, `${pid} ${hz}y: amounts total ₹9,000`, String(tot));
      near(U.sum(res.rows, r => r.pct), 100, 1e-9, `${pid} ${hz}y: percentages total 100%`);
      ok(res.rows.every(r => r.item.fund.minLumpsum != null && r.item.fund.minLumpsum <= r.amount), `${pid} ${hz}y: every pick meets its verified minimum lump sum`);
      ok(res.rows.length <= 4, `${pid} ${hz}y: at most 4 funds for ₹9,000`);
      if (hz === 5) ok(!res.rows.some(r => ['smallcap', 'midcap'].includes(r.item.fund.category)), `${pid} 5y: no mid/small caps below their minimum holding period`);
    }
  }
}

// ---------------------------------------------------------------------------
section('13b. Category auto-detection for custom AMFI schemes');
{
  const g = FR.guessCategory;
  ok(g('Equity Scheme - Large Cap Fund', 'X Bluechip') === 'largecap', 'large cap');
  ok(g('Equity Scheme - Large & Mid Cap Fund', 'X') === 'equity_other', 'large & mid cap → other diversified equity');
  ok(g('Equity Scheme - ELSS', 'X Tax Saver') === 'elss', 'ELSS');
  ok(g('Other Scheme - Index Funds', 'X Nifty 50 Index Fund') === 'index_largecap', 'Nifty 50 index');
  ok(g('Other Scheme - Index Funds', 'X Nifty Next 50 Index') === 'index_next50', 'Next 50 index');
  ok(g('Other Scheme - Index Funds', 'X Nifty G-Sec Jun 2036 Index') === 'debt_other', 'G-Sec index → debt');
  ok(g('Other Scheme - FoF Overseas', 'X US Equity FoF') === 'international_fof', 'overseas FoF');
  ok(g('Other Scheme - Gold ETF', 'X Gold ETF') === 'gold_etf', 'gold ETF');
  ok(g('Hybrid Scheme - Multi Asset Allocation', 'X') === 'multi_asset', 'multi asset');
  ok(g('Debt Scheme - Liquid Fund', 'X') === 'liquid', 'liquid');
  ok(g('', '') === null, 'unknown → null (user must choose)');
}

section('17. Net worth: valuation of each asset type');
const NW = require('../js/networth.js');
const nwCtx = (extra = {}) => Object.assign({ today: '2026-11-15', rules, nw: settings.netWorth, scen: 'm', slabRatePct: 20, cessPct: 4, surchargePct: 0, inflationPct: 6, goldGrowthPct: 8, liquidYieldPct: 6.5, profile: { monthlyExpenses: 40000, emergencyMonths: 6 } }, extra);
{
  const ctx = nwCtx();
  const fd = { id: 'f', type: 'fd', principal: 100000, ratePct: 7, startDate: '2025-11-15', maturityDate: '2028-11-15', compounding: 'quarterly' };
  near(NW.valueAt(fd, '2026-11-15', ctx).value, 100000 * Math.pow(1 + 0.07 / 4, 4 * (365 / 365)), 0.01, 'FD quarterly compounding after 1 year');
  near(NW.valueAt(fd, '2028-11-15', ctx).value, 100000 * Math.pow(1.0175, 4 * (U.daysBetween('2025-11-15', '2028-11-15') / 365)), 0.01, 'FD maturity value');
  near(NW.valueAt(Object.assign({}, fd, { compounding: 'payout' }), '2027-11-15', ctx).value, 100000, 1e-9, 'payout FD keeps principal');
  near(NW.fdEffYield(fd), Math.pow(1.0175, 4) - 1, 1e-12, 'FD effective annual yield');
  // gold auto-tracking: price entered 10,000/g on a date when NAV was 100; NAV now 110 → 11,000/g
  const navs = { '2026-06-01': 100, '2026-11-13': 110 };
  const gctx = nwCtx({ goldNav: d => (U.iso(d) >= '2026-11-13' ? 110 : 100), goldLatestDate: '2026-11-13' });
  const gold = { id: 'g', type: 'gold', form: 'jewellery', grams: 20, purity: 22, pricePerGram: 10000, priceDate: '2026-06-01', autoTrack: true, purchaseDate: '2020-01-01', purchaseCost: 80000 };
  near(NW.valueAt(gold, '2026-11-15', gctx).value, 20 * (22 / 24) * 11000, 0.01, 'gold value = grams × purity × price moved with gold ETF NAV');
  near(NW.valueAt(Object.assign({}, gold, { autoTrack: false }), '2026-11-15', gctx).value, 20 * (22 / 24) * 10000, 0.01, 'manual gold price stays as entered');
  const loan = { id: 'l', type: 'loan', kind: 'personal', outstanding: 100000, ratePct: 12, emi: 4707.35, asOf: '2026-11-15' };
  near(NW.loanBalance(loan, '2028-11-15'), 0, 5, 'EMI 4,707 at 12% repays ₹1L in 24 months');
  ok(NW.loanMonthsLeft(loan) === 24, 'months left = 24', String(NW.loanMonthsLeft(loan)));
  const ppf = { id: 'p', type: 'scheme', scheme: 'PPF', balance: 100000, annualContribution: 0 };
  near(NW.valueAt(ppf, '2027-11-15', ctx).value, 107100, 0.01, 'PPF grows at the sourced 7.1%');
  const pol = { id: 'i', type: 'insurance', kind: 'endowment', annualPremium: 50000, startDate: '2016-01-01', maturityDate: '2036-01-01', premiumYears: 20, maturityValue: 1600000, surrenderValue: 500000 };
  const irr = NW.policyIrr(pol);
  ok(irr > 0.04 && irr < 0.05, `endowment IRR ≈ 4.4% (₹50k × 20 yrs → ₹16L)`, String(irr));
  ok(NW.valueAt({ id: 't', type: 'insurance', kind: 'term', annualPremium: 12000 }, '2026-11-15', ctx).value === 0, 'term insurance has no asset value');
}

section('18. Net worth: totals, liquidation tax and shared equity exemption');
{
  const ctx = nwCtx();
  const assets = [
    { id: 'c', type: 'cash', amount: 50000 },
    { id: 's', type: 'stock', quantity: 100, avgPrice: 1000, currentPrice: 2000, buyDate: '2023-01-01', taxClass: 'equity_oriented' },
    { id: 'm', type: 'mf', value: 200000, taxClass: 'equity_oriented', lots: [{ buyDate: '2023-01-01', cost: 100000, value: 200000 }], growthPct: 10 },
    { id: 'l', type: 'loan', kind: 'car', outstanding: 300000, ratePct: 9, emi: 0 }
  ];
  const rows = NW.evaluate(assets, '2026-11-15', ctx), T = NW.totals(rows);
  near(T.netWorth, 50000 + 200000 + 200000 - 300000, 1e-6, 'net worth = assets − liabilities');
  near(T.liabilities, 300000, 1e-6, 'liabilities total');
  // stock gain ≈ 1L (minus small selling costs) + MF gain 1L → ~2L LTCG, ONE ₹1.25L exemption shared
  const sellCost = 200000 * 0.0012, stt = 200000 * 0.001;
  const stockGain = 200000 - (sellCost - stt) - 100000;
  near(rows.cgTax.tax, (stockGain + 100000 - 125000) * 0.125 * 1.04, 0.01, 'stocks + MF share one ₹1.25L exemption (not counted twice)');
  // property: lower of 12.5% and 20% with indexation
  const prop = (buy) => ({ id: 'p', type: 'property', subtype: 'land', purchaseDate: buy, purchaseCost: 2000000, currentValue: 6000000, valuationDate: '2026-11-15', sellCostPct: 0 });
  const r1 = NW.evaluate([prop('2015-06-01')], '2026-11-15', ctx)[0];
  near(r1.tax, Math.min(4000000 * 0.125, (6000000 - 2000000 * 384 / 254) * 0.20) * 1.04, 1, 'land bought 2015: lower of 12.5% vs 20%-indexed (12.5% wins)');
  const r2 = NW.evaluate([prop('2005-06-01')], '2026-11-15', ctx)[0];
  near(r2.tax, Math.max(0, (6000000 - 2000000 * 384 / 117)) * 0.20 * 1.04, 1, 'land bought 2005: indexed cost ₹65.6L > sale → ₹0 tax under the 20% option');
  const r3 = NW.evaluate([prop('2024-08-01')], '2026-11-15', ctx)[0];
  near(r3.tax, 4000000 * 0.125 * 1.04, 1, 'land bought after 23 Jul 2024 (held >24 months): only 12.5% without indexation');
  const r4 = NW.evaluate([prop('2025-01-01')], '2026-11-15', ctx)[0];
  near(r4.tax, 4000000 * 0.20 * 1.04, 1, 'land held 22 months: short-term at slab');
  const sgb = { id: 'b', type: 'gold', form: 'sgb', grams: 10, pricePerGram: 12000, autoTrack: false, purchaseDate: '2017-01-01', purchaseCost: 29000 };
  ok(NW.evaluate([sgb], '2026-11-15', ctx)[0].tax === 0, 'SGB held to 8-yr maturity: gain exempt');
  const fc = NW.forecast([{ id: 'c', type: 'cash', amount: 100000 }], ctx, '2031-11-15');
  ok(fc.length === 6 && fc[5].netWorth === 100000, '5-yr forecast has 6 points; cash stays flat');
  near(fc[5].real, 100000 / Math.pow(1.06, U.yearsBetween('2026-11-15', '2031-11-15')), 0.01, 'real value deflated by inflation');
}

section('18b. Planned investment as a net-worth component');
{
  const stub = d => d <= '2026-11-15' ? { value: 9000, contrib: 0, costs: 0, lots: [] }
    : { value: 100000, contrib: 12000, costs: 50, lots: [{ buyDate: '2026-11-15', cost: 20000, proceeds: 99950, taxClass: 'equity_oriented' }] };
  const ctx = nwCtx({ projectors: { plan: stub } });
  const plan = { id: 'plan', type: 'projected', name: 'Plan' };
  const stock = { id: 's', type: 'stock', quantity: 100, avgPrice: 1000, currentPrice: 2000, buyDate: '2020-01-01', taxClass: 'equity_oriented', expectedReturnPct: 0 };
  const today = NW.totals(NW.evaluate([plan], '2026-11-15', ctx));
  near(today.netWorth, 9000, 1e-9, 'plan counts its lump sum today');
  const rows = NW.evaluate([plan, stock], '2031-11-15', ctx), T = NW.totals(rows);
  near(T.netWorth, 100000 + 200000, 1e-6, 'plan value at horizon added to net worth');
  near(T.contrib, 12000, 1e-9, 'future SIP contributions reported');
  const stockGain = 200000 - (200000 * 0.0012 - 200000 * 0.001) - 100000;
  near(rows.cgTax.tax, (stockGain + 79950 - 125000) * 0.125 * 1.04, 0.01, 'plan + stocks share ONE ₹1.25L equity exemption');
  near(rows[0].costs, 50, 1e-9, 'plan exit loads / sell charges carried through');
  near(NW.totals(NW.evaluate([plan], '2031-11-15', nwCtx())).netWorth, 0, 1e-9, 'no projector → contributes nothing (no invented value)');
}

section('19. Money leaks');
{
  const ctx = nwCtx();
  const L = NW.leaks([
    { id: 'c', type: 'cash', amount: 140000 },
    { id: 'sv', type: 'savings', balance: 500000, ratePct: 2.5 },
    { id: 'fd', type: 'fd', principal: 100000, ratePct: 6.5, startDate: '2026-01-01', maturityDate: '2029-01-01', compounding: 'quarterly' },
    { id: 'cc', type: 'loan', kind: 'credit_card', outstanding: 50000, ratePct: 42 },
    { id: 'pl', type: 'property', subtype: 'land', currentValue: 2000000, annualCosts: 15000, annualRent: 0 },
    { id: 'g', type: 'gold', form: 'jewellery', grams: 10, purity: 22, pricePerGram: 12000, autoTrack: false, lockerFee: 3000 }
  ], ctx);
  const get = k => L.find(l => l.key === k || l.key.startsWith(k));
  near(get('cash').annual, (140000 - 40000) * 0.06, 0.01, 'idle cash beyond one month of expenses × inflation');
  near(get('savings').annual, (500000 - (240000 - 140000)) * (0.065 - 0.025) * (1 - 0.208), 0.01, 'savings above emergency fund × yield gap (after tax)');
  const post = (Math.pow(1 + 0.065 / 4, 4) - 1) * (1 - 0.208);
  near(get('fd-').annual, NW.valueAt({ type: 'fd', principal: 100000, ratePct: 6.5, startDate: '2026-01-01', maturityDate: '2029-01-01', compounding: 'quarterly' }, '2026-11-15', ctx).value * (0.06 - post), 0.01, 'FD real loss after tax');
  near(get('debt-').annual, 50000 * 0.42, 0.01, 'credit-card interest flagged');
  near(get('prop-').annual, 15000, 0.01, 'land holding cost with no income');
  near(get('locker-').annual, 3000, 0.01, 'gold locker fee');
  ok(L.every(l => isFinite(l.annual)), 'all leak amounts finite');
  ok(NW.leaks([], nwCtx({ profile: { monthlyExpenses: 0 } })).some(l => l.key === 'noexp'), 'asks for monthly expenses when missing');
}

// ---------------------------------------------------------------------------
section('14. Data service: API failure, fallback and stale data');
(async () => {
  const failing = async () => { throw new Error('network down'); };
  const ds = DS.create(settings, { fetch: failing, storage: DS.safeStorage(), retryDelayMs: 0 });
  const r = await ds.getHistory(120716);
  ok(r.hist.length === 0 && /network down/.test(r.error), 'all sources down → empty history with error (nothing invented)');
  ds.cacheMetrics(120716, { metrics: { latestNav: 100, latestDate: '2026-11-01' }, fetchedAt: '2026-11-01T00:00:00Z' });
  ok(ds.cachedMetrics(120716).metrics.latestNav === 100, 'last good metrics retrievable from cache');
  const f = ds.freshness('2026-11-01', '2026-11-01T00:00:00Z', '2026-11-15');
  ok(f.navStale && f.cacheStale && f.navAgeDays === 14, 'NAV 14 days old flagged stale');
  const fresh = ds.freshness('2026-11-13', new Date().toISOString(), '2026-11-15');
  ok(!fresh.navStale && !fresh.cacheStale, 'NAV 2 days old (weekend) not stale');
  const okFetch = async (url) => ({ ok: !/health/.test(url), status: /health/.test(url) ? 404 : 200, json: async () => ({ meta: {}, data: [{ date: '13-11-2026', nav: '177.16' }, { date: '12-11-2026', nav: '178.25' }, { date: 'bad', nav: 'x' }] }) });
  const ds2 = DS.create(settings, { fetch: okFetch, storage: DS.safeStorage() });
  const r2 = await ds2.getHistory(120716);
  ok(r2.hist.length === 2 && r2.hist[0].d === '2026-11-12' && r2.source === 'mfapi.in', 'mfapi parse: ascending, invalid rows dropped, backend absent → direct');
  let calls = 0;
  const flaky = async (url) => { if (/health/.test(url)) return { ok: false, status: 404, json: async () => ({}) }; calls++; if (calls === 1) throw new TypeError('Failed to fetch (CORS)'); return { ok: true, status: 200, json: async () => ({ meta: {}, data: [{ date: '13-11-2026', nav: '10' }] }) }; };
  const ds3 = DS.create(settings, { fetch: flaky, storage: DS.safeStorage(), retryDelayMs: 0 });
  const r3 = await ds3.getHistory(125354);
  ok(r3.hist.length === 1 && r3.attempts === 2, 'mfapi CORS-blocked first response → retried with a fresh cache key and succeeded');

  // -------------------------------------------------------------------------
  section('15. Portfolio tracker: multiple lots, FIFO, realized vs unrealized');
  const tx = [
    { id: 1, type: 'BUY', date: '2025-01-10', fundName: 'Test Eq', schemeCode: 1, taxClass: 'equity_oriented', amount: 10000, units: 100 },
    { id: 2, type: 'BUY', date: '2025-06-10', fundName: 'Test Eq', schemeCode: 1, taxClass: 'equity_oriented', amount: 12000, units: 100 },
    { id: 3, type: 'SELL', date: '2026-03-01', fundName: 'Test Eq', schemeCode: 1, taxClass: 'equity_oriented', amount: 15000, units: 120 }
  ].map(t => PF.normalise(t).txn);
  const res = PF.compute(tx, { '1': { nav: 150, date: '2026-11-13' } }, rules, P0, '2026-11-15');
  const h = res.holdings[0];
  near(h.units, 80, 1e-9, '80 units remain after FIFO sale of 120');
  near(h.cost, 80 * 120, 1e-9, 'remaining cost = 80 units of the second lot at ₹120');
  near(res.realizedGain, 15000 - (10000 + 20 * 120), 1e-9, 'realized gain = 15,000 − (10,000 + 2,400)');
  // lot 1: held 10 Jan 2025 → 1 Mar 2026 (>12m) LT; lot 2 piece held <12m ST.
  const rt = res.realizedTax.lots;
  ok(rt.find(l => l.buyDate === '2025-01-10').cls.term === 'LT' && rt.find(l => l.buyDate === '2025-06-10').cls.term === 'ST', 'each matched piece gets its own holding period');
  near(res.realizedTax.tax, Math.max(0, 20 * 125 - 20 * 120) * 0.20 * 1.04, 0.01, 'tax: ST part ₹100 at 20%+cess; LT part within exemption');
  near(res.unrealized, 80 * 150 - 80 * 120, 1e-9, 'unrealized gain at latest NAV');
  const bad = PF.compute([PF.normalise({ id: 9, type: 'SELL', date: '2026-01-01', fundName: 'X', taxClass: 'equity_oriented', amount: 100, units: 1 }).txn], {}, rules, P0);
  ok(bad.errors.length === 1, 'selling more units than held is reported');
  ok(PF.normalise({ type: 'BUY', date: '2026-01-01', fundName: 'X', taxClass: 'equity_oriented', amount: 1000 }).errors.length === 1, 'buy needs two of amount / units / NAV');
  const missing = PF.compute([PF.normalise({ id: 5, type: 'BUY', date: '2026-01-01', fundName: 'No NAV', schemeCode: 999, taxClass: 'equity_oriented', amount: 1000, units: 10 }).txn], {}, rules, P0);
  ok(missing.missingNav.length === 1 && missing.value === 0, 'holding with no NAV available is listed as missing, not valued');
  const csv = PF.transactionsCSV(tx);
  const back = PF.parseCSV(csv);
  ok(back.length === 3 && back[2].type === 'SELL' && +back[2].units === 120, 'CSV export → import round-trip');

  // -------------------------------------------------------------------------
  section('16. XIRR');
  near(U.xirr([{ date: '2020-01-01', amount: -9000 }, { date: '2024-12-30', amount: 15000 }]), Math.pow(15000 / 9000, 365 / U.daysBetween('2020-01-01', '2024-12-30')) - 1, 1e-8, 'single-flow XIRR = CAGR');
  ok(isNaN(U.xirr([{ date: '2020-01-01', amount: -9000 }])), 'XIRR undefined without an inflow');
  near(U.xirr([{ date: '2020-01-01', amount: -9000 }, { date: '2021-01-01', amount: 4500 }]), Math.pow(0.5, 365 / 366) - 1, 1e-8, 'negative return XIRR');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
})();
