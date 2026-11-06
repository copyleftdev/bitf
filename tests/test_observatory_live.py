import asyncio
from datetime import datetime, timezone
import json
import math
import time
import unittest
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from bitf.observatory_live import LiveMarket, STEP, clean_candles, analytics, add_live_routes


def ticker(trade=1, price='100', at=6000):
    return {'type':'ticker','product_id':'BTC-USD','trade_id':trade,'price':price,
            'time':datetime.fromtimestamp(at,timezone.utc).isoformat()}


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.live=LiveMarket();self.live.ids=['BTC-USD'];self.live.history={'BTC-USD':{}}

    def test_duplicate_old_and_invalid_prices_never_replace_last_trade(self):
        live=self.live
        self.assertTrue(live.ingest(ticker(3),6001))
        for msg in [ticker(3,'150'),ticker(2,'50'),ticker(4,'nan'),ticker(4,'-1'),ticker(4,'inf'),ticker(4,at=7000),ticker(4,at=5999)]:
            self.assertFalse(live.ingest(msg,6001))
        self.assertEqual(live.tickers['BTC-USD']['price'],100)
        self.assertEqual(live.updates,1)
        self.assertTrue(live.ingest(ticker(5,'101',6001),6002)) # ticker batches may skip trade IDs
        self.assertEqual(live.updates,2)

    def test_completed_candles_only_missing_is_not_zero_filled(self):
        rows=[[5700,9,12,10,11,2],[6000,10,12,11,12,3],[5400,9,12,10,float('nan'),2],
              [5101,9,12,10,11,2],[4800,12,10,11,11,2]]
        result=clean_candles(rows,6000)
        self.assertEqual(result,{5700:(11,22)})
        nodes,edges,market=analytics(['BTC-USD'],{'BTC-USD':result},6000)
        self.assertIsNone(nodes[0]['activity']);self.assertIsNone(nodes[0]['return1h'])
        self.assertEqual(nodes[0]['volumeBars'],1);self.assertEqual(edges,[])
        self.assertIsNone(market['breadth'])

    def test_aligned_correlations_and_analytics_ignore_future(self):
        cutoff=30000
        a={cutoff-(50-i)*STEP:(100+math.sin(i/3)+i*.1,1000+i*20) for i in range(50)}
        b={t:(v[0]*2,v[1]) for t,v in a.items()}
        history={'A':a,'B':b}
        expected=analytics(['A','B'],history,cutoff)
        history['A'][cutoff]=(999999,999999)
        self.assertEqual(expected,analytics(['A','B'],history,cutoff))
        self.assertEqual(expected[1],[{'a':'A','b':'B','r':1.,'n':48}])
        for t in sorted(b)[:20]: del b[t]
        self.assertEqual(analytics(['A','B'],history,cutoff)[1],[])

    def test_feed_staleness_preserves_timestamp_and_never_claims_live(self):
        live=self.live
        live.nodes,live.edges,live.market=analytics(live.ids,{},6000)
        live.connected=True;live.last_message=6001
        live.ingest(ticker(),6001);live.publish(6002)
        self.assertEqual(live.frame['live']['status'],'live')
        live.publish(6015)
        self.assertNotEqual(live.frame['live']['status'],'live')
        self.assertEqual(live.frame['nodes'][0]['priceTime'],6000)
        self.assertEqual(live.frame['nodes'][0]['age'],15)
        self.assertIsNone(live.frame['nodes'][0]['return1h'])


class FixtureLive(LiveMarket):
    async def start(self):
        self.ids=['BTC-USD'];self.history={'BTC-USD':{}}
        self.catalog=[{'id':'BTC-USD','symbol':'BTC','qualified':True,'coverage':0,'limitOnly':False}]
        self.nodes,self.edges,self.market=analytics(self.ids,self.history,6000)
        self.publish(6000);self.ready.set()
    async def stop(self): pass


class LiveStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.live=FixtureLive();app=web.Application();add_live_routes(app,self.live)
        self.client=TestClient(TestServer(app));await self.client.start_server()
    async def asyncTearDown(self): await self.client.close()
    async def frame(self,response):
        async with asyncio.timeout(2):
            while True:
                line=await response.content.readline()
                if line.startswith(b'data: '):return json.loads(line[6:])
    async def test_shared_live_snapshot_reconnect_always_gets_latest(self):
        a=await self.client.get('/api/live/events');b=await self.client.get('/api/live/events')
        self.assertEqual(await self.frame(a),await self.frame(b))
        self.live.ingest(ticker(),6001);self.live.publish(6001)
        async with self.live.changed:self.live.changed.notify_all()
        x,y=await self.frame(a),await self.frame(b)
        self.assertEqual(x,y);self.assertEqual(x['nodes'][0]['price'],100)
        c=await self.client.get('/api/live/events',headers={'Last-Event-ID':'old:9999'})
        self.assertEqual(await self.frame(c),x)
        a.close();b.close();c.close()
    async def test_manifest_asset_and_unknown_product(self):
        manifest=await (await self.client.get('/api/live/manifest')).json()
        self.assertEqual(manifest['mode'],'LIVE');self.assertEqual(manifest['timeline'],[])
        self.assertEqual((await self.client.get('/api/live/asset/FAKE')).status,404)
        asset=await (await self.client.get('/api/live/asset/BTC-USD')).json()
        self.assertEqual(asset['alerts'],[])
        self.assertTrue(all(p['price'] is None for p in asset['series']))

    async def test_analytics_remains_on_the_completed_refresh_window(self):
        live=self.live
        live.history_cutoff=6000
        live.history['BTC-USD']={5700:(100,2000)}
        task=asyncio.create_task(live.analytics_loop())
        try:
            async with asyncio.timeout(2):
                while live.analytics_at != 6000:await asyncio.sleep(.01)
            self.assertEqual(live.nodes[0]['volumeBars'],1)
            self.assertEqual(live.nodes[0]['turnover1h'],2000)
            self.assertEqual(live.analytics_at,6000) # wall clock is much later
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True)

    async def test_upstream_disconnect_retries_without_claiming_live(self):
        live=self.live
        class Socket:
            async def send(self,_):pass
            async def recv(self):raise ConnectionError('test disconnect')
        class Context:
            async def __aenter__(self):return Socket()
            async def __aexit__(self,*args):pass
        with patch('bitf.observatory_live.connect',return_value=Context()) as connect:
            task=asyncio.create_task(live.socket_loop())
            try:
                await asyncio.sleep(1.15)
                self.assertGreaterEqual(connect.call_count,2)
                self.assertGreaterEqual(live.reconnects,2)
                self.assertFalse(live.connected)
                self.assertEqual(live.feed_status(time.time())['status'],'reconnecting')
            finally:
                task.cancel()
                await asyncio.gather(task,return_exceptions=True)
