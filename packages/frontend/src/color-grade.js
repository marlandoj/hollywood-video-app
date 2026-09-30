import {whileBusy} from "./busy.js";
/**
 * HV-026-08: the grading panel. A creator picks a finished cut, sets a color decision — eight
 * numbers and a look from the studio's library — and asks for a grade. The grade is a deliverable
 * (docs/COLOR-GRADE.md): the server makes it, checks it, and either offers it with a link or
 * withholds it with the reason. This panel shows both, and never hides a withheld grade.
 *
 * The poll clock is sound-studio.js's (HV-030-08), copied because the API serves this file on its
 * own: a poll that sees nothing change counts toward the limit, and the panel stops and says so.
 */
export const POLL_INTERVAL_MS=1500,STALL_LIMIT_MS=30*60*1000;
const STALL_POLLS=Math.ceil(STALL_LIMIT_MS/POLL_INTERVAL_MS);
/** What each control is called on the page, and what moving it does, in the order the grade applies them. */
export const GRADE_CONTROLS=[
  ["exposure","Exposure (stops)","A gain of two to the power of this on the whole picture."],
  ["temperature","Temperature","Positive is warmer: red up, blue down."],
  ["tint","Tint","Positive is more magenta, negative more green."],
  ["saturation","Saturation","0 is black and white; 1 leaves color as it is."],
  ["lift","Lift","Raises or lowers the blacks, leaving white where it is."],
  ["gain","Gain","Scales the whole range."],
  ["contrast","Contrast","About mid-grey."],
  ["gamma","Gamma","Above 1 brightens the mid-tones."],
];
const seconds=value=>Math.round(value*10)/10+" s";
export function initColorGrade({parent,request,assetUrl,canEdit=()=>true}){
  const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const details=label=>{const el=node("details");el.append(node("summary",label));return el;};
  const actions=()=>{const el=node("div");el.className="result-actions";return el;};
  const panel=node("section"),status=node("p"),sources=node("div"),editor=node("form"),grades=node("div");
  panel.className="motion-workbench color-grade";panel.hidden=true;status.className="status";status.setAttribute("role","status");
  panel.append(node("h2","Color grade"),node("p","Grade a finished cut: primary corrections and a look. The cut itself is never changed. Each grade is checked before it is offered, and a grade that clips the picture or leaves broadcast levels is kept with the reason instead."),status,sources,editor,grades);
  parent.append(panel);
  let busy=false,serial=0,cut=null,offer=null,readers={},look=null,pendingKey=null,pendingDecision=null,timer=null,stalls=0,lastSeen="",epoch=0,opener=null;
  const tell=(message,error=false)=>{status.textContent=message;status.dataset.state=error?"error":"success";};
  const button=(label,action,primary=false)=>{const el=node("button",label);el.type="button";el.className=primary?"":"secondary";el.onclick=()=>run(action);return el;};
  async function run(action){
    if(busy)return;busy=true;const controls=[...panel.querySelectorAll("button,input,select")],disabled=controls.map(control=>control.disabled);controls.forEach(control=>control.disabled=true);
    try{await whileBusy(panel,action);}catch(error){tell(error.message||"This step could not finish. Your grade settings are kept.",true);}
    finally{busy=false;controls.forEach((control,index)=>control.disabled=disabled[index]);}
  }
  function field(container,label,hint,value,{min,max,step}){
    const wrap=node("div"),caption=node("label",label),input=node("input"),help=node("p",hint);
    wrap.className="cast-field";input.id="grade-field-"+(++serial);help.id=input.id+"-hint";caption.htmlFor=input.id;
    input.type="number";input.min=String(min);input.max=String(max);input.step=String(step);input.value=String(value);input.required=true;
    input.setAttribute("aria-describedby",help.id);help.className="hint";
    wrap.append(caption,input,help);container.append(wrap);return input;
  }
  function stopWatching(){clearTimeout(timer);timer=null;}
  /** The decision exactly as the fields read, refused here only when a field is not a number at all. */
  function decision(){
    const out={};
    for(const [name,label] of GRADE_CONTROLS){const text=readers[name].value.trim(),value=Number(text);if(!text||!Number.isFinite(value))throw new Error("Enter a number for "+label.toLowerCase()+".");out[name]=value;}
    out.look=look.value;return out;
  }
  function drawSources(list){
    sources.replaceChildren();
    const wrap=node("div"),caption=node("label","Finished cut"),choose=node("select");wrap.className="cast-field";choose.id="grade-cut-"+(++serial);caption.htmlFor=choose.id;
    for(const source of list){
      const option=new Option((source.stage==="assembly-edit"?"Assembly":"Picture edit")+" · "+(source.completedAt?new Date(source.completedAt).toLocaleString():source.id)
        +(source.durationSec?" · "+seconds(source.durationSec):"")+(source.unavailable?" · unavailable: "+source.unavailable:""),source.id);
      option.disabled=Boolean(source.unavailable);choose.append(option);
    }
    choose.value=list.find(source=>!source.unavailable)?.id??"";
    wrap.append(caption,choose);
    const row=actions(),load=button("Load cut",()=>inspect(choose.value),true);load.disabled=!choose.value;
    choose.onchange=()=>{load.disabled=!choose.value;};
    row.append(load,button("Close color grade",close));
    sources.append(wrap,row);
    if(!list.length)tell("Render a picture edit or an assembly before grading it.");
    else if(!choose.value)tell("No finished cut can be graded now. Each one listed says why.");
    else tell("Choose a finished cut and load it to grade it.");
  }
  function drawEditor(){
    editor.replaceChildren();readers={};pendingKey=null;pendingDecision=null;
    const options=offer.grade,primaries=node("fieldset"),legend=node("legend","Primary corrections");primaries.append(legend);
    for(const [name,label,hint] of GRADE_CONTROLS){const [min,max]=options.controls[name];readers[name]=field(primaries,label,hint+" From "+min+" to "+max+".",options.neutral[name],{min,max,step:options.step});}
    const looks=node("fieldset"),lookWrap=node("div"),caption=node("label","Look"),about=node("p");looks.append(node("legend","Look"));
    look=node("select");look.id="grade-look-"+(++serial);caption.htmlFor=look.id;about.id=look.id+"-hint";about.className="hint";look.setAttribute("aria-describedby",about.id);lookWrap.className="cast-field";
    for(const item of options.looks)look.append(new Option(item.label,item.id));look.value=options.neutral.look;
    const describe=()=>{about.textContent=options.looks.find(item=>item.id===look.value)?.description??"";};look.onchange=describe;describe();
    lookWrap.append(caption,look,about);looks.append(lookWrap);
    const row=actions();
    row.append(button("Grade this cut",submit,true),button("Reset to neutral",()=>{for(const [name] of GRADE_CONTROLS)readers[name].value=String(options.neutral[name]);look.value=options.neutral.look;describe();pendingKey=null;tell("Settings reset to neutral. Nothing is graded until you ask.");}));
    const limits=details("What is checked before a grade is offered");
    limits.append(node("p","A grade is withheld if more than "+Math.round(options.thresholds.programmeShare*100)+"% of its frames have "+Math.round(options.thresholds.frameShare*100)
      +"% or more of the picture newly clipped to black or white, or if any frame has "+Math.round(options.thresholds.frameShare*100)+"% or more outside broadcast levels ("
      +options.thresholds.lumaTolerance.join("–")+")."),node("p","Not checked: "+options.notChecked.join("; ")+"."));
    editor.append(primaries,looks,row,limits);
    editor.onsubmit=event=>{event.preventDefault();void run(submit);};
  }
  /**
   * One request key per decision, kept until the server answers. A retry of the same decision after a
   * dropped connection sends the same key, so it cannot make two grades; a changed decision is a new
   * request.
   */
  async function submit(){
    if(!canEdit())throw new Error("Save or close the open edit before grading.");
    const grade=decision(),same=pendingDecision&&JSON.stringify(pendingDecision)===JSON.stringify(grade);
    if(!same){pendingKey=crypto.randomUUID();pendingDecision=grade;}
    tell("Asking for the grade…");
    const answer=await request("/"+encodeURIComponent(cut),{method:"POST",body:{idempotencyKey:pendingKey,kind:"grade",grade}});
    pendingKey=null;pendingDecision=null;
    await refresh();tell("Grade requested. It is made and checked below; this can take a few minutes.");
    return answer;
  }
  function describeDecision(value,labels){
    const changed=GRADE_CONTROLS.filter(([name])=>value[name]!==offer.grade.neutral[name]).map(([name,label])=>label.replace(/ \(.*\)$/,"")+" "+value[name]);
    return (labels.find(item=>item.id===value.look)?.label??value.look)+(changed.length?" · "+changed.join(", "):" · no primary corrections");
  }
  function drawGrades(jobs){
    grades.replaceChildren();
    const mine=jobs.filter(job=>job.kind==="grade");
    const box=details("Grades of this cut · "+mine.length);box.open=true;grades.append(box);
    if(!mine.length){box.append(node("p","No grade of this cut yet."));return;}
    for(const job of mine){
      const item=node("article"),heading=node("h3",describeDecision(job.grade.decision,offer.grade.looks));item.className="grade-version";item.append(heading);
      if(job.status==="queued"||job.status==="running")item.append(node("p","Making and checking this grade…"));
      else if(job.status!=="done")item.append(node("p","This grade could not be made: "+(job.failureReason||job.status)+"."));
      const check=job.grade.check;
      if(job.output){
        item.append(node("p","Offered: the check found nothing that withholds it."));
        const link=node("a","Download graded cut");link.className="button-link";link.href=assetUrl(job.output.url);link.setAttribute("download","");item.append(link);
      }else if(job.status==="done")item.append(node("p",job.unavailable??"This grade is not available."));
      for(const finding of check?.findings??[]){const line=node("p",(finding.severity==="withhold"?"Withheld: ":"Note: ")+finding.message);line.dataset.severity=finding.severity;item.append(line);}
      box.append(item);
    }
  }
  function watch(jobs){
    stopWatching();
    if(panel.hidden||!jobs.some(job=>job.kind==="grade"&&(job.status==="queued"||job.status==="running")))return;
    const seen=JSON.stringify(jobs.map(job=>[job.id,job.status,job.output?.revision??null])),mine=epoch;
    stalls=seen===lastSeen?stalls+1:0;lastSeen=seen;
    if(stalls>=STALL_POLLS){tell("This grade has not moved in "+STALL_LIMIT_MS/60000+" minutes. Load the cut again to check on it.",true);return;}
    timer=setTimeout(async()=>{if(panel.hidden||mine!==epoch)return;if(busy){watch(jobs);return;}try{await refresh();}catch(error){if(mine===epoch)tell(error.message+" Load the cut again to retry.",true);}},POLL_INTERVAL_MS);
  }
  async function refresh(){
    const mine=epoch,next=await request("/"+encodeURIComponent(cut));
    if(mine!==epoch)return;offer=next;drawGrades(next.jobs);watch(next.jobs);
  }
  /** A cut id is never empty here: an empty path would be the list route, read as an offer. */
  async function inspect(id){
    if(!id)throw new Error("Choose a finished cut to grade.");
    epoch++;stopWatching();lastSeen="";stalls=0;
    const next=await request("/"+encodeURIComponent(id));
    const available=next.offers.find(value=>value.kind==="grade");
    if(!available?.available)throw new Error(available?.reason||"This cut cannot be graded.");
    cut=id;offer=next;drawEditor();drawGrades(next.jobs);watch(next.jobs);
    tell("Cut loaded. Set the grade and ask for it; nothing changes the cut.");
    readers.exposure?.focus();
  }
  function close(){epoch++;stopWatching();panel.hidden=true;if(opener?.isConnected&&!opener.disabled)opener.focus();}
  async function open(from){
    opener=from??null;panel.hidden=false;epoch++;stopWatching();editor.replaceChildren();grades.replaceChildren();cut=null;
    await run(async()=>{const list=await request("");drawSources(list.sources??[]);});
  }
  return {open,close,get grading(){return cut;}};
}
