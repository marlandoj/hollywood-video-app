import type {DecodedPreviewPage,PreviewPageIdentity} from '../../planner/src/edit-preview-protocol';
export function fetchPreviewPacket(url:string,expected:PreviewPageIdentity,fetcher:(url:string,init:RequestInit)=>Promise<Response>,signal?:AbortSignal):Promise<{page:DecodedPreviewPage;bytes:number}>;
