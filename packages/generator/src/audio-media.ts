import {readFileSync,statSync,realpathSync,writeFileSync} from "node:fs";
import {resolve,sep,join} from "node:path";
import type {Job} from "../../queue/src/index";
import {contentHash} from "./capabilities";
import {audioPcmHash,validateAudioDelivery,type AudioLineDelivery} from "./audio-delivery";
import {AudioJobError,validateAudioTakeOutput,type AudioTakeOutput} from "../../planner/src/audio-jobs";

export function prepareAudioMedia(job:Job,scratch:string,report:AudioLineDelivery,wav:Buffer):AudioTakeOutput{
  validateAudioDelivery(report,wav.subarray(44));
  const prefix=`${job.projectId}/${job.id}/audio-${report.attemptId}/`,manifest=Buffer.from(JSON.stringify(report)+"\n");
  const data={schema:"hv-audio-take-output/1" as const,report,wavPath:prefix+"line.wav",manifestPath:prefix+"performance.json",
    files:[{path:prefix+"line.wav",sha256:audioPcmHash(wav),bytes:wav.length},{path:prefix+"performance.json",sha256:audioPcmHash(manifest),bytes:manifest.length}]};
  const output={...data,revision:contentHash(data)};validateAudioTakeOutput(job,output);verifyAudioWav(wav,report);
  writeFileSync(join(scratch,"line.wav"),wav,{flag:"wx"});writeFileSync(join(scratch,"performance.json"),manifest,{flag:"wx"});return output;
}
function verifyAudioWav(wav:Buffer,report:AudioLineDelivery):void{
  if(wav.length<44||wav.subarray(0,4).toString()!=="RIFF"||wav.readUInt32LE(4)!==wav.length-8||wav.subarray(8,16).toString()!=="WAVEfmt "
    ||wav.readUInt32LE(16)!==16||wav.readUInt16LE(20)!==1||wav.readUInt16LE(22)!==1||wav.readUInt32LE(24)!==48000||wav.readUInt32LE(28)!==96000
    ||wav.readUInt16LE(32)!==2||wav.readUInt16LE(34)!==16||wav.subarray(36,40).toString()!=="data"||wav.readUInt32LE(40)!==wav.length-44)throw new AudioJobError("Invalid retained audition WAV format.");
  validateAudioDelivery(report,wav.subarray(44));
}
export function verifyAudioMedia(job:Job,output:AudioTakeOutput,root:string):void{
  validateAudioTakeOutput(job,output);const base=realpathSync(root),files=new Map<string,Buffer>();
  for(const file of output.files){const path=resolve(base,file.path),actual=realpathSync(path);
    if(actual!==path||!actual.startsWith(base+sep))throw new AudioJobError("Audio artifact escaped its owner.");
    const stat=statSync(path);if(!stat.isFile()||stat.size!==file.bytes)throw new AudioJobError("Audio artifact size changed.");
    const bytes=readFileSync(path);if(audioPcmHash(bytes)!==file.sha256)throw new AudioJobError("Audio artifact checksum changed.");files.set(file.path,bytes);
  }
  const saved=JSON.parse(files.get(output.manifestPath)!.toString());
  if(contentHash(saved)!==contentHash(output.report))throw new AudioJobError("The saved audition report changed.");verifyAudioWav(files.get(output.wavPath)!,output.report);
}
