import {fileURLToPath} from "node:url";
let modules:Promise<Map<string,Blob>>|undefined;
const entries=["preview-controller","preview-worklet","mask-editor","mask-viewport","mask-draft","mask-source","edit-script","edit-assemblies","edit-assembly-preview"];
/** Fixed browser entrypoints only. No owner data or caller-controlled filesystem paths enter the build. */
export async function previewBrowserModule(path:string):Promise<Blob|null>{
  if(!entries.some(name=>path==="/api/"+name+".js"))return null;
  modules??=(async()=>{const result=await Bun.build({entrypoints:entries.map(name=>fileURLToPath(new URL("../../frontend/src/"+name+".js",import.meta.url))),target:"browser",format:"esm",splitting:false});if(!result.success)throw new Error("Preview browser modules could not be built.");return new Map(result.outputs.map(output=>["/api/"+output.path.split(/[\\/]/).at(-1),output]));})();
  try{return (await modules).get(path)??null;}catch(error){modules=undefined;throw error;}
}
