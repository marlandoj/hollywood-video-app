import {fileURLToPath} from "node:url";
let modules:Promise<Map<string,Blob>>|undefined;
/** Fixed browser entrypoints only. No owner data or caller-controlled filesystem paths enter the build. */
export async function previewBrowserModule(path:string):Promise<Blob|null>{
  if(!["/api/preview-controller.js","/api/preview-worklet.js"].includes(path))return null;
  modules??=(async()=>{const result=await Bun.build({entrypoints:["preview-controller","preview-worklet"].map(name=>fileURLToPath(new URL("../../frontend/src/"+name+".js",import.meta.url))),target:"browser",format:"esm",splitting:false});if(!result.success)throw new Error("Preview browser modules could not be built.");return new Map(result.outputs.map(output=>["/api/"+output.path.split(/[\\/]/).at(-1),output]));})();
  try{return (await modules).get(path)??null;}catch(error){modules=undefined;throw error;}
}
