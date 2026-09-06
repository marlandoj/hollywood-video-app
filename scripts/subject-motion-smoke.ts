import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileWanMovePacket,verifyWanMovePacket,writeWanMovePacket} from "../packages/generator/src/wan-move-packet";

// Synthetic geometry only. NumPy independently reads the actual exported files; no GPU/model/network call.
const root=mkdtempSync(join(tmpdir(),"hv-motion-numpy-"));
try{
  const image=join(root,"source.png"),made=Bun.spawnSync(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=white:s=832x480,drawbox=x=80:y=80:w=60:h=60:color=red:t=fill,drawbox=x=600:y=300:w=60:h=60:color=blue:t=fill","-frames:v","1",image]);
  if(made.exitCode)throw new Error(made.stderr.toString());
  const source=readFileSync(image),frame=(frame:number,x:number,y:number,easing="linear",visible=true)=>({frame,x,y,easing,visible});
  const plan={schema:"hv-subject-motion/1",source:{sha256:createHash("sha256").update(source).digest("hex"),width:832,height:480},prompt:"A red square moves across the table while a blue square stays still.",seed:7,subjects:[
    {id:"red",label:"Red square",tracks:[{id:"center",keyframes:[frame(0,1250,2000,"smooth"),frame(40,8750,2000,"linear",false),frame(80,1250,2000)]},{id:"corner",keyframes:[frame(0,1100,1800,"smooth"),frame(40,8600,1800,"linear",false),frame(80,1100,1800)]}]},
    {id:"blue",label:"Blue square",tracks:[{id:"center",keyframes:[frame(0,7500,6500),frame(80,7500,6500)]}]}]};
  const directory=writeWanMovePacket(join(root,"packet"),compileWanMovePacket(plan,source));
  const check=join(root,"check.py");
  writeFileSync(check,`import json, pathlib, sys\nimport numpy as np\np = pathlib.Path(sys.argv[1])\na = np.load(p / 'tracks.npy', allow_pickle=False)\nv = np.load(p / 'visibility.npy', allow_pickle=False)\nassert a.shape == (1, 81, 3, 2) and a.dtype == np.dtype('<f4') and a.flags.c_contiguous\nassert v.shape == (1, 81, 3) and v.dtype == np.dtype('bool') and v.flags.c_contiguous\nassert np.isfinite(a).all()\nassert (a[..., 0] >= 0).all() and (a[..., 0] <= 831).all()\nassert (a[..., 1] >= 0).all() and (a[..., 1] <= 479).all()\n# Analytic points for a smooth quarter (5/32), half and endpoint, followed by linear return.\nnp.testing.assert_allclose(a[0, [0, 10, 20, 40, 60, 80], 0, 0], np.array([.125, .2421875, .5, .875, .5, .125]) * 831, atol=0.0001, rtol=0)\nnp.testing.assert_allclose(a[0, :, 0, 1], .2 * 479, atol=0.0001, rtol=0)\nnp.testing.assert_allclose(a[0, :, 0, 0] - a[0, :, 1, 0], .015 * 831, atol=0.0001, rtol=0)\nnp.testing.assert_allclose(a[0, :, 2, :], np.tile([.75 * 831, .65 * 479], (81, 1)), atol=0.0001, rtol=0)\nassert v[0, :40, :].all() and not v[0, 40:80, :2].any() and v[0, 80, :].all()\nassert v[0, :, 2].all()\n# Native model consumes a leading batch then conditions at a temporal stride of four.\nassert a[0][::4].shape == (21, 3, 2)\nassert not v[0][::4][10:20, :2].any()\nprint(json.dumps({'numpy': np.__version__, 'shape': list(a.shape), 'visibilityShape': list(v.shape), 'conditioningFrames': 21, 'rendered': False}))\n`);
  const decoded=Bun.spawnSync([process.env.HV_NUMPY_PYTHON??(process.platform==="win32"?"python":"python3"),check,directory]);
  if(decoded.exitCode)throw new Error(decoded.stderr.toString());
  console.log(JSON.stringify({packet:verifyWanMovePacket(directory),numpy:JSON.parse(decoded.stdout.toString())}));
}finally{rmSync(root,{recursive:true,force:true});}
