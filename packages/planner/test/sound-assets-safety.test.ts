// HV-031-13: the words on an uploaded sound meet the safety gate.
//
// A sound carries four pieces of creator text -- its label, and its rights record's source, credit
// and licence notes. The library shows them, the spotting list and cue sheet credit them, and SDH
// puts the label in front of viewers. None of them passed `checkPrompt` before this increment.
// The refusal examples are the safety package's own: its prohibited-prompt battery, and the
// split pair its tests use to show a refusal spread across two fields of one request.
import {expect,test} from "bun:test";
import {PROHIBITED_PROMPT_BATTERY,checkPrompt} from "../../safety/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {SoundError,SoundRefused,admitSoundText,emptySoundLibrary,soundRights,updateSoundLibrary,type SoundAsset} from "../src/sound-assets";

const PROJECT="00000000-0000-4000-8000-0000000000aa";
const NOW=Date.parse("2026-10-01T12:00:00.000Z");
const clean={basis:"original",source:"Synthetic test tones",credit:"",terms:"Created solely for this closed test fixture.",attested:true};
const FIELDS=[["label","label"],["source","recording source"],["credit","credit"],["terms","licence or ownership notes"]] as const;
/** The label and rights with one field replaced; credit is capped at 500 and label at 120. */
function withField(field:typeof FIELDS[number][0],text:string):[string,Record<string,unknown>]{return field==="label"?[text,clean]:["Garden birds",{...clean,[field]:text}];}
function refusal(run:()=>unknown):SoundRefused{try{run();}catch(error){if(error instanceof SoundRefused)return error;throw error;}throw new Error("expected a refusal");}
/** A well-formed asset record as `normalizeSoundUpload` would build it, with chosen words. */
function asset(label:string,rights:Record<string,unknown>,id="00000000-0000-4000-8000-000000000001"):SoundAsset{
  const data={schema:"hv-sound-asset/1" as const,id,projectId:PROJECT,label,createdAt:new Date(NOW).toISOString(),rights:soundRights(rights,NOW),
    original:{sha256:"a".repeat(64),bytes:44+4800*6,sampleRate:48000,channels:2,frames:4800,encoding:"pcm_s24le"},audio:{sha256:"b".repeat(64),bytes:44+4800*6,frames:4800},engineVersion:"ffmpeg-sound-"+"c".repeat(64)};
  return {...data,revision:contentHash(data)};
}

/** Every prompt in the safety battery, put in each of the four fields, is refused and the refusal names the field. */
test("a prohibited prompt in the label, source, credit or licence notes is refused, naming the field and that nothing was stored",()=>{
  for(const {prompt,category} of PROHIBITED_PROMPT_BATTERY)for(const [field,name] of FIELDS){
    const [label,rights]=withField(field,prompt),error=refusal(()=>admitSoundText(label,rights,NOW));
    expect(error).toBeInstanceOf(SoundError);expect(error.safety.category).toBe(category);
    expect(error.message).toContain("its "+name+(field==="terms"?" name a real person or fall":" names a real person or falls")+" outside the content policy");expect(error.message).toContain("nothing was stored");
  }
});

/** The safety package's own split pair: each half passes alone, and the two together are refused. */
test("words that pass alone in two fields but fail together are refused as a whole",()=>{
  const first="An explicit scene.",second="The character is a minor.";
  expect(checkPrompt(first).allowed).toBe(true);expect(checkPrompt(second).allowed).toBe(true);
  expect(()=>admitSoundText(first,clean,NOW)).not.toThrow();expect(()=>admitSoundText("Garden birds",{...clean,credit:second},NOW)).not.toThrow();
  for(const [label,rights] of [[first,{...clean,credit:second}],["Garden birds",{...clean,credit:first,terms:second}],[second,{...clean,source:first}]] as const){
    const error=refusal(()=>admitSoundText(label,rights,NOW));
    expect(error.safety.category).toBe("minor_sexual_content");expect(error.message).toContain("taken together, fall outside the content policy");expect(error.message).toContain("nothing was stored");
  }
});

/** C0 controls were refused by `soundText`; the C1 block and DEL were not all covered. Newline and tab stay allowed. */
test("control characters other than newline and tab are refused in every field, C1 included",()=>{
  for(const control of ["\u0001","\u007f","\u0085","\u009b"])for(const [field,name] of FIELDS){
    const [label,rights]=withField(field,"Rain on"+control+" glass");
    // C0 and DEL were already refused by `soundText` ("Use ..."); the C1 block is refused by the gate.
    expect(()=>admitSoundText(label,rights,NOW)).toThrow(control<"\u0080"?"Use ":"Remove the control characters from the sound's "+name+".");
  }
  expect(admitSoundText("Rain\ton glass",{...clean,terms:"Line one.\nLine two."},NOW).rights.terms).toBe("Line one.\nLine two.");
});

/** Ordinary words are admitted unchanged, so a clean import still works. */
test("an ordinary label and rights record are admitted unchanged",()=>{
  const admitted=admitSoundText("  Garden birds · test recording ",{...clean,credit:"Field recording by the director"},NOW);
  expect(admitted.label).toBe("Garden birds · test recording");expect(admitted.rights).toEqual({basis:"original",source:"Synthetic test tones",credit:"Field recording by the director",terms:clean.terms,attestedAt:new Date(NOW).toISOString()});
});

/** The library's admission step is the second gate: a record built by any other path meets the same check. */
test("the sound library refuses to admit a record whose words fail the gate, and is left unchanged",()=>{
  const library=emptySoundLibrary();
  expect(()=>updateSoundLibrary(library,PROJECT,0,asset("A portrait of Taylor Swift",clean),NOW)).toThrow(SoundRefused);
  expect(()=>updateSoundLibrary(library,PROJECT,0,asset("An explicit scene.",{...clean,credit:"The character is a minor."}),NOW)).toThrow("taken together");
  expect(library).toEqual(emptySoundLibrary());
  expect(updateSoundLibrary(library,PROJECT,0,asset("Garden birds",clean),NOW).assets).toHaveLength(1);
});

/** No destructive migration: a record stored before the gate is still read, and its availability can still change. */
test("a sound stored before the gate is not re-validated when the library is read or updated",()=>{
  const old=asset("A portrait of Taylor Swift",clean),data={version:1,assetId:old.id,available:true,at:new Date(NOW).toISOString()};
  const stored={schema:"hv-sound-library/1" as const,version:1,assets:[old],events:[{...data,revision:contentHash(data)}]};
  const updated=updateSoundLibrary(stored,PROJECT,1,{assetId:old.id,available:false},NOW+1000);
  expect(updated.events.map(e=>e.available)).toEqual([true,false]);
});
