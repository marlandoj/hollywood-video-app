import {expect,test} from "bun:test";
import {CAMERA_PRESETS,DEFAULT_FRAMING,DEFAULT_OPTICS,framingFilter,framingSettings,opticalFieldOfView,opticsSettings} from "../src/framing";
import {DEFAULT_DIRECTION,directionEntry,directionSettings,directionSnapshot,directShots,validateDirection} from "../src/direction";
import {planShots} from "../src/index";
import {parseFountain} from "../../parser/src/index";
test("framing stays inside the source with equal scale and finite modeled optics",()=>{
  for(const value of [{x:0,y:0,size:2499},{x:5001,y:0,size:5000},{x:0,y:-1,size:5000},{x:0,y:0,size:10001},{x:0,y:0,size:5000.5},{x:0,y:0,size:5000,rotate:90},null])expect(()=>framingSettings(value)).toThrow();
  expect(framingFilter({x:5000,y:2500,size:5000},320,180)).toBe("crop=160:90:160:44,scale=320:180:flags=lanczos,setsar=1");
  for(const value of [{sensorWidthMm:0},{sensorHeightMm:Infinity},{squeeze:2.01},{squeeze:NaN},{look:"\u0000"},{look:"x".repeat(401)},{secret:"ignored?"}])expect(()=>opticsSettings(value)).toThrow();
  expect(directionSettings({})).toEqual(DEFAULT_DIRECTION);expect(Object.hasOwn(directionSettings({}),"framing")).toBe(false);expect(Object.hasOwn(directionSettings({}),"optics")).toBe(false);
});
test("angular spans follow focal length, sensor dimensions, squeeze and off-axis crop boundaries",()=>{
  const full=opticalFieldOfView(DEFAULT_OPTICS,50);expect(full.horizontalDeg).toBeCloseTo(39.5977527,6);expect(full.verticalDeg).toBeCloseTo(22.8951925,5);
  const centered=opticalFieldOfView(DEFAULT_OPTICS,50,{x:2500,y:2500,size:5000});expect(centered.horizontalDeg).toBeCloseTo(20.4079474,6);
  const left=opticalFieldOfView(DEFAULT_OPTICS,50,{x:0,y:2500,size:5000}),right=opticalFieldOfView(DEFAULT_OPTICS,50,{x:5000,y:2500,size:5000});
  expect(left.horizontalDeg).toBeCloseTo(full.horizontalDeg/2,8);expect(right).toEqual(left);expect(left.horizontalDeg).toBeLessThan(centered.horizontalDeg);
  expect(opticalFieldOfView({...DEFAULT_OPTICS,squeeze:2},100).horizontalDeg).toBeCloseTo(full.horizontalDeg,8);
  expect(opticalFieldOfView(DEFAULT_OPTICS,100).verticalDeg).toBeLessThan(full.verticalDeg);
  expect(()=>opticalFieldOfView(DEFAULT_OPTICS,NaN)).toThrow();expect(framingSettings(DEFAULT_FRAMING)).toEqual(DEFAULT_FRAMING);
});
test("preset settings are editable source-bound direction, hashed and gated before generation",()=>{
  const shot=planShots(parseFountain("EXT. GARDEN - DAY\n\nA gate swings open."),7000,24)[0]!;
  // Golden revision produced by PR 27 before framing/optics existed.
  expect(directionSnapshot("p",1,[directionEntry(shot,{lensMm:50})],0).revision).toBe("8015deda5bd522788a42dbc3b6c4ea5055facaa49ebcffc5d35705d25dc19333");
  for(const preset of CAMERA_PRESETS){const entry=directionEntry(shot,{...preset.settings,framing:{x:5000,y:2500,size:5000}}),snapshot=directionSnapshot("p",1,[entry]);
    expect(validateDirection(snapshot,"p")).toEqual(snapshot);expect(directShots([shot],snapshot)[0]!.prompt).toContain(preset.settings.optics.look);
    const edited=structuredClone(snapshot);edited.entries[0]!.settings.framing!.x=0;expect(()=>validateDirection(edited,"p")).toThrow("changed");}
  expect(()=>directShots([shot],directionSnapshot("p",1,[directionEntry(shot,{optics:{look:"deepfake of a real celebrity"}})]))).toThrow("content policy");
});
