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
  /** A silent programme measures as null rather than as a very small number. */
  sound:{meanVolumeDb:number|null;maxVolumeDb:number|null};
}
export interface PictureQcFinding {code:string;severity:"fail"|"warning"|"note";message:string;spans?:PictureQcSpan[]}
export interface PictureQcReport extends PictureQcMeasurement {
  schema:"hv-picture-qc/1";recipeRevision:string;runtimeRevision:string;source:{sha256:string;bytes:number};
  findings:PictureQcFinding[];verdict:"pass"|"review";notChecked:readonly string[];revision:string;
}
const seconds=(value:number)=>Math.round(value*100)/100;
const spanText=(spans:PictureQcSpan[])=>spans.map(span=>seconds(span.fromSec)+"–"+seconds(span.toSec)+" s").join(", ");
/** Pure: the same measurement always produces the same findings, in the same order. */
export function pictureQcFindings(measurement:PictureQcMeasurement):PictureQcFinding[]{
  const {programme,picture,sound}=measurement,limits=PICTURE_QC_RECIPE.thresholds,findings:PictureQcFinding[]=[];
  const add=(code:string,severity:PictureQcFinding["severity"],message:string,spans?:PictureQcSpan[])=>findings.push({code,severity,message,...(spans?{spans}:{})});
  if(!programme.audio)add("audio-missing","fail","The delivered file carries no audio stream.");
  else if(sound.meanVolumeDb===null)add("silent-programme","fail","The soundtrack measures as silence from end to end.");
  if(sound.maxVolumeDb!==null&&sound.maxVolumeDb>=limits.peakCeilingDb)
    add("clipping","fail","The soundtrack peaks at "+seconds(sound.maxVolumeDb)+" dB, at or above full scale. Samples are being clipped.");
  if(sound.meanVolumeDb!==null&&sound.meanVolumeDb<limits.quietDb)
    add("quiet-programme","warning","The soundtrack averages "+seconds(sound.meanVolumeDb)+" dB, below the "+limits.quietDb+" dB a finished film has stayed above here. Check the mix before delivery.");
  if(sound.meanVolumeDb!==null&&sound.meanVolumeDb>limits.loudDb)
    add("loud-programme","warning","The soundtrack averages "+seconds(sound.meanVolumeDb)+" dB, above the "+limits.loudDb+" dB a finished film has stayed below here. Check the mix before delivery.");
  if(picture.blackSpans.length)
    add("black-picture","warning","The picture is black for "+spanText(picture.blackSpans)+". Confirm this is the cut and not a missing render.",picture.blackSpans);
  if(picture.freezeSpans.length)
    add("frozen-picture","warning","The picture does not change for "+spanText(picture.freezeSpans)+". Confirm this is a held frame and not a stalled render.",picture.freezeSpans);
  if(picture.lumaMin!==null&&picture.lumaMin<limits.lumaFloor||picture.lumaMax!==null&&picture.lumaMax>limits.lumaCeiling)
    add("illegal-levels","warning","Luma reaches "+picture.lumaMin+"–"+picture.lumaMax+", outside the "+limits.lumaFloor+"–"+limits.lumaCeiling+" this delivery's limited range allows. Levels will be clipped by a conforming player.");
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
