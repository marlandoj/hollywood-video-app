import {editFail} from '../../planner/src/edit-timeline';
import {soundRuntimeRevision} from './sound-audio';

/** One read operation, including its response body. Authorization is deliberately separate. */
export class PreviewRuntimeCheck {
  #checkedAt=-Infinity;
  #failed=false;
  #failure:unknown;
  constructor(readonly expected:string,readonly read=soundRuntimeRevision,readonly now=()=>performance.now()){}
  check(fresh=false):void{
    if(this.#failed)throw this.#failure;
    const at=this.now();
    if(!fresh&&at>=this.#checkedAt&&at-this.#checkedAt<1000)return;
    try{
      if(this.read()!==this.expected)editFail('Restart preview preparation with the current media runtime.');
      this.#checkedAt=this.now();
    }catch(error){this.#failed=true;this.#failure=error;throw error;}
  }
}
