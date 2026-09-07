import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {create, type Font} from "fontkit";
import {editFail} from "../../planner/src/edit-errors";
import type {MotionGraphicPlan} from "../../planner/src/motion-graphics";

export interface GraphicFont {file:string;weight:number;range:string;sha256:string;bytes:number;data:Buffer}
export const graphicHash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
let installed:{fonts:GraphicFont[];parsed:Font[];license:Buffer}|undefined;
export function graphicFonts(plan:MotionGraphicPlan){
  if(!installed){
    const ranges=JSON.parse(readFileSync(new URL(import.meta.resolve("@fontsource/inter/unicode.json")),"utf8")) as Record<string,string>;
    const fonts:GraphicFont[]=[],parsed:Font[]=[];
    for(const weight of [400,700])for(const [subset,range] of Object.entries(ranges)){
      const data=readFileSync(new URL(import.meta.resolve(`@fontsource/inter/files/inter-${subset}-${weight}-normal.woff2`))),font=create(data);
      if(!("hasGlyphForCodePoint" in font))editFail("The installed graphic font is not a single font face.");
      const sha256=graphicHash(data);fonts.push({file:`fonts/${weight}-${subset}-${sha256}.woff2`,weight,range,sha256,bytes:data.length,data});parsed.push(font);
    }
    installed={fonts,parsed,license:readFileSync(new URL(import.meta.resolve("@fontsource/inter/LICENSE")))};
  }
  const text=[plan.text,plan.secondary,...plan.credits.flatMap(c=>[c.role,c.name])].join("\n");
  for(const character of new Set(text))if(!/\s/u.test(character)){
    const point=character.codePointAt(0)!;
    for(const weight of [400,700])if(!installed.fonts.some((f,i)=>f.weight===weight&&f.range.split(",").some(r=>{const [a,b]=r.slice(2).split("-").map(h=>parseInt(h,16));return point>=a!&&point<=(b??a!);})&&installed!.parsed[i]!.hasGlyphForCodePoint(point)))editFail(`The bundled Inter font has no glyph for U+${point.toString(16).toUpperCase()}. Choose supported text or install and qualify a font covering that script.`);
  }
  return {fonts:installed.fonts,license:installed.license};
}
