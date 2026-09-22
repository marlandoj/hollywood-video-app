/**
 * HV-040-06 — a backup that indexed no recording at all, and said it was healthy.
 *
 * The studio keeps creator media in the private bucket under three families of key: a render's
 * artifacts (rows in `hv_artifacts`), a character's reference images (keys derived from the
 * project body), and a creator's uploaded sound recordings (keys derived from the same body).
 * Three places in this package have to know all three: the orphan sweeper shields them, the
 * project archive copies them, and the backup indexes them.
 *
 * Two of the three knew about sound. `createStorageBackup` did not — so a backup of a studio with a
 * sound library carried the database and none of the recordings, `verifyStorageBackup` passed
 * (it verifies the blobs the manifest names, and the manifest named none), the restore's four
 * counts and one sum matched, and the restored studio's sound libraries all pointed at nothing.
 *
 * The shape check would have refused the key if anyone had tried to add it: a recording's digest
 * lives in the *last* segment, not its own, so it failed the reference family's `parts[3] === sha256`.
 *
 * These tests need no database. The end-to-end proof is in `backups.test.ts` and runs where
 * PostgreSQL and a bucket exist.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {projectBackupObjects,validateBackupObject} from "../src/backups";
import {referenceObjectKey} from "../../planner/src/references";
import {soundAssetObjectKey,type SoundLibrary} from "../../planner/src/sound-assets";
import {contentHash} from "../../generator/src/capabilities";
import {soundFixture} from "../../../test/fixtures/sound";

const PROJECT="11111111-2222-4333-8444-555555555555";
const sha=(seed:string)=>contentHash(seed);
const reference=(id:string,digest:string)=>({schema:"hv-reference/1" as const,id,projectId:PROJECT,sha256:digest,
  originalSha256:sha(digest+"-original"),contentType:"image/png" as const,bytes:4096,width:512,height:512,
  createdAt:"2026-09-22T00:00:00.000Z",attestedAt:"2026-09-22T00:00:00.000Z"});

/** A sound library the validator accepts: one asset, one admission event, version equal to its count. */
function library(projectId:string){
  const {asset,wav}=soundFixture(projectId);
  const data={version:1,assetId:asset.id,available:true,at:asset.createdAt};
  return {wav,asset,value:{schema:"hv-sound-library/1",version:1,assets:[asset],
    events:[{...data,revision:contentHash(data)}]} as unknown as SoundLibrary};
}

test("a recording's key is a backup object shape, and a wrong digest in it is still refused",()=>{
  const {asset}=library(PROJECT);
  for(const kind of ["original","audio"] as const){
    const key=soundAssetObjectKey(asset,kind);
    // The shape this increment added: v1/<project>/sounds/<asset>/<kind>-<sha256>.wav
    expect(key.split("/").slice(0,3)).toEqual(["v1",PROJECT,"sounds"]);
    expect(validateBackupObject({key,sha256:asset[kind].sha256,bytes:asset[kind].bytes})).toMatchObject({key});
    // The digest still has to be the one in the key, which is the whole point of a content address.
    expect(()=>validateBackupObject({key,sha256:sha("another file"),bytes:asset[kind].bytes}))
      .toThrow("does not match its content address");
    // And the kind in the key has to be one of the two that exist.
    expect(()=>validateBackupObject({key:key.replace(/\/(original|audio)-/,"/master-"),sha256:asset[kind].sha256,bytes:1}))
      .toThrow("does not match its content address");
  }
});

test("the other two families are unchanged, and nothing else is accepted",()=>{
  const digest=sha("a reference image");
  const key=referenceObjectKey(reference("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",digest));
  expect(validateBackupObject({key,sha256:digest,bytes:4096})).toMatchObject({key});
  const archive="archives/"+PROJECT+"/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/"+sha("an archive")+".zip";
  expect(validateBackupObject({key:archive,sha256:sha("an archive"),bytes:10})).toMatchObject({key:archive});
  for(const bad of ["v1/"+PROJECT+"/sounds/../"+sha("x")+".wav","v1/"+PROJECT+"/sounds/only-four/parts",
    "somewhere/"+PROJECT+"/sounds/aaaa/original-"+sha("x")+".wav"])
    expect(()=>validateBackupObject({key:bad,sha256:sha("x"),bytes:1})).toThrow();
});

test("a project's own body names two objects per recording and one per reference image",()=>{
  const digest=sha("a reference image"),sound=library(PROJECT);
  const objects=projectBackupObjects(PROJECT,{
    referenceAssets:[reference("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",digest)],
    soundLibrary:sound.value});
  expect(objects).toHaveLength(3);
  expect(objects.map(object=>object.key).filter(key=>key.includes("/sounds/")).sort())
    .toEqual([soundAssetObjectKey(sound.asset,"audio"),soundAssetObjectKey(sound.asset,"original")].sort());
  // Each object carries the bytes the body says it has, which is what the restore checks against.
  for(const object of objects)expect(object.bytes).toBeGreaterThan(0);
  // A body with neither family names nothing, rather than guessing.
  expect(projectBackupObjects(PROJECT,{})).toEqual([]);
  // A library belonging to another project is refused rather than indexed under this one.
  expect(()=>projectBackupObjects(PROJECT,{soundLibrary:library("22222222-3333-4444-8555-666666666666").value})).toThrow();
});

test("the three places that know about an object family all know about both of them",()=>{
  // This is the guard that would have caught it. The sweeper shields these keys, the archive copies
  // them, and the backup indexes them; each file names both families or the studio loses one of
  // them somewhere. Asserted over the source because the failure is an omission, and an omission
  // has nothing to assert about at run time.
  const files=["../src/backups.ts","../src/retention.ts","../src/archives.ts"];
  for(const file of files){
    const source=readFileSync(new URL(file,import.meta.url),"utf8");
    expect({file,references:/referenceObjectKey|referenceAssets|ReferenceBlobStore/.test(source)}).toEqual({file,references:true});
    expect({file,sounds:/soundAssetObjectKey|soundLibrary|SoundBlobStore/.test(source)}).toEqual({file,sounds:true});
  }
});
