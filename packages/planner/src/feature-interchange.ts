import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {EDIT_FPS} from "./edit-timeline";
import {interchangeLine,type EditInterchangeClip,type FeatureInterchangeCut} from "./edit-interchange";
import {FINAL_SHOT_CROSSFADE_FRAMES,FeatureFilmConflict,finalOf,validateFeatureFilmJob,validateFeatureFilmOutput} from "./feature-film";
import {validateRenderRecord} from "./shot-reuse";

/**
 * HV-023-05: the joined feature's cut (HV-030-30) as one 30 fps timeline, for the OTIO and CMX 3600
 * writers of HV-023-04 (`editOtio`, `editCmx3600`).
 *
 * The feature's film is each sequence's finished film, joined in order with a 12-frame dissolve
 * (`xfade`), the opening title laid over the start and the end credits appended. Each sequence film is
 * its final's shots, joined by the worker's own 15-frame dissolve (a cut when a shot carries speech).
 * So every clip here is one shot of one sequence, named by its render record, and its media is the
 * sequence's film as it was joined (`urn:hv:job:<filmJobId>`, after any voice, lip sync or mix):
 *
 * - a shot's source range is where it sits in its sequence film; the film's own shot dissolves are in
 *   that picture already, so neighbouring shots of one film are cut at the middle of each (7 + 8
 *   frames) and are not written as dissolves again, which a conform would apply twice;
 * - each join is a centred dissolve between two films (6 + 6 frames), the only dissolves written;
 * - the end credits are a clip after the last frame, with a hard cut, as the join appends them;
 * - the opening title is an overlay, so it is a clip on picture layer 2 over the start. The EDL carries
 *   layer 1 only, as HV-023-04's does, and says so.
 *
 * Everything is read from the job's own admitted plan and finished export: the films and their finals
 * copied into the plan at admission, the finals' validated render records, the graphics' frames. The
 * film lengths these records give must add up to the export's measured length within one frame per
 * sequence film; when they don't, the cut is refused rather than written approximately.
 */
export const FEATURE_INTERCHANGE_SCHEMA="hv-feature-interchange/1" as const;

const refuse=(message:string):never=>{throw new FeatureFilmConflict(message);};
/** The screenplay's own title (`Title:` on its title page), or a plain name. */
function featureLabel(scriptText:string):string{
  const page=scriptText.replace(/\r/g,"").split(/\n\s*\n/)[0]??"",title=/^Title:[ \t]*(.+)$/im.exec(page)?.[1];
  return interchangeLine(title?.trim()||"Feature film",160);
}

interface FilmShots {number:number;filmJobId:string;filmStage:string;outputRevision:string;finalJobId:string;frames:number;overlap:number;shots:{shotId:string;renderRevision:string;frames:number}[]}

/** Each sequence film's shots, from its final's render records, in the order the worker joined them. */
function filmShots(job:Job):FilmShots[]{
  const plan=job.featureFilm!;
  return plan.films.map((film,index)=>{
    const number=film.number,final=finalOf(film.job),records=final?.output?.shotRenders;
    if(!final||final.id!==plan.sequences[index]!.finalJobId)return refuse("Sequence "+number+"'s film isn't made from its recorded final.");
    if(!records?.length)return refuse("Sequence "+number+"'s final has no shot records, so its shots can't be placed in the feature's cut.");
    const shots=records.map(record=>{
      validateRenderRecord(record,final);
      const frames=Math.round(record.clip.durationSec*EDIT_FPS);
      if(frames<1||Math.abs(frames/EDIT_FPS-record.clip.durationSec)>1e-6)refuse("Sequence "+number+"'s shot "+record.shotId+" doesn't end on a whole frame at 30 fps, so its cut can't be written exactly.");
      return {shotId:record.shotId,renderRevision:record.revision,frames};
    });
    // The worker's assembly: a dissolve between shots unless one carries recorded speech (`assemble`).
    const overlap=shots.length>1&&!records.some(record=>record.clip.speech)?FINAL_SHOT_CROSSFADE_FRAMES:0;
    const frames=shots.reduce((sum,shot)=>sum+shot.frames,0)-overlap*(shots.length-1);
    return {number,filmJobId:film.job.id,filmStage:film.job.stage,outputRevision:film.outputRevision,finalJobId:final.id,frames,overlap,shots};
  });
}

/** The joined feature's cut, from a finished `feature-film` job. Refused, by name, when it can't be written exactly. */
export function featureInterchangeCut(job:Job):FeatureInterchangeCut{
  if(job.stage!=="feature-film"||!job.featureFilm)return refuse("Only a feature's joined film is exported as the feature's cut.");
  if(job.status!=="done"||!job.output?.featureFilm)return refuse("The feature's film isn't finished. Export its cut after the join completes.");
  validateFeatureFilmJob(job);const output=validateFeatureFilmOutput(job,job.output),plan=job.featureFilm;
  const films=filmShots(job);
  // As the assembler joins: a dissolve at each join, unless a film is too short to lend half of it to each side.
  const join=films.length>1&&films.every(film=>film.frames>=4*plan.crossfadeFrames)?plan.crossfadeFrames:0,joinBefore=Math.floor(join/2);
  const picture:EditInterchangeClip[]=[];let start=0;
  for(const [index,film]of films.entries()){
    const last=index===films.length-1,next=start+film.frames-join;
    // Where each shot starts in its own film; neighbouring shots are cut at the middle of the film's own dissolve.
    const within:number[]=[];let at=0;for(const shot of film.shots){within.push(at);at+=shot.frames-film.overlap;}
    const cut=(shot:number)=>within[shot]!+Math.floor(film.overlap/2);
    film.shots.forEach((shot,position)=>{
      const sourceIn=position===0?(index===0?0:joinBefore):cut(position),sourceOut=position===film.shots.length-1?(last?film.frames:film.frames-join+joinBefore):cut(position+1);
      const label="Sequence "+film.number+" shot "+shot.shotId;
      if(sourceOut-sourceIn<1||(position===0&&index>0&&sourceOut-sourceIn<join-joinBefore)||(position===film.shots.length-1&&!last&&sourceOut-sourceIn<joinBefore))
        refuse(label+" is shorter than the dissolves around it, so the feature's cut can't be written exactly.");
      picture.push({clipId:"s"+film.number+"-"+shot.shotId,sourceId:film.filmJobId,jobId:film.filmJobId,stage:film.filmStage,sourceRevision:film.outputRevision,label,sourceFrames:film.frames,
        recordIn:start+sourceIn,recordOut:start+sourceOut,sourceIn,sourceOut,dissolveIn:position===0&&index>0&&join?{id:"join-"+(index)+"-"+(index+1),frames:join,before:joinBefore,after:join-joinBefore}:null,
        shot:{sequence:film.number,finalJobId:film.finalJobId,shotId:shot.shotId,renderRevision:shot.renderRevision}});
    });
    start=last?start+film.frames:next;
  }
  const filmFrames=start,credits=plan.credits;
  if(credits)picture.push({clipId:"credits",sourceId:credits.jobId,jobId:credits.jobId,stage:"motion-graphic",sourceRevision:credits.outputRevision,label:"End credits",sourceFrames:credits.frames,
    recordIn:filmFrames,recordOut:filmFrames+credits.frames,sourceIn:0,sourceOut:credits.frames,dissolveIn:null});
  const frames=filmFrames+(credits?.frames??0);
  // The records against the export: each sequence film was measured when it was joined, and may differ from its shots' frames by under one.
  if(Math.abs(frames-output.durationSec*EDIT_FPS)>films.length)refuse("The feature's film is "+output.durationSec+" s long, but its shots' records add up to "+(frames/EDIT_FPS).toFixed(3)+" s. Join the feature again before exporting its cut.");
  const layers=[{layer:0,clips:picture}];
  if(plan.title){const title=plan.title,shown=Math.min(title.frames,filmFrames);
    layers.push({layer:1,clips:[{clipId:"title",sourceId:title.jobId,jobId:title.jobId,stage:"motion-graphic",sourceRevision:title.outputRevision,label:"Opening title",sourceFrames:title.frames,recordIn:0,recordOut:shown,sourceIn:0,sourceOut:shown,dissolveIn:null}]});}
  const notCarried=[
    "Sound and captions are not written; the joined film's sound (each sequence film's mix, crossfaded at the joins) stays in its export.",
    "Each sequence film's own dissolves between shots are part of that film's picture; its shots are cut at the middle of each and the dissolves are not written again.",
    ...(plan.title?["The opening title is an overlay on picture layer 2 in the OTIO; the EDL carries picture layer 1 only."]:[]),
  ];
  return {schema:FEATURE_INTERCHANGE_SCHEMA,featureFilmJobId:job.id,planRevision:plan.revision,outputRevision:contentHash(job.output),label:featureLabel(job.scriptText),fps:EDIT_FPS,frames,
    width:plan.width,height:plan.height,layers,markers:[],notCarried};
}
