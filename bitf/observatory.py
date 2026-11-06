"""Live Coinbase market observatory with a separate immutable replay kernel.

Run: python -m bitf.observatory --port 8876
Public market data only. No order routing.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import gzip
import json
import math
import time
from pathlib import Path
import numpy as np
from aiohttp import web
from .candles import validate_candles

ROOT = Path(__file__).resolve().parents[1]


def encode(value):
    return json.dumps(value, separators=(',', ':'), allow_nan=False).encode()


def number(value, digits=5):
    return round(float(value), digits) if math.isfinite(value) else None


def correlations(values, minimum=36):
    """Pairwise complete Pearson, including pair-specific means and variances."""
    valid = np.isfinite(values).astype(float)
    x = np.nan_to_num(values)
    n = valid.T @ valid
    sums = x.T @ valid
    squares = (x*x).T @ valid
    safe = np.maximum(n, 1)
    covariance = x.T @ x - sums * sums.T / safe
    variance = np.maximum(squares - sums*sums/safe, 0)
    denom = np.sqrt(variance * variance.T)
    out = np.full_like(n, np.nan)
    np.divide(covariance, denom, out=out, where=(n >= minimum) & (denom > 1e-12))
    return np.clip(out, -1, 1), n


class MarketKernel:
    def __init__(self, root=ROOT):
        started = time.perf_counter()
        root = Path(root)
        with gzip.open(root/'data/replay/coinbase-usd.json.gz', 'rt') as source:
            replay = json.load(source)
        if replay.get('format') != 1:
            raise ValueError('Unsupported replay format')
        p = replay['protocol']
        summaries = replay['summaries']
        self.products = sorted(p['products'], key=lambda x:x['id'])
        self.ids = [p['id'] for p in self.products]
        self.grid = list(range(p['start'], p['end_exclusive'], p['granularity_seconds']))
        self.step = p['granularity_seconds']
        n, m = len(self.grid), len(self.ids)
        self.close = np.full((n,m), np.nan)
        self.volume = np.full((n,m), np.nan)
        self.alerts = {}
        self.sources = {}
        self.catalog = []
        summary_by_id = {r['product']: r for r in summaries}
        fingerprint = hashlib.sha256(encode(p))
        for j, product in enumerate(self.products):
            name = product['id']
            packet = replay['packets'][name]
            body = packet['body']
            digest = hashlib.sha256(body.encode()).hexdigest()
            if digest != packet['body_sha256']:
                raise ValueError(f'Corrupt source: {name}')
            fingerprint.update(digest.encode())
            candles, quality = validate_candles(json.loads(body), p)
            for t, low, high, opening, close, volume in candles:
                i = (t-p['start'])//self.step
                self.close[i,j] = close
                self.volume[i,j] = close*volume  # quote turnover proxy, not actual dollar trade volume
            summary = summary_by_id[name]
            qualified = summary['status'] == 'analyzed'
            self.catalog.append({'id':name,'symbol':product['base_currency'], 'qualified':qualified,
                'coverage':quality['coverage'], 'limitOnly':product['limit_only']})
            self.sources[name] = {'url':packet['url'],'sha256':digest}
            self.alerts[name] = summary.get('changes', {}).get('alerts', []) if qualified else []
        self.qualified = [i for i,c in enumerate(self.catalog) if c['qualified']]
        self.returns = np.full_like(self.close, np.nan)
        self.returns[1:] = np.log(self.close[1:] / self.close[:-1]) * 10000
        self.breadth = {b['end']: b for b in replay['breadth']}
        self.recording = fingerprint.hexdigest()[:12]
        self.frames = []
        self.encoded = []
        durations = []
        for i in range(n):
            before = time.perf_counter()
            frame = self.compute_frame(i)
            self.frames.append(frame)
            self.encoded.append(encode(frame))
            durations.append((time.perf_counter()-before)*1000)
        self.default_index = max(range(n), key=lambda i:self.frames[i]['market']['alertFraction'] or 0)
        self.manifest = {'recording':self.recording, 'mode':'REPLAY', 'venue':'Coinbase Exchange',
            'start':self.grid[0], 'end':self.grid[-1]+self.step, 'step':self.step, 'count':n,
            'defaultIndex':self.default_index, 'catalog':self.catalog,
            'timeline':[{'t':f['t'],'alerts':f['market']['alertCoins'],'breadth':f['market']['breadth']} for f in self.frames],
            'method':{'correlationBars':48,'minimumPairs':36,'edgeThreshold':.65,'returnBars':12,
                      'activityBaselineBars':12,'activityMinimumBars':9,'coverageThreshold':.95,
                      'scope':'404 Coinbase USD pairs; 68 passed a retrospective full-window coverage screen. Not a point-in-time trading universe.',
                      'size':'Area compressed by log10(1 + observed past-hour close × base volume).',
                      'position':'X: trailing 1h simple return, clipped to ±4%. Y: log2(current turnover proxy / previous 12-bar median), clipped to −2…+6.',
                      'alerts':'Recorded experiment 006 BOCPD recent-change-mass threshold crossings; exploratory, not trade signals.'}}
        self.performance = {'startupSeconds':round(time.perf_counter()-started,3),
            'frameComputeP50Ms':round(float(np.percentile(durations,50)),3),
            'frameComputeP95Ms':round(float(np.percentile(durations,95)),3),
            'frames':n,'pairs':m,'qualified':len(self.qualified),
            'encodedMiB':round(sum(map(len,self.encoded))/1024**2,2),
            'frameBytesP95':int(np.percentile(list(map(len,self.encoded)),95))}

    def compute_frame(self, i):
        """Only prefix data affects metrics. Static qualified membership is retrospective."""
        t = self.grid[i]+self.step
        nodes = []
        for j, meta in enumerate(self.catalog):
            close = self.close[i,j]
            past = np.flatnonzero(np.isfinite(self.close[:i+1,j]))
            last = int(past[-1]) if len(past) else None
            ret = (close/self.close[i-12,j]-1)*100 if i>=12 else math.nan
            baseline = self.volume[max(0,i-12):i,j]
            finite = baseline[np.isfinite(baseline)]
            median = float(np.median(finite)) if len(finite)>=9 else math.nan
            activity = self.volume[i,j]/median if median>0 else math.nan
            window = self.volume[max(0,i-11):i+1,j]
            total = float(np.nansum(window)) if np.isfinite(window).any() else math.nan
            alerts = [a['channel'] for a in self.alerts[meta['id']] if a['detected_at']==t]
            nodes.append({'id':meta['id'], 'price':number(close,10),
                'lastPrice':number(self.close[last,j],10) if last is not None else None,
                'age':(i-last)*self.step if last is not None else None,
                'return1h':number(ret), 'return5m':number(self.returns[i,j]/100),
                'activity':number(activity), 'turnover1h':number(total,2),
                'volumeBars':int(np.isfinite(window).sum()),'alerts':alerts,
                'x':number(np.clip(ret/4,-1,1)),
                'y':number(np.clip((math.log2(activity)-2)/4,-1,1)) if activity>0 else None})
        # One vectorized covariance calculation per historical step, shared by every viewer.
        corr, counts = correlations(self.returns[max(0,i-47):i+1,self.qualified])
        edges = {}
        for a in range(len(self.qualified)):
            candidates = [b for b in range(len(self.qualified)) if b!=a and np.isfinite(corr[a,b]) and abs(corr[a,b])>=.65]
            for b in sorted(candidates,key=lambda b: -abs(corr[a,b]))[:3]:
                key = tuple(sorted((a,b)))
                edges[key] = {'a':self.ids[self.qualified[key[0]]],'b':self.ids[self.qualified[key[1]]],
                    'r':number(corr[a,b],4),'n':int(counts[a,b])}
        qualified = [nodes[j] for j in self.qualified]
        valid = [node['return1h'] for node in qualified if node['return1h'] is not None]
        vols = self.returns[max(0,i-11):i+1,self.qualified]
        valid_vols = [float(np.std(v[np.isfinite(v)],ddof=1)) for v in vols.T if np.isfinite(v).sum()>=9]
        b = self.breadth.get(t, {})
        return {'recording':self.recording,'index':i,'t':t,'nodes':nodes,'edges':list(edges.values()),
            'market':{'advancers':sum(v>0 for v in valid),'decliners':sum(v<0 for v in valid),'returnCount':len(valid),
                'breadth':number(sum(v>0 for v in valid)/len(valid)) if valid else None,
                'medianReturn':number(np.median(valid)) if valid else None,
                'volatilityBps':number(np.median(valid_vols),2) if valid_vols else None,
                'currentCoins':sum(node['price'] is not None for node in qualified),
                'alertCoins':b.get('coins_with_alert',0), 'monitored':b.get('monitored_coins',0),
                'alertFraction':b.get('fraction',0)}}

    def asset(self, name, index):
        j = self.ids.index(name)
        frame = self.frames[index]
        edges = [edge for edge in frame['edges'] if name in (edge['a'],edge['b'])]
        return {'id':name,'index':index,'source':self.sources[name],
            'series':[{'t':self.grid[k]+self.step,'price':number(self.close[k,j],10)} for k in range(max(0,index-47),index+1)],
            'alerts':[a for a in self.alerts[name] if a['detected_at']<=frame['t']],
            'edges':sorted(edges,key=lambda x:-abs(x['r']))}


def stream_cursor(request, kernel):
    try:
        i = int(request.query.get('index',kernel.default_index))
        speed = float(request.query.get('speed','1'))
        playing = request.query.get('playing','0') == '1'
        if not 0<=i<len(kernel.frames) or speed not in (.5,1,2,4):
            raise ValueError()
        last = request.headers.get('Last-Event-ID','')
        if last.startswith(kernel.recording+':'):
            previous = int(last.split(':')[1])
            if 0<=previous<len(kernel.frames):
                i = min(previous+int(playing),len(kernel.frames)-1)
        return i,speed,playing
    except (ValueError,IndexError):
        raise web.HTTPBadRequest(text='Invalid replay cursor or speed')


def create_app(kernel, dist=None, live=None):
    dist = Path(dist or ROOT/'observatory/dist').resolve()
    app = web.Application(client_max_size=4096)
    if live is not None:
        from .observatory_live import add_live_routes
        add_live_routes(app, live)
    stats = {'streams': 0}
    async def manifest(request): return web.json_response(kernel.manifest)
    async def health(request): return web.json_response({'status':'ok','mode':'replay','activeStreams':stats['streams'],**kernel.performance})
    async def asset(request):
        try:
            index = int(request.query.get('index',kernel.default_index))
            if not 0<=index<len(kernel.frames): raise ValueError()
            return web.json_response(kernel.asset(request.match_info['name'],index))
        except (ValueError,KeyError): raise web.HTTPNotFound(text='Unknown coin or replay cursor')
    async def events(request):
        i,speed,playing = stream_cursor(request,kernel)
        response = web.StreamResponse(headers={'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',
                                              'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'})
        await response.prepare(request)
        stats['streams'] += 1
        async def write(payload):
            async with asyncio.timeout(5):
                await response.write(payload)
        try:
            await write(b'retry: 1500\n\n')
            while True:
                await write(f'id: {kernel.recording}:{i}\nevent: frame\ndata: '.encode()+kernel.encoded[i]+b'\n\n')
                if not playing or i==len(kernel.frames)-1:
                    await write(b'event: state\ndata: {"playing":false}\n\n')
                    while True:
                        await asyncio.sleep(5)
                        await write(b'event: heartbeat\ndata: {}\n\n')
                await asyncio.sleep(3/speed)
                i += 1
        except (ConnectionError,asyncio.CancelledError,TimeoutError):
            pass
        finally:
            stats['streams'] -= 1
        return response
    async def index(request):
        if not (dist/'index.html').exists(): raise web.HTTPServiceUnavailable(text='Build the client: cd observatory && npm ci && npm run build')
        return web.FileResponse(dist/'index.html',headers={'Cache-Control':'no-cache'})
    app.router.add_get('/api/manifest',manifest)
    app.router.add_get('/api/health',health)
    app.router.add_get('/api/asset/{name}',asset)
    app.router.add_get('/api/events',events)
    app.router.add_get('/',index)
    if (dist/'assets').exists(): app.router.add_static('/assets/',dist/'assets')
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--port',type=int,default=8876)
    parser.add_argument('--benchmark',action='store_true')
    args = parser.parse_args()
    kernel = MarketKernel()
    print(json.dumps(kernel.performance),flush=True)
    if not args.benchmark:
        from .observatory_live import LiveMarket
        web.run_app(create_app(kernel, live=LiveMarket()),host=args.host,port=args.port,shutdown_timeout=2)

if __name__=='__main__': main()
