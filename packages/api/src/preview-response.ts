import {EditConflict} from "../../planner/src/edit-timeline";
import {PREVIEW_MAX_BYTES} from "../../planner/src/edit-preview-protocol";
export class PreviewResponses {
  readonly #active=new Set<()=>void>();readonly #controller=new AbortController();#closed=false;
  constructor(readonly maximum=8,readonly deadlineMs=60000){if(!Number.isSafeInteger(maximum)||maximum<1||maximum>16||!Number.isSafeInteger(deadlineMs)||deadlineMs<100||deadlineMs>120000)throw new Error("Invalid preview response capacity.");}
  get active(){return this.#active.size;}
  open(request:Request){
    if(this.#closed)throw new EditConflict("Preview service stopped. Reopen the editor.");if(this.#active.size>=this.maximum)throw new EditConflict("Preview delivery is busy. Wait for current requests to finish.");
    const timeout=new AbortController(),signal=AbortSignal.any([request.signal,this.#controller.signal,timeout.signal]);let bytes:Uint8Array|null=null,stream:ReadableStreamDefaultController<Uint8Array>|undefined,finished=false,detachSource=()=>{};
    const timer=setTimeout(()=>timeout.abort(new EditConflict("Preview delivery timed out. Request the current frame again.")),this.deadlineMs);timer.unref();
    const finish=()=>{if(finished)return;finished=true;bytes=null;clearTimeout(timer);signal.removeEventListener("abort",abort);detachSource();this.#active.delete(finish);};
    const abort=()=>{if(stream&&!finished)stream.error(signal.reason);finish();};this.#active.add(finish);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    return {signal,finish,response:(packet:Uint8Array,sha256:string,access:()=>Promise<void>,sourceSignal?:AbortSignal)=>{
      signal.throwIfAborted();sourceSignal?.throwIfAborted();if(finished||bytes||packet.length>PREVIEW_MAX_BYTES||packet.length<12||!/^[a-f0-9]{64}$/.test(sha256))throw new EditConflict("Invalid preview response.");bytes=packet;let at=0,last=-Infinity;
      const body=new ReadableStream<Uint8Array>({start(controller){stream=controller;},async pull(controller){try{signal.throwIfAborted();sourceSignal?.throwIfAborted();if(Date.now()-last>=1000){await access();last=Date.now();}signal.throwIfAborted();sourceSignal?.throwIfAborted();if(finished)return;const end=Math.min(at+64*1024,bytes!.length);controller.enqueue(bytes!.slice(at,end));at=end;if(at===bytes!.length){controller.close();finish();}}catch(error){if(!finished)controller.error(error);finish();}},cancel(){finish();}},{highWaterMark:0});
      if(sourceSignal){const stop=()=>{if(!finished)stream?.error(sourceSignal.reason);finish();};sourceSignal.addEventListener("abort",stop,{once:true});detachSource=()=>sourceSignal.removeEventListener("abort",stop);if(sourceSignal.aborted)stop();}
      return new Response(body,{headers:{"content-type":"application/vnd.hollywood-video.preview","content-length":String(packet.length),"x-hv-preview-sha256":sha256,"cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
    }};
  }
  close(){this.#closed=true;this.#controller.abort(new EditConflict("Preview service stopped."));for(const finish of this.#active)finish();}
}
