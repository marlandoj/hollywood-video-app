/**
 * Writes the studio's looks (HV-026-07): one `.cube` per look in the library, from the functions that
 * author them in packages/planner/src/color-grade.ts, and prints each file's digest and size for that
 * module's `COLOR_LOOKS` table.
 *
 *   bun scripts/color-looks.ts
 *
 * No LUT is downloaded. A test holds the shipped files, the authoring functions and the recorded
 * digests to one another, so a look edited in one place and not the others is refused.
 */
import {createHash} from "node:crypto";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {COLOR_LOOK_IDS,colorLookCube,colorLookFile} from "../packages/planner/src/color-grade";

const root=join(import.meta.dir,"..");
for(const id of COLOR_LOOK_IDS){
  const text=colorLookCube(id),path=join(root,colorLookFile(id));
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,text);
  console.log(id+"\tsha256:"+createHash("sha256").update(text).digest("hex")+"\tbytes:"+Buffer.byteLength(text));
}
