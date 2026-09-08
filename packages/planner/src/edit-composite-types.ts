export interface EditMaskPoint {id:string;xQ16:number;yQ16:number}
export interface EditMaskBox {xQ16:number;yQ16:number;widthQ16:number;heightQ16:number}
export interface EditMaskKeyframeBase {sourceFrame:number;interpolation:"hold"|"linear"}
export interface EditBoxMaskKeyframe extends EditMaskKeyframeBase {geometry:EditMaskBox}
export interface EditPolygonMaskKeyframe extends EditMaskKeyframeBase {geometry:{points:EditMaskPoint[]}}
export interface EditMaskBase {
  id:string;label:string;sourceRevision:string;
  combine:"replace"|"union"|"intersect"|"subtract";
  invert:boolean;featherQ8:number;
}
export type EditMask=EditMaskBase&(
  |{kind:"rectangle"|"ellipse";keyframes:EditBoxMaskKeyframe[]}
  |{kind:"polygon";keyframes:EditPolygonMaskKeyframe[]}
);
export interface EditTrackMatte {layer:number;channel:"alpha"|"luma";invert:boolean}
export interface EditPlacement {xQ16:number;yQ16:number;scaleQ16:number;rotationMilliDegrees:number}
export interface EditComposite {
  schema:"hv-edit-composite/1";
  masks?:EditMask[];
  matte?:EditTrackMatte;
  placement?:EditPlacement;
}
export type EditCompositeOperation=
  |{kind:"composite";clipId:string;composite:EditComposite|null}
  |{kind:"matte-only";layers:number[]};
export const EDIT_COMPOSITE_LIMITS={masks:8,vertices:64,keyframes:512,pointSamples:65536,payloadBytes:2*1024**2,coordinateMinQ16:-65536,coordinateMaxQ16:131072,featherMaxQ8:128*256,scaleMinQ16:16384,scaleMaxQ16:262144} as const;
