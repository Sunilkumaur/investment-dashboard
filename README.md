# Smart Indian Investment Research & Wealth Dashboard

A local, working decision-support tool for an Indian retail investor:

* researches a shortlist of 20 Indian mutual funds / ETFs using **live AMFI NAV history**,
* scores them on consistency, risk-adjusted return, drawdown, cost and track record (not on past return alone),
* builds a **model allocation for ₹9,000** (Conservative / Balanced / Growth) that respects minimum investments and holding periods,
* projects lump-sum + SIP outcomes over 5 / 7 / 10 / custom years in three scenarios,
* and shows **what you actually receive after redemption** — expense ratio, exit load, stamp duty, STT, ETF charges and capital-gains tax (lot by lot, with set-off, exemption, surcharge and cess),
* lets you add **any of ~10,000 AMFI schemes as a custom fund** (search fills the scheme code, AMC and category; you confirm expense ratio, exit load and expected returns),
* tracks your **whole net worth** — FDs, gold (auto-tracked with the gold ETF NAV), land/property, cash, savings, PPF/EPF/NPS/small savings, stocks, insurance/ULIPs, loans and credit cards — with an after-tax "if sold today" value, a forecast and a **money-leak** report,
* and has a **✓ Check** button that saves, refreshes live NAVs, recalculates everything and shows what changed since your last check.

> **Not investment advice.** The builder is not a SEBI-registered investment adviser. Projections use your assumptions, not forecasts. Tax figures are estimates. Verify with scheme documents, a SEBI-registered adviser and a tax professional.

---

## 1. Run it

Needs Python 3.8+ (standard library only — nothing to `pip install`) and a modern browser.

```bash
python backend/server.py
```

Then open **http://127.0.0.1:8000/**. Use `--port 8080` to change the port. The server binds to 127.0.0.1 only.

Opening `index.html` directly from disk does not work: browsers block reading the local `config/*.json` files. The page shows a message telling you to start the server.

Any other static server also works (for example `python -m http.server`). Without the backend, the page fetches NAV history straight from mfapi.in and skips the official AMFI latest-NAV file.

## 2. Tests

```bash
node tests/run-tests.js
```

The latest run is saved in `tests/last-run.txt`: **178 passed, 0 failed**. Expected values are worked out independently in the test file (closed-form formulas and hand-computed tax), not by calling the code a second time. Coverage:

| # | Area | Examples |
|---|------|----------|
| 1 | ₹9,000 lump sum 5/7/10 yrs | value = 9000 × 1.12^(days/365); XIRR = 12% |
| 2 | Monthly SIP | 12 instalments/yr, month-end clamping, step-up from month 13 |
| 3 | Returns & expense ratios | TER 1% on 12% → NAV at 11%; expense impact; negative returns |
| 4–5 | Tax by category | equity LTCG ₹2L → ₹9,750; STCG 20%; debt at slab; gold FoF 24-month rule; gold ETF 12-month rule; international FoF; G-Sec |
| 6 | Historical rule sets | FA2018 (10%/15%), FA2024, amended specified-MF definition 2025, ITA 2025; CII indexation |
| 7 | Set-off, surcharge, FYs | ST loss vs slab gain; LT loss not vs ST; 15% surcharge cap; separate exemption per FY |
| 8 | SIP lots | 18 lots → exactly 6 long-term, 12 short-term |
| 9 | Exit loads | tiers, 10% free units, unknown load |
| 10 | Redemption identity | gross − net = sum of all costs and taxes, no double counting; STT; ETF charges |
| 11 | Validation | allocation ≠ 100%, zero investment, negative input, bad dates |
| 12 | NAV metrics | CAGR, drawdown, rolling returns, missing/short history → null, unit-split adjustment |
| 13 | Model allocation | totals exactly ₹9,000 / 100%, meets minimums, ≤4 funds, no mid/small cap at 5 yrs |
| 14 | Data failures | all sources down → empty (nothing invented), cache fallback, stale-NAV detection |
| 15 | Portfolio tracker | FIFO, realised vs unrealised, per-lot tax, oversell error, CSV round-trip |
| 16 | XIRR | single-flow = CAGR, negative returns, undefined cases |
| 13b | Custom-fund category detection | AMFI category text → dashboard category (large cap, ELSS, index, G-Sec index, overseas FoF, gold ETF…) |
| 17 | Net-worth valuation | FD compounding/payout, gold price moved with ETF NAV, loan amortisation, PPF at 7.1%, endowment IRR, term cover = ₹0 |
| 18 | Net worth & liquidation | assets − liabilities, stocks + MF share one ₹1.25L exemption, land: lower of 12.5% vs 20%-indexed, short-term land at slab, SGB maturity exempt |
| 19 | Money leaks | idle cash, savings above emergency fund, FD below inflation after tax, credit-card interest, land holding cost, locker fee |
| 14 | mfapi CORS retry | first response blocked → retried with a fresh cache key |

I also checked the dashboard by hand in a browser: live data load, horizon/SIP changes, the allocation-total warning, "Scale to 100%", the actual-NAV redemption calculator, the SIP-series import, FIFO redemption, comparison tables, the fund dialog and the mobile layout (no horizontal scroll at 375 px).

## 3. Project structure

```
index.html                 Dashboard (sections A–H, portfolio, assumptions, sources)
css/styles.css             Styles, light/dark theme
js/util.js                 Dates, financial years, XIRR, formatting
js/tax-engine.js           Applies tax rule sets from config (no rates hard-coded)
js/calculator.js           Lot-by-lot projection, charges, gross→net, validation
js/fund-research.js        NAV metrics, split adjustment, scoring, model allocation
js/data-service.js         Backend → mfapi.in → cache fallback, freshness checks
js/portfolio.js            Transaction ledger, FIFO, realised/unrealised, CSV
js/networth.js             Net worth: valuation, forecast, liquidation tax, money leaks
js/app.js                  UI state, rendering, events, charts
config/tax-rules.json      Tax rule sets with effective dates and sources
config/funds.json          Fund shortlist and factsheet snapshot with sources
config/settings.json       Defaults, scenarios, profiles, scoring weights, charges
backend/server.py          Local server + AMFI/mfapi proxy with disk cache
tests/run-tests.js         Independent calculation tests
SIP Redemption Planner — 5 to 10 Years.html   Original single-file planner (kept unchanged)
```

The original planner's lot-wise SIP tax logic, exit-load tiers, GOLDBEES charges and XIRR approach were carried into the new engines. The new engines generalise them to any fund category, dated tax rules and portfolio-wide set-off.

## 4. Data sources & API configuration

| Data | Source | Notes |
|------|--------|-------|
| Latest NAV (official) | [AMFI NAVAll.txt](https://www.amfiindia.com/spages/NAVAll.txt) | Free, no key. No CORS, so it is read through `backend/server.py` (cached 6 h). |
| NAV history | [mfapi.in](https://www.mfapi.in/) `https://api.mfapi.in/mf/<schemeCode>` | Free, no key, CORS-enabled community mirror of AMFI data; no SLA. Cached 12 h by the backend. |
| Returns, volatility, Sharpe, Sortino, drawdown, rolling returns, correction behaviour | Computed from NAV history | Risk-free proxy = Parag Parikh Liquid Fund trailing 3-yr CAGR (fallback 6%, flagged). |
| Expense ratio, AUM, managers, exit load, risk-o-meter, minimums, benchmark | Snapshot in `config/funds.json` (Groww fund pages, 13–15 Nov 2026) | Unverifiable or inconsistent values are `null` and flagged, never guessed. |
| Tax rules | `config/tax-rules.json` | Mirae Asset MF Tax Reckoner FY 2026-27, Income Tax Dept, Business Standard / Tata MF on Budget 2026, DSP MF on Budget 2024, AMFI tax corner. |

**No API keys are used anywhere**, so nothing secret is exposed in front-end JavaScript. If you add a paid provider later, put its key in an environment variable read by `backend/server.py` and proxy the calls; never put it in `js/`.

Not used: NSE/BSE live quotes (no free official API; scraping is against their terms), and Value Research / Morningstar (no public API; licence restrictions). Use them to cross-check by hand.

| Gold price for physical/digital gold | Your entered 24K price per gram, moved by the Nippon Gold BeES NAV (AMFI) since the price date | Turn off "auto-track" to keep it fully manual. |
| PPF / EPF / small-savings rates | `config/settings.json → netWorth.schemes` | PPF 7.1%, SSY/SCSS 8.2%, NSC 7.7%, KVP 7.5% (Oct–Dec 2026); EPF 8.25% (FY 2025-26). NPS rate is your assumption. Reset quarterly — update the file. |
| Cost Inflation Index | `config/tax-rules.json` | 2001-02 to 2026-27 (384, CBDT notification 85/2026), used for the 20%-with-indexation option on land bought before 23 Jul 2024. |

**mfapi.in quirk:** its edge cache sometimes serves a response without the CORS header, which browsers block. The data service requests each history with a once-a-day query key and retries with a unique key if blocked, so GitHub Pages works without the backend.

**Fallback behaviour:** backend → mfapi.in direct → last good metrics in `localStorage` (labelled *cached/stale*) → "unavailable". NAVs older than 4 days are flagged stale. The backend serves its last good AMFI copy with `stale: true` when AMFI is unreachable.

Backend endpoints: `/api/health`, `/api/nav/latest?codes=120716,122639`, `/api/nav/history/<code>`, `/api/search?q=parag flexi`.

## 5. Keeping data current

* **Tax law** — edit `config/tax-rules.json`. To add a new law, append a rule set with `effectiveFrom`, close the previous one with `effectiveTo`, and update `lastVerified` / `reviewBy`. Older rule sets stay in place, so historical redemptions are still taxed correctly. The Updates panel warns when `reviewBy` (15 Feb 2027, after Budget 2027) has passed.
* **Factsheets** — update `config/funds.json` from the latest AMC factsheets and change `snapshotDate`. The panel warns after 45 days, and the "Material changes" box lists changes to expense ratio, AUM, managers, risk-o-meter, exit load or benchmark since your last review.
* **Add a fund** — add an entry to `config/funds.json` (the AMFI scheme code is in NAVAll.txt), or use **"+ Add any AMFI scheme"** in the simulator (category and expense ratio are then marked as user-entered).

## 6. Tax rules implemented (current law, redemptions from 1 Apr 2026)

| Asset | Long-term after | Short-term | Long-term |
|---|---|---|---|
| Equity-oriented funds, index funds, equity ETFs, arbitrage | > 12 months | 20% | 12.5% above ₹1.25 lakh per FY |
| Debt funds (>65% debt) bought on/after 1 Apr 2023 | never | slab | — |
| Debt funds bought before 1 Apr 2023 | > 24 months | slab | 12.5% |
| Gold / international FoFs (unlisted) | > 24 months | slab | 12.5% |
| Gold ETFs (listed) | > 12 months | slab | 12.5% |
| Listed G-Secs | > 12 months | slab | 12.5% |

Plus surcharge by income bracket (capped at 15% on equity STCG and all LTCG), 4% cess, STT 0.001% on equity-fund redemptions and 0.005% stamp duty on purchases. Section numbers under the Income-tax Act 2025 (196/197/198) come from secondary sources; check them against the official text.

## 7. Net worth, money leaks and the Check button

* **Assets:** cash, savings accounts, FDs (cumulative or payout, premature penalty), gold (coins, jewellery with purity, digital, SGB), land/property (rent, holding costs, selling cost), PPF/EPF/VPF/NPS/SSY/NSC/SCSS/KVP, stocks & ETFs, insurance (term, endowment, money-back, ULIP), other assets, and mutual funds from "My portfolio" automatically. **Liabilities:** home, car, personal, education and gold loans, credit-card dues, with EMI amortisation.
* **Mutual funds:** holdings recorded in "My portfolio" are valued at the latest NAV and projected at their fund's scenario return after expense ratio. The **allocation-simulator plan** (₹9,000 + SIP) is a separate component, projected lot by lot with the same engine used in sections D–E. Its gains are taxed together with your other holdings so the ₹1.25 lakh exemption is shared. If the planned money is currently in cash or savings, untick one of them.
* **Include toggles:** tick or untick whole types (cash, FDs, gold, property, schemes, stocks, tracked MFs, planned investment, insurance, other, loans) and individual rows. Unticked items stay visible but greyed out and are left out of totals, leaks, the chart, the forecast and the Overview net-worth row. The choice is saved in the browser.
* **"If sold today"** estimates penalties, buy-back deductions, selling costs and tax. Capital gains on stocks, mutual funds and gold are taxed together so losses offset and one ₹1.25 lakh equity exemption is shared. Property uses the cheaper of 12.5% or 20% with indexation where the law allows.
* **Forecast** projects every asset to 5/7/10 years and your horizon (scenario-based growth, sourced scheme rates, loan balances falling with EMIs, future PPF/premium contributions shown separately), in nominal and today's money.
* **Money leaks** (₹ a year): idle cash, savings above your emergency fund vs a liquid-fund yield, FDs earning below inflation after tax, matured FDs left idle, expensive debt, low-yield money held while paying a higher loan rate, low-IRR endowment/money-back policies, ULIP charges, gold locker fees, property costs above rent, Regular-plan / high-cost funds. Also flags risks: emergency fund below target and heavy concentration.
* **✓ Check** (top bar and in each section): saves, re-fetches live NAVs, recalculates, lists anything needing attention (allocation not 100%, missing purchase cost, matured FDs, EMI below interest, stale NAVs, overdue tax review) and shows the change since your previous check. Values still update live as you type.
* **Backup:** "Export all data" downloads one JSON file (settings, custom funds, strategies, transactions, assets); "Import backup" restores it. Data never leaves your browser otherwise.

## 8. Known limitations

* Factsheet fields are a dated snapshot, not live. HDFC Nifty 50 Index and HDFC Corporate Bond have no verified factsheet data. The arbitrage funds' expense ratios looked like Regular-plan figures and are treated as unverified (a category default of 0.40% is used and flagged). ICICI Large Cap's 1.00% expense ratio is flagged for checking.
* Benchmark comparison uses an index-fund NAV as a proxy, because TRI series aren't freely available. Holdings-level diversification data isn't in free feeds.
* Projections use constant returns. Real markets are volatile, and the order of returns matters for SIPs.
* Not modelled: equity grandfathering (31 Jan 2018 FMV), section 87A rebate and basic exemption, marginal relief, carry-forward of past losses, IDCW options, gold-ETF market price vs NAV, and interest income on directly held G-Secs.
* "Spread redemption over N financial years" multiplies the ₹1.25 lakh exemption and ignores growth between the two sales.
* Tax-law changes can't be detected automatically from free sources. The tool reminds you to re-verify instead.
* Saved strategies, portfolio transactions and net-worth entries live in this browser's `localStorage` only. Use "Export all data" to keep a copy.
* Net worth: FD interest is assumed to be taxed yearly (only interest from today onward is taxed in "if sold today"); 80TTA/80TTB, EPF interest tax above ₹2.5 lakh contributions, NPS annuity taxation, and Sec 10(10D) conditions for insurance are noted but not computed. Property and "other" asset values are your estimates.
