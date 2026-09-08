import {expect,test} from 'bun:test';
import {livingScriptResumeMedia} from '../src/living-script.js';

const time=minute=>'2026-09-08T00:'+String(minute).padStart(2,'0')+':00.000Z';
function fixture(){const film={id:'original',stage:'final',status:'done',scriptVersion:1,castingVersion:0,directionVersion:0,completedAt:time(1)},exported={id:'selected-cut-export',stage:'picture-edit',status:'done',scriptVersion:1,pictureEdit:{sequenceId:'saved-cut'},completedAt:time(2)},preview={id:'pending-preview',stage:'animatic',status:'done',scriptVersion:2,castingVersion:1,directionVersion:1,completedAt:time(4),livingScript:{role:'preview'}},generated={...preview,id:'pending-final',stage:'final',completedAt:time(5),livingScript:{role:'render'}},selected={jobId:exported.id,at:time(3)},state={scriptVersion:1,castingVersion:0,directionVersion:0,jobs:[film,exported,preview,generated],dialogueSelections:{entries:[selected]},dialogueExport:{job:exported}};return {state,film,exported,preview,generated,selected};}

test('reload before and after linked acceptance preserves selected editorial output over newer pending source films',()=>{
  const f=fixture(),snapshot=structuredClone(f.state);for(const accepted of [false,true]){const state={...f.state,...(accepted?{scriptVersion:2,castingVersion:1,directionVersion:1}:{})},view=livingScriptResumeMedia(state);expect(view.selected).toEqual(f.selected);expect(state.dialogueExport.job).toBe(f.exported);expect(view.active).toBeUndefined();expect(view.animatic).toBeUndefined();expect(view.finalCut?.id).toBe(accepted?undefined:'original');expect(view.finalCut?.id).not.toBe('pending-final');}expect(f.state).toEqual(snapshot);
});

test('pending queued/completed previews never trigger ordinary auto-poll or final generation when no export is selected',()=>{
  const f=fixture();f.state.dialogueSelections.entries=[];Object.assign(f.state,{scriptVersion:2,castingVersion:1,directionVersion:1});for(const status of ['queued','running','done']){f.preview.status=status;f.generated.status=status;expect(livingScriptResumeMedia(f.state)).toEqual({active:undefined,finalCut:undefined,animatic:undefined,selected:null});}
});

test('ordinary completed films still supersede older selection while unavailable explicitly selected exports stay selected',()=>{
  const f=fixture();delete f.state.dialogueExport.job;f.state.dialogueExport.error='Selected media unavailable';expect(livingScriptResumeMedia(f.state).selected).toEqual(f.selected);const fresh={...f.film,id:'ordinary-new-final',completedAt:time(6)};f.state.jobs.push(fresh);const view=livingScriptResumeMedia(f.state);expect(view.selected).toBeNull();expect(view.finalCut).toBe(fresh);expect(view.animatic).toBeUndefined();
});
