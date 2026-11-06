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
    async def press(selector):
     point=await evaluate(f"(()=>{{const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}}}})()")
     await call('Input.dispatchMouseEvent',{'type':'mousePressed',**point,'button':'left','clickCount':1})
     await call('Input.dispatchMouseEvent',{'type':'mouseReleased',**point,'button':'left','clickCount':1})
    await press('[aria-label="Zoom to selected coin"]')
    await waitfor("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='250%'")
    await press('[aria-label="Expand market field"]')
    await waitfor("document.fullscreenElement===document.querySelector('.app-shell')")
    assert await evaluate("document.querySelector('.app-shell').classList.contains('field-expanded')")
    await asyncio.sleep(.4)
    shot=await call('Page.captureScreenshot',{'format':'png'})
    (OUT/'field-native-fullscreen.png').write_bytes(base64.b64decode(shot['data']))
    await press('[aria-label="Play replay"]')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:50')")
    await press('[aria-label="Pause replay"]')
    await press('[aria-label="Collapse market field"]')
    await waitfor("!document.fullscreenElement && !document.querySelector('.field-expanded')")
    assert await evaluate("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='250%'")
    assert await evaluate("document.querySelector('.cursor-time').textContent.includes('14:50')")
    await press('[aria-label="Expand market field"]')
    await waitfor("!!document.fullscreenElement")
    await evaluate("document.exitFullscreen()")
    await waitfor("!document.fullscreenElement && !document.querySelector('.field-expanded')")
    assert await evaluate("document.activeElement===document.querySelector('[aria-label=\"Expand market field\"]')")
    assert await evaluate("document.body.style.overflow!== 'hidden'")
    await press('[aria-label="Expand market field"]')
    await waitfor("!!document.fullscreenElement")
    await call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await waitfor("!document.fullscreenElement && !document.querySelector('.field-expanded')")
    await evaluate("window.originalRequestFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=undefined")
    await press('[aria-label="Expand market field"]')
    await waitfor("!!document.querySelector('.field-expanded') && !!document.querySelector('.fullscreen-notice')")
    assert await evaluate("!document.fullscreenElement && !document.querySelector('[aria-label=\"Collapse market field\"]').disabled")
    await press('[aria-label="Collapse market field"]')
    await waitfor("!document.querySelector('.field-expanded')")
    await evaluate("Element.prototype.requestFullscreen=function(){return Promise.reject(new DOMException('Test policy rejection','NotAllowedError'))}")
    await press('[aria-label="Expand market field"]')
    await waitfor("!!document.querySelector('.fullscreen-notice')")
    assert await evaluate("!document.fullscreenElement")
    await call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27})
    await waitfor("!document.querySelector('.field-expanded')")
    await evaluate("Element.prototype.requestFullscreen=window.originalRequestFullscreen")
    assert not errors,errors
    report={'nativeFullscreenWithTrustedClick':'passed','collapseExitsNativeFullscreen':'passed','browserOwnedExitSynchronizesLayout':'passed','escapeExitsFullscreen':'passed','cameraAndReplayPreserved':'passed','focusAndScrollRestored':'passed','unsupportedFallback':'passed','rejectedRequestFallback':'passed','javascriptExceptions':errors,'browserErrors':logs}
    (ROOT/'artifacts/checks/fullscreen-check.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':asyncio.run(main())
