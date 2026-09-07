import {expect,test} from 'bun:test';
import {PreviewClock} from '../src/preview-clock.js';
test('device time selects historical playback anchors across queued silence, resume, pause and seek',()=>{
  const c=new PreviewClock();c.reset(1,127,0);c.pictureThrough(60);for(const event of [{state:'playing',at:0,contextFrame:0},{state:'buffering',at:4800,contextFrame:4800},{state:'playing',at:4800,contextFrame:9600},{state:'paused',at:9600,contextFrame:14400}])c.accept({epoch:1,...event});
  expect(c.position(0.05)).toMatchObject({at:2400,state:'playing'});expect(c.position(0.15)).toMatchObject({at:4800,state:'buffering'});expect(c.position(0.25)).toMatchObject({at:7200,state:'playing'});expect(c.position(0.35)).toMatchObject({at:9600,state:'paused'});
  c.reset(2,127,201600);c.pictureThrough(127);c.accept({epoch:1,state:'playing',at:0,contextFrame:15000});expect(c.anchors.length).toBe(0);c.accept({epoch:2,state:'playing',at:201600,contextFrame:20000});c.accept({epoch:2,state:'ended',at:203200,contextFrame:21600});expect(c.position(1)).toEqual({at:203200,frame:126,state:'ended'});
});
test('clock state is bounded and cannot extrapolate beyond known picture coverage',()=>{
  const c=new PreviewClock();c.reset(1,127,0);c.pictureThrough(60);for(let i=0;i<256;i++)c.accept({epoch:1,state:'playing',at:i*128,contextFrame:i*128});expect(c.anchors.length).toBe(128);expect(c.position(10)).toMatchObject({at:96000,frame:59});expect(()=>c.accept({epoch:1,state:'playing',at:0,contextFrame:0})).toThrow('backwards');
});
