import {contentHash} from "../../generator/src/capabilities";

/**
 * HV-026's first check on a delivered film. Every number here is measured from the file itself and
 * nothing is inferred: a finding names what was measured, and the report names what was not looked
 * at, because a quality check that reports only what it found reads as a clean bill of health.
 *
 * Measurement changes no pixel, so this stage sits outside the deterministic render path entirely
 * and cannot move a frame hash.
 */
export const PICTURE_QC_RECIPE=Object.freeze({
  schema:"hv-picture-qc/1",
  container:"ffprobe -show_streams -show_format",
  black:"blackdetect=d=0.5:pic_th=0.98:pix_th=0.10",
  freeze:"freezedetect=n=0.001:d=2",
  levels:"signalstats YMIN and YMAX printed per frame; limited-range luma judged against 16-235",
  sound:"volumedetect over the whole programme, mean and peak",
  thresholds:Object.freeze({blackSec:0.5,freezeSec:2,lumaFloor:16,lumaCeiling:235,quietDb:-45,loudDb:-12,peakCeilingDb:0,frameRate:"30/1",pixelFormat:"yuv420p"}),
  notChecked:Object.freeze(["safe area and title-safe margins","caption overflow and readability","decodability across players and devices","colour accuracy, gamut and any colour-managed transform","high dynamic range","audio channel assignment beyond the stream's own count"]),
} as const);
export interface PictureQcSpan {fromSec:number;toSec:number}
export interface PictureQcMeasurement {
  programme:{durationSec:number;width:number;height:number;frameRate:string;pixelFormat:string;video:string;audio:string|null;channels:number|null;sampleRate:number|null;bytes:number};
  /** `lumaMin`/`lumaMax` are null when no frame carried the statistic, never zero. */
  picture:{blackSpans:PictureQcSpan[];freezeSpans:PictureQcSpan[];lumaMin:number|null;lumaMax:number|null;framesSampled:number};
  /**
   * `null` means no level reading was taken at all — there was no soundtrack to meter, or the meter
   * printed nothing. Inside the reading, a `null` decibel figure is a real `-inf`: silence that was
   * measured. The two are different facts and this type keeps them apart, because a check that
   * reports an unmeasured soundtrack as silent is asserting a measurement nobody took.
   */
  sound:{meanVolumeDb:number|null;maxVolumeDb:number|null}|null;
}
export interface PictureQcFinding {code:string;severity:"fail"|"warning"|"note";message:string;spans?:PictureQcSpan[]}
export interface PictureQcReport extends PictureQcMeasurement {
  schema:"hv-picture-qc/1";recipeRevision:string;runtimeRevision:string;source:{sha256:string;bytes:number};
  findings:PictureQcFinding[];verdict:"pass"|"review";notChecked:readonly string[];revision:string;
}
const rounded=(value:number)=>Math.round(value*100)/100;
const spanText=(spans:PictureQcSpan[])=>spans.map(span=>rounded(span.fromSec)+"–"+rounded(span.toSec)+" s").join(", ");
/**
 * Names only the readings that exist. `lumaMin` and `lumaMax` come from two separate per-frame
 * statistics and one can be empty while the other is not, which used to print "Luma reaches
 * null–253" into a delivery report.
 */
const lumaText=(min:number|null,max:number|null)=>min===null?"a maximum of "+max:max===null?"a minimum of "+min:min+"–"+max;
/**
 * A luma reading that is not a reading (HV-026-06).
 *
 * `lumaMin` and `lumaMax` are typed `number|null`, and `NaN` is a `number`, so the type said nothing
 * when the measurement arrived carrying one -- and neither did any finding below, because every
 * comparison against `NaN` is false. A check that cannot say what it measured must say so by
 * refusing, not by reporting a film whose levels it never read as a film whose levels are fine.
 *
 * Absent is a different fact from unreadable and stays allowed: the two statistics are printed
 * separately and one can be empty while the other is not, which is what `lumaText` above is for.
 */
function assertLevelsRead(picture:PictureQcMeasurement["picture"]):void{
  for(const [name,value] of [["lumaMin",picture.lumaMin],["lumaMax",picture.lumaMax]] as const)
    if(value!==null&&!Number.isFinite(value))
      throw new Error("This quality check's "+name+" is not a number, so the film's levels were never read. Run the check again.");
}
/** Pure: the same measurement always produces the same findings, in the same order. */
export function pictureQcFindings(measurement:PictureQcMeasurement):PictureQcFinding[]{
  const {programme,picture,sound}=measurement,limits=PICTURE_QC_RECIPE.thresholds,findings:PictureQcFinding[]=[];
  assertLevelsRead(picture);
  const add=(code:string,severity:PictureQcFinding["severity"],message:string,spans?:PictureQcSpan[])=>findings.push({code,severity,message,...(spans?{spans}:{})});
  if(!programme.audio)add("audio-missing","fail","The delivered file carries no audio stream.");
  // A reading nobody took is not a reading of silence, and saying so here is what stops the three
  // level findings below from standing on a measurement that was never made. Reported like
  // `levels-unmeasured`: a note, so the gap is in the report rather than hidden by an empty one.
  else if(sound===null)add("sound-unmeasured","note","The file carries an audio stream, but no level reading was taken, so the soundtrack's level was not judged.");
  else if(sound.meanVolumeDb===null)add("silent-programme","fail","The soundtrack measures as silence from end to end.");
  if(sound&&sound.maxVolumeDb!==null&&sound.maxVolumeDb>=limits.peakCeilingDb)
    add("clipping","fail","The soundtrack peaks at "+rounded(sound.maxVolumeDb)+" dB, at or above full scale. Samples are being clipped.");
  if(sound&&sound.meanVolumeDb!==null&&sound.meanVolumeDb<limits.quietDb)
    add("quiet-programme","warning","The soundtrack averages "+rounded(sound.meanVolumeDb)+" dB, below the "+limits.quietDb+" dB a finished film has stayed above here. Check the mix before delivery.");
  if(sound&&sound.meanVolumeDb!==null&&sound.meanVolumeDb>limits.loudDb)
    add("loud-programme","warning","The soundtrack averages "+rounded(sound.meanVolumeDb)+" dB, above the "+limits.loudDb+" dB a finished film has stayed below here. Check the mix before delivery.");
  if(picture.blackSpans.length)
    add("black-picture","warning","The picture is black for "+spanText(picture.blackSpans)+". Confirm this is the cut and not a missing render.",picture.blackSpans);
  if(picture.freezeSpans.length)
    add("frozen-picture","warning","The picture does not change for "+spanText(picture.freezeSpans)+". Confirm this is a held frame and not a stalled render.",picture.freezeSpans);
  if(picture.lumaMin!==null&&picture.lumaMin<limits.lumaFloor||picture.lumaMax!==null&&picture.lumaMax>limits.lumaCeiling)
    add("illegal-levels","warning","Luma reaches "+lumaText(picture.lumaMin,picture.lumaMax)+", outside the "+limits.lumaFloor+"–"+limits.lumaCeiling+" this delivery's limited range allows. Levels will be clipped by a conforming player.");
  if(programme.frameRate!==limits.frameRate)add("unexpected-frame-rate","note","The file reports "+programme.frameRate+" rather than the studio's "+limits.frameRate+".");
  if(programme.pixelFormat!==limits.pixelFormat)add("unexpected-pixel-format","note","The file is "+programme.pixelFormat+" rather than the studio's "+limits.pixelFormat+".");
  if(!picture.framesSampled)add("levels-unmeasured","note","No frame carried a luma statistic, so levels were not judged.");
  return findings;
}
export function pictureQcReport(measurement:PictureQcMeasurement,source:PictureQcReport["source"],runtimeRevision:string):PictureQcReport{
  const findings=pictureQcFindings(measurement);
  const data={schema:"hv-picture-qc/1" as const,recipeRevision:contentHash(PICTURE_QC_RECIPE),runtimeRevision,source,...measurement,findings,
    // A check that has to be read to be believed: anything but "pass" is a thing to look at, not a failure to ship.
    verdict:(findings.some(finding=>finding.severity!=="note")?"review":"pass") as PictureQcReport["verdict"],
    notChecked:PICTURE_QC_RECIPE.notChecked};
  return {...data,revision:contentHash(data)};
}
/** A retained report is re-derived from its own measurement rather than trusted. */
export function validatePictureQcReport(report:PictureQcReport):PictureQcReport{
  if(!report||report.schema!=="hv-picture-qc/1"||report.recipeRevision!==contentHash(PICTURE_QC_RECIPE))
    throw new Error("This quality check was made by another recipe. Run the check again.");
  const rebuilt=pictureQcReport({programme:report.programme,picture:report.picture,sound:report.sound},report.source,report.runtimeRevision);
  // The whole report is compared, not its revision: a retained revision would otherwise vouch for
  // findings and a verdict that had been edited under it.
  if(contentHash(rebuilt)!==contentHash(report))throw new Error("This quality check does not match its own measurement.");
  return rebuilt;
}
