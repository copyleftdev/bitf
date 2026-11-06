export type Coin = {
  id: string;
  symbol: string;
  qualified: boolean;
  coverage: number;
  limitOnly: boolean;
};
export type Node = {
  id: string;
  price: number | null;
  tick?: number;
  priceTime?: number;
  receivedAt?: number;
  lastPrice: number | null;
  age: number | null;
  return1h: number | null;
  return5m: number | null;
  activity: number | null;
  turnover1h: number | null;
  volumeBars: number;
  alerts: string[];
  x: number | null;
  y: number | null;
};
export type Edge = { a: string; b: string; r: number; n: number };
export type Frame = {
  recording: string;
  live?: LiveFeed;
  index: number;
  t: number;
  nodes: Node[];
  edges: Edge[];
  market: {
    advancers: number;
    decliners: number;
    returnCount: number;
    breadth: number | null;
    medianReturn: number | null;
    volatilityBps: number | null;
    currentCoins: number;
    alertCoins: number;
    monitored: number;
    alertFraction: number | null;
  };
};
export type Manifest = {
  recording: string;
  mode: string;
  venue: string;
  start: number;
  end: number;
  step: number;
  count: number;
  defaultIndex: number;
  catalog: Coin[];
  timeline: { t: number; alerts: number; breadth: number | null }[];
  method: Record<string, number | string>;
};
export type Asset = {
  id: string;
  index: number;
  source: { url: string; sha256: string };
  series: { t: number; price: number | null }[];
  alerts: {
    channel: string;
    detected_at: number;
    recent_change_mass: number;
  }[];
  edges: Edge[];
};

export type LiveFeed = {
  status: "live" | "connecting" | "reconnecting";
  messageAge: number | null;
  messages: number;
  updates: number;
  updatesPerSecond: number;
  reconnects: number;
  subscribed: number;
  heartbeatPairs: number;
  pricedPairs: number;
  historyPairs: number;
  historyErrors: number;
  analyticsAt: number | null;
  error: string | null;
};
