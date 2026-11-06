"""Browser integration evidence for the built observatory; server must be on :8876."""
import asyncio,base64,json,subprocess,tempfile,urllib.request
from pathlib import Path
from websockets.asyncio.client import connect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/screenshots'
OUT.mkdir(parents=True,exist_ok=True)

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
    await call('Page.navigate',{'url':'http://127.0.0.1:8876/?mode=live'})
    await waitfor("document.querySelector('.live-badge') && document.querySelector('.price-path') && document.querySelectorAll('.node-label').length>0")
    await asyncio.sleep(3)
    await screenshot('market-live.png',1440,1080)
    point=await evaluate("(()=>{const r=document.querySelector('[aria-label=\"Expand market field\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await call('Input.dispatchMouseEvent',{'type':'mousePressed',**point,'button':'left','clickCount':1})
    await call('Input.dispatchMouseEvent',{'type':'mouseReleased',**point,'button':'left','clickCount':1})
    await waitfor("!!document.fullscreenElement")
    await screenshot('market-fullscreen.png',1440,1080)
    assert not errors,errors
    print('Saved docs/screenshots/market-live.png and market-fullscreen.png',flush=True)
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':asyncio.run(main())
