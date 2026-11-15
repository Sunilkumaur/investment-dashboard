/* Main application: state, rendering and event wiring. Calculations live in the engine modules. */
(function () {
  'use strict';
  const U = window.FinUtil, Calc = window.Calc, TaxEngine = window.TaxEngine, FR = window.FundResearch, PF = window.Portfolio;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = v => (v == null || !isFinite(v)) ? '—' : (Math.abs(v) < 100 && Math.abs(v) > 0 ? U.inr(v, 2) : U.inr(v, 0));
  const pf = (v, dp = 1) => (v == null || !isFinite(v)) ? '<span class="mut" title="Not available from the data source">n/a</span>' : (v * 100).toFixed(dp) + '%';
  const pfs = (v, dp = 1) => (v == null || !isFinite(v)) ? 'n/a' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%';
  const fx = (v, dp = 2) => (v == null || !isFinite(v)) ? '<span class="mut">n/a</span>' : v.toFixed(dp);
  const deep = o => JSON.parse(JSON.stringify(o));
  const STATE_KEY = 'siird.state.v1';
  const store = DataService.safeStorage();

  let CFG, CATS, DS, S, SCORED = [], MODEL = null, RES = null;
  const MET = {}, HIST = {}, OFFICIAL = {};
  const CH = {};
  let dataLoaded = false, rfPct = null, rfSource = '';
  let uidSeq = 1;

  // ------------------------------------------------------------------ boot
  async function boot() {
    try {
      const [tax, funds, settings] = await Promise.all(['config/tax-rules.json', 'config/funds.json', 'config/settings.json'].map(u => fetch(u, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.json(); })));
      CFG = { tax, funds, settings }; CATS = funds.categories;
    } catch (e) {
      $('fatal').innerHTML = `<div class="banner bad"><b>Could not load configuration files.</b> Browsers block reading local JSON when a page is opened directly from disk. Start the local server and open the address it prints:<pre style="margin:8px 0 0">python backend/server.py</pre><span class="note">${esc(e.message)}</span></div>`;
      $('dataChip').textContent = 'Config not loaded'; $('dataChip').className = 'status-chip bad';
      return;
    }
    DS = DataService.create(CFG.settings);
    S = loadState();
    bindStatic();
    renderAssumptionsStatic();
    renderSources();
    renderAll();
    loadData();
  }

  function defaultState() {
    const a = CFG.settings.app, t = CFG.tax.defaults;
    const today = U.todayISO();
    return {
      capital: a.defaultCapital, sip: a.defaultMonthlySip, stepUp: 0, startDate: today,
      horizon: a.defaultHorizonYears, customYears: a.defaultHorizonYears, endOverride: null,
      scenario: a.defaultScenario, inflation: a.defaultInflationPct, profile: a.defaultProfile,
      rows: null,
      tax: { slab: t.slabRatePct, surchargeId: t.surchargeBracket, cess: t.cessPct, nFY: t.redemptionFYs, ov: { eqST: '', eqLT: '', otherLT: '', exemption: '' } },
      levies: pickLevies(CFG.tax.statutoryLevies),
      charges: deep(CFG.settings.charges.etf),
      catScen: {}, weights: deep(CFG.settings.scoring.weights),
      strategies: [], customFunds: [], fc: ['uti-nifty50', 'ppfas-flexi', 'mo-midcap150', 'hdfc-gold-fof'],
      rd: { fundId: 'uti-nifty50', amt: 9000, sip: 0, start: U.iso(U.addYears(today, -5)), end: U.iso(U.addDays(today, -2)), ret: '' },
      seenSnapshot: null
    };
  }
  function pickLevies(l) { const o = {}; Object.keys(l).forEach(k => { if (typeof l[k] === 'number') o[k] = l[k]; }); return o; }
  function loadState() {
    const d = defaultState();
    try {
      const s = JSON.parse(store.getItem(STATE_KEY) || 'null');
      if (s && typeof s === 'object') {
        const m = Object.assign(d, s);
        m.tax = Object.assign(defaultState().tax, s.tax || {}); m.tax.ov = Object.assign(defaultState().tax.ov, (s.tax || {}).ov || {});
        m.levies = Object.assign(defaultState().levies, s.levies || {});
        m.charges = Object.assign(defaultState().charges, s.charges || {});
        m.weights = Object.assign(defaultState().weights, s.weights || {});
        m.rd = Object.assign(defaultState().rd, s.rd || {});
        if (Array.isArray(m.rows)) m.rows.forEach(r => { r.uid = uidSeq++; });
        return m;
      }
    } catch (e) { /* ignore corrupt state */ }
    return d;
  }
  let saveTimer = null;
  function saveState() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { const c = Object.assign({}, S, { rows: S.rows && S.rows.map(r => { const x = Object.assign({}, r); delete x.uid; return x; }) }); store.setItem(STATE_KEY, JSON.stringify(c)); } catch (e) { /* storage unavailable */ } }, 300); }

  // ------------------------------------------------------------------ model helpers
  const allFunds = () => CFG.funds.funds.concat(S.customFunds || []);
  const fundById = id => allFunds().find(f => f.id === id);
  const horizonYears = () => S.endOverride ? U.round(U.yearsBetween(S.startDate, S.endOverride), 2) : (S.horizon === 'custom' ? +S.customYears || 0 : +S.horizon);
  const endDate = () => S.endOverride || U.iso(U.addMonths(S.startDate, Math.round(horizonYears() * 12)));
  const catScen = (cat, sc) => (S.catScen[cat] && isFinite(S.catScen[cat][sc]) ? S.catScen[cat][sc] : CATS[cat].scenario[sc]);
  const metricsFor = f => (f && MET[f.schemeCode] ? MET[f.schemeCode].metrics : null);

  function eff(row, scen = S.scenario) {
    const f = fundById(row.fundId); if (!f) return null;
    const cat = CATS[f.category];
    let ter, terSrc;
    if (isFinite(row.ter) && row.ter !== '' && row.ter != null) { ter = +row.ter; terSrc = 'your override'; }
    else if (f.ter != null) { ter = f.ter; terSrc = f.userEntered ? 'user-entered' : `factsheet ${f.source && f.source.asOf || ''}`; }
    else { ter = cat.defaultTer; terSrc = 'ASSUMED — category default (factsheet value not verified)'; }
    const ret = row.ret && isFinite(row.ret[scen]) && row.ret[scen] !== '' ? +row.ret[scen] : catScen(f.category, scen);
    const exitLoad = row.exitLoad || f.exitLoad;
    return { f, cat, taxClass: cat.taxClass, listed: !!f.listed, ter, terSrc, ret, retOverridden: !!(row.ret && isFinite(row.ret[scen]) && row.ret[scen] !== ''), exitLoad, exitUnknown: !exitLoad };
  }
  function toHoldings(rows, capital, sip, scen) {
    return rows.map(r => { const e = eff(r, scen); if (!e) return null; return { id: r.fundId, name: e.f.name, taxClass: e.taxClass, listed: e.listed, exitLoad: e.exitLoad, amount: capital * (+r.pct || 0) / 100, sipAmount: sip * (+r.pct || 0) / 100, grossReturnPct: e.ret, terPct: e.ter }; }).filter(Boolean);
  }
  function rulesEff() { return Object.assign({}, CFG.tax, { statutoryLevies: Object.assign({}, CFG.tax.statutoryLevies, S.levies) }); }
  function settingsEff() { return Object.assign({}, CFG.settings, { charges: Object.assign({}, CFG.settings.charges, { etf: S.charges }) }); }
  function taxProfile() {
    const br = CFG.tax.surchargeBrackets.find(b => b.id === S.tax.surchargeId) || { pct: 0 };
    const num = v => (v === '' || v == null || !isFinite(+v)) ? undefined : +v;
    return { slabRatePct: +S.tax.slab || 0, cessPct: +S.tax.cess || 0, surchargePct: br.pct, exemptionMultiplier: Math.max(1, Math.round(+S.tax.nFY || 1)), overrides: { eqST: num(S.tax.ov.eqST), eqLT: num(S.tax.ov.eqLT), otherLT: num(S.tax.ov.otherLT), exemption: num(S.tax.ov.exemption) } };
  }
  function project(rows, opt = {}) {
    const capital = opt.capital ?? S.capital, sip = opt.sip ?? S.sip;
    return Calc.projectPortfolio({ holdings: toHoldings(rows, capital, sip, opt.scen || S.scenario), startDate: opt.start || S.startDate, endDate: opt.end || endDate(), stepUpPct: S.stepUp, rules: rulesEff(), settings: settingsEff(), taxProfile: taxProfile(), inflationPct: S.inflation });
  }

  function scoreItems() {
    const items = allFunds().map(f => ({ fund: f, category: CATS[f.category], metrics: metricsFor(f) }));
    FR.scoreFunds(items, S.weights);
    return items;
  }
  function buildModel(profileId) {
    return FR.buildModelPortfolio({ profile: deep(CFG.settings.profiles[profileId]), capital: S.capital, sip: S.sip, horizonYears: horizonYears(), items: SCORED.filter(i => !i.fund.userEntered), categories: CATS, rules: CFG.settings.selectionRules, slabRatePct: +S.tax.slab });
  }
  const modelToRows = m => m.rows.map(r => ({ uid: uidSeq++, fundId: r.fundId, pct: U.round(r.pct, 4) }));
  const scoreOf = id => (SCORED.find(i => i.fund.id === id) || {}).score;

  // ------------------------------------------------------------------ data loading
  async function loadData() {
    const st = CFG.settings;
    const codes = [...new Set(allFunds().flatMap(f => [f.schemeCode, f.benchmarkProxy]).filter(Boolean))];
    const rfCode = st.riskFree.proxySchemeCode;
    let done = 0;
    const chip = () => { $('dataChip').textContent = `Loading NAV history ${done}/${codes.length}…`; };
    chip();
    const fetchOne = async code => {
      const r = await DS.getHistory(code);
      if (r.hist.length) {
        const adj = FR.adjustSplits(r.hist);
        HIST[code] = adj.hist;
        const metrics = FR.computeMetrics(adj.hist, { rfPct: rfPct ?? st.riskFree.fallbackPct, windows: st.correctionWindows });
        metrics.splitAdjustments = adj.adjustments;
        MET[code] = { metrics, source: r.source, fetchedAt: r.fetchedAt, live: !r.upstreamStale, schemeName: r.meta && r.meta.scheme_name };
        DS.cacheMetrics(code, { metrics, source: r.source, fetchedAt: r.fetchedAt, schemeName: MET[code].schemeName });
      } else {
        const c = DS.cachedMetrics(code);
        MET[code] = c ? Object.assign({}, c, { live: false, stale: true, error: r.error }) : { metrics: { available: false }, live: false, error: r.error };
      }
      done++; chip();
    };
    await fetchOne(rfCode);
    const rfm = MET[rfCode] && MET[rfCode].metrics;
    if (rfm && rfm.cagr3 != null) { rfPct = rfm.cagr3 * 100; rfSource = `${st.riskFree.proxyLabel}: ${rfPct.toFixed(2)}%`; }
    else { rfPct = st.riskFree.fallbackPct; rfSource = `fallback assumption ${rfPct}% (liquid-fund history unavailable)`; }
    if (HIST[rfCode]) MET[rfCode].metrics = FR.computeMetrics(HIST[rfCode], { rfPct, windows: st.correctionWindows });
    await DS.pool(codes.filter(c => c !== rfCode), 4, fetchOne);

    const off = await DS.getLatestOfficial(codes);
    if (off && off.navs) Object.entries(off.navs).forEach(([c, v]) => { OFFICIAL[c] = { nav: v.nav, date: U.iso(v.date), fetchedAt: off.fetchedAt, stale: off.stale }; });
    dataLoaded = true;
    if (!S.rows) { SCORED = scoreItems(); MODEL = buildModel(S.profile); S.rows = modelToRows(MODEL); saveState(); }
    renderAll();
    if (location.hash.length > 1) { const t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }

  async function ensureHistory(code) {
    if (HIST[code] || !code) return HIST[code];
    const r = await DS.getHistory(code);
    if (r.hist.length) {
      const adj = FR.adjustSplits(r.hist); HIST[code] = adj.hist;
      const metrics = FR.computeMetrics(adj.hist, { rfPct: rfPct ?? 6, windows: CFG.settings.correctionWindows }); metrics.splitAdjustments = adj.adjustments;
      MET[code] = { metrics, source: r.source, fetchedAt: r.fetchedAt, live: true, schemeName: r.meta && r.meta.scheme_name };
    }
    return HIST[code];
  }

  function latestNav(code) {
    const o = OFFICIAL[code], m = MET[code] && MET[code].metrics;
    if (o && (!m || !m.latestDate || o.date >= m.latestDate)) return { nav: o.nav, date: o.date, source: 'AMFI NAVAll.txt (official)' + (o.stale ? ' — cached copy' : ''), fetchedAt: o.fetchedAt };
    if (m && m.available) return { nav: m.latestNav, date: m.latestDate, source: (MET[code].source || '') + (MET[code].live === false ? ' — CACHED' : ''), fetchedAt: MET[code].fetchedAt };
    return null;
  }

  // ------------------------------------------------------------------ render orchestration
  let renderTimer = null;
  function schedule() { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 120); saveState(); }

  function renderAll() {
    SCORED = scoreItems();
    MODEL = dataLoaded ? buildModel(S.profile) : null;
    renderControls();
    const errs = Calc.validateInputs({ capital: +S.capital, sip: +S.sip, startDate: S.startDate, endDate: endDate(), inflationPct: +S.inflation });
    $('inputErrors').innerHTML = errs.length ? `<div class="banner bad"><b>Check your inputs:</b><ul class="tight">${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '';
    const rows = S.rows || [];
    RES = (!errs.length && rows.length) ? project(rows) : null;
    safe(renderKPIs); safe(renderModel); safe(renderShortlist); safe(renderAlloc); safe(renderStrategies);
    safe(renderProjection); safe(renderTaxes); safe(renderRedeem); safe(renderCompare); safe(renderFundCompare);
    safe(renderUpdates); safe(renderPortfolio); safe(renderAssumptionValues); safe(renderDataChip);
  }
  function safe(fn) { try { fn(); } catch (e) { console.error(fn.name, e); } }

  function renderDataChip() {
    const chip = $('dataChip');
    if (!dataLoaded) return;
    const codes = allFunds().map(f => f.schemeCode);
    const live = codes.filter(c => MET[c] && MET[c].live).length, cached = codes.filter(c => MET[c] && !MET[c].live && MET[c].metrics && MET[c].metrics.available).length;
    const missing = codes.length - live - cached;
    const staleNav = codes.filter(c => { const l = latestNav(c); return !l || DS.freshness(l.date, l.fetchedAt).navStale; }).length;
    chip.textContent = `${DS.isBackend() ? 'Backend + AMFI' : 'mfapi.in'} · ${live} live${cached ? `, ${cached} cached` : ''}${missing ? `, ${missing} unavailable` : ''}${staleNav ? ` · ${staleNav} stale NAV` : ''}`;
    chip.className = 'status-chip ' + (missing || cached ? 'warn' : staleNav ? 'warn' : 'ok');
  }

  // ------------------------------------------------------------------ controls
  function bindStatic() {
    const P = CFG.settings.profiles;
    $('profile').innerHTML = Object.entries(P).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
    const catOpts = Object.entries(CATS).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join('');
    $('catFilter').innerHTML = '<option value="">All categories</option>' + catOpts;
    $('amfiCat').innerHTML = catOpts;
    $('txClass').innerHTML = Object.entries(CFG.tax.taxClasses).map(([k, c]) => `<option value="${k}">${esc(c.label)}</option>`).join('');

    const bindNum = (id, key, after) => $(id).addEventListener('input', e => { S[key] = e.target.value === '' ? 0 : +e.target.value; if (after) after(); schedule(); });
    bindNum('capital', 'capital'); bindNum('sip', 'sip'); bindNum('stepUp', 'stepUp'); bindNum('inflation', 'inflation');
    $('slabTop').addEventListener('input', e => { S.tax.slab = +e.target.value || 0; schedule(); });
    $('startDate').addEventListener('change', e => { if (U.parseDate(e.target.value)) { S.startDate = e.target.value; if (S.endOverride && S.endOverride <= S.startDate) S.endOverride = null; schedule(); } });
    $('endDate').addEventListener('change', e => { if (U.parseDate(e.target.value)) { S.endOverride = e.target.value; S.horizon = 'custom'; S.customYears = U.round(U.yearsBetween(S.startDate, e.target.value), 2); schedule(); } });
    $('customYears').addEventListener('input', e => { S.customYears = +e.target.value || 0; S.endOverride = null; S.horizon = 'custom'; schedule(); });
    $('horizonSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.horizon = b.dataset.h === 'custom' ? 'custom' : +b.dataset.h; S.endOverride = null; schedule(); });
    $('scenSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.scenario = b.dataset.s; allocFull = true; schedule(); });
    $('profile').addEventListener('change', e => { S.profile = e.target.value; schedule(); });
    $('themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const nxt = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nxt;
      try { localStorage.setItem('siird.theme', nxt); } catch (e) { /* ignore */ }
      Object.values(CH).forEach(c => c.destroy()); Object.keys(CH).forEach(k => delete CH[k]); renderAll();
    });
    $('applyModel').addEventListener('click', () => { if (MODEL) { S.rows = modelToRows(MODEL); allocFull = true; schedule(); location.hash = '#allocation'; } });
    $('resetModel').addEventListener('click', () => { if (MODEL) { S.rows = modelToRows(MODEL); allocFull = true; schedule(); } });
    $('fundFilter').addEventListener('input', () => safe(renderShortlist));
    $('catFilter').addEventListener('change', () => safe(renderShortlist));
    $('fundDlgClose').addEventListener('click', () => $('fundDlg').close());
    bindAlloc(); bindStrategies(); bindRedeem(); bindPortfolio(); bindAssumptions();
    renderWeights();
  }

  function renderControls() {
    const setV = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    setV('capital', S.capital); setV('sip', S.sip); setV('stepUp', S.stepUp); setV('startDate', S.startDate); setV('inflation', S.inflation);
    setV('customYears', horizonYears()); setV('endDate', endDate()); setV('slabTop', S.tax.slab); $('profile').value = S.profile;
    document.querySelectorAll('#horizonSeg button').forEach(b => b.classList.toggle('on', String(S.horizon) === b.dataset.h));
    document.querySelectorAll('#scenSeg button').forEach(b => b.classList.toggle('on', S.scenario === b.dataset.s));
    $('customYearsWrap').style.opacity = S.horizon === 'custom' ? 1 : .55;
    $('scenNote').textContent = CFG.settings.scenarios[S.scenario].description;
  }

  // ------------------------------------------------------------------ A. overview
  function kpi(l, v, s = '', cls = '') { return `<div class="kpi ${cls === 'hero' ? 'hero' : ''}"><div class="l">${l}</div><div class="v ${cls !== 'hero' ? cls : ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`; }
  function renderKPIs() {
    const yrs = horizonYears();
    $('ovLede').innerHTML = `Plan: ${money(S.capital)} on ${esc(S.startDate)}${S.sip > 0 ? ` + ${money(S.sip)}/month SIP` : ''}, redeemed on <b>${esc(endDate())}</b> (${yrs} yrs), <b>${CFG.settings.scenarios[S.scenario].label}</b> scenario. All figures after expense ratios, exit loads, charges and capital-gains tax unless labelled gross.`;
    if (!RES) { $('kpis').innerHTML = `<div class="kpi"><div class="l">Projection</div><div class="v mut" style="font-size:14px">${dataLoaded ? 'Add funds in the allocation simulator and fix any input errors.' : 'Loading fund data…'}</div></div>`; }
    else {
      const R = RES, gp = R.grossProfit;
      $('kpis').innerHTML = [
        kpi('Total invested', money(R.invested), S.sip > 0 ? `${money(S.capital)} lump sum + SIPs` : 'one-time lump sum'),
        kpi('Projected value (gross, no costs)', money(R.vGross), `assumed returns, before expenses`),
        kpi('Gross profit', money(gp), R.invested ? pfs(gp / R.invested) + ' on invested' : '', 'pos'),
        kpi('Fund expenses (TER) cost', money(R.losses.fundExpenses), 'growth lost to expense ratios', 'neg'),
        kpi('Exit load + other charges', money(R.losses.exitLoad + R.groupedLosses.transactionCosts + R.losses.other), 'brokerage, exchange, DP, spread', 'neg'),
        kpi('Capital-gains tax (est.)', money(R.tax.tax), `incl. cess${R.tax.surcharge ? ' & surcharge' : ''}; + ${money(R.losses.stt + R.losses.purchaseStampDuty)} STT/stamp duty`, 'neg'),
        kpi('Net amount received', money(R.net), `on ${esc(endDate())}`, 'hero'),
        kpi('Net profit after everything', money(R.netProfit), R.invested ? pfs(R.netProfit / R.invested) + ' overall return' : '', R.netProfit >= 0 ? 'pos' : 'neg'),
        kpi('Annualised return (net XIRR)', isFinite(R.netXirr) ? pfs(R.netXirr, 2) : '—', `gross ${isFinite(R.grossXirr) ? pfs(R.grossXirr, 2) : '—'}`),
        kpi('Lost to charges & taxes', money(R.totalLost), R.vGross ? `${(R.totalLost / R.vGross * 100).toFixed(1)}% of gross value` : '', 'neg'),
        kpi('You retain', isFinite(R.retainedPct) ? (R.retainedPct * 100).toFixed(1) + '%' : '—', 'of the gross projected value'),
        kpi("Net in today's money", money(R.realNet), `at ${S.inflation}% inflation`)
      ].join('');
    }
    const txns = PF.load(store);
    if (!txns.length) { $('kpisActual').innerHTML = `<div class="kpi"><div class="l">No holdings recorded</div><div class="s">Add real transactions in <a href="#portfolio">I · My portfolio</a> to see current value, gains and tax.</div></div>`; return; }
    const P = portfolioResult(txns);
    $('kpisActual').innerHTML = [
      kpi('Invested (units held)', money(P.invested)),
      kpi('Current value', money(P.value), P.missingNav.length ? `${P.missingNav.length} holding(s) without NAV` : 'at latest available NAV'),
      kpi('Unrealised profit / loss', money(P.unrealized), P.invested ? pfs(P.unrealized / P.invested) : '', P.unrealized >= 0 ? 'pos' : 'neg'),
      kpi('Annualised (XIRR)', isFinite(P.xirr) ? pfs(P.xirr, 2) : '—', 'all buys, sells & current value'),
      kpi('Realised gains', money(P.realizedGain), P.realizedTax ? `tax ${money(P.realizedTax.tax)}` : ''),
      kpi('Est. tax if redeemed today', money(P.unrealizedTax ? P.unrealizedTax.tax : 0), 'excl. exit loads', 'neg'),
      kpi('Est. redemption amount', money(P.estRedemption), 'value − estimated tax', 'hero')
    ].join('');
  }

  // ------------------------------------------------------------------ B. research
  function riskOf(f) { return f.riskometer ? esc(f.riskometer) : '<span class="mut">n/a</span>'; }
  function fundLink(f) { return `<button class="linkish" type="button" data-fund="${esc(f.id)}">${esc(f.name)}</button>`; }

  function renderModel() {
    const prof = CFG.settings.profiles[S.profile];
    $('modelTitle').textContent = `${prof.label} profile, ${money(S.capital)}${S.sip ? ` + ${money(S.sip)}/mo` : ''}, ${horizonYears()} yrs`;
    $('modelSummary').textContent = prof.summary;
    if (!MODEL) { $('modelTbl').innerHTML = '<tr><td class="mut">Loading NAV history to score funds…</td></tr>'; return; }
    let h = '<tr><th>Fund (sleeve)</th><th>Category · tax</th><th>Suggested ₹</th><th>%</th><th>Assumed return*</th><th>Risk</th><th>Hold for</th><th class="wrap">Why selected (from data)</th><th class="wrap">Main risks</th></tr>';
    MODEL.rows.forEach(r => {
      const f = r.item.fund, cat = CATS[f.category];
      const e = eff({ fundId: f.id }, S.scenario);
      const bench = f.benchmarkProxy ? (MET[f.benchmarkProxy] || {}).metrics : null;
      h += `<tr><td class="fundname">${fundLink(f)}<div class="note">${esc(r.sleeves.join(' + '))}</div></td><td class="tl">${esc(cat.label)}<div class="note">${esc(CFG.tax.taxClasses[cat.taxClass].label)}</div></td>
        <td><b>${money(r.amount)}</b>${S.sip ? `<div class="note">${money(S.sip * r.pct / 100)}/mo</div>` : ''}</td><td>${r.pct.toFixed(1)}%</td>
        <td>${(e.ret - e.ter).toFixed(2)}%<div class="note">${e.ret}% − TER ${e.ter.toFixed(2)}%</div></td><td class="tl">${riskOf(f)}</td><td>${cat.minHoldYears ? cat.minHoldYears + '+ yrs' : 'any'}</td>
        <td class="wrap reason"><ul class="tight">${FR.selectionRationale(r.item, SCORED, bench).map(x => `<li>${esc(x)}</li>`).join('')}</ul></td><td class="wrap reason">${esc(cat.risks)}</td></tr>`;
    });
    if (!MODEL.rows.length) h += '<tr><td colspan="9" class="mut">No fund met the rules for this amount — try a larger amount or another profile.</td></tr>';
    const exp = U.sum(MODEL.rows, r => { const e = eff({ fundId: r.fundId }); return r.pct / 100 * (e.ret - e.ter); });
    h += `<tr class="tot"><td>Total</td><td></td><td>${money(U.sum(MODEL.rows, r => r.amount))}</td><td>${U.sum(MODEL.rows, r => r.pct).toFixed(1)}%</td><td>${exp.toFixed(2)}%</td><td colspan="4" class="tl note">*${CFG.settings.scenarios[S.scenario].label} scenario assumption after expense ratio — not a forecast.</td></tr>`;
    $('modelTbl').innerHTML = h;
    $('modelNotes').innerHTML = MODEL.notes.length ? `<div class="banner info"><ul class="tight">${MODEL.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '';
    $('rejectTbl').innerHTML = '<tr><th>Fund</th><th>Category</th><th>Score</th><th class="wrap">Reasons</th></tr>' + MODEL.rejected.map(r => {
      const f = fundById(r.fundId), sc = scoreOf(r.fundId);
      return `<tr><td class="fundname">${fundLink(f)}</td><td class="tl">${esc(CATS[f.category].label)}</td><td>${sc ? sc.total.toFixed(0) : '—'}</td><td class="wrap reason"><ul class="tight">${r.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul></td></tr>`;
    }).join('');
    // profile comparison
    let pc = '<div class="scroll"><table><tr><th>Profile</th><th class="wrap">Funds</th><th>Equity %</th><th>Net received</th><th>Net XIRR</th><th>Lost to costs &amp; tax</th><th>Worst 5-yr fall (weighted)</th></tr>';
    Object.keys(CFG.settings.profiles).forEach(pid => {
      const m = buildModel(pid), rows = modelToRows(m); const ev = evalRows(rows);
      pc += `<tr${pid === S.profile ? ' class="sel"' : ''}><td>${esc(CFG.settings.profiles[pid].label)}</td><td class="wrap reason">${m.rows.map(r => `${esc(r.item.fund.name.split('–')[0])} ${r.pct.toFixed(0)}%`).join('<br>')}</td><td>${ev.equityPct.toFixed(0)}%</td><td>${money(ev.res && ev.res.net)}</td><td>${ev.res && isFinite(ev.res.netXirr) ? pfs(ev.res.netXirr, 2) : '—'}</td><td>${money(ev.res && ev.res.totalLost)}</td><td>${pf(ev.wDD)}</td></tr>`;
    });
    $('profileCompare').innerHTML = pc + '</table></div><p class="note">Same horizon and scenario as above. "Worst 5-yr fall" = allocation-weighted maximum drawdown of each fund over the last 5 years (actual NAV data) — a rough guide to how deep an interim loss could feel.</p>';
  }

  function evalRows(rows, opt) {
    let res = null; try { res = rows.length ? project(rows, opt) : null; } catch (e) { res = null; }
    const tot = U.sum(rows, r => +r.pct || 0) || 1;
    let eq = 0, ter = 0, dd = 0, ddW = 0, vol = 0, volW = 0, hist5 = 0, h5W = 0;
    rows.forEach(r => {
      const e = eff(r); if (!e) return; const w = (+r.pct || 0) / tot; const m = metricsFor(e.f) || {};
      if (e.cat.assetClass === 'equity') eq += w; if (e.f.category === 'arbitrage') eq += 0;
      ter += w * e.ter;
      if (m.maxDD5) { dd += w * m.maxDD5.mdd; ddW += w; }
      if (m.stdev3 != null) { vol += w * m.stdev3; volW += w; }
      const c = m.cagr5 ?? null; if (c != null) { hist5 += w * c; h5W += w; }
    });
    return { res, equityPct: eq * 100, wTer: ter, wDD: ddW > 0.999 ? dd : (ddW ? dd / ddW : null), wVol: volW ? vol / volW : null, wHist5: h5W ? hist5 / h5W : null, histCover: h5W };
  }

  function renderShortlist() {
    const q = ($('fundFilter').value || '').toLowerCase(), cf = $('catFilter').value;
    const modelPct = {}; if (MODEL) MODEL.rows.forEach(r => { modelPct[r.fundId] = r; });
    let h = '<tr><th>Fund</th><th>Category</th><th>NAV (date)</th><th>1Y</th><th>3Y CAGR</th><th>5Y CAGR</th><th>10Y CAGR</th><th>Bench. proxy 5Y</th><th>TER</th><th>AUM ₹ cr</th><th>Risk-o-meter</th><th>Std dev 3Y</th><th>Sharpe 3Y</th><th>Sortino 3Y</th><th>Max fall 5Y</th><th>Score</th><th>Model %</th><th>Model ₹</th></tr>';
    const items = [...SCORED].sort((a, b) => (a.fund.category < b.fund.category ? -1 : a.fund.category > b.fund.category ? 1 : b.score.total - a.score.total));
    items.forEach(it => {
      const f = it.fund, m = it.metrics || {}, cat = CATS[f.category];
      if (cf && f.category !== cf) return;
      if (q && !(`${f.name} ${f.amc} ${cat.label}`.toLowerCase().includes(q))) return;
      const ln = latestNav(f.schemeCode);
      const fr = ln ? DS.freshness(ln.date, ln.fetchedAt) : { navStale: true };
      const bm = f.benchmarkProxy ? (MET[f.benchmarkProxy] || {}).metrics : null;
      const terCell = f.ter != null ? f.ter.toFixed(2) + '%' : `<span class="warnc" title="${esc((f.flags || []).join(' '))}">unverified${f.terReported ? ` (${f.terReported}% shown)` : ''}</span>`;
      const mp = modelPct[f.id];
      h += `<tr><td class="fundname">${fundLink(f)}${f.userEntered ? ' <span class="pill warn">user-added</span>' : ''}${(f.flags || []).length ? ' <span class="pill warn" title="' + esc(f.flags.join(' ')) + '">check</span>' : ''}<div class="note">${esc(f.amc)}</div></td>
        <td class="tl">${esc(cat.label)}</td><td>${ln ? `${ln.nav.toFixed(4)}<div class="note ${fr.navStale ? 'warnc' : ''}">${esc(ln.date)}${fr.navStale ? ' · stale' : ''}</div>` : '<span class="mut">unavailable</span>'}</td>
        <td>${pf(m.ret1y)}</td><td>${pf(m.cagr3)}</td><td>${pf(m.cagr5)}</td><td>${pf(m.cagr10)}</td><td>${bm ? pf(bm.cagr5) : '<span class="mut">—</span>'}</td>
        <td>${terCell}</td><td>${f.aumCr != null ? Math.round(f.aumCr).toLocaleString('en-IN') : '<span class="mut">n/a</span>'}</td><td class="tl">${riskOf(f)}</td>
        <td>${pf(m.stdev3)}</td><td>${fx(m.sharpe3)}</td><td>${fx(m.sortino3)}</td><td class="neg">${m.maxDD5 ? pf(m.maxDD5.mdd) : '<span class="mut">n/a</span>'}</td>
        <td><b>${it.score.total.toFixed(0)}</b>${it.score.missing.length ? `<div class="note warnc" title="Missing: ${esc(it.score.missing.join(', '))}">${it.score.missing.length} n/a</div>` : ''}</td>
        <td>${mp ? mp.pct.toFixed(1) + '%' : '—'}</td><td>${mp ? money(mp.amount) : '—'}</td></tr>`;
    });
    $('shortTbl').innerHTML = h;
    $('shortNote').innerHTML = `NAV-derived metrics computed from daily AMFI NAVs (Direct Growth). Sharpe/Sortino use ${esc(rfSource || 'risk-free proxy (loading)')}. Benchmark proxy = an index fund tracking the fund's benchmark (its NAV is after its own small expense ratio; TRI data itself is not freely available). Factsheet snapshot: ${esc(CFG.funds.snapshotDate)}. Click a fund for managers, exit load, correction behaviour and sources.`;
  }

  function renderWeights() {
    const L = CFG.settings.scoring.labels;
    $('weights').innerHTML = Object.keys(S.weights).map(k => `<div class="field"><label for="w_${k}" title="${esc(L[k])}">${esc(L[k].split('(')[0])}</label><input type="number" class="assume" id="w_${k}" data-w="${k}" min="0" max="100" step="5" value="${S.weights[k]}"></div>`).join('');
    $('weightsNote').textContent = CFG.settings.scoring.note;
    $('weights').addEventListener('input', e => { const k = e.target.dataset.w; if (k) { S.weights[k] = Math.max(0, +e.target.value || 0); schedule(); } });
  }

  function openFund(id) {
    const f = fundById(id); if (!f) return;
    const m = metricsFor(f) || {}, cat = CATS[f.category], it = SCORED.find(i => i.fund.id === id);
    const ln = latestNav(f.schemeCode);
    const corr = (m.corrections || []).map(c => `<tr><td class="tl">${esc(c.label)}</td><td>${esc(c.from)} → ${esc(c.to)}</td><td class="${c.ret < 0 ? 'neg' : 'pos'}">${pf(c.ret)}</td><td>${(() => { const bm = f.benchmarkProxy && (MET[f.benchmarkProxy] || {}).metrics; const b = bm && (bm.corrections || []).find(x => x.id === c.id); return b ? pf(b.ret) : '—'; })()}</td></tr>`).join('');
    const comps = it ? Object.entries(it.score.components).map(([k, v]) => `<tr><td class="tl">${esc(CFG.settings.scoring.labels[k])}</td><td>${v.toFixed(0)}</td><td style="width:40%"><div class="bar"><i style="width:${v}%"></i></div></td></tr>`).join('') : '';
    $('fundDlgTitle').textContent = f.name;
    $('fundDlgBody').innerHTML = `
      <div class="grid g2">
        <div><table>
          <tr><td class="tl mut">AMC</td><td>${esc(f.amc)}</td></tr>
          <tr><td class="tl mut">AMFI scheme code</td><td>${f.schemeCode}</td></tr>
          <tr><td class="tl mut">Category</td><td>${esc(cat.label)}</td></tr>
          <tr><td class="tl mut">Tax classification</td><td class="wrap">${esc(CFG.tax.taxClasses[cat.taxClass].label)}</td></tr>
          <tr><td class="tl mut">Latest NAV</td><td>${ln ? `${ln.nav.toFixed(4)} on ${esc(ln.date)}<div class="note">${esc(ln.source)}</div>` : 'unavailable'}</td></tr>
          <tr><td class="tl mut">NAV history</td><td>${m.firstDate ? `${esc(m.firstDate)} → ${esc(m.latestDate)} (${m.historyYears.toFixed(1)} yrs)` : 'unavailable'}</td></tr>
          <tr><td class="tl mut">Expense ratio</td><td class="wrap">${f.ter != null ? f.ter.toFixed(2) + '%' : '<span class="warnc">unverified</span>'}${f.terNote ? `<div class="note">${esc(f.terNote)}</div>` : ''}</td></tr>
          <tr><td class="tl mut">AUM</td><td>${f.aumCr != null ? '₹' + Math.round(f.aumCr).toLocaleString('en-IN') + ' cr' : 'n/a'}</td></tr>
          <tr><td class="tl mut">Fund manager(s)</td><td class="wrap">${f.managers ? esc(f.managers.join(', ')) : 'n/a'}</td></tr>
          <tr><td class="tl mut">Risk-o-meter</td><td>${riskOf(f)}</td></tr>
          <tr><td class="tl mut">Exit load</td><td class="wrap">${f.exitLoad ? esc(f.exitLoad.text) : '<span class="warnc">not verified</span>'}</td></tr>
          <tr><td class="tl mut">Minimum lump sum / SIP</td><td>${f.minLumpsum != null ? money(f.minLumpsum) : 'n/a'} / ${f.minSip != null ? money(f.minSip) : 'n/a'}</td></tr>
          <tr><td class="tl mut">Benchmark</td><td class="wrap">${esc(f.benchmark || 'n/a')}${f.benchmarkProxy ? `<div class="note">Proxy: scheme ${f.benchmarkProxy}</div>` : ''}</td></tr>
          <tr><td class="tl mut">Portfolio diversification</td><td class="wrap note">Holdings-level data is not in the free AMFI feed — see the AMC's monthly portfolio disclosure.</td></tr>
          <tr><td class="tl mut">Factsheet source</td><td class="wrap">${f.source ? (/^https?:/.test(f.source.url) ? `<a href="${esc(f.source.url)}" target="_blank" rel="noopener">${esc(f.source.label)}</a>` : esc(f.source.label)) + (f.source.asOf ? ` · ${esc(f.source.asOf)}` : '') : 'n/a'}</td></tr>
        </table>
        ${(f.flags || []).concat(f.notes || []).concat((m.splitAdjustments || []).map(a => `NAV history adjusted for a unit split/consolidation on ${a.date} (one-day NAV ratio ${a.ratio.toFixed(4)}); earlier NAVs rescaled so returns are continuous.`)).map(x => `<p class="flag">⚠ ${esc(x)}</p>`).join('')}</div>
        <div>
          <h3 style="margin-top:0">Risk &amp; return (from NAV)</h3>
          <table><tr><td class="tl">1-yr return</td><td>${pf(m.ret1y)}</td></tr><tr><td class="tl">3 / 5 / 10-yr CAGR</td><td>${pf(m.cagr3)} / ${pf(m.cagr5)} / ${pf(m.cagr10)}</td></tr>
          <tr><td class="tl">Std deviation (3-yr, annualised)</td><td>${pf(m.stdev3)}</td></tr><tr><td class="tl">Sharpe / Sortino (3-yr)</td><td>${fx(m.sharpe3)} / ${fx(m.sortino3)}</td></tr>
          <tr><td class="tl">Max drawdown 5-yr</td><td>${m.maxDD5 ? `${pf(m.maxDD5.mdd)} <span class="note">${esc(m.maxDD5.peak)} → ${esc(m.maxDD5.trough)}</span>` : 'n/a'}</td></tr>
          <tr><td class="tl">Max drawdown (all history)</td><td>${m.maxDDAll ? `${pf(m.maxDDAll.mdd)} <span class="note">${esc(m.maxDDAll.peak)} → ${esc(m.maxDDAll.trough)}</span>` : 'n/a'}</td></tr>
          <tr><td class="tl">Rolling 3-yr CAGR (median / worst / best)</td><td>${m.rolling3 ? `${pf(m.rolling3.median)} / ${pf(m.rolling3.min)} / ${pf(m.rolling3.max)}` : 'n/a'}</td></tr>
          <tr><td class="tl">Rolling 3-yr windows beating risk-free</td><td>${m.rolling3 ? pf(m.rolling3.pctAboveRf, 0) + ` of ${m.rolling3.count}` : 'n/a'}</td></tr></table>
          <h3>During market corrections</h3><table><tr><th>Window</th><th>Dates</th><th>Fund</th><th>Bench. proxy</th></tr>${corr || '<tr><td colspan="4" class="mut">n/a</td></tr>'}</table>
          <h3>Score breakdown</h3><table>${comps}</table>
        </div>
      </div>
      <div class="chartbox" style="margin-top:12px"><canvas id="fundDlgChart"></canvas></div>`;
    $('fundDlg').showModal();
    const hist = HIST[f.schemeCode];
    if (hist && window.Chart) {
      const pts = sample(hist, 400);
      if (CH.fundDlgChart) { CH.fundDlgChart.destroy(); delete CH.fundDlgChart; }
      CH.fundDlgChart = new Chart($('fundDlgChart'), { type: 'line', data: { labels: pts.map(p => p.d), datasets: [{ label: 'NAV', data: pts.map(p => p.nav), borderColor: col(0), pointRadius: 0, borderWidth: 1.5 }] }, options: baseOpts({ y: v => v.toFixed(0) }) });
    }
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-fund]'); if (b) openFund(b.dataset.fund); });

  // ------------------------------------------------------------------ C. allocation
  let allocFull = true;
  function fundOptions(sel) {
    const groups = {};
    allFunds().forEach(f => { (groups[f.category] = groups[f.category] || []).push(f); });
    return Object.entries(groups).map(([c, fs]) => `<optgroup label="${esc(CATS[c].label)}">${fs.map(f => `<option value="${esc(f.id)}"${f.id === sel ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</optgroup>`).join('');
  }
  function bindAlloc() {
    const t = $('allocTbl');
    t.addEventListener('input', e => {
      const tr = e.target.closest('tr[data-uid]'); if (!tr) return;
      const r = S.rows.find(x => x.uid === +tr.dataset.uid); if (!r) return;
      const k = e.target.dataset.k, v = e.target.value;
      if (k === 'pct') r.pct = v === '' ? 0 : +v;
      else if (k === 'amt') { if (S.capital > 0) r.pct = (+v || 0) / S.capital * 100; }
      else if (k === 'sipamt') { if (S.sip > 0) r.pct = (+v || 0) / S.sip * 100; }
      else if (k === 'ret') { r.ret = r.ret || {}; r.ret[S.scenario] = v === '' ? '' : +v; }
      else if (k === 'ter') r.ter = v === '' ? null : +v;
      else if (k === 'el' || k === 'eld') {
        const e0 = eff(r); const cur = (r.exitLoad || e0.exitLoad || { tiers: [] });
        const pct = k === 'el' ? +v || 0 : (cur.tiers[0] ? cur.tiers[0].pct : 0);
        const days = k === 'eld' ? +v || 0 : (cur.tiers[0] ? cur.tiers[0].days : 0);
        r.exitLoad = { tiers: pct > 0 && days > 0 ? [{ days, pct }] : [], freePct: 0, text: `Your override: ${pct}% within ${days} days` };
      }
      allocFull = false; schedule();
    });
    t.addEventListener('change', e => {
      if (e.target.dataset.k !== 'fund') return;
      const tr = e.target.closest('tr[data-uid]'); const r = S.rows.find(x => x.uid === +tr.dataset.uid);
      r.fundId = e.target.value; r.ret = null; r.ter = null; r.exitLoad = null; allocFull = true; schedule();
    });
    t.addEventListener('click', e => {
      const b = e.target.closest('[data-del]'); if (!b) return;
      S.rows = S.rows.filter(x => x.uid !== +b.dataset.del); allocFull = true; schedule();
    });
    $('addRow').addEventListener('click', () => { S.rows = S.rows || []; const used = new Set(S.rows.map(r => r.fundId)); const f = allFunds().find(x => !used.has(x.id)) || allFunds()[0]; S.rows.push({ uid: uidSeq++, fundId: f.id, pct: 0 }); allocFull = true; schedule(); });
    $('normalise').addEventListener('click', () => { const tot = U.sum(S.rows || [], r => +r.pct || 0); if (tot > 0) S.rows.forEach(r => { r.pct = U.round(r.pct / tot * 100, 4); }); allocFull = true; schedule(); });
    $('addAmfi').addEventListener('click', () => $('amfiSearch').classList.toggle('hidden'));
    let qT = null;
    $('amfiQ').addEventListener('input', e => {
      clearTimeout(qT); const q = e.target.value.trim();
      qT = setTimeout(async () => {
        if (q.length < 3) { $('amfiRes').innerHTML = ''; return; }
        $('amfiRes').innerHTML = '<div class="note" style="padding:8px">Searching…</div>';
        const res = await DS.searchSchemes(q);
        $('amfiRes').innerHTML = res.length ? res.slice(0, 40).map(r => `<button type="button" data-code="${r.schemeCode}" data-name="${esc(r.schemeName)}">${esc(r.schemeName)} <span class="note">· ${r.schemeCode}</span></button>`).join('') : '<div class="note" style="padding:8px">No matches (or search source unavailable).</div>';
      }, 350);
    });
    $('amfiRes').addEventListener('click', async e => {
      const b = e.target.closest('button[data-code]'); if (!b) return;
      const code = +b.dataset.code, cat = $('amfiCat').value, ter = $('amfiTer').value;
      const id = 'custom-' + code;
      if (!fundById(id)) S.customFunds.push({ id, schemeCode: code, name: b.dataset.name, amc: 'User-added (AMFI)', category: cat, ter: ter === '' ? null : +ter, aumCr: null, exitLoad: null, managers: null, riskometer: null, minLumpsum: null, minSip: null, benchmark: null, benchmarkProxy: null, userEntered: true, flags: ['Added by you: category, expense ratio and exit load are user-entered, not sourced.'], source: { label: 'AMFI NAV (user-added)', url: CFG.settings.data.amfiNavUrl, asOf: null } });
      S.rows = S.rows || []; S.rows.push({ uid: uidSeq++, fundId: id, pct: 0 });
      $('amfiSearch').classList.add('hidden'); allocFull = true;
      await ensureHistory(code); schedule();
    });
  }

  function renderAlloc() {
    const rows = S.rows || [];
    const chk = Calc.allocationCheck(rows.map(r => ({ pct: r.pct, amount: S.capital * r.pct / 100 })), S.capital);
    $('allocMsg').innerHTML = !dataLoaded && !rows.length ? '<div class="banner info">Loading fund data to build the model allocation…</div>'
      : chk.ok ? `<div class="banner good">Allocation totals 100% — ${money(S.capital)} lump sum${S.sip ? ` and ${money(S.sip)}/month SIP` : ''} fully allocated.</div>`
        : `<div class="banner bad"><b>${esc(chk.message)}</b> ${chk.totalPct < 100 ? `${money(S.capital * (100 - chk.totalPct) / 100)} is unallocated` : `over-allocated by ${money(S.capital * (chk.totalPct - 100) / 100)}`}; projections below use the amounts as entered. Use “Scale to 100%” to fix.</div>`;
    const scLabel = CFG.settings.scenarios[S.scenario].label;
    if (allocFull || $('allocTbl').rows.length !== rows.length + 2) {
      let h = `<tr><th>Fund</th><th>Tax class</th><th>%</th><th>Lump sum ₹</th><th>SIP ₹/mo</th><th title="Assumed portfolio return before the expense ratio">Return % (${scLabel})</th><th>TER %</th><th>Exit load %</th><th>within days</th><th>Hist. 5Y CAGR</th><th></th></tr>`;
      rows.forEach(r => {
        const e = eff(r); if (!e) return;
        const m = metricsFor(e.f) || {};
        const el = e.exitLoad && e.exitLoad.tiers && e.exitLoad.tiers[0];
        h += `<tr data-uid="${r.uid}"><td><select data-k="fund" aria-label="Fund">${fundOptions(r.fundId)}</select><div class="note">${e.exitLoad ? esc(e.exitLoad.text) : '<span class="warnc">exit load not verified — assumed nil</span>'}</div></td>
          <td class="tl note">${esc(CFG.tax.taxClasses[e.taxClass].label)}</td>
          <td><input type="number" data-k="pct" step="1" min="0" max="100" value="${U.round(r.pct, 2)}" class="assume" aria-label="Allocation percent"></td>
          <td><input type="number" data-k="amt" step="100" min="0" value="${Math.round(S.capital * r.pct / 100)}" class="assume" aria-label="Lump sum amount"${S.capital > 0 ? '' : ' disabled'}></td>
          <td><input type="number" data-k="sipamt" step="100" min="0" value="${Math.round(S.sip * r.pct / 100)}" class="assume" aria-label="SIP amount"${S.sip > 0 ? '' : ' disabled'}></td>
          <td><input type="number" data-k="ret" step="0.5" value="${e.ret}" class="assume" aria-label="Assumed return" title="${e.retOverridden ? 'Your override' : 'Category default — edit to override'}"></td>
          <td><input type="number" data-k="ter" step="0.01" min="0" value="${e.ter}" class="${/factsheet/.test(e.terSrc) ? '' : 'assume'}" aria-label="Expense ratio" title="Source: ${esc(e.terSrc)}"></td>
          <td><input type="number" data-k="el" step="0.25" min="0" value="${el ? el.pct : 0}" aria-label="Exit load percent" class="${r.exitLoad ? 'assume' : ''}"></td>
          <td><input type="number" data-k="eld" step="15" min="0" value="${el ? el.days : 0}" aria-label="Exit load days" class="${r.exitLoad ? 'assume' : ''}"></td>
          <td>${pf(m.cagr5)}</td><td><button class="btn small danger" type="button" data-del="${r.uid}" aria-label="Remove fund">✕</button></td></tr>`;
      });
      h += `<tr class="tot"><td>Total</td><td></td><td id="allocTotPct"></td><td id="allocTotAmt"></td><td id="allocTotSip"></td><td colspan="6"></td></tr>`;
      $('allocTbl').innerHTML = h; allocFull = false;
    } else {
      // update derived inputs in place without stealing focus
      [...$('allocTbl').querySelectorAll('tr[data-uid]')].forEach(tr => {
        const r = rows.find(x => x.uid === +tr.dataset.uid); if (!r) return;
        const set = (k, v) => { const el = tr.querySelector(`[data-k="${k}"]`); if (el && document.activeElement !== el) el.value = v; };
        set('pct', U.round(r.pct, 2)); set('amt', Math.round(S.capital * r.pct / 100)); set('sipamt', Math.round(S.sip * r.pct / 100));
      });
    }
    const tp = $('allocTotPct'); if (tp) { tp.innerHTML = `<span class="${chk.ok ? 'pos' : 'neg'}">${chk.totalPct.toFixed(2)}%</span>`; $('allocTotAmt').textContent = money(S.capital * chk.totalPct / 100); $('allocTotSip').textContent = money(S.sip * chk.totalPct / 100); }
    // chart
    const lab = rows.map(r => (fundById(r.fundId) || {}).name || r.fundId), dat = rows.map(r => U.round(+r.pct || 0, 2));
    chart('allocChart', { type: 'doughnut', data: { labels: lab, datasets: [{ data: dat, backgroundColor: rows.map((_, i) => col(i)), borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { position: 'bottom', labels: { color: cssv('--mut'), boxWidth: 10, font: { size: 11 } } }, tooltip: { callbacks: { label: c => `${c.label}: ${c.parsed}% (${money(S.capital * c.parsed / 100)})` } } } } });
    const ev = evalRows(rows);
    $('allocSummary').innerHTML = rows.length ? `Equity ${ev.equityPct.toFixed(0)}% · weighted expense ratio ${ev.wTer.toFixed(2)}% · weighted 3-yr volatility ${pf(ev.wVol)} · weighted worst 5-yr fall ${pf(ev.wDD)} · ${rows.length} fund${rows.length > 1 ? 's' : ''}` : '';
  }

  // ------------------------------------------------------------------ strategies
  function bindStrategies() {
    $('saveStrat').addEventListener('click', () => {
      if (!S.rows || !S.rows.length) return;
      const name = ($('stratName').value || '').trim() || `Strategy ${S.strategies.length + 1}`;
      S.strategies.push({ id: Date.now(), name, savedAt: new Date().toISOString(), capital: S.capital, sip: S.sip, rows: S.rows.map(r => ({ fundId: r.fundId, pct: r.pct, ret: r.ret, ter: r.ter, exitLoad: r.exitLoad })) });
      $('stratName').value = ''; schedule();
    });
    $('stratTbl').addEventListener('click', e => {
      const ld = e.target.closest('[data-load]'), dl = e.target.closest('[data-sdel]');
      if (ld) { const s = S.strategies.find(x => x.id === +ld.dataset.load); if (s) { S.rows = s.rows.map(r => Object.assign({ uid: uidSeq++ }, deep(r))); allocFull = true; schedule(); } }
      if (dl) { S.strategies = S.strategies.filter(x => x.id !== +dl.dataset.sdel); schedule(); }
    });
  }
  function renderStrategies() {
    if (!S.strategies.length) { $('stratTbl').innerHTML = '<tr><td class="mut">No saved strategies yet.</td></tr>'; return; }
    $('stratTbl').innerHTML = '<tr><th>Name</th><th class="wrap">Funds</th><th>Saved</th><th></th></tr>' + S.strategies.map(s => `<tr><td>${esc(s.name)}</td><td class="wrap reason">${s.rows.map(r => `${esc(((fundById(r.fundId) || {}).name || r.fundId).split('–')[0])} ${(+r.pct).toFixed(0)}%`).join(', ')}</td><td>${esc(s.savedAt.slice(0, 10))}</td><td><button class="btn small" data-load="${s.id}" type="button">Load</button> <button class="btn small danger" data-sdel="${s.id}" type="button">Delete</button></td></tr>`).join('');
  }

  // ------------------------------------------------------------------ D. projection
  function renderProjection() {
    const rows = S.rows || [];
    const ev = evalRows(rows);
    const wRet = U.sum(rows, r => { const e = eff(r); return e ? (+r.pct || 0) / 100 * e.ret : 0; });
    const wTer = U.sum(rows, r => { const e = eff(r); return e ? (+r.pct || 0) / 100 * e.ter : 0; });
    $('projLede').innerHTML = `Weighted assumed return (${CFG.settings.scenarios[S.scenario].label}): <b>${wRet.toFixed(2)}%</b> before expenses, <b>${(wRet - wTer).toFixed(2)}%</b> after. Weighted historical 5-yr NAV CAGR of these funds: <b>${ev.wHist5 != null ? pf(ev.wHist5, 2) : 'n/a'}</b>${ev.histCover && ev.histCover < 0.999 ? ` (covers ${(ev.histCover * 100).toFixed(0)}% of allocation)` : ''} — shown for context only; the projection never uses past CAGR as a future return.`;
    if (!RES) { $('scenTbl').innerHTML = '<tr><td class="mut">No projection — check inputs and allocation.</td></tr>'; return; }
    // yearly series
    const yrs = horizonYears(), N = Math.max(1, Math.ceil(yrs));
    const series = [];
    for (let y = 1; y <= N; y++) {
      const end = y === N ? endDate() : U.iso(U.addMonths(S.startDate, y * 12));
      try { series.push({ y: y === N ? yrs : y, r: project(rows, { end }) }); } catch (e) { /* skip */ }
    }
    chart('growthChart', { type: 'line', data: { labels: series.map(s => 'Yr ' + U.round(s.y, 2)), datasets: [
      { label: 'Invested', data: series.map(s => Math.round(s.r.invested)), borderColor: cssv('--c8'), backgroundColor: 'rgba(100,116,139,.15)', fill: true, tension: .2, pointRadius: 2 },
      { label: 'Gross value (no costs)', data: series.map(s => Math.round(s.r.vGross)), borderColor: col(0), tension: .2, pointRadius: 2 },
      { label: 'Net in hand (after all costs & tax)', data: series.map(s => Math.round(s.r.net)), borderColor: col(1), borderDash: [5, 4], tension: .2, pointRadius: 2 }] }, options: baseOpts() });
    // scenario × horizon table
    const hs = [...new Set([5, 7, 10, U.round(yrs, 2)])].sort((a, b) => a - b);
    const grid = {};
    let h = '<tr><th>Scenario</th><th>Horizon</th><th>Redeem on</th><th>Invested</th><th>Assumed return (pre-exp.)</th><th>Gross value</th><th>Net in hand</th><th>Net profit</th><th>Net XIRR</th><th>Lost to costs &amp; tax</th><th>Real value</th><th>Net ÷ invested</th></tr>';
    ['c', 'm', 'o'].forEach(sc => {
      const wr = U.sum(rows, r => { const e = eff(r, sc); return e ? (+r.pct || 0) / 100 * e.ret : 0; });
      hs.forEach(hy => {
        const end = (hy === U.round(yrs, 2)) ? endDate() : U.iso(U.addMonths(S.startDate, Math.round(hy * 12)));
        const r = project(rows, { scen: sc, end }); grid[sc + hy] = r;
        h += `<tr class="${sc === S.scenario && hy === U.round(yrs, 2) ? 'sel' : ''}"><td class="tl">${CFG.settings.scenarios[sc].label}</td><td>${hy} yrs</td><td>${esc(end)}</td><td>${money(r.invested)}</td><td>${wr.toFixed(2)}%</td><td>${money(r.vGross)}</td><td><b>${money(r.net)}</b></td><td class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${money(r.netProfit)}</td><td>${isFinite(r.netXirr) ? pfs(r.netXirr, 2) : '—'}</td><td class="neg">${money(r.totalLost)}</td><td>${money(r.realNet)}</td><td>${r.invested ? (r.net / r.invested).toFixed(2) + '×' : '—'}</td></tr>`;
      });
    });
    $('scenTbl').innerHTML = h;
    chart('scenChart', { type: 'bar', data: { labels: hs.map(x => x + ' yrs'), datasets: ['c', 'm', 'o'].map((sc, i) => ({ label: CFG.settings.scenarios[sc].label, data: hs.map(hy => Math.round(grid[sc + hy].net)), backgroundColor: [cssv('--c8'), col(0), col(1)][i] })) }, options: baseOpts() });
  }

  // ------------------------------------------------------------------ E. taxes & charges
  function renderTaxes() {
    if (!RES) { ['scenA', 'scenB'].forEach(id => { $(id).innerHTML = '<p class="mut">No projection.</p>'; }); ['lossTbl', 'taxTbl', 'fundResTbl', 'lotTbl'].forEach(id => { $(id).innerHTML = ''; }); return; }
    const R = RES, L = R.losses, G = R.groupedLosses;
    $('taxLede').innerHTML = `Redemption of the whole portfolio on <b>${esc(endDate())}</b> (${esc(U.fyLabel(U.fyStart(endDate())))}) under rule set <b>${esc(TaxEngine.ruleSetFor(CFG.tax, endDate()).rs.label)}</b>. Slab rate ${S.tax.slab}%, surcharge bracket “${esc((CFG.tax.surchargeBrackets.find(b => b.id === S.tax.surchargeId) || {}).label)}”, cess ${S.tax.cess}%.`;
    $('scenA').innerHTML = `<h3>Scenario A · without charges or tax</h3><dl>
      <dt>Initial investment</dt><dd>${money(S.capital)}</dd>${S.sip ? `<dt>+ SIP instalments</dt><dd>${money(R.invested - S.capital)}</dd>` : ''}
      <dt>Total invested</dt><dd>${money(R.invested)}</dd><dt>Gross projected value</dt><dd class="big">${money(R.vGross)}</dd>
      <dt>Gross investment profit</dt><dd class="pos">${money(R.grossProfit)}</dd><dt>Gross XIRR</dt><dd>${isFinite(R.grossXirr) ? pfs(R.grossXirr, 2) : '—'}</dd></dl>`;
    $('scenB').innerHTML = `<h3>Scenario B · after charges and taxes</h3><dl>
      <dt>Total invested</dt><dd>${money(R.invested)}</dd><dt>Gross projected value</dt><dd>${money(R.vGross)}</dd>
      <dt>− Fund expenses (TER)</dt><dd class="neg">${money(L.fundExpenses)}</dd><dt>− Exit load</dt><dd class="neg">${money(L.exitLoad)}</dd>
      <dt>− Transaction &amp; other charges</dt><dd class="neg">${money(G.transactionCosts + L.other)}</dd><dt>− Stamp duty &amp; STT</dt><dd class="neg">${money(L.purchaseStampDuty + L.stt)}</dd>
      <dt>− Capital-gains tax</dt><dd class="neg">${money(L.capitalGainsTax)}</dd><dt>= Final redemption value</dt><dd class="big">${money(R.net)}</dd>
      <dt>Net profit</dt><dd class="${R.netProfit >= 0 ? 'pos' : 'neg'}">${money(R.netProfit)}</dd><dt>Net XIRR</dt><dd>${isFinite(R.netXirr) ? pfs(R.netXirr, 2) : '—'}</dd></dl>`;
    const gp = R.grossProfit;
    const line = (n, v, what, src) => `<tr><td class="tl">${n}</td><td class="neg">${money(v)}</td><td>${R.vGross ? (v / R.vGross * 100).toFixed(2) + '%' : '—'}</td><td>${gp > 0 ? (v / gp * 100).toFixed(1) + '%' : '—'}</td><td class="wrap reason">${what}</td><td class="wrap note">${src}</td></tr>`;
    $('lossTbl').innerHTML = '<tr><th>Item</th><th>Amount</th><th>% of gross value</th><th>% of gross profit</th><th class="wrap">What it is</th><th class="wrap">Basis</th></tr>'
      + line('1. Fund expenses (expense ratio)', G.fundExpenses, 'Growth lost because the TER is deducted from NAV daily. Already inside NAV — shown separately, not deducted twice.', 'Factsheet TER (or your override)')
      + line('2. Transaction costs', G.transactionCosts, 'ETF brokerage, exchange charges, SEBI fee, GST, DP charge, bid-ask spread (purchase-side costs include the growth they forgo).', 'config/settings.json → charges')
      + line('3. Exit loads', G.exitLoads, 'Charged on lots redeemed inside the fund’s exit-load window.', 'Factsheet exit load (or your override)')
      + line('4a. Capital-gains tax (incl. surcharge &amp; cess)', L.capitalGainsTax, `Base ${money(R.tax.baseTax)} + surcharge ${money(R.tax.surcharge)} + cess ${money(R.tax.cess)}.`, 'config/tax-rules.json')
      + line('4b. Securities Transaction Tax', L.stt, '0.001% on equity-fund redemptions; 0.1% on equity-ETF sales; nil for debt/gold.', 'config/tax-rules.json → statutoryLevies')
      + line('4c. Stamp duty on purchase', L.purchaseStampDuty, '0.005% on MF purchases (0.015% for exchange purchases), incl. the growth forgone.', 'config/tax-rules.json → statutoryLevies')
      + line('5. Other charges', G.other, 'Demat AMC if you hold ETFs (set in Charges).', 'Your assumption')
      + `<tr class="tot"><td>Total lost (gross − net)</td><td class="neg">${money(R.totalLost)}</td><td>${R.vGross ? (R.totalLost / R.vGross * 100).toFixed(2) + '%' : '—'}</td><td>${gp > 0 ? (R.totalLost / gp * 100).toFixed(1) + '%' : '—'}</td><td class="wrap reason">You keep ${money(R.net)} = ${isFinite(R.retainedPct) ? (R.retainedPct * 100).toFixed(1) : '—'}% of the gross value.</td><td></td></tr>`;
    $('lossNote').textContent = `Check: gross ${money(R.vGross)} − total lost ${money(R.totalLost)} = net ${money(R.vGross - R.totalLost)} (net shown: ${money(R.net)}).`;
    chart('lossChart', { type: 'bar', data: { labels: ['Fund expenses', 'Transaction', 'Exit load', 'CG tax', 'STT + stamp', 'Other'], datasets: [{ data: [G.fundExpenses, G.transactionCosts, G.exitLoads, L.capitalGainsTax, L.stt + L.purchaseStampDuty, G.other].map(v => U.round(v, 2)), backgroundColor: [col(3), col(4), col(5), cssv('--bad'), col(2), cssv('--c8')] }] }, options: Object.assign(baseOpts(), { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => money(c.parsed.x) } } }, scales: { x: { ticks: { color: cssv('--mut'), callback: v => '₹' + v.toLocaleString('en-IN') }, grid: { color: cssv('--line') } }, y: { ticks: { color: cssv('--mut') }, grid: { display: false } } } }) });
    $('taxTbl').innerHTML = taxTable(R.tax);
    $('taxNotes').innerHTML = taxNotesHTML(R.tax);
    // per fund
    let fh = '<tr><th>Fund</th><th>Invested</th><th>Gross value</th><th>TER impact</th><th>Purchase costs</th><th>Exit load</th><th>Sell charges + STT</th><th>LT gain</th><th>ST gain</th><th>Tax (allocated)</th><th>Net received</th><th>Net XIRR</th></tr>';
    R.perHolding.forEach((p, i) => {
      const flows = p.lots.map(l => ({ date: l.date, amount: -l.amount })).concat([{ date: R.endDate, amount: p.net }]);
      const x = U.xirr(flows);
      fh += `<tr><td class="fundname"><span class="dot" style="background:${col(i)}"></span>${esc(p.holding.name)}</td><td>${money(p.invested)}</td><td>${money(p.vGross)}</td><td class="neg">${money(p.vGross - p.vTer)}</td><td class="neg">${money(p.stampEffect + p.txnEffect)}</td><td class="neg">${money(p.exit)}</td><td class="neg">${money(p.sellCharges + p.stt)}</td><td>${money(p.ltGain)}</td><td>${money(p.stGain)}</td><td class="neg">${money(p.tax)}</td><td><b>${money(p.net)}</b></td><td>${isFinite(x) ? pfs(x, 2) : '—'}</td></tr>`;
    });
    fh += `<tr class="tot"><td>Total</td><td>${money(R.invested)}</td><td>${money(R.vGross)}</td><td>${money(L.fundExpenses)}</td><td>${money(L.purchaseStampDuty + L.purchaseTransaction)}</td><td>${money(L.exitLoad)}</td><td>${money(L.sellTransaction + L.stt)}</td><td>${money(U.sum(R.perHolding, p => p.ltGain))}</td><td>${money(U.sum(R.perHolding, p => p.stGain))}</td><td>${money(R.tax.tax)}</td><td>${money(R.net + L.other)}</td><td></td></tr>`;
    if (L.other) fh += `<tr><td colspan="12" class="tl note">Total net above is before ${money(L.other)} of other charges; portfolio net after them is ${money(R.net)}. Per-fund tax is the portfolio tax shared in proportion to each fund's gains within its tax bucket (exemption and loss set-off work across funds).</td></tr>`;
    $('fundResTbl').innerHTML = fh;
    let lh = '<tr><th>Fund</th><th>Lot</th><th>Purchase date</th><th>Amount</th><th>Days held</th><th>Term</th><th>Value at NAV</th><th>Exit load</th><th>Taxable gain</th><th>Rate</th><th>Section</th><th>Tax</th></tr>';
    let n = 0;
    R.perHolding.forEach(p => p.lots.forEach(l => { if (n++ > 800) return; lh += `<tr><td class="tl">${esc(p.holding.name.split('–')[0])}</td><td class="tl">${esc(l.kind || '')}</td><td>${esc(l.date)}</td><td>${money(l.amount)}</td><td>${l.days}</td><td><span class="pill ${l.term === 'LT' ? 'good' : 'warn'}">${l.term === 'LT' ? 'Long' : 'Short'}</span></td><td>${money(l.vNav)}</td><td>${money(l.exit)}</td><td>${money(l.gain)}</td><td>${l.taxRate}%</td><td class="tl note">${esc(l.section)}</td><td>${money(l.tax)}</td></tr>`; }));
    $('lotTbl').innerHTML = lh;
  }
  function taxTable(T) {
    let h = '<tr><th>FY</th><th>Term</th><th class="wrap">Treatment (section)</th><th>Rule set</th><th>Gains / losses</th><th>Set-off used</th><th>Exemption</th><th>Taxable</th><th>Rate</th><th>Base tax</th><th>Surcharge</th><th>Cess</th><th>Tax</th></tr>';
    T.years.forEach(y => y.buckets.forEach(b => {
      h += `<tr><td>${esc(y.fyLabel)}</td><td>${b.term === 'LT' ? 'Long' : 'Short'}</td><td class="wrap tl">${esc(b.section)}${b.isSlab ? ' — your slab' : ''}</td><td class="tl note">${esc(b.ruleSetId)}</td><td class="${b.gross < 0 ? 'neg' : ''}">${money(b.gross)}</td><td>${money(b.setOffUsed)}</td><td>${money(b.exemption)}</td><td>${money(b.taxable)}</td><td>${b.rate}%</td><td>${money(b.baseTax)}</td><td>${money(b.surcharge)}${b.surchargePct ? ` <span class="note">(${b.surchargePct}%)</span>` : ''}</td><td>${money(b.cess)}</td><td><b>${money(b.tax)}</b></td></tr>`;
    }));
    h += `<tr class="tot"><td colspan="6">Total</td><td>${money(T.exemptionUsed)}</td><td></td><td></td><td>${money(T.baseTax)}</td><td>${money(T.surcharge)}</td><td>${money(T.cess)}</td><td>${money(T.tax)}</td></tr>`;
    return h;
  }
  function taxNotesHTML(T) {
    const steps = T.years.flatMap(y => y.steps.map(s => `${y.fyLabel}: ${s}`));
    const items = steps.concat(T.notes).concat([CFG.tax.disclaimer]);
    return `<ul class="tight note">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------------ F. redemption calculator
  function bindRedeem() {
    const map = { rdAmt: 'amt', rdSip: 'sip', rdStart: 'start', rdEnd: 'end', rdRet: 'ret' };
    Object.entries(map).forEach(([id, k]) => $(id).addEventListener(id.includes('Start') || id.includes('End') ? 'change' : 'input', e => { S.rd[k] = e.target.value; saveState(); safe(renderRedeem); }));
    $('rdFund').addEventListener('change', async e => { S.rd.fundId = e.target.value; S.rd.ret = ''; saveState(); const f = fundById(S.rd.fundId); if (f) await ensureHistory(f.schemeCode); safe(renderRedeem); });
  }
  function renderRedeem() {
    const sel = $('rdFund'); if (document.activeElement !== sel) sel.innerHTML = fundOptions(S.rd.fundId);
    const setV = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
    setV('rdAmt', S.rd.amt); setV('rdSip', S.rd.sip); setV('rdStart', S.rd.start); setV('rdEnd', S.rd.end);
    const f = fundById(S.rd.fundId); if (!f) return;
    const cat = CATS[f.category], e = eff({ fundId: f.id });
    if (document.activeElement !== $('rdRet')) $('rdRet').value = S.rd.ret !== '' && S.rd.ret != null ? S.rd.ret : e.ret;
    const ret = S.rd.ret !== '' && S.rd.ret != null ? +S.rd.ret : e.ret;
    const amt = +S.rd.amt || 0, sip = +S.rd.sip || 0;
    const errs = Calc.validateInputs({ capital: amt, sip, startDate: S.rd.start, endDate: S.rd.end, inflationPct: 0 });
    if (errs.length) { $('rdOut').innerHTML = `<div class="banner bad">${errs.map(esc).join('<br>')}</div>`; return; }
    const hist = HIST[f.schemeCode];
    const actual = hist && hist.length && S.rd.end <= hist[hist.length - 1].d && S.rd.start >= hist[0].d;
    let navFactor = null, navEnd = null;
    if (actual) { navEnd = FR.navOnOrBefore(hist, S.rd.end); navFactor = d => { const a = FR.navOnOrBefore(hist, d); return a ? navEnd.nav / a.nav : NaN; }; }
    const r = Calc.projectPortfolio({ holdings: [{ id: f.id, name: f.name, taxClass: cat.taxClass, listed: !!f.listed, exitLoad: e.exitLoad, amount: amt, sipAmount: sip, grossReturnPct: ret, terPct: e.ter, navFactor }], startDate: S.rd.start, endDate: S.rd.end, rules: rulesEff(), settings: settingsEff(), taxProfile: taxProfile(), inflationPct: 0 });
    const L = r.losses, p = r.perHolding[0];
    const mode = actual ? `<span class="pill good">Actual NAV</span> ${esc(FR.navOnOrBefore(hist, S.rd.start).d)} → ${esc(navEnd.d)} (NAV ${FR.navOnOrBefore(hist, S.rd.start).nav.toFixed(4)} → ${navEnd.nav.toFixed(4)}). Expense impact is an estimate (TER is already inside NAV).`
      : `<span class="pill warn">Assumed return</span> ${ret}% a year before TER ${e.ter.toFixed(2)}% ${hist ? '' : '(NAV history unavailable)'}${hist && S.rd.end > hist[hist.length - 1].d ? '— redemption date is after the latest NAV' : ''}.`;
    const ltLots = p.lots.filter(l => l.term === 'LT').length;
    $('rdOut').innerHTML = `<p class="note">${mode}</p>
      <div class="grid g2"><div class="scen"><dl>
        <dt>Total invested</dt><dd>${money(r.invested)}</dd><dt>Value before expense ratio (gross)</dt><dd>${money(r.vGross)}</dd>
        <dt>− Fund expenses</dt><dd class="neg">${money(L.fundExpenses)}</dd><dt>Value at NAV</dt><dd>${money(r.vNav)}</dd>
        <dt>− Exit load</dt><dd class="neg">${money(L.exitLoad)}</dd><dt>− Stamp duty, STT &amp; charges</dt><dd class="neg">${money(L.purchaseStampDuty + L.purchaseTransaction + L.sellTransaction + L.stt)}</dd>
        <dt>Capital gain (${ltLots} long-term / ${p.lots.length - ltLots} short-term lots)</dt><dd>${money(r.tax.totalGain)}</dd>
        <dt>− Capital-gains tax</dt><dd class="neg">${money(r.tax.tax)}</dd><dt>= Amount received</dt><dd class="big">${money(r.net)}</dd>
        <dt>Net profit</dt><dd class="${r.netProfit >= 0 ? 'pos' : 'neg'}">${money(r.netProfit)}</dd><dt>Net XIRR</dt><dd>${isFinite(r.netXirr) ? pfs(r.netXirr, 2) : '—'}</dd>
        <dt>Lost to costs &amp; tax</dt><dd class="neg">${money(r.totalLost)}</dd></dl></div>
        <div><div class="scroll"><table>${taxTable(r.tax)}</table></div>${taxNotesHTML(r.tax)}</div></div>`;
  }

  // ------------------------------------------------------------------ G. compare
  function renderCompare() {
    if (!dataLoaded) { $('cmpTbl').innerHTML = '<tr><td class="mut">Loading…</td></tr>'; return; }
    const list = [{ name: 'Current allocation', rows: S.rows || [] }]
      .concat(Object.keys(CFG.settings.profiles).map(pid => ({ name: 'Model: ' + CFG.settings.profiles[pid].label, rows: modelToRows(buildModel(pid)) })))
      .concat(S.strategies.map(s => ({ name: 'Saved: ' + s.name, rows: s.rows })));
    let h = '<tr><th>Portfolio</th><th>Funds</th><th>Equity %</th><th>Wtd TER</th><th>Wtd 3Y volatility</th><th>Wtd worst 5Y fall</th><th>Invested</th><th>Gross value</th><th>Net received</th><th>Lost to costs &amp; tax</th><th>Net XIRR</th><th>Real value</th></tr>';
    const out = list.map(s => Object.assign(s, evalRows(s.rows)));
    out.forEach(s => {
      const r = s.res;
      h += `<tr><td class="tl">${esc(s.name)}</td><td>${s.rows.length}</td><td>${s.equityPct.toFixed(0)}%</td><td>${s.wTer.toFixed(2)}%</td><td>${pf(s.wVol)}</td><td class="neg">${pf(s.wDD)}</td><td>${money(r && r.invested)}</td><td>${money(r && r.vGross)}</td><td><b>${money(r && r.net)}</b></td><td class="neg">${money(r && r.totalLost)}</td><td>${r && isFinite(r.netXirr) ? pfs(r.netXirr, 2) : '—'}</td><td>${money(r && r.realNet)}</td></tr>`;
    });
    $('cmpTbl').innerHTML = h;
    chart('cmpChart', { type: 'bar', data: { labels: out.map(s => s.name), datasets: [{ label: 'Gross value', data: out.map(s => s.res ? Math.round(s.res.vGross) : 0), backgroundColor: col(0) }, { label: 'Net received', data: out.map(s => s.res ? Math.round(s.res.net) : 0), backgroundColor: col(1) }] }, options: baseOpts() });
  }

  function renderFundCompare() {
    const box = $('fcSel');
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.addEventListener('change', async e => { const i = +e.target.dataset.i; S.fc[i] = e.target.value; saveState(); const f = fundById(e.target.value); if (f) await ensureHistory(f.schemeCode); safe(renderFundCompare); });
    }
    if (!box.contains(document.activeElement)) box.innerHTML = [0, 1, 2, 3].map(i => `<div class="field" style="flex:1 1 220px"><label>Fund ${i + 1}</label><select data-i="${i}"><option value="">—</option>${fundOptions(S.fc[i])}</select></div>`).join('');
    const fs = S.fc.map(id => fundById(id)).filter(Boolean);
    const rowsDef = [
      ['Category', f => esc(CATS[f.category].label)], ['Expense ratio', f => f.ter != null ? f.ter.toFixed(2) + '%' : '<span class="warnc">unverified</span>'],
      ['AUM ₹ cr', f => f.aumCr != null ? Math.round(f.aumCr).toLocaleString('en-IN') : 'n/a'], ['Risk-o-meter', f => riskOf(f)],
      ['Exit load', f => f.exitLoad ? esc(f.exitLoad.text) : 'n/a'], ['Fund manager(s)', f => f.managers ? esc(f.managers.slice(0, 3).join(', ')) + (f.managers.length > 3 ? '…' : '') : 'n/a'],
      ['1-yr return', f => pf((metricsFor(f) || {}).ret1y)], ['3-yr CAGR', f => pf((metricsFor(f) || {}).cagr3)], ['5-yr CAGR', f => pf((metricsFor(f) || {}).cagr5)], ['10-yr CAGR', f => pf((metricsFor(f) || {}).cagr10)],
      ['Std dev (3-yr)', f => pf((metricsFor(f) || {}).stdev3)], ['Sharpe (3-yr)', f => fx((metricsFor(f) || {}).sharpe3)], ['Sortino (3-yr)', f => fx((metricsFor(f) || {}).sortino3)],
      ['Max fall (5-yr)', f => { const m = metricsFor(f) || {}; return m.maxDD5 ? pf(m.maxDD5.mdd) : 'n/a'; }],
      ['Rolling 3-yr median', f => { const m = metricsFor(f) || {}; return m.rolling3 ? pf(m.rolling3.median) : 'n/a'; }],
      ...CFG.settings.correctionWindows.map(w => [w.label, f => { const m = metricsFor(f) || {}; const c = (m.corrections || []).find(x => x.id === w.id); return c ? pf(c.ret) : 'n/a'; }]),
      ['Tax treatment', f => esc(CFG.tax.taxClasses[CATS[f.category].taxClass].label)], ['Score', f => { const s = scoreOf(f.id); return s ? s.total.toFixed(0) : '—'; }]
    ];
    $('fcTbl').innerHTML = `<tr><th>Metric</th>${fs.map((f, i) => `<th class="wrap"><span class="dot" style="background:${col(i)}"></span>${esc(f.name)}</th>`).join('')}</tr>` + rowsDef.map(([l, fn]) => `<tr><td class="tl">${l}</td>${fs.map(f => `<td class="wrap">${fn(f)}</td>`).join('')}</tr>`).join('');
    const hs = fs.map(f => HIST[f.schemeCode]).filter(Boolean);
    if (hs.length && window.Chart) {
      const startD = hs.map(h => h[0].d).sort().pop();
      const ds = fs.map((f, i) => {
        const h = HIST[f.schemeCode]; if (!h) return null;
        const base = FR.navOnOrBefore(h, startD) || h[0];
        const pts = sample(h.filter(p => p.d >= startD), 300);
        return { label: f.name.split('–')[0], data: pts.map(p => ({ x: p.d, y: Math.round(10000 * p.nav / base.nav) })), borderColor: col(i), pointRadius: 0, borderWidth: 1.5 };
      }).filter(Boolean);
      const labels = sample(hs[0].filter(p => p.d >= startD), 300).map(p => p.d);
      const aligned = ds.map(d => { const m = new Map(d.data.map(p => [p.x, p.y])); const h = HIST[fs.find(f => f.name.split('–')[0] === d.label).schemeCode]; const b = FR.navOnOrBefore(h, startD) || h[0]; return Object.assign(d, { data: labels.map(x => { const p = FR.navOnOrBefore(h, x); return p ? Math.round(10000 * p.nav / b.nav) : null; }) }); });
      chart('fcChart', { type: 'line', data: { labels, datasets: aligned }, options: baseOpts() });
    }
  }

  // ------------------------------------------------------------------ H. updates
  function renderUpdates() {
    const today = U.todayISO();
    const snapAge = U.daysBetween(CFG.funds.snapshotDate, today);
    const reviewOver = today > CFG.tax.reviewBy;
    const codes = allFunds().map(f => f.schemeCode);
    const staleList = allFunds().filter(f => { const l = latestNav(f.schemeCode); return !l || DS.freshness(l.date, l.fetchedAt).navStale; });
    const anyOfficial = Object.values(OFFICIAL)[0];
    $('freshBox').innerHTML = `<ul class="tight">
      <li>NAV source: <b>${DS.isBackend() ? 'local backend → AMFI NAVAll.txt (official) + mfapi.in history' : 'mfapi.in (AMFI data mirror) directly from the browser'}</b>${anyOfficial ? ` · AMFI file fetched ${esc(new Date(anyOfficial.fetchedAt).toLocaleString('en-IN'))}${anyOfficial.stale ? ' <span class="pill warn">stale copy</span>' : ''}` : ''}.</li>
      <li>${dataLoaded ? `${codes.filter(c => MET[c] && MET[c].live).length} of ${codes.length} funds loaded live this session.` : 'Loading…'}</li>
      <li class="${staleList.length ? 'warnc' : ''}">${staleList.length ? `${staleList.length} fund(s) with NAV older than ${CFG.settings.data.navStaleAfterDays} days or unavailable: ${esc(staleList.map(f => f.name.split('–')[0]).join(', '))}` : 'All NAVs are current (within ' + CFG.settings.data.navStaleAfterDays + ' days).'}</li>
      <li class="${snapAge > CFG.funds.maxAgeDays ? 'warnc' : ''}">Factsheet snapshot (TER, AUM, managers, exit loads): ${esc(CFG.funds.snapshotDate)} — ${snapAge} days old${snapAge > CFG.funds.maxAgeDays ? ' — <b>refresh config/funds.json from the latest AMC factsheets</b>' : ''}.</li>
      <li class="${reviewOver ? 'warnc' : ''}">Tax rules v${esc(CFG.tax.version)}, last verified ${esc(CFG.tax.lastVerified)}; next review due ${esc(CFG.tax.reviewBy)}${reviewOver ? ' — <b>overdue: re-verify after the latest Budget/Finance Act</b>' : ''}. ${esc(CFG.tax.reviewNote)}</li>
      <li class="note">Tax-law changes cannot be detected automatically and reliably from free sources; rule sets are updated by editing the dated config file, and older rule sets are preserved for historical calculations.</li></ul>`;
    // changes since last review
    const snapNow = {};
    CFG.funds.funds.forEach(f => { snapNow[f.id] = { ter: f.ter, aumCr: f.aumCr, managers: (f.managers || []).slice().sort().join(', '), riskometer: f.riskometer, exitLoad: f.exitLoad ? f.exitLoad.text : null, benchmark: f.benchmark }; });
    let ch = '';
    if (!S.seenSnapshot) { S.seenSnapshot = snapNow; saveState(); ch += '<p class="note">Baseline recorded. Changes to expense ratio, AUM, fund managers, risk-o-meter, exit load or benchmark in future factsheet snapshots will be listed here.</p>'; }
    else {
      const changes = [];
      Object.entries(snapNow).forEach(([id, now]) => {
        const was = S.seenSnapshot[id]; const f = fundById(id);
        if (!was) { changes.push(`<b>${esc(f.name)}</b> added to the shortlist.`); return; }
        const lab = { ter: 'Expense ratio', aumCr: 'AUM (₹ cr)', managers: 'Fund manager(s)', riskometer: 'Risk-o-meter', exitLoad: 'Exit load', benchmark: 'Benchmark' };
        Object.keys(lab).forEach(k => {
          if (String(was[k]) === String(now[k])) return;
          if (k === 'aumCr' && was[k] && now[k] && Math.abs(now[k] / was[k] - 1) < 0.1) return; // ignore <10% AUM moves
          changes.push(`<b>${esc(f.name.split('–')[0])}</b> — ${lab[k]}: ${esc(was[k] ?? 'n/a')} → <b>${esc(now[k] ?? 'n/a')}</b>`);
        });
      });
      ch += changes.length ? `<ul class="tight">${changes.map(c => `<li>${c}</li>`).join('')}</ul><button class="btn small" id="markSeen" type="button">Mark as reviewed</button>` : '<p class="note">No factsheet changes since your last review.</p>';
    }
    const sel = (S.rows || []).map(r => fundById(r.fundId)).filter(Boolean);
    const alerts = [];
    sel.forEach(f => {
      (f.flags || []).forEach(x => alerts.push(`<b>${esc(f.name.split('–')[0])}</b>: ${esc(x)}`));
      const h = HIST[f.schemeCode];
      if (h && h.length > 260) {
        const yr = h.filter(p => p.d >= U.iso(U.addYears(h[h.length - 1].d, -1)));
        const hi = Math.max(...yr.map(p => p.nav)), last = h[h.length - 1].nav;
        if (last / hi - 1 < -0.10) alerts.push(`<b>${esc(f.name.split('–')[0])}</b> is ${pf(last / hi - 1)} below its 52-week high NAV.`);
      }
    });
    ch += `<h3>Alerts for your selected funds</h3>` + (alerts.length ? `<ul class="tight">${alerts.map(a => `<li>${a}</li>`).join('')}</ul>` : '<p class="note">None.</p>');
    $('changeBox').innerHTML = ch;
    const ms = $('markSeen'); if (ms) ms.addEventListener('click', () => { S.seenSnapshot = snapNow; saveState(); safe(renderUpdates); });
    let nt = '<tr><th>Fund</th><th>Scheme code</th><th>NAV</th><th>NAV date</th><th>1-day change</th><th class="wrap">Source</th><th>Fetched</th><th>Status</th></tr>';
    const listF = sel.length ? sel : allFunds();
    listF.forEach(f => {
      const l = latestNav(f.schemeCode), m = metricsFor(f) || {};
      const fr = l ? DS.freshness(l.date, l.fetchedAt) : null;
      nt += `<tr><td class="fundname">${fundLink(f)}</td><td>${f.schemeCode}</td><td>${l ? l.nav.toFixed(4) : '—'}</td><td>${l ? esc(l.date) : '—'}</td><td class="${(m.dayChange || 0) >= 0 ? 'pos' : 'neg'}">${m.dayChange != null ? pfs(m.dayChange, 2) : '—'}</td><td class="wrap note">${l ? esc(l.source) : esc((MET[f.schemeCode] || {}).error || 'loading…')}</td><td class="note">${l && l.fetchedAt ? esc(new Date(l.fetchedAt).toLocaleString('en-IN')) : '—'}</td><td>${!l ? '<span class="pill bad">unavailable</span>' : fr.navStale ? '<span class="pill warn">stale</span>' : (MET[f.schemeCode] || {}).live === false ? '<span class="pill warn">cached</span>' : '<span class="pill good">current</span>'}</td></tr>`;
    });
    $('navTbl').innerHTML = nt;
    $('logBox').innerHTML = DS.log.length ? DS.log.map(l => `<div>${esc(l.at.slice(11, 19))} · ${esc(l.level)} · ${esc(l.msg)}</div>`).join('') : 'No messages.';
  }

  // ------------------------------------------------------------------ I. portfolio
  function portfolioResult(txns) {
    const latest = {};
    txns.forEach(t => { if (t.schemeCode) { const l = latestNav(t.schemeCode); if (l) latest[String(t.schemeCode)] = l; } });
    return PF.compute(txns, latest, rulesEff(), taxProfile());
  }
  function bindPortfolio() {
    $('txDate').value = U.todayISO();
    const syncFund = () => { const id = $('txFund').value; const f = fundById(id); $('txNameWrap').classList.toggle('hidden', !!f); if (f) $('txClass').value = CATS[f.category].taxClass; };
    $('txFund').addEventListener('change', async () => { syncFund(); const f = fundById($('txFund').value); if (f) await ensureHistory(f.schemeCode); });
    $('txAdd').addEventListener('click', async () => {
      const f = fundById($('txFund').value);
      const t = { id: Date.now() + Math.random(), type: $('txType').value, date: $('txDate').value, fundName: f ? f.name : $('txName').value.trim(), schemeCode: f ? f.schemeCode : null, taxClass: $('txClass').value, amount: $('txAmt').value, units: $('txUnits').value, nav: $('txNav').value, exitLoad: $('txExit').value, note: $('txNote').value };
      const { txn, errors } = PF.normalise(t);
      if (errors.length) { $('txMsg').innerHTML = `<div class="banner bad">${errors.map(esc).join('<br>')}</div>`; return; }
      const all = PF.load(store); all.push(txn); PF.save(store, all);
      if (txn.schemeCode) await ensureHistory(txn.schemeCode);
      $('txMsg').innerHTML = `<div class="banner good">Added ${esc(txn.type)} of ${txn.units.toFixed(4)} units in ${esc(txn.fundName)} on ${esc(txn.date)}.</div>`;
      ['txAmt', 'txUnits', 'txNav', 'txExit', 'txNote'].forEach(id => { $(id).value = ''; });
      renderAll();
    });
    $('ssAdd').addEventListener('click', async () => {
      const f = fundById($('txFund').value), amt = +$('ssAmt').value, from = $('ssFrom').value, to = $('ssTo').value;
      if (!f || !(amt > 0) || !U.parseDate(from) || !U.parseDate(to) || to < from) { $('txMsg').innerHTML = '<div class="banner bad">Choose a listed fund, a positive monthly amount and a valid date range.</div>'; return; }
      const h = await ensureHistory(f.schemeCode);
      if (!h) { $('txMsg').innerHTML = '<div class="banner bad">NAV history unavailable for this fund — enter instalments manually from your statement.</div>'; return; }
      const sd = (S.levies.stampDutyMFPurchasePct || 0) / 100;
      const all = PF.load(store); let n = 0, skipped = 0;
      for (let k = 0; k < 600; k++) {
        const d = U.iso(U.addMonths(from, k)); if (d > to) break;
        const p = FR.navOnOrBefore(h, d);
        if (!p || U.daysBetween(p.d, d) > 7) { skipped++; continue; }
        all.push(PF.normalise({ id: Date.now() + k, type: 'BUY', date: p.d, fundName: f.name, schemeCode: f.schemeCode, taxClass: CATS[f.category].taxClass, amount: amt, units: amt / (1 + sd) / p.nav, note: 'SIP series (historical NAV)' }).txn); n++;
      }
      PF.save(store, all);
      $('txMsg').innerHTML = `<div class="banner good">Added ${n} SIP instalments${skipped ? `; ${skipped} skipped (no NAV within 7 days)` : ''}. Check against your account statement — actual allotment NAVs can differ by a day.</div>`;
      renderAll();
    });
    $('txTbl').addEventListener('click', e => { const b = e.target.closest('[data-txdel]'); if (!b) return; PF.save(store, PF.load(store).filter(t => String(t.id) !== b.dataset.txdel)); renderAll(); });
    $('expTx').addEventListener('click', () => download('transactions.csv', PF.transactionsCSV(PF.load(store))));
    $('expHold').addEventListener('click', () => download('holdings.csv', PF.holdingsCSV(portfolioResult(PF.load(store)))));
    $('impTx').addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      const rows = PF.parseCSV(await file.text()); const all = PF.load(store); const errs = []; let n = 0;
      rows.forEach((r, i) => { const { txn, errors } = PF.normalise(Object.assign({}, r, { id: r.id || Date.now() + i, schemeCode: r.schemeCode ? +r.schemeCode : null })); if (errors.length) errs.push(`Row ${i + 2}: ${errors.join(' ')}`); else { all.push(txn); n++; } });
      PF.save(store, all); e.target.value = '';
      for (const c of [...new Set(all.map(t => t.schemeCode).filter(Boolean))]) await ensureHistory(c);
      $('txMsg').innerHTML = `<div class="banner ${errs.length ? 'warn' : 'good'}">Imported ${n} transaction(s).${errs.length ? '<br>' + errs.slice(0, 10).map(esc).join('<br>') : ''}</div>`;
      renderAll();
    });
    $('clearTx').addEventListener('click', () => { if (confirm('Delete ALL recorded transactions from this browser? This cannot be undone (export a CSV first if you want a copy).')) { PF.save(store, []); renderAll(); } });
    $('txFund').innerHTML = fundOptions(null) + '<option value="__other">Other (type the name)…</option>';
    syncFund();
  }
  function renderPortfolio() {
    const txns = PF.load(store);
    if (!txns.length) { $('holdTbl').innerHTML = '<tr><td class="mut">No transactions recorded yet.</td></tr>'; $('realTbl').innerHTML = ''; $('txTbl').innerHTML = ''; $('pfNotes').innerHTML = ''; return; }
    const P = portfolioResult(txns);
    let h = '<tr><th>Fund</th><th>Units held</th><th>Invested (cost)</th><th>NAV (date)</th><th>Current value</th><th>Unrealised P/L</th><th>Return</th><th>Status</th></tr>';
    P.holdings.filter(x => x.units > 1e-9).forEach(x => {
      const fr = x.navDate ? DS.freshness(x.navDate, null) : null;
      h += `<tr><td class="fundname">${esc(x.name)}</td><td>${x.units.toFixed(4)}</td><td>${money(x.cost)}</td><td>${x.nav != null ? `${x.nav.toFixed(4)}<div class="note">${esc(x.navDate)}</div>` : '<span class="warnc">no NAV</span>'}</td><td>${money(x.value)}</td><td class="${(x.unrealized || 0) >= 0 ? 'pos' : 'neg'}">${money(x.unrealized)}</td><td>${x.cost && x.unrealized != null ? pfs(x.unrealized / x.cost) : '—'}</td><td>${x.nav == null ? '<span class="pill bad">unvalued</span>' : fr.navStale ? '<span class="pill warn">stale NAV</span>' : '<span class="pill good">current</span>'}</td></tr>`;
    });
    h += `<tr class="tot"><td>Total</td><td></td><td>${money(P.invested)}</td><td></td><td>${money(P.value)}</td><td>${money(P.unrealized)}</td><td>${P.invested ? pfs(P.unrealized / P.invested) : ''}</td><td></td></tr>`;
    $('holdTbl').innerHTML = h;
    const notes = P.errors.map(e => `<div class="banner bad">${esc(e)}</div>`).join('') + (P.missingNav.length ? `<div class="banner warn">No NAV available for: ${esc(P.missingNav.join(', '))}. These holdings are excluded from current value.</div>` : '')
      + (P.unrealizedTax ? `<p class="note">If everything were redeemed today: estimated tax ${money(P.unrealizedTax.tax)} → estimated amount received ${money(P.estRedemption)} (exit loads not included). </p>` : '');
    $('pfNotes').innerHTML = notes;
    if (P.realizedTax) {
      let r = '<tr><th>FY</th><th>Fund</th><th>Bought</th><th>Sold</th><th>Units</th><th>Cost</th><th>Proceeds</th><th>Gain</th><th>Term</th><th>Rate</th><th>Tax (allocated)</th></tr>';
      P.realizedTax.lots.forEach(l => { r += `<tr><td>${esc(U.fyLabel(U.fyStart(l.sellDate)))}</td><td class="tl">${esc(l.label)}</td><td>${esc(l.buyDate)}</td><td>${esc(l.sellDate)}</td><td>${l.units.toFixed(4)}</td><td>${money(l.cost)}</td><td>${money(l.proceeds)}</td><td class="${l.gain >= 0 ? 'pos' : 'neg'}">${money(l.gain)}</td><td>${l.cls.term === 'LT' ? 'Long' : 'Short'}</td><td>${l.rate}%</td><td>${money(l.taxAllocated)}</td></tr>`; });
      P.realizedTax.years.forEach(y => { r += `<tr class="tot"><td>${esc(y.fyLabel)}</td><td colspan="6" class="tl">ST gains ${money(y.stGain)} · LT gains ${money(y.ltGain)} · exemption used ${money(y.exemptionUsed)}</td><td></td><td></td><td></td><td>${money(y.tax)}</td></tr>`; });
      $('realTbl').innerHTML = r;
    } else $('realTbl').innerHTML = '<tr><td class="mut">No redemptions recorded.</td></tr>';
    $('txTbl').innerHTML = '<tr><th>Date</th><th>Type</th><th>Fund</th><th>Amount</th><th>Units</th><th>NAV</th><th>Exit load</th><th>Note</th><th></th></tr>' + [...txns].sort((a, b) => a.date < b.date ? 1 : -1).map(t => `<tr><td>${esc(t.date)}</td><td>${esc(t.type)}</td><td class="tl">${esc(t.fundName)}</td><td>${money(t.amount)}</td><td>${(+t.units).toFixed(4)}</td><td>${(+t.nav).toFixed(4)}</td><td>${t.exitLoad ? money(t.exitLoad) : ''}</td><td class="tl note">${esc(t.note || '')}</td><td><button class="btn small danger" data-txdel="${esc(String(t.id))}" type="button" aria-label="Delete transaction">✕</button></td></tr>`).join('');
  }
  function download(name, text) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ------------------------------------------------------------------ assumptions
  function inputField(id, label, value, attrs = '', cls = 'assume', help = '') { return `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" value="${esc(value)}" class="${cls}" ${attrs}>${help ? `<div class="note">${help}</div>` : ''}</div>`; }
  function renderAssumptionsStatic() {
    const cur = CFG.tax.ruleSets.find(r => r.current) || CFG.tax.ruleSets[CFG.tax.ruleSets.length - 1];
    $('taxProfileBox').innerHTML = inputField('tSlab', 'Marginal slab rate % (debt funds, short-term gold/intl.)', S.tax.slab, 'min="0" max="42.74" step="1"')
      + `<div class="field"><label for="tSur">Surcharge bracket (total income)</label><select id="tSur" class="assume">${CFG.tax.surchargeBrackets.map(b => `<option value="${b.id}">${esc(b.label)} — ${b.pct}%</option>`).join('')}</select><div class="note">${esc(CFG.tax.specialRateSurchargeCapNote)}</div></div>`
      + inputField('tCess', 'Health &amp; education cess %', S.tax.cess, 'min="0" step="1"')
      + inputField('tFY', 'Spread redemption over N financial years', S.tax.nFY, 'min="1" max="10" step="1"', 'assume', 'Selling part in March and the rest in April lets you use the ₹1.25L equity LTCG exemption in each FY. Approximation: growth between the two sales is ignored.');
    const eqST = cur.classes.equity_oriented[0].st.rate, eqLT = cur.classes.equity_oriented[0].lt.rate, oLT = cur.classes.commodity_fof[0].lt.rate;
    $('taxOverrideBox').innerHTML = `<p class="note">Leave blank to use the law as configured (${esc(cur.label)}).</p>`
      + inputField('oEqST', `Equity STCG rate % (law: ${eqST}%)`, S.tax.ov.eqST, 'step="0.5" min="0" placeholder="' + eqST + '"')
      + inputField('oEqLT', `Equity LTCG rate % (law: ${eqLT}%)`, S.tax.ov.eqLT, 'step="0.5" min="0" placeholder="' + eqLT + '"')
      + inputField('oEx', `Equity LTCG exemption ₹ per FY (law: ${cur.equity112AExemption.toLocaleString('en-IN')})`, S.tax.ov.exemption, 'step="5000" min="0" placeholder="' + cur.equity112AExemption + '"')
      + inputField('oOLT', `Other LTCG rate % — gold, intl., G-Sec (law: ${oLT}%)`, S.tax.ov.otherLT, 'step="0.5" min="0" placeholder="' + oLT + '"')
      + inputField('lStamp', 'MF stamp duty on purchase %', S.levies.stampDutyMFPurchasePct, 'step="0.001" min="0"')
      + inputField('lStt', 'STT on equity-fund redemption %', S.levies.sttEquityMFRedemptionPct, 'step="0.001" min="0"')
      + inputField('lSttD', 'STT on equity-ETF sale %', S.levies.sttEquityDeliveryPct, 'step="0.01" min="0"');
    $('chargesBox').innerHTML = inputField('cBrok', 'ETF brokerage per order (₹)', S.charges.brokeragePerOrder, 'step="1" min="0"')
      + inputField('cExch', 'Exchange transaction charge %', S.charges.exchangeTxnPct, 'step="0.0001" min="0"')
      + inputField('cDp', 'DP charge per sell day (₹, incl. GST)', S.charges.dpChargePerSellDay, 'step="0.5" min="0"')
      + inputField('cSpread', 'Bid-ask spread / impact cost % per trade', S.charges.bidAskSpreadPctPerSide, 'step="0.01" min="0"')
      + inputField('cAmc', 'Demat annual maintenance (₹/yr, if ETFs held)', S.charges.annualDematAmc, 'step="50" min="0"')
      + `<p class="note">${esc(CFG.settings.charges.etfNote)} ${esc(CFG.settings.charges.mfNote)} Mutual-fund expense ratios are already inside NAV and are not charged again.</p><div class="btns"><button class="btn small" id="resetAssump" type="button">Reset tax &amp; charges to defaults</button></div>`;
    // rules viewer
    const tc = CFG.tax.taxClasses;
    $('rulesBox').innerHTML = `<p class="note">Version ${esc(CFG.tax.version)} · last verified ${esc(CFG.tax.lastVerified)} · review by ${esc(CFG.tax.reviewBy)}. ${esc(CFG.tax.disclaimer)}</p>` + CFG.tax.ruleSets.map(rs => `
      <details${rs.current ? ' open' : ''}><summary>${esc(rs.label)} <span class="pill ${rs.current ? 'acc' : ''}">${esc(rs.effectiveFrom)} → ${esc(rs.effectiveTo || 'current')}</span></summary>
      <div class="scroll"><table><tr><th>Asset class</th><th>Acquired</th><th>Long-term after</th><th class="wrap">Short-term</th><th class="wrap">Long-term</th></tr>
      ${Object.entries(rs.classes).map(([k, arr]) => arr.map(e => `<tr><td class="tl wrap">${esc(tc[k].label)}</td><td class="tl">${esc(e.acquiredFrom ? 'from ' + e.acquiredFrom : '')}${esc(e.acquiredTo ? ' to ' + e.acquiredTo : '')}${!e.acquiredFrom && !e.acquiredTo ? 'any date' : ''}</td><td>${e.alwaysShortTerm ? 'never (always short-term)' : '> ' + e.ltAfterMonths + ' months'}</td><td class="wrap tl">${e.st.rate === 'slab' ? 'Slab rate' : e.st.rate + '%'} · ${esc(e.st.section)}</td><td class="wrap tl">${e.lt ? `${e.lt.rate}%${e.lt.indexation ? ' with indexation' : ''}${e.lt.exemptionPool ? ` above ₹${rs.equity112AExemption.toLocaleString('en-IN')}/FY` : ''} · ${esc(e.lt.section)}` : '—'}</td></tr>`).join('')).join('')}</table></div>
      <ul class="tight note">${rs.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
      <p class="note">Sources: ${rs.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(' · ')}</p></details>`).join('');
  }
  function bindAssumptions() {
    const on = (id, fn) => document.addEventListener('input', e => { if (e.target.id === id) { fn(e.target.value); schedule(); } });
    on('tSlab', v => { S.tax.slab = +v || 0; }); on('tCess', v => { S.tax.cess = +v || 0; }); on('tFY', v => { S.tax.nFY = Math.max(1, Math.round(+v || 1)); });
    on('oEqST', v => { S.tax.ov.eqST = v; }); on('oEqLT', v => { S.tax.ov.eqLT = v; }); on('oEx', v => { S.tax.ov.exemption = v; }); on('oOLT', v => { S.tax.ov.otherLT = v; });
    on('lStamp', v => { S.levies.stampDutyMFPurchasePct = +v || 0; }); on('lStt', v => { S.levies.sttEquityMFRedemptionPct = +v || 0; }); on('lSttD', v => { S.levies.sttEquityDeliveryPct = +v || 0; });
    on('cBrok', v => { S.charges.brokeragePerOrder = +v || 0; }); on('cExch', v => { S.charges.exchangeTxnPct = +v || 0; }); on('cDp', v => { S.charges.dpChargePerSellDay = +v || 0; }); on('cSpread', v => { S.charges.bidAskSpreadPctPerSide = +v || 0; }); on('cAmc', v => { S.charges.annualDematAmc = +v || 0; });
    document.addEventListener('change', e => { if (e.target.id === 'tSur') { S.tax.surchargeId = e.target.value; schedule(); } });
    document.addEventListener('click', e => {
      if (e.target.id === 'resetAssump') { const d = defaultState(); S.tax = d.tax; S.levies = d.levies; S.charges = d.charges; renderAssumptionsStatic(); schedule(); }
      if (e.target.id === 'resetCat') { S.catScen = {}; allocFull = true; schedule(); }
    });
    $('catScenTbl').addEventListener('input', e => { const c = e.target.dataset.cat, sc = e.target.dataset.sc; if (!c) return; S.catScen[c] = S.catScen[c] || {}; S.catScen[c][sc] = e.target.value === '' ? undefined : +e.target.value; allocFull = true; schedule(); });
  }
  function renderAssumptionValues() {
    const setV = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    setV('tSlab', S.tax.slab); setV('tCess', S.tax.cess); setV('tFY', S.tax.nFY); const ts = $('tSur'); if (ts) ts.value = S.tax.surchargeId;
    const t = $('catScenTbl');
    if (!t.contains(document.activeElement)) {
      t.innerHTML = '<tr><th>Category</th><th>Tax class</th><th>Conservative %</th><th>Moderate %</th><th>Optimistic %</th><th>TER assumed if unverified</th><th>Min. holding (yrs)</th></tr>' + Object.entries(CATS).map(([k, c]) => `<tr><td class="tl">${esc(c.label)}</td><td class="tl note">${esc(CFG.tax.taxClasses[c.taxClass].label)}</td>${['c', 'm', 'o'].map(sc => `<td><input type="number" step="0.5" class="assume" data-cat="${k}" data-sc="${sc}" value="${catScen(k, sc)}" aria-label="${esc(c.label)} ${sc}"></td>`).join('')}<td>${c.defaultTer}%</td><td>${c.minHoldYears}</td></tr>`).join('');
    }
    $('catScenNote').textContent = CFG.settings.scenarioNote;
  }

  // ------------------------------------------------------------------ sources
  function renderSources() {
    const fundSrc = CFG.funds.funds.map(f => f.source).filter(s => s && /^https?:/.test(s.url));
    const ruleSrc = CFG.tax.ruleSets.flatMap(r => r.sources).concat(CFG.tax.statutoryLevies.sources);
    const uniq = arr => { const m = new Map(); arr.forEach(s => m.set(s.url, s)); return [...m.values()]; };
    $('sourcesBox').innerHTML = `
      <h3 style="margin-top:0">Live data</h3><ul class="tight">
        <li><a href="https://www.amfiindia.com/spages/NAVAll.txt" target="_blank" rel="noopener">AMFI NAVAll.txt</a> — official daily NAV of every scheme. Free, no key, no documented rate limit; published each business evening. Used via the local backend (browsers cannot read it directly due to CORS).</li>
        <li><a href="https://www.mfapi.in/" target="_blank" rel="noopener">mfapi.in</a> — free, key-less JSON mirror of AMFI NAV history (CORS-enabled). Used for full NAV history → returns, volatility, Sharpe, Sortino, drawdowns, rolling returns, correction behaviour. Community-run, no SLA: failures fall back to the last cached metrics, shown as stale.</li>
        <li>Not used: NSE/BSE live quotes (no free official API; scraping is against their terms), Value Research / Morningstar (no public API; licence restrictions). Use them to cross-check: <a href="https://www.valueresearchonline.com/" target="_blank" rel="noopener">Value Research</a>, <a href="https://www.morningstar.in/" target="_blank" rel="noopener">Morningstar India</a>, <a href="https://www.sebi.gov.in/" target="_blank" rel="noopener">SEBI</a>, <a href="https://www.rbi.org.in/" target="_blank" rel="noopener">RBI</a>.</li></ul>
      <h3>Factsheet snapshot (config/funds.json, ${esc(CFG.funds.snapshotDate)})</h3><p class="note">${esc(CFG.funds.snapshotNote)}</p>
      <ul class="tight note">${uniq(fundSrc).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a> · ${esc(s.asOf || '')}</li>`).join('')}</ul>
      <h3>Tax rules (config/tax-rules.json, verified ${esc(CFG.tax.lastVerified)})</h3><ul class="tight note">${uniq(ruleSrc).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul>
      <h3>Methodology</h3><ul class="tight">
        <li>Each lump sum and SIP instalment is a separate lot with its own purchase date, compounded daily at (1 + return)<sup>days/365</sup>.</li>
        <li>Your scenario return is the portfolio return <b>before</b> the expense ratio; NAV grows at return − TER. “Fund expenses” = value at the pre-expense return − value at the NAV return. TER is never deducted twice.</li>
        <li>Stamp duty (0.005%) is deducted before units are allotted. Exit load applies per lot by days held. STT (0.001%) on equity-fund redemptions. ETFs: brokerage, exchange charge, SEBI fee, GST, stamp duty, DP charge, spread.</li>
        <li>Capital gains = sale value − exit load − deductible selling costs − cost. Tax is computed for the whole portfolio per financial year: short-term losses offset any gains, long-term losses only long-term gains, then the ₹1.25 lakh equity exemption, then rate, surcharge (capped at 15% on equity and LTCG) and 4% cess.</li>
        <li>Net XIRR uses the actual dated cash flows. Real value deflates the net amount by your inflation assumption.</li>
        <li>Fund score: percentile within asset class of rolling-return consistency, Sortino, 5-yr max drawdown, expense ratio, AUM/track record and 5-yr CAGR (weights editable). Model allocations pick the best-scoring eligible fund per sleeve, respecting verified minimum investments, minimum history and the category's minimum holding period, with at most four funds for small amounts.</li></ul>
      <h3>Known limitations</h3><ul class="tight">
        <li>Factsheet fields are a dated snapshot, not live. Some were unavailable or looked inconsistent and are flagged instead of guessed.</li>
        <li>Benchmark comparison uses an index fund as proxy (TRI series are not freely available). Portfolio holdings / diversification data are not in free feeds.</li>
        <li>Projections assume constant returns; real markets are volatile and sequence matters. Tax rules for future years assume current law continues.</li>
        <li>Not modelled: equity grandfathering (31 Jan 2018 FMV), Sec 87A rebate/basic exemption, marginal relief, carry-forward of past losses, IDCW options, gold ETF market-price premium/discount to NAV, interest on directly-held G-Secs.</li>
        <li>Browser storage is per device; clearing site data deletes your saved strategies and transactions — export a CSV.</li></ul>`;
  }

  // ------------------------------------------------------------------ chart helpers
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function col(i) { return cssv(['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'][i % 8]); }
  function baseOpts(fmt = {}) {
    const mut = cssv('--mut'), grid = cssv('--line');
    return { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: mut, boxWidth: 12 } }, tooltip: { callbacks: { label: c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt.y ? fmt.y(c.parsed.y) : money(c.parsed.y)}` } } },
      scales: { x: { ticks: { color: mut, maxTicksLimit: 12 }, grid: { color: grid } }, y: { ticks: { color: mut, callback: v => fmt.y ? fmt.y(v) : (Math.abs(v) >= 1e5 ? '₹' + (v / 1e5).toFixed(1) + 'L' : '₹' + Math.round(v).toLocaleString('en-IN')) }, grid: { color: grid } } } };
  }
  function chart(id, cfg) {
    if (!window.Chart) { const el = $(id); if (el && el.parentElement) el.parentElement.innerHTML = '<p class="note">Charts unavailable (Chart.js could not load — offline?). All numbers are in the tables.</p>'; return; }
    if (CH[id]) { CH[id].data = cfg.data; CH[id].options = cfg.options; CH[id].update('none'); }
    else CH[id] = new Chart($(id), cfg);
  }
  function sample(arr, n) { if (arr.length <= n) return arr; const step = arr.length / n; const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]); out.push(arr[arr.length - 1]); return out; }

  boot();
})();
