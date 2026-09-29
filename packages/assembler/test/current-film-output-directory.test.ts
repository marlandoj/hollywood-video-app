import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createCurrentFilmExportDirectory,currentFilmExportDirectoryKey} from "../src/current-film-output-directory";

test("exclusive delivery directories preserve a replacement export when an earlier writer finishes late",()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-mixed-output-"));
  try{
    const first=join(root,"project","job","exports",crypto.randomUUID()),second=join(root,"project","job","exports",crypto.randomUUID());
    createCurrentFilmExportDirectory(root,"project","job",first);createCurrentFilmExportDirectory(root,"project","job",second);
    writeFileSync(join(second,"export.mp4"),"replacement");writeFileSync(join(first,"export.mp4"),"late original");
    expect(readFileSync(join(second,"export.mp4"),"utf8")).toBe("replacement");
    expect(()=>createCurrentFilmExportDirectory(root,"project","job",second)).toThrow();
    expect(readFileSync(join(second,"export.mp4"),"utf8")).toBe("replacement");
    expect(currentFilmExportDirectoryKey(root,"project","job",join(root,"project","job"))).toBe("project/job");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("delivery directory refuses foreign owners, arbitrary nested paths and linked parents",()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-mixed-output-"));
  try{
    for(const path of [join(root,"foreign","job"),join(root,"project","job","clips","output"),join(root,"project","job","exports","anything")])expect(()=>createCurrentFilmExportDirectory(root,"project","job",path)).toThrow("exact target job");
    const target=join(root,"neighbor");mkdirSync(target);mkdirSync(join(root,"project","job"),{recursive:true});
    symlinkSync(target,join(root,"project","job","exports"),process.platform==="win32"?"junction":"dir");
    expect(()=>createCurrentFilmExportDirectory(root,"project","job",join(root,"project","job","exports",crypto.randomUUID()))).toThrow("linked");
  }finally{rmSync(root,{recursive:true,force:true});}
});
