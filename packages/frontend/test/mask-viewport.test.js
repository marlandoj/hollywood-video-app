import {expect,test} from 'bun:test';
import {mountMaskViewport} from '../src/mask-viewport.js';

// Exercise pointer transaction boundaries without substituting another rasterizer.
function harness(kind='rectangle'){
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document'),events=new Map(),context=new Proxy({},{get:(target,key)=>target[key]??(()=>{})}),canvas={width:0,height:0,style:{},setAttribute(){},focus(){},setPointerCapture(){},getContext:()=>context,getBoundingClientRect:()=>({left:0,top:0,width:640,height:360}),addEventListener:(type,fn)=>events.set(type,fn)},changes=[],errors=[];
  globalThis.document={createElement:tag=>tag==='canvas'?canvas:{}};
  const viewport=mountMaskViewport({parent:{append(){}},source:{width:320,height:180},onGeometry:value=>changes.push(structuredClone(value)),onVertex(){},onError:value=>errors.push(value),canChange:()=>true}),geometry=kind==='polygon'?{points:[{id:'a',xQ16:16384,yQ16:16384},{id:'b',xQ16:49152,yQ16:16384},{id:'c',xQ16:49152,yQ16:49152}]}:{xQ16:16384,yQ16:16384,widthQ16:32768,heightQ16:32768};viewport.set({geometry,kind,selectedVertex:'a',mode:'source',frame:0});
  return {viewport,changes,errors,geometry,fire:(type,values={})=>events.get(type)?.({clientX:0,clientY:0,pointerId:1,preventDefault(){},...values}),restore(){viewport.dispose();if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}};
}

test('drawing a box commits once on release and cancellation preserves the existing authored geometry',()=>{
  const h=harness();try{h.viewport.draw();h.fire('pointerdown',{clientX:64,clientY:36});h.fire('pointermove',{clientX:320,clientY:180});expect(h.changes).toHaveLength(0);h.fire('pointerup');expect(h.changes).toEqual([{xQ16:6554,yQ16:6554,widthQ16:26214,heightQ16:26214}]);expect(h.viewport.drawing).toBe(false);
    h.viewport.draw();h.fire('pointerdown',{clientX:160,clientY:90});h.fire('pointermove',{clientX:600,clientY:300});h.fire('pointercancel');expect(h.changes).toHaveLength(1);expect(h.viewport.drawing).toBe(false);
    h.fire('keydown',{key:'ArrowRight'});expect(h.changes.at(-1).xQ16).toBe(6554+205);expect(h.changes.at(-1).widthQ16).toBe(26214);
  }finally{h.restore();}
});

test('polygon tracing requires three vertices, commits stable IDs at finish, and Escape cancels an incomplete trace',()=>{
  const h=harness('polygon');try{h.viewport.draw();h.fire('pointerdown',{clientX:64,clientY:36});h.fire('pointerdown',{clientX:320,clientY:36});expect(()=>h.viewport.finishPolygon()).toThrow('three');expect(h.changes).toHaveLength(0);h.fire('pointerdown',{clientX:320,clientY:180});h.fire('keydown',{key:'Enter'});expect(h.changes).toHaveLength(1);expect(h.changes[0].points.map(p=>[p.xQ16,p.yQ16])).toEqual([[6554,6554],[32768,6554],[32768,32768]]);expect(new Set(h.changes[0].points.map(p=>p.id)).size).toBe(3);expect(h.viewport.drawing).toBe(false);
    h.viewport.draw();h.fire('pointerdown',{clientX:500,clientY:100});h.fire('keydown',{key:'Escape'});expect(h.changes).toHaveLength(1);expect(h.viewport.drawing).toBe(false);
  }finally{h.restore();}
});

test('a selected vertex supports source-pixel keyboard precision and does not move its neighboring vertices',()=>{
  const h=harness('polygon');try{h.fire('keydown',{key:'ArrowRight',shiftKey:true});expect(h.changes[0].points[0]).toEqual({...h.geometry.points[0],xQ16:18432});expect(h.changes[0].points.slice(1)).toEqual(h.geometry.points.slice(1));h.fire('keydown',{key:'ArrowDown',altKey:true});expect(h.changes[1].points[0].yQ16).toBe(16420);expect(h.errors).toEqual([]);}finally{h.restore();}
});
