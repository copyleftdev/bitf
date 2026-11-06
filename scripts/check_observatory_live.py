"""Browser integration evidence for the built observatory; server must be on :8876."""
import asyncio,base64,json,subprocess,tempfile,urllib.request
from pathlib import Path
from aiohttp import web, ClientSession
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/screenshots'
OUT.mkdir(parents=True,exist_ok=True)
(ROOT/'artifacts/checks').mkdir(parents=True,exist_ok=True)


class StreamProxy:
 """Test-only proxy: sever SSE transport without affecting the real live kernel."""
 def __init__(self): self.outage=False;self.streams=set()
 async def start(self):
  self.session=ClientSession()
  app=web.Application();app.router.add_route('*','/{path:.*}',self.handle)
  self.runner=web.AppRunner(app,shutdown_timeout=1);await self.runner.setup()
  self.site=web.TCPSite(self.runner,'127.0.0.1',0);await self.site.start()
  self.port=self.site._server.sockets[0].getsockname()[1]
 async def handle(self,request):
  stream=request.path in ('/api/live/events','/api/events')
  if stream and self.outage:return web.Response(status=503,text='Controlled test outage')
  task=asyncio.current_task()
  if stream:self.streams.add(task)
  try:
   async with self.session.get('http://127.0.0.1:8876'+str(request.rel_url)) as upstream:
    headers={k:v for k,v in upstream.headers.items() if k.lower() not in ('content-length','transfer-encoding','connection','content-encoding')}
    if not stream:return web.Response(status=upstream.status,headers=headers,body=await upstream.read())
    response=web.StreamResponse(status=upstream.status,headers=headers);await response.prepare(request)
    async for chunk in upstream.content.iter_any():await response.write(chunk)
    return response
  except (asyncio.CancelledError,ConnectionError):
   if request.transport:request.transport.close()
   return web.Response(status=503)
  finally:self.streams.discard(task)
 async def drop(self):
  self.outage=True
  for task in list(self.streams):task.cancel()
 async def close(self):
  await self.drop();await self.runner.cleanup();await self.session.close()

async def main():
 proxy=StreamProxy();await proxy.start()
 with tempfile.TemporaryDirectory(prefix='bitf-observatory-ui-',ignore_cleanup_errors=True) as profile:
  proc=subprocess.Popen(['google-chrome','--headless=new','--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9228','--user-data-dir='+profile,'about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   targets=[]
   for _ in range(100):
    try:
     with urllib.request.urlopen('http://127.0.0.1:9228/json/list',timeout=1) as r:targets=json.load(r)
     if any(t.get('type')=='page' for t in targets):break
    except OSError:pass
    await asyncio.sleep(.1)
   async with connect(next(t for t in targets if t.get('type')=='page')['webSocketDebuggerUrl'],max_size=25_000_000) as ws:
    identifier=0;errors=[];logs=[]
    async def call(method,params=None):
     nonlocal identifier
     identifier+=1;current=identifier
     await ws.send(json.dumps({'id':current,'method':method,'params':params or {}}))
     while True:
      msg=json.loads(await ws.recv())
      if msg.get('method')=='Runtime.exceptionThrown':errors.append(msg['params'])
      if msg.get('method')=='Log.entryAdded' and msg['params']['entry'].get('level')=='error':logs.append(msg['params']['entry'])
      if msg.get('id')==current:
       if 'error' in msg:raise RuntimeError(msg['error'])
       return msg.get('result',{})
    async def evaluate(expression):
     result=await call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True})
     if 'exceptionDetails' in result:raise RuntimeError(result['exceptionDetails'])
     return result['result'].get('value')
    async def waitfor(expression):
     for _ in range(120):
      if await evaluate('Boolean('+expression+')'):return
      await asyncio.sleep(.1)
     raise AssertionError('Timed out: '+expression+' '+str(await evaluate('document.body.innerText.slice(0,400)')))
    async def click(selector):await evaluate(f'document.querySelector({json.dumps(selector)}).click()')
    async def screenshot(name,width,height,mobile=False):
     await call('Emulation.setDeviceMetricsOverride',{'width':width,'height':height,'deviceScaleFactor':1,'mobile':mobile})
     await evaluate('document.activeElement?.blur();window.scrollTo(0,0)');await asyncio.sleep(.8)
     size=await evaluate('({width:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,height:document.documentElement.scrollHeight,viewport:innerWidth})')
     assert size['width']<=width and size['viewport']==width,size
     shot=await call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':True,'clip':{'x':0,'y':0,'width':width,'height':size['height'],'scale':1}})
     (OUT/name).write_bytes(base64.b64decode(shot['data']))
     return size
    await call('Runtime.enable');await call('Log.enable');await call('Page.enable')
    await call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1080,'deviceScaleFactor':1,'mobile':False})
    await call('Page.navigate',{'url':f'http://127.0.0.1:{proxy.port}/'})
    await waitfor("document.querySelector('.live-transport') && document.querySelector('.live-badge') && document.querySelector('.price-block strong').textContent!=='—'")
    await asyncio.sleep(3)
    assert not await evaluate("!!document.querySelector('[aria-label=\"Historical replay controls\"]')")
    first=await evaluate("({time:document.querySelector('.live-transport time').textContent,price:document.querySelector('.price-block strong').textContent,footer:document.querySelector('.status-bar').textContent})")
    await asyncio.sleep(4)
    second=await evaluate("({time:document.querySelector('.live-transport time').textContent,price:document.querySelector('.price-block strong').textContent,footer:document.querySelector('.status-bar').textContent})")
    assert first['time']!=second['time'] and first['footer']!=second['footer'],(first,second)
    assert not await evaluate("!!document.querySelector('.webgl-fallback')")
    desktop=await screenshot('live-desktop.png',1440,1080)
    mobile=await screenshot('live-mobile.png',390,844,True)
    await click('[aria-label="Expand market field"]')
    await waitfor("!!document.querySelector('.field-expanded')")
    expanded_mobile=await screenshot('live-expanded-mobile.png',390,844,True)
    await click('[aria-label="Collapse market field"]')
    await call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1080,'deviceScaleFactor':1,'mobile':False})
    await evaluate('window.scrollTo(0,0)')
    # The UI must stop claiming LIVE when its own transport stops, retain last
    # prices with aging timestamps, and never substitute the historical replay.
    await proxy.drop()
    await asyncio.sleep(7)
    assert not await evaluate("!!document.querySelector('.live-badge')")
    assert await evaluate("!!document.querySelector('.connection-warning') && !!document.querySelector('.live-transport')")
    assert not await evaluate("!!document.querySelector('[aria-label=\"Historical replay controls\"]')")
    stale=await evaluate("document.querySelector('.live-price-time').textContent")
    await asyncio.sleep(2)
    assert stale!=await evaluate("document.querySelector('.live-price-time').textContent")
    proxy.outage=False
    await waitfor("!!document.querySelector('.live-badge')")
    await evaluate("document.querySelectorAll('.source-switch button')[1].click()")
    await waitfor("!!document.querySelector('[aria-label=\"Historical replay controls\"]')")
    assert await evaluate("document.querySelector('.cursor-time').textContent.includes('14:45')")
    assert not await evaluate("!!document.querySelector('.live-transport')")
    await click('[aria-label="Play replay"]')
    await waitfor("document.querySelector('.cursor-time').textContent.includes('14:50')")
    await proxy.drop();await asyncio.sleep(7);proxy.outage=False
    await waitfor("!document.querySelector('.connection-warning')")
    assert not await evaluate("document.querySelector('.cursor-time').textContent.includes('14:45')"), 'Replay rewound after reconnect'
    await click('[aria-label="Pause replay"]')
    await evaluate("document.querySelectorAll('.source-switch button')[0].click()")
    await waitfor("!!document.querySelector('.live-badge')")
    assert not await evaluate("!!document.querySelector('[aria-label=\"Historical replay controls\"]')")
    point=await evaluate("(()=>{const r=document.querySelector('[aria-label=\"Expand market field\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await call('Input.dispatchMouseEvent',{'type':'mousePressed',**point,'button':'left','clickCount':1})
    await call('Input.dispatchMouseEvent',{'type':'mouseReleased',**point,'button':'left','clickCount':1})
    await waitfor("!!document.fullscreenElement && !!document.querySelector('.live-transport')")
    native=await screenshot('live-fullscreen.png',1440,1080)
    await call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await waitfor("!document.fullscreenElement && !document.querySelector('.field-expanded')")
    await click('[aria-label="Explain the observations"]')
    assert 'WebSocket' in await evaluate("document.querySelector('.method-panel').textContent")
    assert not errors,errors
    report={'liveByDefault':'passed','realStreamAdvances':{'before':first,'after':second},'desktop':desktop,'mobile':mobile,'expandedMobile':expanded_mobile,'nativeFullscreen':native,'offlineShowsStaleWithoutReplay':'passed','lastTradeAgeContinuesOffline':'passed','automaticRecovery':'passed','liveReplaySwitch':'passed','replayReconnectPreservesCursor':'passed','methodDefinitions':'passed','javascriptExceptions':errors,'browserErrorsDuringOfflineTest':logs}
    (ROOT/'artifacts/checks/live-ui-check.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)
  finally:
   await proxy.close()
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':asyncio.run(main())
