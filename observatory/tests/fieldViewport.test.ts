import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_VIEW,boundedView,project,unproject,zoomAt,panBy} from '../src/fieldViewport.ts';
const bounds={left:64,top:36,width:900,height:500};
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('projection inverts across viewport sizes and camera states',()=>{
 for(const b of [bounds,{left:48,top:36,width:270,height:310}])for(const view of [DEFAULT_VIEW,{zoom:2.5,x:.3,y:.2},{zoom:6,x:-.7,y:.7}])for(const [x,y]of [[0,0],[-1,1],[.34,.6]]){
  const screen=project(x,y,view,b),back=unproject(...screen,view,b);near(back[0],x);near(back[1],y);
 }
});
test('zoom preserves the data under the pointer away from domain boundaries',()=>{
 const x=600,y=240,anchor=unproject(x,y,DEFAULT_VIEW,bounds),view=zoomAt(DEFAULT_VIEW,2,x,y,bounds),after=unproject(x,y,view,bounds);
 near(anchor[0],after[0]);near(anchor[1],after[1]);
});
test('zoom and panning stay within the observed domain',()=>{
 assert.deepEqual(boundedView({zoom:.1,x:99,y:-99}),DEFAULT_VIEW);
 const view=boundedView({zoom:99,x:99,y:-99});near(view.zoom,6);near(view.x,5/6);near(view.y,-5/6);
 assert.deepEqual(panBy(DEFAULT_VIEW,500,-500,bounds),DEFAULT_VIEW);
});
test('drag carries a stationary data point with the pointer',()=>{
 const before={zoom:2.5,x:0,y:0},after=panBy(before,45,-30,bounds),a=project(0,0,before,bounds),b=project(0,0,after,bounds);
 near(b[0]-a[0],45);near(b[1]-a[1],-30);
});
