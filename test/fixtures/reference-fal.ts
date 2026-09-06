/** Closed HTTP fixture: these model contracts never send inference or media traffic. */
export const REFERENCE_IMAGE_MODEL = "fal-ai/flux-2/edit";
export const REFERENCE_VIDEO_MODEL = "fal-ai/kling-video/o3/standard/reference-to-video";
export function referenceFal(png: Buffer, mp4: Buffer, localOrigin?: string, realFetch = fetch) {
  const submissions: {model: string; body: Record<string, unknown>}[] = [];
  const requests = new Map<string,string>();
  const json = (body: unknown) => Response.json(body);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    init.signal?.throwIfAborted();
    if (localOrigin && url.origin === localOrigin) return realFetch(input,init);
    if (url.origin === "https://queue.fal.run") {
      const model = url.pathname.slice(1), method = init.method ?? "GET";
      if (method === "POST" && [REFERENCE_IMAGE_MODEL,REFERENCE_VIDEO_MODEL].includes(model)) {
        submissions.push({model,body:JSON.parse(String(init.body))});
        const id = "reference-fixture-" + submissions.length;
        const base = "https://queue.fal.run/" + model + "/requests/" + id;
        requests.set(base,model);
        return json({request_id:id,status_url:base+"/status",response_url:base,cancel_url:base+"/cancel"});
      }
      if (method === "GET" && url.href.endsWith("/status") && requests.has(url.href.slice(0,-7))) return json({status:"COMPLETED"});
      const requestedModel = requests.get(url.href);
      if (method === "GET" && requestedModel) return requestedModel === REFERENCE_IMAGE_MODEL
        ? json({images:[{url:"https://v3.fal.media/files/reference-fixture.png",width:640,height:512}],has_nsfw_concepts:[false]})
        : json({video:{url:"https://v3.fal.media/files/reference-fixture.mp4"}});
    }
    if (url.href === "https://v3.fal.media/files/reference-fixture.png") return new Response(new Uint8Array(png));
    if (url.href === "https://v3.fal.media/files/reference-fixture.mp4") return new Response(new Uint8Array(mp4));
    throw new Error("Reference fixture refused unexpected network destination or operation.");
  }) as typeof fetch;
  return {fetchImpl,submissions};
}
