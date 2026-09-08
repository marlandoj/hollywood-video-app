import {expect,test} from 'bun:test';
import {buildScriptNavigationIndex,createScriptNavigationState,scriptEntryKey,validateScriptNavigation} from '../src/edit-script-state.js';

import {scriptFixture} from './edit-script-fixture.js';

test('script navigation loads on demand, binds the request signal, and preserves data on the same saved identity',async()=>{
  const f=scriptFixture(),events=[],requests=[];let current=f.saved;const state=createScriptNavigationState({current:()=>current,onChange:value=>events.push(value.status),request:async(path,options)=>{requests.push({path,options});return f.data;}});state.bind(f.saved);expect(requests).toHaveLength(0);await state.load();expect(requests[0].path).toBe('/sequences/sequence/script?historyRevision='+f.saved.sequence.history.revision);expect(requests[0].options.signal).toBeInstanceOf(AbortSignal);expect(state.state.data).toBe(f.data);expect(events).toEqual(['idle','loading','ready']);expect(state.bind(structuredClone(f.saved))).toBe(false);current=null;expect(state.state.data).toBe(f.data);state.dispose();
});

test('late responses cannot replace a rebound sequence, a cancelled load, or a changed current history',async()=>{
  const f=scriptFixture(),pending=[];let current=f.saved;const state=createScriptNavigationState({current:()=>current,onChange(){},request:(path,{signal})=>new Promise(resolve=>pending.push({path,signal,resolve}))});state.bind(f.saved);const first=state.load();current={...f.saved,sequence:{...f.saved.sequence,history:{revision:'2'.repeat(64)}}};state.bind(current);expect(pending[0].signal.aborted).toBe(true);pending[0].resolve(f.data);await first;expect(state.state.status).toBe('idle');expect(state.state.data).toBeNull();
  const second=state.load();state.cancel();pending[1].resolve({...f.data,historyRevision:current.sequence.history.revision});await second;expect(state.state.status).toBe('cancelled');expect(state.state.data).toBeNull();
  const third=state.load();current={...current,sequence:{...current.sequence,history:{revision:'3'.repeat(64)}}};pending[2].resolve({...f.data,historyRevision:'2'.repeat(64)});await third;expect(state.state.status).toBe('error');expect(state.state.data).toBeNull();state.dispose();
});

test('navigation verifies source and timeline bindings but retains exact fractional ramp phases and held endpoints',()=>{
  const f=scriptFixture();expect(validateScriptNavigation(f.data,f.saved)).toBe(f.data);
  const ramp=structuredClone(f.data);ramp.occurrences[0].sourceStartSample=100+1/65536;ramp.occurrences[0].sourceEndSample=3199+32767/65536;expect(validateScriptNavigation(ramp,f.saved)).toBe(ramp);
  const held=structuredClone(ramp);held.occurrences[0].sourceEndSample=held.occurrences[0].sourceStartSample;held.occurrences[0].held=true;held.occurrences[0].muted=true;expect(validateScriptNavigation(held,f.saved)).toBe(held);
  for(const change of [value=>value.historyRevision='2'.repeat(64),value=>value.timelineRevision='2'.repeat(64),value=>value.sources[0].sourceRevision='2'.repeat(64),value=>value.occurrences[0].clipId='other',value=>value.occurrences[0].sourceEndSample=144001,value=>value.occurrences[0].sourceStartSample=.1,value=>value.occurrences[0].startSample=.5,value=>value.occurrences[0].endFrame=3]){const bad=structuredClone(f.data);change(bad);expect(()=>validateScriptNavigation(bad,f.saved)).toThrow('changed');}
});

test('occurrence lookup retains duplicate, held, transition and independent-lane ranges',()=>{
  const f=scriptFixture();f.data.occurrences.push({...f.occurrence,id:'held',startSample:1600,endSample:4800,startFrame:1,endFrame:3,sourceStartSample:100,sourceEndSample:100,held:true,muted:true},{...f.occurrence,id:'borrowed',clipId:'picture',lane:'picture',transition:true});const index=buildScriptNavigationIndex(f.data),key=scriptEntryKey('original','line-1');expect(index.byEntry.get(key)).toHaveLength(3);expect(index.active('original',1,'dialogue').map(item=>item.id).sort()).toEqual(['held','speech']);expect(index.active('original',2,'dialogue').map(item=>item.id)).toEqual(['held']);expect(index.active('original',3,'dialogue')).toEqual([]);expect(index.active('original',1,'picture').map(item=>item.id)).toContain('borrowed');expect(index.active('another',1)).toEqual([]);
});

test('the playhead interval index prunes a large source rather than reading every occurrence each frame',()=>{
  const f=scriptFixture();let reads=0;const occurrences=Array.from({length:99999},(_,i)=>{const item={...f.occurrence,id:String(i),endFrame:i+1};Object.defineProperty(item,'startFrame',{enumerable:true,get(){reads++;return i;}});return item;});occurrences.push({...f.occurrence,id:'long-scene',entryId:'scene',startFrame:0,endFrame:100000});const index=buildScriptNavigationIndex({...f.data,occurrences});reads=0;expect(index.active('original',50000,'dialogue').map(item=>item.id).sort()).toEqual(['50000','long-scene']);expect(reads).toBeLessThan(100);expect(index.entries.get(scriptEntryKey('original','line-1')).search).toContain('hola.');
});
