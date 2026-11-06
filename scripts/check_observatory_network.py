"""Browser integration evidence for the built observatory; server must be on :8876."""
import asyncio,base64,json,subprocess,tempfile,urllib.request
from pathlib import Path
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/screenshots'
OUT.mkdir(parents=True,exist_ok=True)
(ROOT/'artifacts/checks').mkdir(parents=True,exist_ok=True)

async def main():
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
    await call('Page.navigate',{'url':'http://127.0.0.1:8876/?mode=replay'})
    await waitfor("document.querySelector('.price-path') && document.querySelectorAll('.node-label').length>=68")
    await asyncio.sleep(3)
    assert await evaluate("document.querySelector('.field-mode-network') && !document.querySelector('.field-tick')")
    assert not await evaluate("!!document.querySelector('.webgl-fallback')")
    sample="({position:document.querySelector('.node-label.selected').style.transform,time:document.querySelector('.cursor-time').textContent,price:document.querySelector('.price-block').textContent})"
    first=await evaluate(sample);await asyncio.sleep(2);second=await evaluate(sample)
    assert first['position']!=second['position'],(first,second)
    assert first['time']==second['time'] and first['price']==second['price'],(first,second)
    await click('[aria-label="Freeze network motion"]');await asyncio.sleep(2.5)
    first=await evaluate(sample);await asyncio.sleep(1);second=await evaluate(sample)
    assert first==second,(first,second)
    assert 'idle' in (await evaluate("document.querySelector('.render-stats').innerText")).lower()
    desktop=await screenshot('network-desktop.png',1440,1080)
    assert second['position']==(await evaluate(sample))['position'], 'Viewport capture changed a frozen layout'
    await click('[aria-label="Expand market field"]')
    await waitfor("!!document.querySelector('.field-expanded')")
    expanded=await screenshot('network-expanded.png',1440,1080)
    mobile=await screenshot('network-expanded-mobile.png',390,844,True)
    await click('[aria-label="Collapse market field"]')
    narrow=await screenshot('network-mobile.png',390,844,True)
    await click('[aria-label="Freeze network motion"]');await asyncio.sleep(1)
    await evaluate('window.scrollTo(0, document.body.scrollHeight)');await asyncio.sleep(.5)
    offscreen_first=await evaluate(sample);await asyncio.sleep(1);offscreen_second=await evaluate(sample)
    assert offscreen_first['position']==offscreen_second['position'], 'Offscreen motion must sleep'
    await evaluate('window.scrollTo(0,0)');await asyncio.sleep(1)
    await call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1080,'deviceScaleFactor':1,'mobile':False})
    await asyncio.sleep(1)
    first=await evaluate(sample);await asyncio.sleep(1);second=await evaluate(sample)
    assert first['position']!=second['position']
    await call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-motion','value':'reduce'}]})
    await asyncio.sleep(2.5)
    first=await evaluate(sample);await asyncio.sleep(.5);second=await evaluate(sample)
    assert first==second
    assert await evaluate("document.querySelector('[aria-label=\"Freeze network motion\"]').disabled")
    await call('Emulation.setEmulatedMedia',{'features':[]})
    await click('[aria-label="Toggle all pairs in field"]')
    await waitfor("document.querySelectorAll('.node-label').length===404")
    await asyncio.sleep(3)
    assert not await evaluate("!!document.querySelector('.webgl-fallback')")
    allpairs=await screenshot('network-all-pairs.png',1440,1080)
    await evaluate("document.querySelectorAll('.layout-switch button')[1].click()")
    await waitfor("document.querySelectorAll('.field-tick').length>0")
    assert first['time']==(await evaluate(sample))['time']
    assert not errors,errors
    assert not logs,logs
    report={'networkDefault':'passed','motionWhileReplayPaused':'passed','measurementsUnchanged':'passed','freezeAndResume':'passed','offscreenSuspension':'passed','frozenViewportTransition':'passed','reducedMotion':'passed','metricView':'passed','all404Pairs':'passed','desktop':desktop,'expanded':expanded,'mobileExpanded':mobile,'mobile':narrow,'allPairs':allpairs,'javascriptExceptions':errors,'browserErrors':logs}
    (ROOT/'artifacts/checks/network-check.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':asyncio.run(main())
