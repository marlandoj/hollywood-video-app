import {expect,test} from "bun:test";
import {assemble,assembleAsync,assembleCurrentFilmMixedAsync,type AssembleOptions} from "../src/index";
import type {CurrentFilmMixedCheckpoint,CurrentFilmMixedCheckpointContext} from "../../planner/src/current-film-mixed-context";

/** Every export records when it was assembled (HV-031-02); these fixtures fix one real instant. */
const assembledAt="2026-09-17T10:00:00.000Z";

test("legacy assembly cannot bypass the explicit V3 entry through own or inherited private options",async()=>{
  for(const options of [{mixed:{}},Object.create({mixed:{}})] as AssembleOptions[]){
    expect(()=>assemble([],[],"unused",options)).toThrow("explicit version-three");
    await expect(assembleAsync([],[],"unused",options)).rejects.toThrow("explicit version-three");
  }
});
test("already cancelled V3 assembly stops before reading caller metadata or files",async()=>{
  const signal=AbortSignal.abort();let reads=0;
  const context=Object.defineProperty({},"currentFilm",{enumerable:true,get(){reads++;throw new Error("Unexpected plan read.");}}) as CurrentFilmMixedCheckpointContext;
  await expect(assembleCurrentFilmMixedAsync(context,{} as CurrentFilmMixedCheckpoint,"unused","unused",{assembledAt,signal,access:async()=>{reads++;}})).rejects.toThrow();
  expect(reads).toBe(0);
});
