/**
 * HV-026-08 — the grading panel.
 *
 * HV-026-07 made a grade something the API could make, check and withhold, and nothing on the page
 * could ask for one. This panel lists the finished cuts, loads one, reads a color decision from eight
 * labelled fields and a look, asks for the grade with a request key that survives a retry, and shows
 * every grade of the cut: offered with a link, or withheld with the reasons the check gave.
 *
 * Mounted on the repository's small DOM (audio-studio-dom.js), with the delivery routes answered by
 * a stub that writes down every request.
 */
import {afterEach,expect,test} from "bun:test";
import {GRADE_CONTROLS,initColorGrade} from "../src/color-grade.js";
import {Element,fire,mountDom,tree} from "./audio-studio-dom.js";

const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
let restore=()=>{};
afterEach(()=>restore());

const NEUTRAL={exposure:0,temperature:0,tint:0,lift:0,gamma:1,gain:1,contrast:1,saturation:1,look:"neutral-709"};
const GRADE={controls:{exposure:[-2,2],temperature:[-1,1],tint:[-1,1],lift:[-0.2,0.2],gamma:[0.5,2],gain:[0.5,2],contrast:[0.5,2],saturation:[0,2]},step:0.01,neutral:NEUTRAL,
  looks:[{id:"neutral-709",label:"Neutral Rec.709",description:"No look."},{id:"warm",label:"Warm",description:"Reds lifted."},{id:"cool",label:"Cool",description:"Blues lifted."}],
  thresholds:{frameShare:0.01,programmeShare:0.05,lumaTolerance:[14,241],lumaNominal:[16,235]},notChecked:["scene-linear exposure"]};
const SOURCES=[
  {id:"cut-new",stage:"picture-edit",completedAt:"2026-09-30T10:00:00.000Z",unavailable:null,width:640,height:360,durationSec:1},
  {id:"cut-gone",stage:"assembly-edit",completedAt:"2026-09-29T10:00:00.000Z",unavailable:"This film is no longer retained, so nothing new can be delivered from it."},
];
const offers=jobs=>({sourceJobId:"cut-new",offers:[{kind:"mezzanine",available:true},{kind:"grade",available:true,reason:null}],grade:GRADE,jobs});

/** The panel opened, with `answer` deciding what each request returns; every request is written down. */
async function panel(answer){
  restore=mountDom();
  const unmount=restore;Object.defineProperty(Element.prototype,"classList",{get(){return {add(){},remove(){}};},configurable:true});
  restore=()=>{unmount();delete Element.prototype.classList;};
  const calls=[],parent=document.createElement("div");document.body.append(parent);
  const request=async(path,options={})=>{calls.push({path,method:options.method??"GET",body:options.body});return answer(path,options,calls);};
  const grade=initColorGrade({parent,request,assetUrl:url=>"https://api.example"+url});
  await grade.open();await settle();
  const all=()=>tree(parent);
  const button=text=>all().find(element=>element.tag==="button"&&element.textContent===text);
  const labelled=text=>{const label=all().find(element=>element.tag==="label"&&element.textContent===text);return all().find(element=>element.id===label?.htmlFor);};
  const status=()=>all().find(element=>element.getAttribute("role")==="status").textContent;
  const texts=()=>all().filter(element=>element.tag==="p").map(element=>element.textContent);
  return {grade,parent,calls,all,button,labelled,status,texts};
}

test("Opening the grade panel lists the finished cuts, and a cut that cannot be graded cannot be chosen.",async()=>{
  const view=await panel(()=>({kinds:[],sources:SOURCES,jobs:[]}));
  expect(view.calls.map(call=>call.method+" "+call.path)).toEqual(["GET "]);
  const choose=view.labelled("Finished cut");
  expect(choose.children.map(option=>[option.value,option.disabled])).toEqual([["cut-new",false],["cut-gone",true]]);
  expect(choose.children[1].textContent).toContain("unavailable: This film is no longer retained");
  expect(choose.value).toBe("cut-new");
  expect(view.button("Load cut").disabled).toBe(false);
  // With nothing gradeable the button is off and the page says why, before any request is made.
  restore();
  const none=await panel(()=>({kinds:[],sources:[SOURCES[1]],jobs:[]}));
  expect(none.labelled("Finished cut").value).toBe("");
  expect(none.button("Load cut").disabled).toBe(true);
  expect(none.status()).toBe("No finished cut can be graded now. Each one listed says why.");
});

test("Grading sends the decision exactly as the fields read, and a retry of the same decision reuses its request key.",async()=>{
  let fail=true;
  const view=await panel((path,options)=>{
    if(path==="")return {kinds:[],sources:SOURCES,jobs:[]};
    if(options.method==="POST"){if(fail){fail=false;throw new Error("The connection dropped.");}return {jobId:"grade-1"};}
    return offers([]);
  });
  fire(view.button("Load cut"),"click");await settle();
  expect(view.calls.at(-1)).toMatchObject({method:"GET",path:"/cut-new"});
  // Every control is a labelled number field, bounded and stepped as the API says, at neutral.
  for(const [name,label] of GRADE_CONTROLS){
    const input=view.labelled(label);
    expect({name,type:input.type,min:input.min,max:input.max,step:input.step,value:input.value})
      .toEqual({name,type:"number",min:String(GRADE.controls[name][0]),max:String(GRADE.controls[name][1]),step:"0.01",value:String(NEUTRAL[name])});
    expect(input.getAttribute("aria-describedby")).toBe(input.id+"-hint");
  }
  view.labelled("Gain").value="1.2";view.labelled("Temperature").value="-0.3";view.labelled("Look").value="warm";
  fire(view.button("Grade this cut"),"click");await settle();
  expect(view.status()).toBe("The connection dropped.");
  fire(view.button("Grade this cut"),"click");await settle();
  const posts=view.calls.filter(call=>call.method==="POST");
  expect(posts).toHaveLength(2);
  expect(posts[0].path).toBe("/cut-new");
  expect(posts[0].body).toEqual({idempotencyKey:posts[0].body.idempotencyKey,kind:"grade",grade:{...NEUTRAL,gain:1.2,temperature:-0.3,look:"warm"}});
  // The retry is the same request: the server answers it with the grade it already made, not a second one.
  expect(posts[1].body.idempotencyKey).toBe(posts[0].body.idempotencyKey);
  expect(view.status()).toBe("Grade requested. It is made and checked below; this can take a few minutes.");
  // A changed decision is a new request.
  view.labelled("Gain").value="1.1";
  fire(view.button("Grade this cut"),"click");await settle();
  expect(view.calls.filter(call=>call.method==="POST").at(-1).body.idempotencyKey).not.toBe(posts[0].body.idempotencyKey);
  // A field that is not a number is refused on the page, and nothing is sent.
  const before=view.calls.length;view.labelled("Lift").value="";
  fire(view.button("Grade this cut"),"click");await settle();
  expect(view.status()).toBe("Enter a number for lift.");
  expect(view.calls.length).toBe(before);
});

test("A withheld grade shows every reason and no download; an offered grade links its file.",async()=>{
  const withheld={id:"g-1",kind:"grade",status:"done",output:null,unavailable:"This grade is withheld: This grade clips the highlights in 30 of 30 frames (up to 97% of frame 0) that the cut did not. Lower the gain or the exposure, and grade again.",
    grade:{decision:{...NEUTRAL,gain:2,exposure:1},look:{id:"neutral-709",label:"Neutral Rec.709"},check:{verdict:"withheld",findings:[
      {code:"highlights-clipped",severity:"withhold",message:"This grade clips the highlights in 30 of 30 frames (up to 97% of frame 0) that the cut did not. Lower the gain or the exposure, and grade again."}]}}};
  const offered={id:"g-2",kind:"grade",status:"done",unavailable:null,output:{url:"/artifacts/token/p/g-2/grade.mp4",revision:"r"},
    grade:{decision:{...NEUTRAL,look:"warm"},look:{id:"warm",label:"Warm"},check:{verdict:"offered",findings:[
      {code:"levels-outside-nominal",severity:"note",message:"The graded cut's luma reaches 13–216, past the nominal 16–235 on less than 1% of any frame."}]}}};
  const mezzanine={id:"m-1",kind:"mezzanine",status:"done",output:{url:"/artifacts/x/m.mkv"}};
  const view=await panel(path=>path===""?{kinds:[],sources:SOURCES,jobs:[]}:offers([withheld,offered,mezzanine]));
  fire(view.button("Load cut"),"click");await settle();
  const articles=view.all().filter(element=>element.tag==="article");
  expect(articles).toHaveLength(2);
  const [first,second]=articles.map(article=>tree(article));
  expect(first.find(element=>element.tag==="h3").textContent).toBe("Neutral Rec.709 · Exposure 1, Gain 2");
  expect(first.some(element=>element.tag==="a")).toBe(false);
  expect(first.filter(element=>element.tag==="p").map(element=>element.textContent)).toEqual([withheld.unavailable,"Withheld: "+withheld.grade.check.findings[0].message]);
  expect(second.find(element=>element.tag==="h3").textContent).toBe("Warm · no primary corrections");
  const link=second.find(element=>element.tag==="a");
  expect({text:link.textContent,href:link.href}).toEqual({text:"Download graded cut",href:"https://api.example/artifacts/token/p/g-2/grade.mp4"});
  expect(second.some(element=>element.tag==="p"&&element.textContent.startsWith("Note: The graded cut's luma"))).toBe(true);
});

test("A grade in progress is polled until it finishes, and the poll stops with it.",async()=>{
  const running={id:"g-1",kind:"grade",status:"running",output:null,unavailable:null,grade:{decision:NEUTRAL,look:{id:"neutral-709",label:"Neutral Rec.709"},check:null}};
  const done={...running,status:"done",output:{url:"/artifacts/t/p/g-1/grade.mp4",revision:"r"},grade:{...running.grade,check:{verdict:"offered",findings:[]}}};
  let polls=0;
  const timers=[],realSetTimeout=globalThis.setTimeout;
  const view=await panel(path=>{if(path==="")return {kinds:[],sources:SOURCES,jobs:[]};polls++;return offers([polls<3?running:done]);});
  globalThis.setTimeout=(callback,ms)=>{if(ms===1500){timers.push(callback);return timers.length;}return realSetTimeout(callback,ms);};
  try{
    fire(view.button("Load cut"),"click");await settle();
    expect(view.texts()).toContain("Making and checking this grade…");
    expect(timers).toHaveLength(1);
    await timers.shift()();await settle();
    expect(timers).toHaveLength(1);
    await timers.shift()();await settle();
    expect(polls).toBe(3);
    expect(timers).toHaveLength(0);
    expect(view.all().find(element=>element.tag==="a").textContent).toBe("Download graded cut");
  }finally{globalThis.setTimeout=realSetTimeout;}
});
