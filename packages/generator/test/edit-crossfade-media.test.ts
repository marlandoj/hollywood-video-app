import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {soundWav} from '../src/sound-audio';
import {soundDigest} from '../src/sound-media';
import {soundProcessingCommand} from '../src/sound-finishing';
import {conformEdit,type EditConformSource} from '../src/edit-conform';
import {EditPreviewSource} from '../src/edit-preview-media';
import {EditPreviewMix} from '../src/edit-preview-mix';
import {decodePreviewPage} from '../../planner/src/edit-preview-protocol';
import {applyEditOperation,editTimeline,type EditTimeline} from '../../planner/src/edit-timeline';
import {PreviewAudioRenderer,previewPicture} from '../../planner/src/edit-preview-render';
import {transitionFixture,crossfadeOperation} from './edit-transitions.test';
const access=async()=>{};
const Q20=1048576,FRAME_BYTES=64*48*3/2;
async function rawVideo(input:string,path:string,root:string,concat=false){await soundProcessingCommand(['ffmpeg','-v','error','-nostdin','-protocol_whitelist','file,pipe',...(concat?['-f','concat','-safe','0']:[]),'-i',input,'-an','-c:v','rawvideo','-threads','1','-pix_fmt','yuv420p','-f','rawvideo',path],root,access);return readFileSync(path);}
async function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'hv-crossfade-media-'))),t=transitionFixture(),pcm=Buffer.alloc(160*1600*6);
  const close=()=>{if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error('Unsafe crossfade fixture cleanup');rmSync(root,{recursive:true,force:true});};
  try{for(let i=0;i<160*1600;i++)for(let ch=0;ch<2;ch++)pcm.writeIntLE(((i*997+ch*127)%2000000)-1000000,i*6+ch*3,3);writeFileSync(join(root,'sound.wav'),soundWav(pcm));
    await soundProcessingCommand(['ffmpeg','-v','error','-nostdin',...['green','red','blue'].flatMap(c=>['-f','lavfi','-i',`color=c=${c}:s=64x48:r=30`]),'-filter_complex','[0:v]trim=end_frame=20,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=50,setpts=PTS-STARTPTS[b];[2:v]trim=end_frame=90,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[out]','-map','[out]','-an','-frames:v','160','-c:v','libx264','-preset','medium','-crf','18','-g','90','-bf','3','-sc_threshold','0','-threads','1',join(root,'picture.mp4')],root,access);
    await soundProcessingCommand(['ffprobe','-v','error','-show_streams','-of','json','-o',join(root,'probe.json'),join(root,'picture.mp4')],root,access);expect(JSON.parse(readFileSync(join(root,'probe.json'),'utf8')).streams[0].has_b_frames).toBeGreaterThan(0);
    const media:EditConformSource={id:'original',picture:{path:'picture.mp4',...await soundDigest(join(root,'picture.mp4'))},audio:{mix:{path:'sound.wav',...await soundDigest(join(root,'sound.wav'))}}},original=await rawVideo(join(root,'picture.mp4'),join(root,'original.yuv'),root),preview=await EditPreviewSource.prepare(t.sources[0]!,media,root,join(root,'source-index'),access);expect(original.length).toBe(160*FRAME_BYTES);return {root,t,pcm,media,original,preview,close};
  }catch(error){close();throw error;}
}
async function audioParity(f:Awaited<ReturnType<typeof fixture>>,t:EditTimeline,name:string,full:Buffer){
  const preview=Buffer.alloc(full.length),renderer=new PreviewAudioRenderer(t.clips,4096,t.sources,t.transitions),sizes=[127,511,1600,4096];let block=0;
  for(let at=0;at<t.frames*1600;){const size=Math.min(sizes[block++%sizes.length]!,t.frames*1600-at),left=new Float32Array(size),right=new Float32Array(size);expect(renderer.render(at,left,right,(_id,_lane,from)=>f.pcm.subarray(from*1600*6,Math.min(160,from+60)*1600*6))).toBe(true);for(let i=0;i<size;i++){preview.writeIntLE(left[i]!*8388608,(at+i)*6,3);preview.writeIntLE(right[i]!*8388608,(at+i)*6+3,3);}at+=size;}
  expect(preview.equals(full)).toBe(true);const mix=new EditPreviewMix(t,[f.preview],f.root),pages:Uint8Array[]=[];
  for(const from of [0,60]){const page=await mix.page(from,join(f.root,name+'-mix-'+from),access),decoded=await decodePreviewPage(readFileSync(join(f.root,page.file.path)),{sourceKey:mix.sourceKey,from,sha256:page.file.sha256});pages.push(decoded.audio.mix!);}expect(Buffer.concat(pages).equals(full)).toBe(true);
  await expect(mix.page(0,join(f.root,name+'-withdrawn'),async()=>{throw new Error('permission withdrawn');})).rejects.toThrow('permission withdrawn');
}
test('real B-frame crossfades match independent YUV/PCM expectations and both preview audio paths',async()=>{
  const f=await fixture();try{const t=applyEditOperation(f.t,crossfadeOperation),report=await conformEdit(t,[f.media],f.root,join(f.root,'normal'),access),full=readFileSync(join(f.root,'normal/audio/final.wav')).subarray(44),expected=Buffer.alloc(full.length);
    for(let at=0;at<t.frames*1600;at++)for(let ch=0;ch<2;ch++){let value:number;if(at<35*1600)value=f.pcm.readIntLE((20*1600+at)*6+ch*3,3);else if(at>=45*1600)value=f.pcm.readIntLE((80*1600+at-40*1600)*6+ch*3,3);else{const u=Math.round((at-35*1600)/(10*1600)*Q20),a=f.pcm.readIntLE((20*1600+at)*6+ch*3,3),b=f.pcm.readIntLE((80*1600+at-40*1600)*6+ch*3,3);value=Math.round((a*(Q20-u)+b*u)/Q20);}expected.writeIntLE(value,at*6+ch*3,3);}
    expect(full.equals(expected)).toBe(true);await audioParity(f,t,'normal',full);
    const raw=await rawVideo(join(f.root,'normal/picture/index.ffconcat'),join(f.root,'normal.yuv'),f.root,true);expect(raw.length).toBe(80*FRAME_BYTES);
    expect(raw.subarray(0,35*FRAME_BYTES).equals(f.original.subarray(20*FRAME_BYTES,55*FRAME_BYTES))).toBe(true);expect(raw.subarray(45*FRAME_BYTES).equals(f.original.subarray(85*FRAME_BYTES,120*FRAME_BYTES))).toBe(true);
    for(let frame=35;frame<45;frame++)for(const pixel of [0,64*48,64*48+32*24]){const u=(frame-35)/10,a=f.original[(20+frame)*FRAME_BYTES+pixel]!,b=f.original[(40+frame)*FRAME_BYTES+pixel]!;expect(Math.abs(raw[frame*FRAME_BYTES+pixel]!-(a*(1-u)+b*u))).toBeLessThanOrEqual(2);}
    expect(report.crossfades!.find(x=>x.lane==='mix')!.clips[1]!.voices.map(v=>v.id)).toEqual(['line']);expect(readFileSync(join(f.root,'normal/captions.vtt'),'utf8')).toContain('00:00:01.200');expect(report.picture.parts.flatMap(p=>p.layers).some(l=>l.clipId==='left-picture'&&l.from===55)).toBe(true);
  }finally{f.close();}
},60000);
test('partial-opacity dissolves preserve lower layers and retimed handles retain exact preview/conform audio',async()=>{
  const f=await fixture();try{const {revision:_revision,...data}=f.t;data.clips=data.clips.map(c=>c.lane==='picture'?{...c,layer:1,opacity:.5}:c);data.clips.push({...f.t.clips.find(c=>c.lane==='picture')!,id:'background',link:null,at:0,from:0,frames:80,envelope:{from:0,frames:80,fadeIn:0,fadeOut:0}});const t=applyEditOperation(editTimeline(data),crossfadeOperation);
    await conformEdit(t,[f.media],f.root,join(f.root,'partial'),access);const raw=await rawVideo(join(f.root,'partial/picture/index.ffconcat'),join(f.root,'partial.yuv'),f.root,true);
    for(let frame=35;frame<45;frame++)for(const pixel of [0,64*48,64*48+32*24]){const u=(frame-35)/10,a=f.original[(20+frame)*FRAME_BYTES+pixel]!,b=f.original[(40+frame)*FRAME_BYTES+pixel]!,background=f.original[frame*FRAME_BYTES+pixel]!;expect(Math.abs(raw[frame*FRAME_BYTES+pixel]!-(a*.5*(1-u)+b*.5*u+background*.5))).toBeLessThanOrEqual(3);}
    expect(previewPicture(t,40).map(p=>p.clip.id)).toEqual(['background','left-picture','right-picture']);
    const retimed=applyEditOperation(applyEditOperation(f.t,{kind:'retime',clipId:'right-picture',linked:true,from:80,frames:40,points:[{frame:0,rate:500},{frame:40,rate:1500}],ripple:false}),crossfadeOperation);await conformEdit(retimed,[f.media],f.root,join(f.root,'retimed'),access);await audioParity(f,retimed,'retimed',readFileSync(join(f.root,'retimed/audio/final.wav')).subarray(44));
  }finally{f.close();}
},60000);
