// PRIVATE, UNAPPLIED, UNEXECUTED DRAFT.
// Intended location: packages/api/test/mixed-source-owner.assertions.ts.
// Host owns genuine setup, authenticated HTTP transport, independent reload,
// phase timeout/drain and disposal. This helper neither generates nor seeds /4.
import {expect} from "bun:test";
import type {PersistedState} from "../src/index";
import type {CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import type {EditSequence} from "../../planner/src/edit-library";
import type {EditSourceReceipt} from "../../planner/src/edit-sources";
import type {EditSource} from "../../planner/src/edit-timeline";
import type {EditScriptNavigation} from "../../planner/src/edit-script-types";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {editHistoryState} from "../../planner/src/edit-history";
import {contentHash as hash} from "../../generator/src/capabilities";

interface OwnerResponse {status:number;body:unknown}
interface SourceView {jobId:string;sourceRevision:string;facts:EditSource;capabilities:{lineRevision:boolean}}
interface SavedView {libraryVersion:number;sequence:EditSequence;sourceCapabilities:{sourceRevision:string;sourceId:string;lineRevision:boolean}[]}
interface Fixture {
  job:CurrentFilmMixedJob;
  // A real pre-existing saved legacy sequence, initially containing no /4.
  legacySequenceId:string;newSequenceId:string;
  // Path is editorial-relative. The host must send it through its owner-authenticated
  // HTTP app and parse the response; do not replace this with pure planner results.
  request:(method:"GET"|"POST",path:string,body:Record<string,unknown>|undefined,signal:AbortSignal)=>Promise<OwnerResponse>;
  // Read authoritative persisted project state, not a projected response body.
  readState:()=>Promise<PersistedState>;
  // Close/recreate the local service from disk, or reconnect an independent PG
  // service instance, retaining the exact queue/artifact custody. No fromState
  // reconstruction from this helper's cached copy qualifies as a reload.
  reload:()=>Promise<void>;
  // Complete jobs + real ledger/capture/journal digest, excluding editorial metadata.
  executionRevision:()=>Promise<string>;
}

/** Four separately awaited phases reuse one completed authentic V3 job. */
export function mixedSourceOwnerAssertions(fixture:Fixture){
  let phase=0,inspected:SourceView,created:SavedView,admitted:SavedView,saved:PersistedState,receipt:EditSourceReceipt,execution:string;
  const original=hash(fixture.job);
  const project=(state:PersistedState)=>{const value=state.projects.find(value=>value.id===fixture.job.projectId);if(!value)throw new Error("The owner fixture lost its project.");return value;};
  const call=async<T>(method:"GET"|"POST",path:string,status:number,signal:AbortSignal,body?:Record<string,unknown>):Promise<T>=>{
    signal.throwIfAborted();const response=await fixture.request(method,path,body,signal);signal.throwIfAborted();expect(response.status).toBe(status);
    for(const marker of ["hv-current-film-job/3","currentFilmProof","originalRecord","hv-shot-execution-capture/1"])expect(JSON.stringify(response.body)).not.toContain(marker);
    return response.body as T;
  };
  const guard=async()=>{expect(hash(fixture.job)).toBe(original);expect(await fixture.executionRevision()).toBe(execution);};
  return {
    async inspect(signal:AbortSignal){
      expect(phase).toBe(0);const before=await fixture.readState(),owner=project(before),legacy=owner.editLibrary?.sequences.find(value=>value.id===fixture.legacySequenceId);
      expect(legacy).toBeDefined();expect(owner.editLibrary!.sources.some(source=>source.schema==="hv-edit-source/4")).toBe(false);
      execution=await fixture.executionRevision();
      const response=await call<{sources:SourceView[]}>("GET","sources/"+fixture.job.id,200,signal);
      expect(response.sources).toHaveLength(1);inspected=response.sources[0]!;
      expect(inspected.jobId).toBe(fixture.job.id);expect(inspected.facts.id).toBe(fixture.job.id);expect(inspected.capabilities.lineRevision).toBe(false);
      expect(inspected.facts.frames).toBe(fixture.job.output!.currentFilm.assembly.frames);
      expect(await fixture.readState()).toEqual(before);await guard();phase=1;
    },
    async create(signal:AbortSignal){
      expect(phase).toBe(1);const before=await fixture.readState(),owner=project(before),version=owner.editLibrary!.version;
      created=await call<SavedView>("POST","sequences",201,signal,{id:fixture.newSequenceId,label:"Owner saved mixed source",sources:[{jobId:inspected.jobId,sourceRevision:inspected.sourceRevision}],firstSourceId:inspected.facts.id,width:320,height:180,expectedVersion:version});
      const after=await fixture.readState(),library=project(after).editLibrary!;
      expect(library.schema).toBe("hv-edit-library/2");expect(library.version).toBe(version+1);expect(created.libraryVersion).toBe(library.version);
      expect(library.sequences.find(value=>value.id===fixture.newSequenceId)).toEqual(created.sequence);
      expect(created.sequence.sourceRevisions).toEqual([inspected.sourceRevision]);expect(created.sourceCapabilities).toEqual([{sourceRevision:inspected.sourceRevision,sourceId:inspected.facts.id,lineRevision:false}]);
      const found=library.sources.find(source=>source.revision===inspected.sourceRevision);if(!found)throw new Error("The actual owner create did not persist its inspected source.");receipt=found;
      expect(receipt.schema).toBe("hv-edit-source/4");expect(receipt.job).toEqual(fixture.job);expect(receipt.facts).toEqual(inspected.facts);
      const withoutLibrary=(value:PersistedState)=>{const copy=structuredClone(value);for(const project of copy.projects)delete project.editLibrary;return copy;};
      expect(withoutLibrary(after)).toEqual(withoutLibrary(before));await guard();phase=2;
    },
    async admit(signal:AbortSignal){
      expect(phase).toBe(2);const before=await fixture.readState(),library=project(before).editLibrary!,legacy=library.sequences.find(value=>value.id===fixture.legacySequenceId)!;
      expect(legacy.sourceRevisions).not.toContain(receipt.revision);
      admitted=await call<SavedView>("POST","sequences/"+legacy.id+"/sources",201,signal,{jobId:fixture.job.id,sourceRevision:receipt.revision,expectedVersion:library.version,expectedHistoryRevision:legacy.history.revision});
      saved=await fixture.readState();const actual=project(saved).editLibrary!;
      expect(actual.schema).toBe("hv-edit-library/2");expect(actual.version).toBe(library.version+1);expect(actual.sources).toEqual(library.sources);
      expect(actual.sequences.find(value=>value.id===legacy.id)).toEqual(admitted.sequence);
      expect(admitted.sequence.sourceRevisions).toEqual([...legacy.sourceRevisions,receipt.revision]);expect(admitted.sequence.history.root).toEqual(legacy.history.root);
      expect(admitted.sequence.history.events.length).toBe(legacy.history.events.length+1);
      expect(admitted.sourceCapabilities).toContainEqual({sourceRevision:receipt.revision,sourceId:receipt.facts.id,lineRevision:false});
      expect(admitted.sourceCapabilities.some(row=>row.sourceRevision!==receipt.revision&&row.lineRevision)).toBe(true);
      await guard();phase=3;
    },
    async reloadAndNavigate(signal:AbortSignal){
      expect(phase).toBe(3);await fixture.reload();signal.throwIfAborted();expect(await fixture.readState()).toEqual(saved);
      for(const prior of [created,admitted]){
        const opened=await call<SavedView>("GET","sequences/"+prior.sequence.id,200,signal);
        expect(opened.libraryVersion).toBe(project(saved).editLibrary!.version);expect(opened.sequence).toEqual(prior.sequence);expect(opened.sourceCapabilities).toEqual(prior.sourceCapabilities);
      }
      // The mixed-only initial timeline spans the complete original at zero;
      // its measured line samples therefore remain source-identical.
      const navigation=await call<EditScriptNavigation>("GET","sequences/"+created.sequence.id+"/script?historyRevision="+created.sequence.history.revision,200,signal);
      const index=compileEditScriptSource(receipt),timeline=editHistoryState(created.sequence.history).timeline;
      expect(navigation.sequenceId).toBe(created.sequence.id);expect(navigation.historyRevision).toBe(created.sequence.history.revision);expect(navigation.timelineRevision).toBe(timeline.revision);
      expect(navigation.sources).toEqual([index]);const spoken=index.entries.filter(entry=>entry.kind==="dialogue"&&entry.windows.some(window=>window.evidence==="measured-speech"));
      expect(spoken.length).toBeGreaterThan(1);expect(new Set(spoken.map(entry=>entry.id)).size).toBe(spoken.length);
      expect(timeline.clips.some(clip=>clip.sourceId===receipt.facts.id&&clip.lane==="mix")).toBe(true);
      for(const entry of spoken){const windows=entry.windows.filter(window=>window.evidence==="measured-speech"&&window.lanes.includes("mix"));
        const occurrences=navigation.occurrences.filter(row=>row.entryId===entry.id&&row.lane==="mix");
        expect(windows.length).toBeGreaterThan(0);
        expect(occurrences.map(row=>[row.sourceStartSample,row.sourceEndSample])).toEqual(windows.map(window=>[window.startSample,window.endSample]));
        for(const row of occurrences){expect(row.sourceId).toBe(receipt.facts.id);expect(row.startSample).toBe(row.sourceStartSample);expect(row.endSample).toBe(row.sourceEndSample);}
      }
      expect(await fixture.readState()).toEqual(saved);await guard();phase=4;
      return {receipt,sequence:created.sequence,navigation};
    },
  };
}
