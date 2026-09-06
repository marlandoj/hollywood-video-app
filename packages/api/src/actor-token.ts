import { createHmac, timingSafeEqual } from "node:crypto";
import { tokenSecret } from "./tokens";
import { validateActorShare, type ActorShare } from "../../planner/src/actor-library";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface ActorToken {kind:"actor-share";projectId:string;shareId:string;revision:string;exp:number}
const mac=(body:string)=>createHmac("sha256",tokenSecret()).update("hv-actor-share/1\n"+body).digest("base64url");
export function mintActorToken(share:ActorShare):string {
  validateActorShare(share,share.projectId);
  const payload:ActorToken={kind:"actor-share",projectId:share.projectId,shareId:share.id,revision:share.revision,exp:Date.parse(share.expiresAt)};
  const body=Buffer.from(JSON.stringify(payload)).toString("base64url");return body+"."+mac(body);
}
export function verifyActorToken(token:unknown,now=Date.now()):ActorToken|null {
  if(typeof token!=="string" || token.length>2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))return null;
  const [body,signature]=token.split("."),expected=Buffer.from(mac(body!)),actual=Buffer.from(signature!);
  if(actual.length!==expected.length || !timingSafeEqual(actual,expected))return null;
  try {
    const value=JSON.parse(Buffer.from(body!,"base64url").toString()) as ActorToken;
    if(!value || Object.keys(value).sort().join(",")!=="exp,kind,projectId,revision,shareId" || value.kind!=="actor-share" || !UUID.test(value.projectId) || !UUID.test(value.shareId)
      || !/^[a-f0-9]{64}$/.test(value.revision) || !Number.isSafeInteger(value.exp) || value.exp<=now)return null;
    return value;
  } catch {return null;}
}
