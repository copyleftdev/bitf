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
    await evaluate("document.querySelectorAll('.layout-switch button')[1].click()")
    await asyncio.sleep(2)
    assert not await evaluate("!!document.querySelector('.webgl-fallback')")
    initial=await evaluate("({time:document.querySelector('.cursor-time').innerText,canvas:document.querySelectorAll('canvas').length,labels:document.querySelectorAll('.node-label').length,telemetry:document.querySelector('.telemetry').innerText,render:document.querySelector('.render-stats').innerText})")
    assert '14:45' in initial['time'],initial
    print('INITIAL',json.dumps(initial),flush=True)
    # Hover the plotted BTC observation using its visible axis and inspector measurements.
    point=await evaluate("(()=>{const ticks=[...document.querySelectorAll('.field-tick')];const center=t=>{const r=ticks.find(e=>e.textContent===t).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};const zero=center('0'),one=center('+1%'),four=center('4×'),top=center('64×');const ret=parseFloat(document.querySelector('.price-block>span').textContent),activity=parseFloat(document.querySelector('.asset-stats dd').textContent);return {x:zero.x+ret*(one.x-zero.x),y:four.y+(Math.log2(activity)-2)/4*(top.y-four.y)}})()")
    await call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':point['x'],'y':point['y']})
    await waitfor("!document.querySelector('.field-tooltip').hidden && document.querySelector('.field-tooltip strong').textContent.includes('BTC')")
    # Camera, relationship hierarchy and expanded playback, exercised through real UI events.
    browser_shortcuts=await evaluate("(()=>{const canvas=document.querySelector('canvas'),zoom=document.querySelector('[aria-label=\"Field zoom\"]').textContent;const events=[];for(const modifier of ['ctrlKey','metaKey','altKey'])for(const key of ['+','-','0']){const e=new KeyboardEvent('keydown',{key,[modifier]:true,bubbles:true,cancelable:true});canvas.dispatchEvent(e);events.push(!e.defaultPrevented)}return {preserved:events.every(Boolean),cameraUnchanged:zoom===document.querySelector('[aria-label=\"Field zoom\"]').textContent}})()")
    assert browser_shortcuts['preserved'] and browser_shortcuts['cameraUnchanged'],browser_shortcuts
    label_wheel=await evaluate("(()=>{const label=document.querySelector('.node-label.selected'),r=label.getBoundingClientRect();const e=new WheelEvent('wheel',{deltaY:-100,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true,cancelable:true});label.dispatchEvent(e);return e.defaultPrevented})()")
    assert label_wheel
    await waitfor("parseInt(document.querySelector('[aria-label=\"Field zoom\"]').textContent)>100")
    await click('[aria-label="Reset field view"]')
    await click('[aria-label="Zoom in"]')
    await waitfor("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='135%'")
    await click('[aria-label="Zoom to selected coin"]')
    await waitfor("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='250%'")
    await asyncio.sleep(.3)
    edge_labels=await evaluate("Array.from(document.querySelectorAll('.edge-label')).filter(e=>getComputedStyle(e).display!=='none').length")
    assert edge_labels>0,edge_labels
    edge_point=await evaluate("(()=>{const e=[...document.querySelectorAll('.edge-label')].find(e=>getComputedStyle(e).display!=='none'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':edge_point['x'],'y':edge_point['y']})
    await waitfor("!document.querySelector('.field-tooltip').hidden && document.querySelector('.field-tooltip').textContent.includes('paired 5m returns')")
    await call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':5,'y':5})

    focused=await screenshot('field-focused.png',1440,1080)
    await click('[aria-label="Expand market field"]')
    await waitfor("!!document.querySelector('.field-expanded')")
    expanded=await screenshot('field-expanded.png',1440,1080)
    await click('[aria-label="Play replay"]')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:50')")
    await click('[aria-label="Pause replay"]')
    assert await evaluate("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='250%'")
    await call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape'})
    await call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape'})
    await waitfor("!document.querySelector('.field-expanded')")
    await click('.event-jump')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:45')")
    await click('[aria-label="Reset field view"]')
    await waitfor("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='100%'")
    canvas=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.55,y:r.y+r.height*.5}})()")
    await call('Input.dispatchMouseEvent',{'type':'mouseWheel','x':canvas['x'],'y':canvas['y'],'deltaX':0,'deltaY':-160})
    await asyncio.sleep(.2)
    wheel_zoom=await evaluate("parseInt(document.querySelector('[aria-label=\"Field zoom\"]').textContent)")
    assert wheel_zoom>100,wheel_zoom
    await click('[aria-label="Zoom to selected coin"]')
    before=await evaluate("document.querySelector('.node-label.selected').style.transform")
    await call('Input.dispatchMouseEvent',{'type':'mousePressed','x':canvas['x'],'y':canvas['y'],'button':'left','clickCount':1})
    await call('Input.dispatchMouseEvent',{'type':'mouseMoved','x':canvas['x']+45,'y':canvas['y']+25,'buttons':1})
    await call('Input.dispatchMouseEvent',{'type':'mouseReleased','x':canvas['x']+45,'y':canvas['y']+25,'button':'left','clickCount':1})
    await asyncio.sleep(.3)
    after=await evaluate("document.querySelector('.node-label.selected').style.transform")
    assert before!=after,(before,after)
    await evaluate("document.querySelector('canvas').focus()")
    await call('Input.dispatchKeyEvent',{'type':'keyDown','key':'0','code':'Digit0'})
    await call('Input.dispatchKeyEvent',{'type':'keyUp','key':'0','code':'Digit0'})
    await waitfor("document.querySelector('[aria-label=\"Field zoom\"]').textContent==='100%'")
    await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Minimum field correlation\"]');s.value='0.95';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
    await waitfor("document.querySelector('.connection-count').textContent==='1 link'")
    await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Minimum field correlation\"]');s.value='0.65';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
    desktop=await screenshot('desktop.png',1440,1080)
    narrow=await screenshot('desktop-1280.png',1280,1024)
    mobile=await screenshot('mobile.png',390,844,True)
    await click('[aria-label="Expand market field"]')
    expanded_mobile=await screenshot('field-expanded-mobile.png',390,844,True)
    touch=await evaluate("(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*.5}})()")
    await call('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':touch['x']-30,'y':touch['y'],'id':1},{'x':touch['x']+30,'y':touch['y'],'id':2}]})
    await call('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':touch['x']-60,'y':touch['y'],'id':1},{'x':touch['x']+60,'y':touch['y'],'id':2}]})
    await call('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    await asyncio.sleep(.3)
    pinch_zoom=await evaluate("parseInt(document.querySelector('[aria-label=\"Field zoom\"]').textContent)")
    assert pinch_zoom>100,pinch_zoom
    await click('[aria-label="Collapse market field"]')
    await click('[aria-label="Reset field view"]')

    await call('Emulation.setDeviceMetricsOverride',{'width':1440,'height':1080,'deviceScaleFactor':1,'mobile':False})
    await click('[aria-label="Play replay"]')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:50')")
    await click('[aria-label="Pause replay"]')
    await waitfor("document.querySelector('[aria-label=\"Play replay\"]')")
    await click('[aria-label="Next observation"]')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:55')")
    await click('[aria-label="Previous observation"]')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:50')")
    await click('.event-jump')
    await waitfor("document.querySelector('.cursor-time').innerText.includes('14:45')")
    # Focus and all-pairs controls preserve the renderer and real node inventory.
    await click('[aria-label="Focus selected connections"]')
    assert await evaluate("document.querySelector('.field-actions button').getAttribute('aria-pressed')==='true'")
    await click('[aria-label="Toggle all pairs in field"]')
    await waitfor("document.querySelectorAll('.node-label').length===404")
    await click('[aria-label="Toggle all pairs in field"]')
    await click('[aria-label="Focus selected connections"]')
    # DOM labels and catalog both provide working coin selection.
    await click('.node-label[aria-label="Inspect ETH-USD"]')
    await waitfor("document.querySelector('.asset-heading h2').innerText.startsWith('ETH')")
    await click('nav button:last-child')
    await waitfor("document.querySelectorAll('tbody tr').length===404")
    await evaluate("(()=>{let s=document.querySelector('[aria-label=\"Coverage filter\"]');s.value='sparse';s.dispatchEvent(new Event('change',{bubbles:true}));})()")
    await waitfor("document.querySelectorAll('tbody tr').length===336")
    await evaluate("(()=>{let s=document.querySelector('[aria-label=\"Coverage filter\"]');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}));let x=document.querySelector('[aria-label=\"Search all coins\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'BTC');x.dispatchEvent(new Event('input',{bubbles:true}));})()")
    await waitfor("document.querySelectorAll('tbody tr').length<10")
    search=await evaluate("Array.from(document.querySelectorAll('tbody tr')).map(r=>r.cells[0].innerText)")
    assert search and all('BTC' in row for row in search),search
    await click('tbody button')
    await click('nav button:first-child')
    await click('[aria-label="Explain the observations"]')
    assert await evaluate("document.querySelector('.method-panel').innerText.includes('retrospective')")
    await click('[aria-label="Close explanation"]')
    await click('[aria-label="Reduce field motion"]')
    assert await evaluate("document.querySelector('[aria-label=\"Reduce field motion\"]').getAttribute('aria-pressed')==='true'")
    await call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-motion','value':'reduce'}]})
    assert await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
    # Range control moves to the first observed bar, with missing warmup values.
    await evaluate("(()=>{const s=document.querySelector('[aria-label=\"Replay timestamp\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s,'0');s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));})()")
    await waitfor("document.querySelector('.cursor-time').innerText.includes('04:45')")
    assert await evaluate("document.querySelector('.missing-rail').innerText.includes('68')")
    # WebGL loss produces a functional text fallback rather than a silent black chart.
    await evaluate("document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true}))")
    await waitfor("!!document.querySelector('.webgl-fallback')")
    assert not errors,errors
    shader_errors=[x for x in logs if any(y in x.get('text','') for y in ['THREE.WebGLProgram','VALIDATE_STATUS','Shader Error'])]
    assert not shader_errors,shader_errors
    report={'camera':{'wheelOverCoinLabel':label_wheel,'browserZoomShortcuts':browser_shortcuts,'nodeAndRelationshipHover':'passed','wheelZoom':wheel_zoom,'pinchZoom':pinch_zoom,'dragPan':'passed','keyboardReset':'passed','focusAndReset':'passed','expandedReplay':'passed','expandedEscape':'passed','visibleCorrelationLabels':edge_labels,'thresholdFilter':'passed'},'expandedDesktop':expanded,'expandedMobile':expanded_mobile,'initial':initial,'desktop':desktop,'narrowDesktop':narrow,'mobile':mobile,'playPauseStepSeek':'passed','independentKernelStreams':'covered by Python integration tests','searchMatches':search,'qualifiedAndAllPairs':'passed','sparseFilter':336,'coinSelection':'passed','methodPanel':'passed','reducedMotion':'passed','warmupMissingCoordinates':'passed','webglFallback':'passed','javascriptExceptions':errors,'browserErrors':logs,'renderer':'Headless Chrome / SwiftShader software; not a hardware performance claim'}
    (ROOT/'artifacts/checks/ui-check.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report),flush=True)
  finally:
   proc.terminate()
   try:proc.wait(timeout=5)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()

if __name__=='__main__':asyncio.run(main())
