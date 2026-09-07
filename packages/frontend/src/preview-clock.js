// Map audio-device context time through transport transitions rather than extrapolating only the latest event.
const integer=(n,lo,hi)=>Number.isSafeInteger(n)&&n>=lo&&n<=hi;
export class PreviewClock {
  constructor(){this.epoch=0;this.frames=1;this.initial=0;this.through=0;this.anchors=[];}
  reset(epoch,frames,at){if(!integer(epoch,this.epoch+1,Number.MAX_SAFE_INTEGER)||!integer(frames,1,108000)||!integer(at,0,frames*1600))throw new Error('Invalid preview clock position.');this.epoch=epoch;this.frames=frames;this.initial=at;this.through=at;this.anchors=[];}
  pictureThrough(frame){if(!integer(frame,0,this.frames))throw new Error('Invalid preview clock coverage.');this.through=Math.max(this.through,frame*1600);}
  accept(message){
    if(message.epoch!==this.epoch||message.kind==='accepted')return;
    if(!['playing','buffering','paused','stopped','ended'].includes(message.state)||!integer(message.contextFrame,0,Number.MAX_SAFE_INTEGER)||!integer(message.at,0,this.frames*1600))throw new Error('Invalid preview clock event.');
    const previous=this.anchors.at(-1);if(previous&&(message.contextFrame<previous.contextFrame||message.at<previous.at))throw new Error('Preview clock moved backwards without a seek.');
    if(previous&&message.contextFrame===previous.contextFrame)this.anchors.pop();this.anchors.push({state:message.state,at:message.at,contextFrame:message.contextFrame});if(this.anchors.length>128)this.anchors.shift();
  }
  position(contextTime){
    if(!Number.isFinite(contextTime)||contextTime<0)throw new Error('Invalid audio-device timestamp.');const sample=Math.floor(contextTime*48000);let selected=-1;
    for(let i=this.anchors.length-1;i>=0;i--)if(this.anchors[i].contextFrame<=sample){selected=i;break;}
    if(selected<0)return {at:this.anchors[0]?.at??this.initial,frame:Math.min(this.frames-1,Math.floor((this.anchors[0]?.at??this.initial)/1600)),state:'waiting'};
    const anchor=this.anchors[selected],next=this.anchors[selected+1],at=anchor.state==='playing'?Math.min(anchor.at+sample-anchor.contextFrame,next?.at??this.through,this.frames*1600):anchor.at;
    return {at,frame:Math.min(this.frames-1,Math.floor(at/1600),Math.max(0,Math.ceil(this.through/1600)-1)),state:anchor.state};
  }
}
