/**
 * HV-021-05 — a contradiction the repair will not resolve was named only when there was nothing else
 * to say.
 *
 * HV-021-04 closed this on one branch:
 *
 * > "Nothing in this film's declared look contradicts itself" was said whenever there were no edits
 * > -- including for a film whose only defect is a scene directed against its own heading. The
 * > report held a warning and the headline said there was none.
 *
 * It computed `contradictions` at the top of the function and then consulted it **inside the
 * empty-edits branch only**. So a film with a repairable drift in one scene and a scene directed
 * against its own heading in another got "Hold key light across 1 shot, matching the first shot
 * that states each." and nothing else. The note was in the payload; the one line a creator reads
 * before accepting said nothing about it.
 *
 * That is the worse half of the same defect. A creator who accepts an empty proposal has applied
 * nothing and may go looking; a creator who accepts this one has applied the repair and has every
 * reason to believe the continuity pass is done.
 *
 * Nothing caught it because the existing cases are empty-edits-with-contradiction,
 * empty-edits-without and edits-without. The case with both was the one nobody wrote.
 */
import {expect,test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../src/index";
import {castingSnapshot,characterRecord} from "../src/casting";
import {directionEntry,directionSnapshot} from "../src/direction";
import {continuityReport} from "../src/continuity";
import {CONTINUITY_REPAIR_CONTRADICTIONS,continuityRepair,continuityRepairSummary} from "../src/continuity-repair";

const now=Date.UTC(2026,8,22);
const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nMARGUERITE\nThe light has to hold.\n\nTOMAS\nIt will hold.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
const parsed=parseFountain(SCRIPT),shots=planShots(parsed,7000,24);
const permission={status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:new Date(now).toISOString()};
const actor=(name:string)=>characterRecord({name,aliases:[],kind:"original-fictional",appearance:"A keeper of the light.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"",wardrobe:[],sceneBindings:[],permission},
  name==="MARGUERITE"?"aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa":"bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",now,true);
const cast=castingSnapshot("project-1",1,[actor("MARGUERITE"),actor("TOMAS")],now);
const report=(entries:ReturnType<typeof directionEntry>[])=>continuityReport(shots,cast,directionSnapshot("project-1",1,entries,now),parsed);

/** A film with both: a key light that drifts between two shots, and a shot fighting its heading. */
const both=()=>continuityRepair(report([
  directionEntry(shots[0]!,{timeOfDay:"night",keyLight:"The lamp above"}),
  directionEntry(shots[1]!,{keyLight:"Moon through glass"}),
]));

test("a film with something to repair and something that cannot be says both",()=>{
  const proposal=both();
  // The shape this case needs, asserted rather than assumed: there is a repair, and there is a
  // contradiction the repair deliberately will not resolve.
  expect(proposal.edits.length).toBeGreaterThan(0);
  expect(proposal.refused).toContain("time-contradicts-heading");
  const summary=continuityRepairSummary(proposal);
  // The headline the creator reads before accepting. It used to stop at the first sentence.
  expect(summary).toStartWith("Hold key light across 1 shot, matching the first shot that states each.");
  expect(summary).toBe("Hold key light across 1 shot, matching the first shot that states each."
    +" What is left cannot be repaired automatically: time-contradicts-heading. Read the notes.");
});

test("and every contradiction it will not resolve is named, wherever it is said",()=>{
  // One list, one instruction, two sentences. The point is that the two branches cannot come to name
  // the contradictions differently: whatever the empty proposal would have said about them, the
  // proposal with edits says too.
  const proposal=both();
  const empty={...proposal,edits:[]};
  for (const code of proposal.refused.filter(value=>CONTINUITY_REPAIR_CONTRADICTIONS.includes(value))) {
    expect(continuityRepairSummary(proposal)).toContain(code);
    expect(continuityRepairSummary(empty)).toContain(code);
  }
  expect(continuityRepairSummary(empty)).toEndWith("time-contradicts-heading. Read the notes.");
  expect(continuityRepairSummary(proposal)).toEndWith("time-contradicts-heading. Read the notes.");
});

test("and a repair with nothing standing against it is still one sentence",()=>{
  // The note is news. A film whose drift is the whole of its trouble gets the headline it always had,
  // and a headline that ended "Read the notes." every time would be one to stop reading.
  const proposal=continuityRepair(report([
    directionEntry(shots[0]!,{timeOfDay:"day",keyLight:"The lamp above"}),
    directionEntry(shots[1]!,{keyLight:"Moon through glass"}),
  ]));
  expect(proposal.edits.length).toBeGreaterThan(0);
  expect(proposal.refused).not.toContain("time-contradicts-heading");
  expect(continuityRepairSummary(proposal)).toBe("Hold key light across 1 shot, matching the first shot that states each.");
  // And an unknown beside it is not a contradiction: a wardrobe nobody stated is not a declared look
  // fighting itself, and the headline must not be made noisy by one.
  expect(proposal.notes.length).toBeGreaterThan(0);
});
