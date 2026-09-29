# Main-workspace trade-plan release

## Authority and scope

User requested all previously discussed functionality be deployed, not just the isolated research page. This authorizes scoped implementation, acceptance and publication to the existing GitHub Pages site. No exchange execution, credentials, new paid infrastructure or background-service installation is authorized.

Approved product flow: market opportunity → conditional entry plan → explicitly adopted local observation → explicitly recorded actual fill → system-proposed structural exit protection → explicitly adopted reminders → manually confirmed close. No transition equates a price touch or notification with an executed trade.

## Locked contracts

- Entry plans have their own `MarketPlan` type, separate from a real `ManualPosition` and from research advice. Exact USDT futures identity, decimal prices, closed historical candles, source timestamps and frozen settings travel with the plan.
- 60 seconds is the proposal acceptance TTL only. Entry observation waits at most 30 minutes. Position holding limits are independently 30/60/120/240 minutes, default 240, with immediate price protection.
- Entry zone uses the nearest confirmed 15m structure from seven complete days of closed 5m mark-price history. Buffer is max(0.25 × 15m ATR14 SMA, two ticks). The conservative endpoint must have at least 1.5 net reward/risk after an illustrative 12 bps round-trip fee/slippage assumption, excluding funding. These rules are not validated profitable strategies.
- Entry notification also requires a new closed rolling-five-minute direction window after adoption, matching frozen OI/price/taker thresholds. Mark-price zone observation and trade-price direction evidence are explicitly distinct inputs.
- Formal position protection adopts the first structural target and structural stop only. Its existing 1.2 space/risk threshold is gross, not the entry-plan net ratio. It disables legacy trailing/signal rules unless separately selected, and records a real opening time or explicitly starts the holding timer at adoption.
- Existing plans and local books are preserved. Reanalysis never changes an adopted plan. Persisted state and notification claims use IndexedDB transactions; actual-fill registration is recoverable and idempotent.

## Visual and performance direction

References: Apple HIG Offering Help (https://developer.apple.com/design/human-interface-guidelines/offering-help) and TradingView Long Position tool (https://www.tradingview.com/support/solutions/43000517002-long-position-drawing-tool/). Derive price/risk hierarchy and contextual help, not branding or pixel copies. Retain restrained light surfaces, existing system typography, tabular prices, compact level grids, explicit actions and expandable evidence. No decorative gradients or extra marketing cards.

Only the selected market or explicitly opened position loads historical structure. All pages share the existing mark stream and a bounded historical client. Decimal candle scans stay in Web Workers. Changes and anomalies use one shared entry panel; historical-event views cannot adopt current entry plans.

## Release constraints and acceptance

Still no permanent backend. Closing all pages, sleeping the device, unavailable sources or browser throttling can interrupt monitoring. System notifications require supported browser permission. Do not claim 24/7 delivery, commercial operational readiness, or profitable signals.

Required evidence: pure-rule and state-machine boundaries, old-book compatibility, failure-closed persistence, frozen-plan reload, actual-fill idempotency, once-only time/price reminders, desktop/mobile browser paths, full regression/build, successful Pages workflow and public asset/runtime verification. Publish exact final evidence and residual limitations with the release receipt.

## Local acceptance evidence — 2026-09-29

- Full local regression before the final notification-routing addition: 57 files / 1,582 tests passed; the final routing change plus UI regression: 3 files / 66 tests passed. Final committed revision is verified again by the deployment workflow.
- Real in-app browser, isolated localhost origin and explicitly synthetic price/history: generated long plan (entry 98.5–99, stop 97.5, target 105.5), adopted, reloaded and retained frozen prices/deadline. Simulated new direction window plus in-zone price produced one entry alert without creating a position.
- Manually recorded the test fill at 98.8, margin 100, leverage 3 and explicit time. It created exactly one draft position with no exit plan. Formal structure proposal inherited the selected 60-minute preference; explicit adoption and reload preserved the stop, target and opening-time-based absolute deadline.
- Synthetic mark 96 triggered one stop alert. Advancing the fixture clock past the deadline triggered one independent time-exit alert with interruption disclosure. Neither closed the position; only the explicit manual close action did.
- Two actual browser tabs, native IndexedDB: both saved identical actual-fill data for a second plan concurrently; both actions completed, total position count increased from one to two, with one open draft and one earlier manually closed record. No duplicate second position or automatic exit-plan adoption.
- Historical-view entry actions disabled. 390px mobile layout inspected. New-candidate TTL and filled-position status regressions repaired; fresh-tab analysis showed enabled adoption immediately and no console errors. Development harness HMR produced earlier duplicate-root errors; those were isolated to the ignored harness and did not reproduce in a clean tab.
- Native system notification permission/delivery was not exercised. Worker notification-click routing is tested against shipped source. Delivery still depends on browser support/permission; no claim of guaranteed, closed-page or 24/7 monitoring.
