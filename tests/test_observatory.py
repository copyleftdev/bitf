import asyncio
import json
import unittest
import numpy as np
from aiohttp.test_utils import TestClient, TestServer
from bitf.observatory import MarketKernel, correlations, create_app


class KernelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.kernel=MarketKernel()

    def test_scope_source_and_peak(self):
        k=self.kernel
        self.assertEqual((len(k.catalog),len(k.qualified),len(k.frames)),(404,68,288))
        peak=k.frames[k.default_index]
        self.assertEqual((peak['t'],peak['market']['alertCoins'],peak['market']['monitored']),(1793803500,32,57))
        self.assertTrue(all(json.loads(raw)['index']==i for i,raw in enumerate(k.encoded)))

    def test_pairwise_correlation_with_missing_and_constant(self):
        rng=np.random.default_rng(9)
        a=rng.normal(size=(48,4));a[:8,0]=np.nan;a[5:12,1]=np.nan;a[:,3]=1
        corr,n=correlations(a,minimum=36)
        mask=np.isfinite(a[:,0])&np.isfinite(a[:,1])
        self.assertAlmostEqual(corr[0,1],np.corrcoef(a[mask,0],a[mask,1])[0,1])
        self.assertEqual(n[0,1],mask.sum())
        self.assertTrue(np.isnan(corr[0,3]))
        self.assertTrue(np.isnan(correlations(a[:10])[0]).all())

    def test_metrics_ignore_future_observations(self):
        k=self.kernel;i=121
        before=k.compute_frame(i)
        close=k.close.copy();volume=k.volume.copy();returns=k.returns.copy()
        try:
            k.close[i+1:]*=100;k.volume[i+1:]*=1e6;k.returns[i+1:]=99999
            self.assertEqual(before,k.compute_frame(i))
        finally:k.close=close;k.volume=volume;k.returns=returns
        self.assertTrue(all(a['detected_at']<=before['t'] for a in k.asset('BTC-USD',i)['alerts']))
        self.assertTrue(all(p['t']<=before['t'] for p in k.asset('BTC-USD',i)['series']))

    def test_missing_values_and_warmup_are_not_imputed(self):
        k=self.kernel
        first=k.frames[0]
        self.assertTrue(all(n['return1h'] is None and n['activity'] is None for n in first['nodes']))
        self.assertEqual(first['edges'],[])
        sparse=next((i,j) for j in range(404) for i in range(12,288) if not np.isfinite(k.close[i,j]))
        i,j=sparse;n=k.frames[i]['nodes'][j]
        self.assertIsNone(n['price']);self.assertIsNone(n['x']);self.assertIsNone(n['return1h'])

    def test_graph_edges_are_measured(self):
        k=self.kernel;i=k.default_index
        for e in k.frames[i]['edges']:
            a,b=k.ids.index(e['a']),k.ids.index(e['b'])
            x=k.returns[i-47:i+1,a];y=k.returns[i-47:i+1,b]
            valid=np.isfinite(x)&np.isfinite(y)
            self.assertGreaterEqual(valid.sum(),36)
            self.assertGreaterEqual(abs(e['r']),.65)
            self.assertAlmostEqual(e['r'],np.corrcoef(x[valid],y[valid])[0,1],places=4)


class StreamTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls): cls.kernel=KernelTests.kernel if hasattr(KernelTests,'kernel') else MarketKernel()
    async def asyncSetUp(self):
        self.client=TestClient(TestServer(create_app(self.kernel)))
        await self.client.start_server()
    async def asyncTearDown(self): await self.client.close()

    async def first_frame(self,response):
        async with asyncio.timeout(3):
            while True:
                line=await response.content.readline()
                if line.startswith(b'data: '):return json.loads(line[6:])

    async def test_independent_sessions_and_snapshot_reconnect(self):
        a=await self.client.get('/api/events?index=100&playing=0')
        b=await self.client.get('/api/events?index=120&playing=0')
        self.assertEqual((await self.first_frame(a))['index'],100)
        self.assertEqual((await self.first_frame(b))['index'],120)
        c=await self.client.get('/api/events?index=0&playing=1&speed=4',headers={'Last-Event-ID':self.kernel.recording+':130'})
        self.assertEqual((await self.first_frame(c))['index'],131)
        self.assertEqual((await self.first_frame(c))['index'],132)
        self.assertEqual(a.headers['Content-Type'],'text/event-stream')
        self.assertEqual(a.headers['X-Accel-Buffering'],'no')
        a.close();b.close();c.close()

    async def test_invalid_inputs_and_asset_bounds(self):
        for url in ['/api/events?index=-1','/api/events?speed=999','/api/events?index=nan']:
            r=await self.client.get(url);self.assertEqual(r.status,400)
        for url in ['/api/asset/NO-SUCH-PAIR?index=1','/api/asset/BTC-USD?index=999']:
            r=await self.client.get(url);self.assertEqual(r.status,404)
        r=await self.client.get('/api/asset/BTC-USD?index=100');data=await r.json()
        self.assertEqual(data['index'],100)
        self.assertEqual(len(data['source']['sha256']),64)

    async def test_foreign_recording_id_resets_to_requested_snapshot(self):
        r=await self.client.get('/api/events?index=42',headers={'Last-Event-ID':'old-recording:100'})
        self.assertEqual((await self.first_frame(r))['index'],42)
        r.close()
