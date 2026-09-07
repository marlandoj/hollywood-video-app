import {expect,test} from 'bun:test';
import {PreviewRuntimeCheck} from '../src/edit-preview-runtime';
import {EditPreviewSessions} from '../src/edit-preview-sessions';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+'hv-preview-runtime-')||realpathSync(root)!==root)throw new Error('Unsafe runtime fixture cleanup');rmSync(root,{recursive:true,force:true});}

test('nested runtime checks share a bounded read interval while response admission always verifies freshly',()=>{
  let at=0,calls=0,version='expected';const check=new PreviewRuntimeCheck(version,()=>{calls++;return version;},()=>at);
  check.check();for(let i=0;i<20;i++){at+=40;check.check();}expect(calls).toBe(1);
  at=1000;check.check();expect(calls).toBe(2);check.check(true);expect(calls).toBe(3);
  version='changed';at=1001;check.check();expect(calls).toBe(3);expect(()=>check.check(true)).toThrow('current media runtime');expect(calls).toBe(4);
  version='expected';at=3000;expect(()=>check.check()).toThrow('current media runtime');expect(calls).toBe(4);
});

test('slow delivery rechecks runtime, new requests do not share successful checks, and failed probes stay failed',()=>{
  let at=0,version='expected',calls=0;const read=()=>{calls++;return version;},check=new PreviewRuntimeCheck(version,read,()=>at);
  check.check();new PreviewRuntimeCheck(version,read,()=>at).check();expect(calls).toBe(2);
  version='changed';at=1000;expect(()=>check.check()).toThrow('current media runtime');
  const unavailable=new PreviewRuntimeCheck('expected',()=>{throw new Error('runtime unavailable');},()=>at);expect(()=>unavailable.check()).toThrow('unavailable');expect(()=>unavailable.check(true)).toThrow('unavailable');
});

test('session reads coalesce nested probes and reject a runtime change before returning a prepared result',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'hv-preview-runtime-'))),pool=new EditPreviewSessions(root),identity={id:'read',projectId:'project',sequenceId:'sequence',historyRevision:'a'.repeat(64)},original=Bun.spawnSync;let calls=0,changed=false,entered=false;
  try{
    await pool.start(identity,[],async()=>{});
    // Alter only the reported version in this isolated test; no executable, PATH or operator setting changes.
    (Bun as any).spawnSync=(...args:any[])=>{const result=(original as any)(...args);if(Array.isArray(args[0])&&args[0][0]==='ffmpeg'&&args[0][1]==='-version'){calls++;return changed?{...result,stdout:Buffer.concat([result.stdout,Buffer.from('\nfixture runtime change\n')])}:result;}return result;};
    expect(await pool.withSources(identity,async(_sources,permission)=>{for(let i=0;i<20;i++)await permission();return 'ready';})).toBe('ready');expect(calls).toBe(2);
    calls=0;await expect(pool.withSources(identity,async()=>{changed=true;return 'must not escape';})).rejects.toThrow('current media runtime');expect(calls).toBe(2);
    await expect(pool.withSources(identity,async()=>{entered=true;})).rejects.toThrow('current media runtime');expect(entered).toBe(false);
  }finally{Bun.spawnSync=original;await pool.close();cleanup(root);}
});
