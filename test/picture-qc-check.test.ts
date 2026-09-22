import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {contentHash} from "../packages/generator/src/capabilities";
import {PICTURE_QC_RECIPE,pictureQcFindings,pictureQcReport,validatePictureQcReport,type PictureQcReport} from "../packages/planner/src/picture-qc";

/**
 * HV-026-02: the first quality check run against a film this studio actually delivered, read from
 * the record made on private staging. The numbers are re-derived from the contract and from the
 * measurement wherever they can be, so the record cannot drift from the code that produced it — and
 * the film's own facts are cross-checked against the hand-measured record of the same film.
 */
const REPO=resolve(import.meta.dir,"..");
const json=(path:string)=>JSON.parse(readFileSync(resolve(REPO,path),"utf8"));
const check=json("docs/evidence/hv026-finishing/first-check.json");
const voiced=json("docs/evidence/release-2/elevenlabs-voiced.json");
const report=check.report as PictureQcReport;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("the record is a report this recipe could have produced, and it is re-derived rather than trusted",()=>{
  expect(check.schema).toBe("hv-picture-qc-check/1");
  expect(report.schema).toBe("hv-picture-qc/1");
  // The recipe the check was made by is this recipe, not a description of one.
  expect(report.recipeRevision).toBe(contentHash(PICTURE_QC_RECIPE));
  expect(report.notChecked).toEqual([...PICTURE_QC_RECIPE.notChecked]);
  // Findings and verdict are recomputed from the recorded measurement, so neither can be edited here.
  const rebuilt=pictureQcReport({programme:report.programme,picture:report.picture,sound:report.sound},report.source,report.runtimeRevision);
  expect(rebuilt).toEqual(report);
  expect(validatePictureQcReport(report)).toEqual(report);
  expect(report.source.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(check.film.objectKey).toContain(report.source.sha256);
});

test("the check agrees, number for number, with the same film measured by hand",()=>{
  const output=voiced.film.output;
  expect(report.programme.durationSec).toBe(output.durationSec);
  expect(report.programme.video).toBe(output.video);
  expect(report.programme.audio).toBe(output.audio);
  expect(report.programme.sampleRate).toBe(output.sampleRate);
  expect(report.programme.channels).toBe(output.channels);
  expect(report.programme.bytes).toBe(output.bytes);
  expect(report.source.bytes).toBe(output.bytes);
  // The two levels the release evidence had been recording by hand, now produced by code.
  expect(report.sound.meanVolumeDb).toBe(output.meanVolumeDb);
  expect(report.sound.maxVolumeDb).toBe(output.maxVolumeDb);
  expect(check.film.jobId).toBe(voiced.film.jobs.find((job:{stage:string})=>job.stage==="picture-edit").id);
  expect(check.film.projectId).toBe(voiced.film.projectId);
  expect(UUID.test(check.film.jobId)).toBe(true);
});

test("what the check found on a real film is stated, read, and not quietly resolved",()=>{
  expect(report.verdict).toBe("review");
  const codes=report.findings.map(finding=>finding.code);
  expect(codes).toEqual(["black-picture","frozen-picture","illegal-levels"]);
  expect(report.findings.every(finding=>finding.severity==="warning")).toBe(true);
  // Every finding is read, and each reading says what was decided about it.
  expect(check.findingsRead.map((entry:{code:string})=>entry.code)).toEqual(codes);
  for(const entry of check.findingsRead){expect(entry.reading.length).toBeGreaterThan(60);expect(entry.action.length).toBeGreaterThan(4);}
  // The one that is a real defect is named as unfixed rather than absorbed into the expected ones.
  expect(check.knownGaps.join(" ")).toContain("illegal luma range is not fixed");
  const levels=report.findings.find(finding=>finding.code==="illegal-levels")!;
  expect(report.picture.lumaMin).toBeLessThan(PICTURE_QC_RECIPE.thresholds.lumaFloor);
  expect(report.picture.lumaMax).toBeGreaterThan(PICTURE_QC_RECIPE.thresholds.lumaCeiling);
  expect(levels.message).toContain(String(report.picture.lumaMin));
  // A black or frozen span is evidence with times on it, in the message and as data.
  for(const code of ["black-picture","frozen-picture"]){
    const finding=report.findings.find(value=>value.code===code)!;
    expect(finding.spans!.length).toBeGreaterThan(0);
    for(const span of finding.spans!)expect(span.toSec).toBeGreaterThan(span.fromSec);
  }
  // Every frame of the film was sampled for levels; 14 seconds at 30 fps is 420 of them.
  expect(report.picture.framesSampled).toBe(report.programme.durationSec*30);
});

test("the check spent nothing, and says what it did not establish",()=>{
  expect(check.spendUsd).toBe(0);
  expect(check.spendNote).toContain("Nothing was generated");
  expect(voiced.spend.ledgerAfter.spentUsd).toBe(voiced.spend.ledgerBefore.spentUsd);
  expect(check.knownGaps.length).toBeGreaterThanOrEqual(4);
  expect(check.knownGaps.join(" ")).toContain("Nothing calls this check in the product yet");
  expect(check.knownGaps.join(" ")).toContain("one host");
  expect(pictureQcFindings({programme:report.programme,picture:{...report.picture,blackSpans:[],freezeSpans:[],lumaMin:16,lumaMax:235},sound:report.sound})).toEqual([]);
});
