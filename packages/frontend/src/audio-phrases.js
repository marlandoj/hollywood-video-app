const tokens=text=>[...(text??"").matchAll(/\S+/gu)].map(m=>({start:m.index,end:m.index+m[0].length,text:m[0]}));
export function describePhrase(p,source){const words=tokens(source),start=words.findIndex(w=>w.start===p.start)+1,end=words.findIndex(w=>w.end===p.end)+1;
  return ["Words "+start+"–"+end+": “"+p.text+"”",p.speed!==undefined?"speed "+p.speed:null,p.volume!==undefined?"volume "+p.volume:null,p.pauseBeforeMs?"requested pause before "+p.pauseBeforeMs+" ms":null,p.pauseAfterMs?"requested pause after "+p.pauseAfterMs+" ms":null].filter(Boolean).join(" · ");}
export function createPhraseEditor({parent,node,details,field,button,changed}){
  const panel=details("Phrase pacing and volume"),list=node("div"),draft=node("fieldset");draft.append(node("legend","Direct a phrase in this line"));
  panel.append(node("p","Choose whole words, then set optional speed, volume or pauses. Values guide the voice; they do not guarantee word stress. Outside each phrase, the line settings resume."),list,draft);parent.append(panel);
  const first=field(draft,"Phrase first word"),last=field(draft,"Phrase last word"),preview=node("p"),speed=field(draft,"Phrase speed multiplier","number",.6,1.5,.05),volume=field(draft,"Phrase volume multiplier","number",.5,2,.05);draft.append(preview);
  const pauses=details("Requested pauses around this phrase"),before=field(pauses,"Requested pause before phrase (milliseconds)","number",0,3000,1),after=field(pauses,"Requested pause after phrase (milliseconds)","number",0,3000,1);pauses.append(node("p","These pauses are requested from the voice provider. Their actual timing comes from the retained audio. Use a single pause between neighboring phrases."));draft.append(pauses);
  for(const input of [speed,volume,before,after])input.required=false;
  let source="",words=[],values=[],editing=-1,pending=false;
  const apply=button("Apply phrase to line draft",save),discard=button("Discard phrase draft",()=>{reset();changed();});draft.append(node("p","Blank speed or volume inherits the line setting."),apply,discard);
  function pick(){const a=words[Number(first.value)],b=words[Number(last.value)];return a&&b&&a.start<b.end?{start:a.start,end:b.end,text:source.slice(a.start,b.end)}:null;}
  function show(){preview.textContent=pick()?.text??"Choose the first and last word in order.";}
  function reset(){editing=-1;pending=false;first.value="0";last.value="0";for(const input of [speed,volume,before,after])input.value="";apply.textContent="Apply phrase to line draft";show();}
  for(const input of [first,last,speed,volume,before,after])input.addEventListener("input",()=>{pending=true;if(input===first&&Number(last.value)<Number(first.value))last.value=first.value;show();});
  function draw(){list.replaceChildren();if(!values.length)list.append(node("p","No phrase overrides in this line draft."));
    for(const [i,p]of values.entries()){const row=node("article");row.className="cast-card";row.append(node("p",describePhrase(p,source)),button("Edit phrase "+(i+1),()=>{if(pending)throw new Error("Apply or discard the current phrase draft first.");editing=i;first.value=String(words.findIndex(w=>w.start===p.start));last.value=String(words.findIndex(w=>w.end===p.end));speed.value=p.speed??"";volume.value=p.volume??"";before.value=p.pauseBeforeMs??"";after.value=p.pauseAfterMs??"";apply.textContent="Update phrase in line draft";show();}),button("Remove phrase "+(i+1),()=>{if(pending)throw new Error("Apply or discard the current phrase draft first.");values.splice(i,1);reset();draw();changed();}));list.append(row);}
  }
  function save(){const phrase=pick();if(!phrase)throw new Error("Choose a phrase's first and last word in order.");
    for(const [input,min,max,integer]of [[speed,.6,1.5,false],[volume,.5,2,false],[before,0,3000,true],[after,0,3000,true]])if(input.validity.badInput||input.value!==""&&(!Number.isFinite(Number(input.value))||Number(input.value)<min||Number(input.value)>max||integer&&!Number.isInteger(Number(input.value))))throw new Error("Use valid phrase speed, volume and whole-millisecond pauses within the displayed limits.");
    if(speed.value!=="")phrase.speed=Number(speed.value);if(volume.value!=="")phrase.volume=Number(volume.value);if(Number(before.value))phrase.pauseBeforeMs=Number(before.value);if(Number(after.value))phrase.pauseAfterMs=Number(after.value);
    if(Object.keys(phrase).length===3)throw new Error("Set a phrase speed, volume or pause, or remove its direction.");
    const next=values.filter((_,i)=>i!==editing);if(next.length>=16)throw new Error("Use up to 16 phrase directions per line.");if(next.some(p=>p.start<phrase.end&&phrase.start<p.end))throw new Error("This phrase overlaps an existing direction. Edit that phrase or choose another range.");
    next.push(phrase);next.sort((a,b)=>a.start-b.start);values=next;reset();draw();changed();
  }
  return {set(text,phrases=[]){source=text??"";words=tokens(source);values=structuredClone(phrases);first.replaceChildren();last.replaceChildren();for(const [i,w]of words.entries()){first.append(new Option((i+1)+" · "+w.text,String(i)));last.append(new Option((i+1)+" · "+w.text,String(i)));}draft.disabled=!words.length;reset();draw();},values(){if(pending)throw new Error("Apply or discard the phrase draft before reviewing the line.");return structuredClone(values);}};
}
