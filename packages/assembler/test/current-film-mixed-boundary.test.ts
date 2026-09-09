import {expect,test} from "bun:test";
import {assemble,assembleAsync,assembleCurrentFilmMixedAsync,type AssembleOptions} from "../src/index";
import type {CurrentFilmMixedCheckpoint,CurrentFilmMixedCheckpointContext} from "../../planner/src/current-film-mixed-context";

test("legacy assembly cannot bypass the explicit V3 entry through own or inherited private options",async()=>{
  for(const options of [{mixed:{}},Object.create({mixed:{}})] as AssembleOptions[]){
    expect(()=>assemble([],[],"unused",options)).toThrow("explicit version-three");
    await expect(assembleAsync([],[],"unused",options)).rejects.toThrow("explicit version-three");
  }
});
test("already cancelled V3 assembly stops before reading caller metadata or files",async()=>{
  const signal=AbortSignal.abort();let reads=0;
  const context=Object.defineProperty({},"currentFilm",{enumerable:true,get(){reads++;throw new Error("Unexpected plan read.");}}) as CurrentFilmMixedCheckpointContext;
  await expect(assembleCurrentFilmMixedAsync(context,{} as CurrentFilmMixedCheckpoint,"unused","unused",{signal,access:async()=>{reads++;}})).rejects.toThrow();
  expect(reads).toBe(0);
});
