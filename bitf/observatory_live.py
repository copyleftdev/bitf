"""Shared public Coinbase price feed; closed REST candles supply separate analytics.

Ticker batches are not a complete trade tape. We never infer trade volume from them.
One upstream socket and one bounded latest snapshot serve all browser subscribers.
"""
from __future__ import annotations
import asyncio
from datetime import datetime, timezone
import json
import math
import time
from urllib.parse import quote
import uuid
import numpy as np
from aiohttp import ClientSession, ClientTimeout, ClientError, web
from websockets.asyncio.client import connect

REST = 'https://api.exchange.coinbase.com'
WS = 'wss://ws-feed.exchange.coinbase.com'
STEP = 300


def stamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def clean_candles(rows, cutoff):
    """Keep only valid, completed, aligned bars; missing bars stay absent."""
    result = {}
    for row in rows:
        if not isinstance(row, list) or len(row) != 6:
            continue
        try:
            t, low, high, opening, close, volume = map(float, row)
            if not all(math.isfinite(x) for x in (t, low, high, opening, close, volume)):
                continue
            if t % STEP or t + STEP > cutoff or t < cutoff - 65*STEP:
                continue
            if min(low, opening, close) <= 0 or volume < 0 or not low <= min(opening, close) <= max(opening, close) <= high:
                continue
            result[int(t)] = (close, close * volume)
        except (TypeError, ValueError):
            continue
    return result


def analytics(ids, history, cutoff):
    """Shared closed-bar metrics on one aligned grid; never mix replay into live."""
    from .observatory import correlations, number
    grid = list(range(cutoff - 50*STEP, cutoff, STEP))
    close = np.full((50, len(ids)), np.nan)
    volume = np.full_like(close, np.nan)
    for j, name in enumerate(ids):
        for i, t in enumerate(grid):
            if t in history.get(name, {}):
                close[i, j], volume[i, j] = history[name][t]
    with np.errstate(invalid='ignore', divide='ignore'):
        returns = np.log(close[1:] / close[:-1]) * 10000
    nodes = []
    for j, name in enumerate(ids):
        c = close[-1, j]
        ret = (c / close[-13, j] - 1)*100
        prior = volume[-13:-1, j]
        prior = prior[np.isfinite(prior)]
        median = float(np.median(prior)) if len(prior) >= 9 else math.nan
        activity = volume[-1, j] / median if median > 0 else math.nan
        window = volume[-12:, j]
        total = float(np.nansum(window)) if np.isfinite(window).any() else math.nan
        nodes.append({'id':name, 'price':None, 'lastPrice':None, 'age':None,
                      'return1h':number(ret), 'return5m':number(returns[-1,j]/100),
                      'activity':number(activity), 'turnover1h':number(total,2),
                      'volumeBars':int(np.isfinite(window).sum()), 'alerts':[],
                      'x':number(np.clip(ret/4,-1,1)),
                      'y':number(np.clip((math.log2(activity)-2)/4,-1,1)) if activity>0 else None})
    corr, counts = correlations(returns[-48:])
    edges = {}
    for a, name in enumerate(ids):
        candidates = np.flatnonzero(np.isfinite(corr[a]) & (np.abs(corr[a]) >= .65))
        candidates = sorted((int(b) for b in candidates if b != a), key=lambda b:-abs(corr[a,b]))[:3]
        for b in candidates:
            lo, hi = sorted((a,b))
            edges[(lo,hi)] = {'a':ids[lo],'b':ids[hi],'r':number(corr[lo,hi],4),'n':int(counts[lo,hi])}
    valid = [n['return1h'] for n in nodes if n['return1h'] is not None]
    vols = [float(np.std(v[np.isfinite(v)],ddof=1)) for v in returns[-12:].T if np.isfinite(v).sum() >= 9]
    market = {'advancers':sum(v>0 for v in valid),'decliners':sum(v<0 for v in valid),
              'returnCount':len(valid),'breadth':number(sum(v>0 for v in valid)/len(valid)) if valid else None,
              'medianReturn':number(np.median(valid)) if valid else None,
              'volatilityBps':number(np.median(vols),2) if vols else None,
              'currentCoins':0,'alertCoins':0,'monitored':0,'alertFraction':None}
    return nodes, list(edges.values()), market


class LiveMarket:
    def __init__(self):
        self.recording = 'live-' + uuid.uuid4().hex[:12]
        self.catalog = []
        self.ids = []
        self.tickers = {}
        self.beats = {}
        self.history = {}
        self.ready = asyncio.Event()
        self.changed = asyncio.Condition()
        self.tasks = []
        self.connected = False
        self.last_message = 0
        self.last_error = None
        self.history_errors = 0
        self.messages = self.updates = self.reconnects = self.index = 0
        self.previous_updates = 0
        self.started = time.time()
        self.nodes, self.edges, self.market = [], [], {}
        self.analytics_at = None
        self.history_cutoff = int(time.time()//STEP)*STEP
        self.encoded = b''
        self.frame = None
        self.streams = 0

    def ingest(self, msg, received=None):
        """Deduplicate by per-product trade ID; exchange event time remains visible."""
        received = time.time() if received is None else received
        name = msg.get('product_id')
        if name not in self.history:
            return False
        if msg.get('type') == 'heartbeat':
            self.beats[name] = received
            return False
        if msg.get('type') != 'ticker':
            return False
        try:
            price, trade_id, event = float(msg['price']), int(msg['trade_id']), stamp(msg['time'])
            if not math.isfinite(price) or price <= 0 or not math.isfinite(event) or event > received + 10:
                return False
            previous = self.tickers.get(name)
            if previous and (trade_id <= previous['tick'] or event < previous['priceTime']):
                return False
        except (KeyError, ValueError, TypeError, OverflowError):
            return False
        self.tickers[name] = {'price':price,'lastPrice':price,'tick':trade_id,
                              'priceTime':event,'receivedAt':received}
        self.updates += 1
        return True

    def feed_status(self, now):
        age = now-self.last_message if self.last_message else None
        healthy = self.connected and age is not None and age < 10
        return {'status':'live' if healthy else 'reconnecting' if self.reconnects else 'connecting',
                'messageAge':round(max(0,age),1) if age is not None else None,
                'messages':self.messages,'updates':self.updates,'updatesPerSecond':self.updates-self.previous_updates,
                'reconnects':self.reconnects,'subscribed':len(self.ids),
                'heartbeatPairs':sum(now-t<10 for t in self.beats.values()),
                'pricedPairs':len(self.tickers),'historyPairs':sum(bool(v) for v in self.history.values()),
                'historyErrors':self.history_errors,'analyticsAt':self.analytics_at,
                'error':self.last_error}

    def publish(self, now=None):
        from .observatory import encode
        now = time.time() if now is None else now
        nodes = []
        for node in self.nodes:
            tick = self.tickers.get(node['id'])
            nodes.append({**node, **(tick or {}), 'age':round(max(0,now-tick['priceTime']),1) if tick else None})
        self.index += 1
        self.frame = {'recording':self.recording,'index':self.index,'t':now,
                      'nodes':nodes,'edges':self.edges,'market':{**self.market,'currentCoins':len(self.tickers)},
                      'live':self.feed_status(now)}
        self.encoded = encode(self.frame)
        self.previous_updates = self.updates

    async def start(self):
        self.session = ClientSession(timeout=ClientTimeout(total=15), headers={'User-Agent':'BITF-Observatory/1.0'})
        self.tasks = [asyncio.create_task(self.initialize())]

    async def stop(self):
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.session.close()

    async def initialize(self):
        while not self.ready.is_set():
            try:
                async with self.session.get(REST+'/products') as response:
                    response.raise_for_status()
                    products = await response.json()
                products = sorted((p for p in products if p.get('quote_currency')=='USD' and p.get('status')=='online'
                                   and not p.get('trading_disabled') and not p.get('cancel_only')),key=lambda p:p['id'])
                if not products:
                    raise ValueError('No online Coinbase USD products returned')
                self.ids = [p['id'] for p in products]
                self.catalog = [{'id':p['id'],'symbol':p['base_currency'],'qualified':True,'coverage':0,
                                 'limitOnly':bool(p.get('limit_only'))} for p in products]
                self.history = {name:{} for name in self.ids}
                self.nodes, self.edges, self.market = analytics(self.ids, self.history, int(time.time()//STEP)*STEP)
                self.publish()
                self.ready.set()
                self.tasks.extend(asyncio.create_task(fn()) for fn in (self.socket_loop,self.history_loop,self.publish_loop,self.analytics_loop))
            except (OSError, ValueError, TimeoutError, ClientError) as exc:
                self.last_error = str(exc)[:180]
                await asyncio.sleep(5)

    async def socket_loop(self):
        backoff = 1
        while True:
            try:
                async with connect(WS, open_timeout=15, ping_interval=20, ping_timeout=20,
                                   max_size=1024*1024, max_queue=64) as ws:
                    await ws.send(json.dumps({'type':'subscribe','product_ids':self.ids,'channels':['ticker','heartbeat']}))
                    while True:
                        raw = await asyncio.wait_for(ws.recv(), timeout=15)
                        msg = json.loads(raw)
                        self.messages += 1
                        self.last_message = time.time()
                        if msg.get('type') == 'error':
                            raise ValueError('Exchange rejected subscription: '+str(msg.get('message','')))
                        if msg.get('type') == 'subscriptions':
                            subscribed = {c['name']:set(c.get('product_ids',[])) for c in msg.get('channels',[])}
                            if any(not set(self.ids) <= subscribed.get(c,set()) for c in ('ticker','heartbeat')):
                                raise ValueError('Incomplete exchange subscription acknowledgement')
                            self.connected = True
                            self.last_error = None
                            backoff = 1
                        self.ingest(msg)
                    raise ConnectionError('Exchange closed the feed')
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connected = False
                self.beats.clear()
                self.reconnects += 1
                self.last_error = str(exc)[:180]
                await asyncio.sleep(backoff)
                backoff = min(30,backoff*2)

    async def history_loop(self):
        # Bound REST traffic to <=2.5 requests/s. Bootstrap liquid majors first.
        priority = ['BTC-USD','ETH-USD','SOL-USD','XRP-USD','DOGE-USD','ADA-USD','LINK-USD']
        order = [n for n in priority if n in self.history] + [n for n in self.ids if n not in priority]
        while True:
            cutoff = int(time.time()//STEP)*STEP
            for name in order:
                params = {'granularity':str(STEP),
                          'start':datetime.fromtimestamp(cutoff-60*STEP,timezone.utc).isoformat(),
                          'end':datetime.fromtimestamp(cutoff,timezone.utc).isoformat()}
                try:
                    async with self.session.get(REST+'/products/'+quote(name,safe='')+'/candles',params=params) as response:
                        response.raise_for_status()
                        rows = await response.json()
                    self.history[name] = clean_candles(rows,cutoff)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self.history_errors += 1
                await asyncio.sleep(.4)
            # Advance the common window only after the refresh sweep finishes.
            # A new wall-clock bucket must not erase still-valid closed-bar metrics.
            self.history_cutoff = cutoff
            await asyncio.sleep(max(1,cutoff+STEP-time.time()))

    async def analytics_loop(self):
        while True:
            cutoff = self.history_cutoff
            snapshot = {name:dict(rows) for name,rows in self.history.items()}
            self.nodes,self.edges,self.market = await asyncio.to_thread(analytics,self.ids,snapshot,cutoff)
            self.analytics_at = cutoff
            await asyncio.sleep(15)

    async def publish_loop(self):
        while True:
            self.publish()
            async with self.changed:
                self.changed.notify_all()
            await asyncio.sleep(1)

    def manifest(self):
        return {'recording':self.recording,'mode':'LIVE','venue':'Coinbase Exchange','start':self.started,'end':time.time(),
                'step':STEP,'count':1,'defaultIndex':0,'catalog':self.catalog,'timeline':[],
                'method':{'scope':'Online Coinbase USD pairs discovered at connection startup; not all exchanges.',
                          'prices':'Public ticker WebSocket; latest trade price, updates coalesced once per second.',
                          'analytics':'Completed five-minute REST candles; four-hour correlations with >=36 pairs. Missing bars excluded.',
                          'alerts':'Historical detector is not running on the live feed.'}}

    def asset(self, name):
        if name not in self.history:
            raise KeyError(name)
        return {'id':name,'index':self.index,'source':{'url':REST+'/products/'+quote(name,safe='')+'/candles?granularity=300','sha256':''},
                'series':[{'t':t+STEP,'price':self.history[name].get(t,(None,))[0]} for t in range((self.analytics_at or int(time.time()//STEP)*STEP)-48*STEP,(self.analytics_at or int(time.time()//STEP)*STEP),STEP)],
                'alerts':[],'edges':sorted((e for e in self.edges if name in (e['a'],e['b'])),key=lambda e:-abs(e['r']))}


def add_live_routes(app, live):
    async def ready():
        try:
            async with asyncio.timeout(20):
                await live.ready.wait()
        except TimeoutError:
            raise web.HTTPServiceUnavailable(text='Live product discovery unavailable; retry shortly.')
    async def manifest(request):
        await ready()
        return web.json_response(live.manifest())
    async def asset(request):
        try:
            return web.json_response(live.asset(request.match_info['name']))
        except KeyError:
            raise web.HTTPNotFound(text='Unknown live product')
    async def health(request):
        return web.json_response({**live.feed_status(time.time()),'activeStreams':live.streams,'frame':live.index})
    async def events(request):
        await ready()
        response = web.StreamResponse(headers={'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'})
        await response.prepare(request)
        live.streams += 1
        last = -1
        try:
            while True:
                async with live.changed:
                    await live.changed.wait_for(lambda:live.index != last)
                    last, payload = live.index, live.encoded
                async with asyncio.timeout(5):
                    await response.write(f'id: {live.recording}:{last}\nevent: frame\ndata: '.encode()+payload+b'\n\n')
        except (ConnectionError, TimeoutError, asyncio.CancelledError):
            pass
        finally:
            live.streams -= 1
        return response
    async def lifecycle(app):
        await live.start()
        yield
        await live.stop()
    app.cleanup_ctx.append(lifecycle)
    app.router.add_get('/api/live/manifest',manifest)
    app.router.add_get('/api/live/events',events)
    app.router.add_get('/api/live/asset/{name}',asset)
    app.router.add_get('/api/live/health',health)
