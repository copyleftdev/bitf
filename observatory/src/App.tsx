import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crosshair,
  ExternalLink,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Scan,
  Layers,
  Pause,
  Play,
  Radio,
  Search,
  SlidersHorizontal,
  StepBack,
  X,
} from "lucide-react";
import { MarketField, type FieldMode } from "./Field";
import { DEFAULT_VIEW } from "./fieldViewport";
import { useFieldFullscreen } from "./useFieldFullscreen";
import type { Asset, Coin, Frame, Manifest, Node } from "./types";

const clock = (t: number) =>
  new Date(t * 1000).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
const signed = (v: number | null, d = 2) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;
const money = (v: number | null) =>
  v === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: v < 1 ? 6 : 2,
      }).format(v);
const compact = (v: number | null) =>
  v === null
    ? "—"
    : "$" +
      new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(v);
const channel = (value: string) =>
  ({
    return_bps: "Price change",
    log_range: "Range expansion",
    log_volume_proxy: "Activity change",
  })[value] || value;

function PriceChart({ asset }: { asset: Asset }) {
  const values = asset.series.filter((s) => s.price !== null);
  if (values.length < 2)
    return (
      <div className="chart-empty">Not enough observed prices for a chart.</div>
    );
  const prices = values.map((s) => s.price!);
  const low = Math.min(...prices),
    high = Math.max(...prices),
    span = high - low || high * 0.001;
  let path = "";
  let open = false;
  asset.series.forEach((s, i) => {
    if (s.price === null) {
      open = false;
      return;
    }
    const x = 8 + (i / (asset.series.length - 1)) * 272,
      y = 18 + ((high - s.price) / span) * 86;
    path += `${open ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    open = true;
  });
  return (
    <div className="price-chart">
      <svg
        viewBox="0 0 288 135"
        role="img"
        aria-label={`Observed closes over the last four hours. Low ${money(low)}, high ${money(high)}.`}
      >
        <path className="chart-guide" d="M8 18H280M8 61H280M8 104H280" />
        <path className="price-path" d={path} />
        <text x="8" y="130">
          {clock(asset.series[0].t)}
        </text>
        <text x="280" y="130" textAnchor="end">
          {clock(asset.series.at(-1)!.t)} UTC
        </text>
      </svg>
      <div className="chart-range">
        <span>Low {money(low)}</span>
        <span>High {money(high)}</span>
      </div>
    </div>
  );
}

function FieldView({
  manifest,
  frame,
  selected,
  onSelect,
  all,
  focused,
  reduced,
  onStats,
  expanded,
}: {
  manifest: Manifest;
  frame: Frame;
  selected: string;
  onSelect: (id: string) => void;
  all: boolean;
  focused: boolean;
  reduced: boolean;
  expanded: boolean;
  onStats: (s: {
    fps: number;
    calls: number;
    nodes: number;
    idle?: boolean;
  }) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    field = useRef<MarketField | null>(null);
  const [failed, setFailed] = useState(false),
    [view, setView] = useState({ ...DEFAULT_VIEW }),
    [minR, setMinR] = useState(0.65),
    [mode, setMode] = useState<FieldMode>("network"),
    [frozen, setFrozen] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let instance: MarketField;
    try {
      instance = new MarketField(host.current, manifest.catalog, onSelect, () =>
        setFailed(true),
      );
      instance.onStats = onStats;
      instance.onView = setView;
      field.current = instance;
    } catch {
      setFailed(true);
      return;
    }
    return () => {
      instance.dispose();
      field.current = null;
    };
  }, [manifest, onSelect, onStats]);
  useEffect(() => {
    field.current?.update(
      frame,
      selected,
      all,
      focused,
      reduced,
      minR,
      mode,
      frozen,
    );
  }, [frame, selected, all, focused, reduced, minR, mode, frozen, manifest]);
  const visible = frame.nodes.filter(
    (n) =>
      all ||
      manifest.catalog.find((c) => c.id === n.id)?.qualified ||
      n.id === selected,
  );
  const positioned = (n: Node) =>
    mode === "network" && frame.live
      ? n.price !== null
      : n.x !== null && n.y !== null;
  const missing = visible.filter((n) => !positioned(n)).length;
  const node = frame.nodes.find((n) => n.id === selected)!;
  const connections = frame.edges.filter(
    (e) => (e.a === selected || e.b === selected) && Math.abs(e.r) >= minR,
  ).length;
  const offscreen =
    node.x !== null &&
    node.y !== null &&
    (Math.abs(node.x - view.x) > 1 / view.zoom ||
      Math.abs(node.y - view.y) > 1 / view.zoom);
  return (
    <div className={`field-stage field-mode-${mode}`}>
      <div className="field-layout-controls">
        <div className="layout-switch" role="group" aria-label="Field layout">
          <button
            aria-pressed={mode === "network"}
            onClick={() => setMode("network")}
          >
            Network
          </button>
          <button
            aria-pressed={mode === "metrics"}
            onClick={() => setMode("metrics")}
          >
            Return & activity
          </button>
        </div>
        {mode === "network" && (
          <button
            className="layout-motion"
            aria-label="Freeze network motion"
            aria-pressed={frozen || reduced}
            disabled={reduced}
            onClick={() => setFrozen(!frozen)}
          >
            {frozen || reduced ? "Layout still" : "Layout in motion"}
          </button>
        )}
      </div>
      <div className="field-readout">
        <div className="selected-observation">
          <span className="selected-beacon" />
          <strong>
            {selected.replace("-USD", "")}
            <span> / USD</span>
          </strong>
          <span className={(node.return1h ?? 0) >= 0 ? "up" : "down"}>
            {signed(node.return1h)}
            <small> 1h</small>
          </span>
          <span className="connection-count">
            {connections} {connections === 1 ? "link" : "links"}
          </span>
          {expanded && (
            <select
              aria-label="Expanded coin selector"
              value={selected}
              onChange={(e) => onSelect(e.target.value)}
            >
              {manifest.catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
          )}
        </div>
        <label className="link-filter">
          Link strength
          <select
            aria-label="Minimum field correlation"
            value={minR}
            onChange={(e) => setMinR(Number(e.target.value))}
          >
            {[0.65, 0.75, 0.85, 0.95].map((r) => (
              <option key={r} value={r}>
                |r| ≥ {r.toFixed(2)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="plot-wrap">
        <div className="field-canvas" ref={host} />
        {!failed && (
          <>
            {mode === "metrics" ? (
              <>
                <div className="y-caption">RELATIVE ACTIVITY</div>
                <div className="x-caption">
                  TRAILING 1H RETURN <span>· bounds ±4%</span>
                </div>
              </>
            ) : (
              <div className="network-caption">
                Correlation shapes the network.
                <span>
                  {frame.live
                    ? "Layout is illustrative · glow responds to received prices."
                    : "Layout motion is illustrative · prices follow replay."}
                </span>
              </div>
            )}
            {missing > 0 && (
              <div className="missing-rail">
                <i />
                {missing}{" "}
                {mode === "network" && frame.live
                  ? "awaiting prices"
                  : "without complete coordinates"}{" "}
                · available in Universe
              </div>
            )}
            {(mode === "metrics" ? offscreen : view.zoom > 1) && (
              <button
                className="return-selection"
                onClick={() => field.current?.focusCoin()}
              >
                <Crosshair size={13} />
                Locate {selected.replace("-USD", "")}
              </button>
            )}
            {!positioned(node) ? (
              <div className="coordinate-note">
                {selected.replace("-USD", "")}{" "}
                {frame.live && mode === "network"
                  ? "is waiting for its first price."
                  : "has no complete coordinates at this timestamp."}
              </div>
            ) : null}
            <div
              className="camera-controls"
              role="group"
              aria-label="Field camera"
            >
              <button
                aria-label="Zoom out"
                title="Zoom out (−)"
                disabled={view.zoom <= 1.001}
                onClick={() => field.current?.zoom(1 / 1.35)}
              >
                <ZoomOut size={16} />
              </button>
              <output aria-label="Field zoom">
                {Math.round(view.zoom * 100)}%
              </output>
              <button
                aria-label="Zoom in"
                title="Zoom in (+)"
                disabled={view.zoom >= 5.999}
                onClick={() => field.current?.zoom(1.35)}
              >
                <ZoomIn size={16} />
              </button>
              <span className="camera-divider" />
              <button
                aria-label="Zoom to selected coin"
                title="Focus selected coin (F)"
                disabled={!positioned(node)}
                onClick={() => field.current?.focusCoin()}
              >
                <Scan size={16} />
              </button>
              <button
                aria-label="Reset field view"
                title="Reset view (0)"
                onClick={() => field.current?.reset()}
              >
                <RotateCcw size={15} />
              </button>
            </div>
            <div className="field-gesture-hint">
              Drag to pan · Scroll or pinch to zoom
            </div>
          </>
        )}
        {failed && (
          <div className="webgl-fallback">
            <Activity size={28} />
            <h2>Field rendering is unavailable</h2>
            <p>
              Your browser could not start WebGL. Every observation is still
              available in the universe table and coin inspector.
            </p>
            <div className="fallback-coins">
              {visible.slice(0, 12).map((n) => (
                <button key={n.id} onClick={() => onSelect(n.id)}>
                  {n.id.replace("-USD", "")} <span>{signed(n.return1h)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [liveMode, setLiveMode] = useState(
    () => new URLSearchParams(location.search).get("mode") !== "replay",
  );
  const changeMode = (live: boolean) => {
    const url = new URL(location.href);
    url.searchParams.set("mode", live ? "live" : "replay");
    history.replaceState(null, "", url);
    setLiveMode(live);
  };
  return (
    <Observatory
      key={String(liveMode)}
      liveMode={liveMode}
      onMode={changeMode}
    />
  );
}

function Observatory({
  liveMode,
  onMode,
}: {
  liveMode: boolean;
  onMode: (live: boolean) => void;
}) {
  const api = liveMode ? "/api/live" : "/api";
  const [manifest, setManifest] = useState<Manifest | null>(null),
    [frame, setFrame] = useState<Frame | null>(null),
    [asset, setAsset] = useState<Asset | null>(null);
  const [selected, setSelected] = useState("BTC-USD"),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [cursor, setCursor] = useState<number | null>(null);
  const [status, setStatus] = useState("Connecting"),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    [streamRetry, setStreamRetry] = useState(0),
    [assetError, setAssetError] = useState(false);
  const [tab, setTab] = useState<"field" | "universe">("field"),
    [query, setQuery] = useState(""),
    [coverage, setCoverage] = useState("all"),
    [method, setMethod] = useState(false);
  const {
    shellRef,
    buttonRef: expandButton,
    expanded,
    pending: fullscreenPending,
    notice: fullscreenNotice,
    expand,
    collapse,
  } = useFieldFullscreen();
  const [all, setAll] = useState(false),
    [focused, setFocused] = useState(false),
    [reduced, setReduced] = useState(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  const [stats, setStats] = useState<{
      fps: number;
      calls: number;
      nodes: number;
      idle?: boolean;
    }>({ fps: 0, calls: 0, nodes: 0 }),
    [received, setReceived] = useState(Date.now()),
    [now, setNow] = useState(Date.now());
  const frameRef = useRef<Frame | null>(null),
    seq = useRef(0),
    seekRef = useRef<HTMLInputElement>(null),
    helpButton = useRef<HTMLButtonElement>(null);
  const [systemReduced, setSystemReduced] = useState(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const effectiveReduced = reduced || systemReduced;
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setSystemReduced(preference.matches);
    preference.addEventListener("change", changed);
    return () => preference.removeEventListener("change", changed);
  }, []);
  const select = useCallback((id: string) => {
    setSelected(id);
  }, []);
  const updateStats = useCallback(
    (s: { fps: number; calls: number; nodes: number; idle?: boolean }) =>
      setStats(s),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch(`${api}/manifest`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error("Cannot reach the market kernel.");
        return r.json();
      })
      .then((m: Manifest) => {
        setManifest(m);
        setCursor(m.defaultIndex);
        if (!m.catalog.some((c) => c.id === "BTC-USD"))
          setSelected(m.catalog[0].id);
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          setError(
            liveMode
              ? "The live feed could not load. Check the market server, then reconnect."
              : "The recording could not load. Check the local market server, then reconnect.",
          );
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!manifest || cursor === null) return;
    const generation = ++seq.current;
    setStatus("Connecting");
    const source = new EventSource(
      `${api}/events?index=${cursor}&playing=${Number(playing)}&speed=${speed}`,
    );
    source.onopen = () => {
      setStatus("Connected");
      setReceived(Date.now());
    };
    source.addEventListener("frame", (event) => {
      if (seq.current !== generation) return;
      const next: Frame = JSON.parse((event as MessageEvent).data);
      frameRef.current = next;
      setFrame(next);
      setStatus("Connected");
      setReceived(Date.now());
    });
    source.addEventListener("heartbeat", () => {
      setReceived(Date.now());
      setStatus("Connected");
    });
    source.addEventListener("state", (event) => {
      if (!JSON.parse((event as MessageEvent).data).playing && playing) {
        setCursor(frameRef.current?.index ?? cursor);
        setPlaying(false);
      }
    });
    let reconnectTimer: number | undefined;
    source.onerror = () => {
      setStatus("Reconnecting");
      // HTTP errors can permanently close EventSource instead of auto-retrying.
      if (source.readyState === EventSource.CLOSED) {
        reconnectTimer = window.setTimeout(() => {
          if (!liveMode) setCursor(frameRef.current?.index ?? cursor);
          setStreamRetry((v) => v + 1);
        }, 3000);
      }
    };
    return () => {
      clearTimeout(reconnectTimer);
      source.close();
    };
  }, [manifest, cursor, playing, speed, retry, streamRetry]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!frame) return;
    const controller = new AbortController();
    setAssetError(false);
    fetch(`${api}/asset/${encodeURIComponent(selected)}?index=${frame.index}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setAsset)
      .catch((e) => {
        if (e.name !== "AbortError") setAssetError(true);
      });
    return () => controller.abort();
  }, [selected, liveMode ? Math.floor((frame?.t ?? 0) / 10) : frame?.index]);
  const seek = useCallback((index: number) => {
    setPlaying(false);
    setCursor(index);
  }, []);
  const toggle = useCallback(() => {
    if (!manifest || liveMode) return;
    setCursor(
      frameRef.current?.index === manifest.count - 1
        ? 0
        : (frameRef.current?.index ?? manifest.defaultIndex),
    );
    setPlaying((p) => !p);
  }, [manifest]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && expanded) {
        void collapse();
        return;
      }
      const target = e.target as HTMLElement;
      if (
        ["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"].includes(target.tagName)
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape") {
        setMethod(false);
        helpButton.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggle, expanded, collapse]);
  useEffect(() => {
    if (!expanded) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, [expanded]);
  const node = frame?.nodes.find((n) => n.id === selected),
    meta = manifest?.catalog.find((c) => c.id === selected);
  const rows = useMemo(() => {
    if (!manifest || !frame) return [];
    const byId = new Map(frame.nodes.map((n) => [n.id, n]));
    return manifest.catalog
      .filter(
        (c) =>
          c.id.toLowerCase().includes(query.toLowerCase()) &&
          (coverage === "all" ||
            (coverage === "qualified" ? c.qualified : !c.qualified)),
      )
      .map((c) => ({ coin: c, node: byId.get(c.id)! }))
      .sort((a, b) => (b.node.turnover1h || 0) - (a.node.turnover1h || 0));
  }, [manifest, frame, query, coverage]);
  const currentAsset =
    asset?.id === selected && (liveMode || asset.index === frame?.index)
      ? asset
      : null;
  const timeLabel = frame ? `${day(frame.t)} · ${clock(frame.t)} UTC` : "";
  if (!manifest || !frame)
    return (
      <main className="loading-screen">
        <div className="wordmark">
          BITF<span>/</span>
        </div>
        <h1>{error ? "Market data unavailable" : "Opening the observatory"}</h1>
        <p role="status">
          {error ||
            (status === "Reconnecting"
              ? "The market stream is unavailable. Reconnecting automatically…"
              : "Connecting to the shared market kernel…")}
        </p>
        {(error || status === "Reconnecting") && (
          <button onClick={() => setRetry((x) => x + 1)}>Reconnect</button>
        )}
        <p className="small">
          Historical Coinbase market observations · Experiment 006
        </p>
      </main>
    );
  const feed = frame.live;
  const liveHealthy =
    liveMode &&
    feed?.status === "live" &&
    status === "Connected" &&
    now - received < 5000 &&
    now / 1000 - frame.t < 5;
  const market = frame.market;
  return (
    <div
      ref={shellRef}
      className={`app-shell${expanded ? " field-expanded" : ""}`}
    >
      <a className="skip-link" href="#main">
        Skip to market observations
      </a>
      <header className="masthead">
        <div className="identity">
          <div className="wordmark">
            BITF<span>/</span>
          </div>
          <span className="product-name">
            Market
            <br />
            Observatory
          </span>
        </div>
        <nav aria-label="Views">
          <button
            className={tab === "field" ? "active" : ""}
            onClick={() => setTab("field")}
          >
            <Radio size={15} />
            Field
          </button>
          <button
            className={tab === "universe" ? "active" : ""}
            onClick={() => setTab("universe")}
          >
            Universe <span>{manifest.catalog.length}</span>
          </button>
        </nav>
        <div className="header-right">
          <div
            className="source-switch"
            role="group"
            aria-label="Market data source"
          >
            <button aria-pressed={liveMode} onClick={() => onMode(true)}>
              Live
            </button>
            <button aria-pressed={!liveMode} onClick={() => onMode(false)}>
              Replay
            </button>
          </div>
          <span
            className={`recording-badge${liveHealthy ? " live-badge" : ""}`}
          >
            <span />
            {liveMode ? (liveHealthy ? "LIVE" : "CONNECTING") : "REPLAY"}
          </span>
          <button
            className="icon-button"
            ref={helpButton}
            aria-label="Explain the observations"
            aria-expanded={method}
            onClick={() => setMethod((v) => !v)}
          >
            <CircleHelp size={18} />
          </button>
        </div>
      </header>
      <section className="telemetry" aria-label="Market telemetry">
        <div>
          <span className="metric-label">
            {liveMode
              ? `1h breadth · ${market.returnCount} pairs`
              : "1h market breadth"}
          </span>
          <strong>
            {market.breadth === null
              ? "—"
              : `${Math.round(market.breadth * 100)}%`}{" "}
            <span className="up">advancing</span>
          </strong>
          <div className="breadth-line">
            <i style={{ width: `${(market.breadth || 0) * 100}%` }} />
          </div>
        </div>
        <div>
          <span className="metric-label">Median 1h return</span>
          <strong className={(market.medianReturn || 0) >= 0 ? "up" : "down"}>
            {signed(market.medianReturn)}
          </strong>
          <small>
            {market.advancers} up / {market.decliners} down
          </small>
        </div>
        <div>
          <span className="metric-label">Realized variation</span>
          <strong>
            {market.volatilityBps ?? "—"} <em>bps</em>
          </strong>
          <small>Median 5m σ · trailing 1h</small>
        </div>
        <div className="alert-metric">
          <span className="metric-label">
            {liveMode ? "Price updates / second" : "Change alerts · this bar"}
          </span>
          <strong>
            {liveMode ? (feed?.updatesPerSecond ?? 0) : market.alertCoins}
            <em>
              {liveMode ? " received" : ` / ${market.monitored} monitored`}
            </em>
          </strong>
          <small>
            {liveMode
              ? "Ticker messages · may batch trades"
              : "Exploratory detector crossings"}
          </small>
        </div>
        <div>
          <span className="metric-label">
            {liveMode ? "Feed heartbeats" : "Research coverage"}
          </span>
          <strong>
            {liveMode
              ? (feed?.heartbeatPairs ?? 0)
              : manifest.catalog.filter((c) => c.qualified).length}
            <em> / {manifest.catalog.length} pairs</em>
          </strong>
          <small>
            {liveMode
              ? "Received within 10 seconds"
              : "≥95% recorded-bar coverage"}
          </small>
        </div>
      </section>
      {(status === "Reconnecting" || (liveMode && !liveHealthy)) && (
        <div role="status" className="connection-warning">
          {liveMode
            ? "Waiting for a healthy live feed. Last received prices remain visible with their timestamps; reconnecting automatically."
            : "Connection interrupted. Displaying the last received observation; reconnecting automatically."}
        </div>
      )}
      <main id="main" className="workspace">
        <section className="market-pane" aria-label="Market observations">
          <div className="pane-header">
            <div>
              <h1>
                {tab === "field"
                  ? "The market, in motion."
                  : "The observed universe."}
              </h1>
              <p>
                {tab === "field"
                  ? "Price direction. Relative activity. Measured co-movement."
                  : "Every scanned Coinbase USD pair. Missing data stays visible."}
              </p>
            </div>
            <span className="venue">COINBASE / USD</span>
          </div>
          {tab === "field" ? (
            <>
              <div className="field-toolbar">
                <div className="legend">
                  <span>
                    <i className="dot mint" />
                    Positive 1h
                  </span>
                  <span>
                    <i className="dot coral" />
                    Negative 1h
                  </span>
                  <span>
                    <i className={liveMode ? "live-glow" : "ring"} />
                    {liveMode ? "Glow on price update" : "Change alert"}
                  </span>
                </div>
                <div className="field-actions">
                  <button
                    aria-pressed={focused}
                    className={focused ? "selected-tool" : ""}
                    onClick={() => setFocused((f) => !f)}
                    aria-label="Focus selected connections"
                    title="Show only selected coin connections"
                  >
                    <Crosshair size={14} />
                    <span>Focus links</span>
                  </button>
                  <button
                    aria-pressed={all}
                    className={
                      liveMode ? "live-pair-count" : all ? "selected-tool" : ""
                    }
                    aria-label="Toggle all pairs in field"
                    onClick={() => setAll((v) => !v)}
                    disabled={liveMode}
                  >
                    <Layers size={14} />
                    <span>
                      {liveMode
                        ? `${manifest.catalog.length} live pairs`
                        : all
                          ? `All ${manifest.catalog.length}`
                          : `${manifest.catalog.filter((c) => c.qualified).length} qualified`}
                    </span>
                  </button>
                  <button
                    ref={expandButton}
                    aria-label={
                      expanded ? "Collapse market field" : "Expand market field"
                    }
                    aria-pressed={expanded}
                    disabled={fullscreenPending}
                    title={
                      expanded ? "Exit fullscreen (Escape)" : "Enter fullscreen"
                    }
                    onClick={() => {
                      setMethod(false);
                      if (expanded) void collapse();
                      else void expand();
                    }}
                  >
                    {expanded ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )}
                    <span>{expanded ? "Collapse" : "Expand"}</span>
                  </button>
                </div>
              </div>
              {fullscreenNotice && (
                <p className="fullscreen-notice" role="status">
                  {fullscreenNotice}
                </p>
              )}
              <FieldView
                manifest={manifest}
                frame={frame}
                selected={selected}
                onSelect={select}
                all={all}
                focused={focused}
                reduced={effectiveReduced}
                onStats={updateStats}
                expanded={expanded}
              />
              <div className="field-footnote">
                <span>Node area: compressed 1h turnover proxy</span>
                <span>
                  Curves: 4h correlation · brighter = selected · dashed =
                  negative
                </span>
              </div>
            </>
          ) : (
            <div className="universe-view">
              <div className="search-row">
                <label>
                  <Search size={16} />
                  <input
                    aria-label="Search all coins"
                    placeholder="Find a coin…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <select
                  aria-label="Coverage filter"
                  value={coverage}
                  onChange={(e) => setCoverage(e.target.value)}
                >
                  <option value="all">All pairs</option>
                  <option value="qualified">
                    {liveMode ? "Subscribed pairs" : "Qualified only"}
                  </option>
                  {!liveMode && <option value="sparse">Sparse coverage</option>}
                </select>
                <span>{rows.length} pairs</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>{liveMode ? "Last trade" : "Last close"}</th>
                      <th>1h return</th>
                      <th>1h turnover*</th>
                      <th>{liveMode ? "Trade age" : "Coverage"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ coin: c, node: n }) => (
                      <tr
                        key={c.id}
                        className={selected === c.id ? "selected-row" : ""}
                      >
                        <td>
                          <button onClick={() => select(c.id)}>
                            {c.symbol}
                            <small> / USD</small>
                          </button>
                        </td>
                        <td>
                          {money(n.price)}
                          {n.price === null && n.lastPrice !== null && (
                            <small>
                              Last {Math.round((n.age || 0) / 60)}m ago
                            </small>
                          )}
                        </td>
                        <td className={(n.return1h || 0) >= 0 ? "up" : "down"}>
                          {signed(n.return1h)}
                        </td>
                        <td>
                          {compact(n.turnover1h)}
                          <small>{n.volumeBars}/12 bars</small>
                        </td>
                        <td>
                          <span
                            className={c.qualified ? "qualified" : "sparse"}
                          >
                            {liveMode
                              ? n.age === null
                                ? "Waiting"
                                : `${Math.max(0, Math.floor(now / 1000 - (n.priceTime ?? now / 1000)))}s`
                              : `${(c.coverage * 100).toFixed(0)}%`}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && (
                  <div className="empty-state">
                    No pairs match “{query}”. Try a symbol such as BTC or clear
                    the coverage filter.
                  </div>
                )}
              </div>
              <p className="table-note">
                *Observed close × base volume; incomplete hours are labeled.
                {liveMode
                  ? "Returns and activity use completed 5m bars. Trade age is shown separately."
                  : "Coverage is measured across the full recording."}
              </p>
            </div>
          )}
        </section>
        <aside className="inspector" aria-label="Selected coin inspector">
          <div className="inspector-top">
            <label htmlFor="asset-picker">Coin</label>
            <select
              id="asset-picker"
              aria-label="Select coin"
              value={selected}
              onChange={(e) => select(e.target.value)}
            >
              {manifest.catalog.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                  {c.qualified ? "" : " · sparse"}
                </option>
              ))}
            </select>
          </div>
          <div className="asset-heading">
            <div className="asset-monogram">{meta!.symbol.slice(0, 1)}</div>
            <div>
              <h2>
                {meta!.symbol}
                <span> / USD</span>
              </h2>
              <p>
                {liveMode
                  ? "Live last-trade price"
                  : meta!.qualified
                    ? "Research-qualified"
                    : "Insufficient coverage"}
                {meta!.limitOnly ? " · Limit only" : ""}
              </p>
            </div>
          </div>
          <div className="price-block">
            <strong>{money(node!.price)}</strong>
            <span className={(node!.return1h || 0) >= 0 ? "up" : "down"}>
              {(node!.return1h || 0) >= 0 ? (
                <ArrowUpRight size={16} />
              ) : (
                <ArrowDownRight size={16} />
              )}{" "}
              {signed(node!.return1h)}{" "}
              <small>{liveMode ? "1h bars" : "1h"}</small>
            </span>
          </div>
          {liveMode && (
            <p className="stale-note live-price-time">
              {node!.priceTime
                ? `Last trade ${new Date(node!.priceTime * 1000).toISOString().slice(11, 19)} UTC · ${Math.max(0, Math.floor(now / 1000 - node!.priceTime))}s ago`
                : "Waiting for the first exchange price."}
            </p>
          )}
          {!liveMode && node!.price === null && (
            <p className="stale-note">
              No close for this bar.
              {node!.age !== null
                ? ` Last observation ${node!.age / 60} minutes ago.`
                : ""}
            </p>
          )}
          <div className="section-label">
            Observed closes <span>4H / 5M BARS</span>
          </div>
          {currentAsset ? (
            <PriceChart asset={currentAsset} />
          ) : (
            <div className="chart-empty" role="status">
              {assetError
                ? "Price history unavailable. Try another coin or timestamp."
                : "Loading observed prices…"}
            </div>
          )}
          <dl className="asset-stats">
            <div>
              <dt>Relative activity</dt>
              <dd>
                {node!.activity === null
                  ? "—"
                  : `${node!.activity.toFixed(2)}×`}
              </dd>
            </div>
            <div>
              <dt>1h turnover proxy</dt>
              <dd>
                {compact(node!.turnover1h)} <small>{node!.volumeBars}/12</small>
              </dd>
            </div>
            <div>
              <dt>
                {liveMode ? "Analytics through" : "Full-recording coverage"}
              </dt>
              <dd>
                {liveMode
                  ? feed?.analyticsAt
                    ? `${clock(feed.analyticsAt)} UTC`
                    : "Warming up"
                  : `${(meta!.coverage * 100).toFixed(1)}%`}
              </dd>
            </div>
          </dl>
          <div className="section-label">
            Strong connections <span>4H PEARSON r</span>
          </div>
          <div className="connections">
            {currentAsset && currentAsset.edges.length ? (
              currentAsset.edges.slice(0, 4).map((e) => {
                const other = e.a === selected ? e.b : e.a;
                return (
                  <button key={other} onClick={() => select(other)}>
                    <span>{other.replace("-USD", "")}</span>
                    <span className="correlation-track">
                      <i style={{ width: `${Math.abs(e.r) * 100}%` }} />
                    </span>
                    <span>
                      {e.r > 0 ? "+" : ""}
                      {e.r.toFixed(2)}
                    </span>
                    <ChevronRight size={13} />
                  </button>
                );
              })
            ) : (
              <p className="small muted">
                No qualifying connections at this cursor. Requires 36 paired
                bars and |r| ≥ 0.65.
              </p>
            )}
          </div>
          <div className="section-label">
            Recent changes <span>DETECTED AT</span>
          </div>
          <div className="event-list">
            {currentAsset?.alerts.length ? (
              currentAsset.alerts
                .slice(-3)
                .reverse()
                .map((a, i) => (
                  <div key={`${a.detected_at}-${i}`}>
                    <i />
                    <div>
                      {channel(a.channel)}
                      <small>
                        Recent-change mass {a.recent_change_mass.toFixed(2)}
                      </small>
                    </div>
                    <time>{clock(a.detected_at)}</time>
                  </div>
                ))
            ) : (
              <p className="small muted">
                {liveMode
                  ? "Historical detector alerts are available in Replay. No live detector is enabled."
                  : "No recorded detector crossings yet."}
              </p>
            )}
          </div>
          <p className="inspector-note">
            Co-movement is association, not capital flow.
            <br />
            Changes are observations, not trading signals.
          </p>
        </aside>
      </main>
      {liveMode ? (
        <section className="live-transport" aria-label="Live feed status">
          <div>
            <span
              className={`live-indicator${liveHealthy ? " healthy" : ""}`}
            />
            <strong>{liveHealthy ? "Live market" : "Feed reconnecting"}</strong>
            <time>
              {new Date(frame.t * 1000).toISOString().slice(11, 19)} UTC
            </time>
          </div>
          <p>
            Prices stream continuously · {feed?.historyPairs ?? 0}/
            {manifest.catalog.length} histories loaded
            <br />
            <span>
              Returns, activity and links use completed 5m candles
              {feed?.analyticsAt
                ? ` through ${clock(feed.analyticsAt)} UTC`
                : ""}
              . Layout motion is illustrative.
            </span>
          </p>
          <button
            className="motion-button"
            aria-label="Reduce field motion"
            aria-pressed={effectiveReduced}
            disabled={systemReduced}
            onClick={() => setReduced((v) => !v)}
          >
            {effectiveReduced ? "Motion: reduced" : "Motion: full"}
          </button>
        </section>
      ) : (
        <section className="transport" aria-label="Historical replay controls">
          <div className="transport-top">
            <div className="playback-buttons">
              <button
                className="play-button"
                onClick={toggle}
                aria-label={playing ? "Pause replay" : "Play replay"}
              >
                {playing ? (
                  <Pause size={18} fill="currentColor" />
                ) : (
                  <Play size={18} fill="currentColor" />
                )}
              </button>
              <button
                className="icon-button"
                aria-label="Previous observation"
                disabled={frame.index === 0}
                onClick={() => seek(Math.max(0, frame.index - 1))}
              >
                <ChevronLeft size={19} />
              </button>
              <button
                className="icon-button"
                aria-label="Next observation"
                disabled={frame.index === manifest.count - 1}
                onClick={() =>
                  seek(Math.min(manifest.count - 1, frame.index + 1))
                }
              >
                <ChevronRight size={19} />
              </button>
              <div className="cursor-time">
                <strong>
                  {clock(frame.t)}
                  <span> UTC</span>
                </strong>
                <small>
                  {day(frame.t)} · {playing ? "Playing" : "Paused"}
                </small>
              </div>
            </div>
            <div className="transport-context">
              <span className="recorded-dot" />
              Recorded observations <span>5-minute bars</span>
            </div>
            <div className="transport-options">
              <button
                className="event-jump"
                onClick={() => seek(manifest.defaultIndex)}
              >
                <Activity size={14} />
                Peak alert event
              </button>
              <select
                aria-label="Replay speed"
                value={speed}
                onChange={(e) => {
                  setCursor(frame.index);
                  setSpeed(Number(e.target.value));
                }}
              >
                {[0.5, 1, 2, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}× speed
                  </option>
                ))}
              </select>
              <button
                className={`motion-button ${effectiveReduced ? "selected-tool" : ""}`}
                aria-pressed={effectiveReduced}
                aria-label="Reduce field motion"
                disabled={systemReduced}
                title={
                  systemReduced
                    ? "Your system requests reduced motion"
                    : "Reduce field motion"
                }
                onClick={() => setReduced((v) => !v)}
              >
                {effectiveReduced ? (
                  <Pause size={13} />
                ) : (
                  <Activity size={13} />
                )}
                <span>Motion: {effectiveReduced ? "reduced" : "full"}</span>
              </button>
            </div>
          </div>
          <div className="timeline-wrap">
            <div className="timeline-label">
              CHANGE
              <br />
              ALERTS
            </div>
            <div className="timeline">
              <svg
                viewBox={`0 0 ${manifest.count * 4} 48`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {manifest.timeline.map((p, i) => (
                  <rect
                    key={i}
                    x={i * 4}
                    y={
                      46 -
                      Math.max(
                        1,
                        (p.alerts /
                          Math.max(
                            1,
                            ...manifest.timeline.map((t) => t.alerts),
                          )) *
                          40,
                      )
                    }
                    width="2"
                    height={Math.max(
                      1,
                      (p.alerts /
                        Math.max(
                          1,
                          ...manifest.timeline.map((t) => t.alerts),
                        )) *
                        40,
                    )}
                    className={i <= frame.index ? "elapsed-bar" : "future-bar"}
                  />
                ))}
              </svg>
              <div
                className="timeline-cursor"
                style={{
                  left: `${(frame.index / (manifest.count - 1)) * 100}%`,
                }}
              />
              <input
                ref={seekRef}
                type="range"
                aria-label="Replay timestamp"
                aria-valuetext={timeLabel}
                min="0"
                max={manifest.count - 1}
                step="1"
                value={frame.index}
                onChange={(e) => seek(Number(e.target.value))}
              />
              <div className="timeline-ticks">
                <span>
                  {clock(manifest.start + manifest.step)} /{" "}
                  {day(manifest.start).slice(0, 6)}
                </span>
                {[0.25, 0.5, 0.75].map((f) => (
                  <span key={f}>
                    {clock(
                      manifest.start +
                        manifest.step +
                        (manifest.count - 1) * manifest.step * f,
                    )}
                  </span>
                ))}
                <span>
                  {clock(manifest.end)} / {day(manifest.end).slice(0, 6)}
                </span>
              </div>
            </div>
          </div>
        </section>
      )}
      <footer className="status-bar">
        <span className="connection-state">
          <i className={status === "Connected" ? "online" : ""} />
          {status === "Connected" ? "Kernel connected" : status}
          <span className="status-detail">
            · {Math.max(0, Math.floor((now - received) / 1000))}s since
            transport message
          </span>
        </span>
        <span>
          {liveMode ? "Coinbase WebSocket" : "Experiment 006"}{" "}
          <span className="status-detail">
            {liveMode
              ? `/ ${manifest.catalog.length} USD pairs · ${feed?.messages ?? 0} messages`
              : `/ ${manifest.catalog.length} Coinbase pairs · historical, not live`}
          </span>
        </span>
        <span className="render-stats">
          {stats.idle
            ? `Field idle · ${stats.calls} draws`
            : stats.fps
              ? `${stats.fps} fps · ${stats.calls} draws`
              : "Initializing field"}
        </span>
      </footer>
      {method && (
        <section
          className="method-panel"
          aria-label="How to read the observatory"
        >
          <button
            className="icon-button close-method"
            aria-label="Close explanation"
            onClick={() => {
              setMethod(false);
              helpButton.current?.focus();
            }}
          >
            <X size={18} />
          </button>
          <h2>Read the field.</h2>
          <p>
            {liveMode
              ? "Prices arrive from the public Coinbase ticker WebSocket and are published once per second. Returns, activity and correlations use completed five-minute candles fetched separately; they are not tick-by-tick signals."
              : "Each node is one coin. Measurements use observed candles available at the replay cursor. Choose a layout to explore relationships or values."}
          </p>
          <dl>
            <div>
              <dt>Network / layout</dt>
              <dd>
                Stronger absolute correlations pull connected coins together.
                Positions and gentle motion are illustrative, not prices or
                capital flow. Unlinked coins sit outside the connected group.
                Freeze the layout to inspect it.
              </dd>
            </div>
            <div>
              <dt>Return &amp; activity / horizontal</dt>
              <dd>
                Simple price return over the preceding hour. Positions clip at
                ±4%; exact values remain in the inspector.
              </dd>
            </div>
            <div>
              <dt>Return &amp; activity / vertical</dt>
              <dd>
                Current five-minute close × base volume, divided by the previous
                12-bar median (at least 9 present). A logarithmic axis spans
                0.25× to 64×; extremes clip.
              </dd>
            </div>
            <div>
              <dt>Size / observed turnover</dt>
              <dd>
                Compressed past-hour close × base volume. This proxy does not
                measure liquidity or actual dollars exchanged.
              </dd>
            </div>
            <div>
              <dt>Lines / relationships</dt>
              <dd>
                Four hours of paired five-minute log returns. At least 36 pairs;
                |Pearson r| ≥ 0.65; retain each coin’s three strongest links.
                Negative links use coral. These are associations, not
                transaction paths.
              </dd>
            </div>
            <div>
              <dt>Rings / statistical changes</dt>
              <dd>
                Recorded BOCPD recent-change-mass threshold crossings on return,
                range or activity. They are exploratory and have not
                demonstrated trading profitability.
              </dd>
            </div>
            <div>
              <dt>
                {liveMode
                  ? "Live universe / online USD pairs"
                  : "Coverage / 68 of 404"}
              </dt>
              <dd>
                {liveMode ? (
                  "Online Coinbase USD products are discovered at server startup. Prices keep their exchange timestamps; missing candles are not filled. Live Network includes coins with a received price, even while analytics are warming up. This is one exchange, not all cryptocurrencies."
                ) : (
                  <>
                    Coins qualified using ≥95% coverage across the entire
                    recording. This retrospective selection is not a
                    point-in-time investable universe. Coins without complete
                    return/activity observations are excluded from both layouts
                    and counted below the field; their records remain available
                    in Universe. Motion never changes reported prices.
                  </>
                )}
              </dd>
            </div>
          </dl>
          {!liveMode && (
            <p className="small">
              Recording: {day(manifest.start)} {clock(manifest.start)} to{" "}
              {day(manifest.end)} {clock(manifest.end)} UTC. First displayed
              observation is the first completed bar.
            </p>
          )}
          {currentAsset && (
            <a href={currentAsset.source.url} target="_blank" rel="noreferrer">
              View {selected} source request <ExternalLink size={13} />
            </a>
          )}
        </section>
      )}
    </div>
  );
}
