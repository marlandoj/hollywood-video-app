import {expect,test} from "bun:test";
import {castingSnapshot} from "../src/casting";
import {directionSnapshot} from "../src/direction";
import {validateLivingScriptSettings} from "../src/living-script-settings";

const baseline={casting:castingSnapshot("project",1,[],1000),direction:directionSnapshot("project",2,[],1000)};
test("pending settings preserve exact current snapshots or review their explicit next versions",()=>{
  expect(validateLivingScriptSettings(baseline,baseline,"project")).toEqual(baseline);
  const candidate={casting:castingSnapshot("project",2,[],2000),direction:directionSnapshot("project",3,[],2000)};
  const result=validateLivingScriptSettings(baseline,candidate,"project");expect(result).toEqual(candidate);
  result.casting.version=10;expect(candidate.casting.version).toBe(2);expect(baseline.casting.version).toBe(1);
});
test("changed snapshots cannot silently reset, reuse a version, skip a version or predate baseline",()=>{
  const invalid=[{}, {...baseline,casting:castingSnapshot("project",1,[],2000)}, {...baseline,direction:directionSnapshot("project",4,[],2000)}, {...baseline,direction:directionSnapshot("project",3,[],999)}, {...baseline,casting:castingSnapshot("project",0,[],0)}];
  for(const candidate of invalid)expect(()=>validateLivingScriptSettings(baseline,candidate,"project")).toThrow("next explicit snapshot");
});
test("canonical empty settings are explicit baseline identities and foreign bindings fail",()=>{
  const empty={casting:castingSnapshot("project",0,[],0),direction:directionSnapshot("project",0,[],0)};
  expect(validateLivingScriptSettings(empty,{},"project")).toEqual(empty);
  expect(()=>validateLivingScriptSettings({...empty,direction:directionSnapshot("other",0,[],0)},empty,"project")).toThrow();
  expect(()=>validateLivingScriptSettings(empty,{casting:castingSnapshot("other",1,[],1)},"project")).toThrow();
});
test("normalizing a snapshot cannot discard an extra field from the reviewed request",()=>{
  const alteredBaseline={...baseline,direction:{...baseline.direction,unreviewed:"extra"}},alteredCandidate={...baseline,casting:{...baseline.casting,unreviewed:"extra"}};
  expect(()=>validateLivingScriptSettings(alteredBaseline,baseline,"project")).toThrow();
  expect(()=>validateLivingScriptSettings(baseline,alteredCandidate,"project")).toThrow();
});
