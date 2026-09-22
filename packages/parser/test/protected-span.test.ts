/**
 * HV-016-04 — the bound on the screenplay was not a bound on the work.
 *
 * `PROTECTED_SPAN` was `/\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//`, tested once per line. The first
 * alternative is quadratic in the length of the line: `\[\[` matches at every offset of a run of
 * `[`, `[^\]]*` runs to the end of the line, `\]\]` fails, and the engine gives back one character
 * at a time. `parseFountain` bounds the *document* at thirty pages of parsed lines and has never
 * bounded a line, so two hundred thousand `[` is one line, one page, and `rejected: false` — it
 * saves, and every later read parses it again.
 *
 * The replacement is a left-to-right scan whose cursors only move forward. This file asserts two
 * things about it: that it decides exactly what the regex decided, over an exhaustive enumeration
 * of the alphabet that matters, and that it is fast enough that the route's own limit is the limit.
 */
import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {holdsProtectedSpan,parseFountain} from "../src/index";

/** The pattern this replaced, kept here as the oracle and nowhere else. */
const PROTECTED_SPAN = /\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//;

test("the scan decides exactly what the pattern decided, over every string that could disagree",()=>{
  const alphabet=["[","]","/","*"];
  const disagreements:string[]=[];
  let checked=0;
  const walk=(value:string)=>{
    if(value){checked++;if(PROTECTED_SPAN.test(value)!==holdsProtectedSpan(value))disagreements.push(value);}
    if(value.length<8)for(const character of alphabet)walk(value+character);
  };
  walk("");
  // 87,380 strings: every arrangement of the four characters the pattern is about, to length eight.
  expect({checked,disagreements}).toEqual({checked:87380,disagreements:[]});
});

test("and over ordinary text mixed with them, where a false positive would take a line out of the film",()=>{
  const alphabet=["[","]","/","*","a"," ","\t","\\","\n"];
  const disagreements:string[]=[];
  // Seeded by hand rather than randomly, so a failure here is a failure anyone can reproduce.
  let seed=20260922;
  const next=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
  for(let index=0;index<200_000;index++){
    let value="";
    for(let length=1+Math.floor(next()*14);length>0;length--)value+=alphabet[Math.floor(next()*alphabet.length)]!;
    if(PROTECTED_SPAN.test(value)!==holdsProtectedSpan(value))disagreements.push(value);
  }
  expect(disagreements).toEqual([]);
});

test("a line the screenplay route accepts is parsed in milliseconds, not seconds",()=>{
  // 200,000 is the limit `PUT /api/projects/:id/script` enforces on the whole screenplay, so every
  // payload here is one the route saves. Before the scan, the first took 6,048 ms and grew fourfold
  // per doubling; `GET /direction` parses the same text four times.
  const payloads:[string,string][]=[
    ["a run of openers","[".repeat(200_000)],
    ["openers in pairs","[[".repeat(100_000)],
    ["one closer at the end","[".repeat(199_999)+"]"],
    ["a real note then filler","[[a]]"+"x".repeat(199_995)],
    ["comment openers","/*".repeat(100_000)],
    ["a closer with no opener","]".repeat(200_000)],
  ];
  for(const [name,payload] of payloads){
    const started=performance.now();
    const parsed=parseFountain(payload);
    const elapsed=performance.now()-started;
    // The verdict is reported with the name so a failure says which shape was slow.
    expect({name,fast:elapsed<500,ms:Math.round(elapsed)}).toEqual({name,fast:true,ms:Math.round(elapsed)});
    expect(parsed.rejected).toBe(false);
  }
});

test("and the growth is linear, so twice the screenplay is about twice the work",()=>{
  const time=(length:number)=>{const payload="[".repeat(length);const started=performance.now();parseFountain(payload);return performance.now()-started;};
  time(200_000); // warm
  const small=time(50_000),large=time(200_000);
  // Four times the input. Quadratic would be sixteen times; the assertion is deliberately loose,
  // because what it must not tolerate is the sixteen.
  expect({ratio:large<=Math.max(small,1)*8,small:Math.round(small),large:Math.round(large)})
    .toEqual({ratio:true,small:Math.round(small),large:Math.round(large)});
});

test("notes and boneyards are still kept out of the film, which is what the check is for",()=>{
  const parsed=parseFountain("INT. LAB - DAY\n\n[[private note DO NOT RENDER]]\n\n/* cut\nmaterial */\n\nVisible action.");
  expect(parsed.scenes[0]!.action).toEqual(["Visible action."]);
  expect(JSON.stringify(parsed)).not.toContain("DO NOT RENDER");
  // One-line forms of each, and the near misses that are not protected.
  expect(holdsProtectedSpan("[[a note]]")).toBe(true);
  expect(holdsProtectedSpan("before /* and */ after")).toBe(true);
  expect(holdsProtectedSpan("[[unterminated")).toBe(false);
  expect(holdsProtectedSpan("[single brackets]")).toBe(false);
  expect(holdsProtectedSpan("[[a] b]")).toBe(false);
  expect(holdsProtectedSpan("/*/")).toBe(false);
  expect(holdsProtectedSpan("She walks in. Nothing to hide.")).toBe(false);
  // A note after one that does not close: the second is still found.
  expect(holdsProtectedSpan("[[a] [[b]]")).toBe(true);
});

test("no pattern in the parser pairs two things across an unbounded gap",()=>{
  // Asserted over the source because this is a shape one new line reintroduces, and because the
  // parser's own siblings say so: `final-draft.ts` states that every search in it is a linear
  // indexOf. The bounded forms `[\s\S]{0,80}` elsewhere in the repo are fine; this is the
  // unbounded one.
  const source=readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
  // Every regular expression the parser declares, taken from its own source rather than listed.
  const declared=source.split("\n").filter(line=>/^const [A-Z_]+ = \//.test(line));
  expect(declared.length).toBeGreaterThanOrEqual(4);
  for(const line of declared){
    expect({line,unbounded:/\[\\s\\S\]\*/.test(line)}).toEqual({line,unbounded:false});
    expect({line,negated:/\[\^[^\]]*\\?\][^\]]*\]\*/.test(line)}).toEqual({line,negated:false});
  }
});
