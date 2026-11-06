# Data and operation

## Live prices

The server discovers online, trading-enabled Coinbase Exchange USD products at startup. It subscribes to the public `ticker` and `heartbeat` channels over one WebSocket. The catalog contained 404 products when the README screenshots were captured; the count is discovered, not hard-coded into the live service.

Ticker messages may batch matches. Their count is not a trade count and their sizes are not accumulated into volume. Per-product trade IDs reject duplicate or old updates. The UI shows the last received trade price, its exchange timestamp, and its age. Nodes brighten when a new price update arrives; their continuous drift is illustrative layout motion.

The shared producer publishes a complete snapshot once per second. Upstream subscription acknowledgement and recent messages determine feed health. The browser also checks its own transport and frame age. Ten seconds without upstream messages removes healthy status; fifteen seconds without a message forces reconnect. The socket retries with exponential backoff capped at 30 seconds. Browser streams retry after network failures and after HTTP errors that permanently close EventSource. Neither path substitutes historical data for a live outage.

Heartbeat coverage counts products with a heartbeat received within ten seconds. An active heartbeat does not mean a coin traded recently. Old trade prices retain their timestamps even while that product's feed remains healthy.

## Candle analytics

Public REST candles supply a separate analytics window. Requests are paced at no more than 2.5 per second. BTC, ETH, and other major pairs bootstrap first. Every refresh sweep uses one fixed completed-bar cutoff; that cutoff advances after the sweep finishes. Consequently, analytic measurements can lag live prices. The current cutoff and available breadth denominator are visible in the UI.

Analytics recompute every fifteen seconds on an aligned five-minute grid. Incomplete, malformed, or future candles are excluded. Missing intervals are not filled with zero and prices are not carried forward as new observations.

| Encoding | Definition |
| --- | --- |
| Node color | Sign of the simple return between completed candle closes one hour apart; neutral when unavailable |
| Return & activity: horizontal | That one-hour return, clipped to ±4%; exact values remain in the inspector |
| Return & activity: vertical | Last completed candle's close × base volume divided by the preceding 12-bar median, with at least 9 valid baseline bars; logarithmic range 0.25×–64× |
| Node area | Compressed observed one-hour turnover proxy: `5 + 5 log10(1 + turnover)` before viewport scaling; not liquidity or actual quote volume |
| Connections | Pearson correlation of five-minute log returns over 48 intervals, at least 36 paired observations, absolute correlation ≥0.65; union of each asset's three strongest qualifying links |
| Negative connections | Coral, dashed lines; sign is retained even though absolute strength drives the illustrative layout |
| Network position | Deterministic force layout with shared deformation and individual drift; position and distance are not market measurements |
| Realized variation | Median cross-coin sample standard deviation of trailing 12 five-minute log returns, at least 9 observations, in basis points; not annualized |

The link-strength control filters existing computed relationships; it does not compute a new all-pairs graph. Node/link selection changes emphasis without changing analytics. Correlation is association, not capital flow or causality.

Live Network can include a coin with a received price before its candle analytics are ready. The metric chart needs both measured coordinates. Missing observations remain accessible through Universe and the coin selector. Historical detector alerts are not enabled on live data.

## Historical replay

`data/replay/coinbase-usd.json.gz` contains one public Coinbase recording from 2026-11-04 04:40 to 2026-11-05 04:40 UTC, end exclusive for candle starts. Display times are completed-bar ends. It contains 404 requested USD pairs and 288 intervals. Of these pairs, 68 passed a retrospective ≥95% full-window candle-coverage screen.

The default replay cursor is a recorded alert event at 14:45 UTC on November 4. Amber rings are stored exploratory BOCPD threshold crossings from the original experiment. They are not recomputed live and do not establish significance or trading profitability. The recording's universe screen and complete timeline are retrospective context, not a point-in-time backtest universe.

The compact bundle retains the original candle response bodies, source request URLs, SHA-256 body hashes, protocol metadata, and only the stored alert/coverage inputs used by this tool. The loader verifies each candle response hash. The cleanup preserves the original recording identifier and every encoded replay frame byte-for-byte. Earlier research programs and reports are not runtime dependencies.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/live/manifest` | Live catalog and definitions |
| `GET /api/live/events` | Shared latest live snapshot as SSE; reconnect starts at latest |
| `GET /api/live/asset/{pair}` | Closed-candle history with missing points and measured relationships |
| `GET /api/live/health` | Upstream status, heartbeat coverage, history readiness, and message counters |
| `GET /api/manifest` | Replay identity, catalog, timeline, and definitions |
| `GET /api/events?index=120&playing=0&speed=1` | Independent replay stream; speeds 0.5, 1, 2, or 4 |
| `GET /api/asset/{pair}?index=120` | Replay history, alerts, relationships, and source hash |
| `GET /api/health` | Replay kernel timing, payload sizes, and active replay readers |

SSE snapshots have `recording:index` IDs. Replay honors `Last-Event-ID` within the same recording. Writes have a five-second deadline; there is no per-client frame queue. Server shutdown cancels upstream and history tasks.

The renderer suspends when hidden or offscreen. Frozen/reduced Network and settled metric views sleep between updates. Live prices continue arriving while layout motion is frozen. The frontend uses one imperative Three.js renderer; force-layout calculation runs in a worker and animation avoids per-frame React updates.

## Upstream references

- [Coinbase WebSocket channels](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)
- [Coinbase WebSocket rate limits](https://docs.cdp.coinbase.com/exchange/websocket-feed/rate-limits)
- [Coinbase product candles](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles)
