/**
 * HV-030-18 — pressing again after a lost reply admitted, and charged for, a second render.
 *
 * The Director's desk asked for both of its picture renders with a key minted on every press:
 *
 *     body: JSON.stringify({ idempotencyKey: crypto.randomUUID(),...reuseOptions() }),                          // Create film
 *     body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), stage: "final", animaticJobId,...reuseOptions() }), // Approve and generate
 *
 * `POST /projects/:id/jobs` answers a repeated key with the job it already admitted. A fresh UUID is
 * never repeated, so when the server admitted the render and the reply was lost (a dropped
 * connection, a gateway 502, a laptop lid), the desk said so, re-enabled Create film, and the
 * creator's next press was admitted -- and paid for -- as a second render of the same film. For the
 * final that is the expensive one.
 *
 * Sending no key at all would let the server derive one from the versions, but the route returns the
 * existing job for a key whatever its status, so a render that *failed* could then never be asked
 * for again at the same versions. So the desk now does what HV-017-14 did for character sheets: it
 * keeps the key of a request whose outcome is unknown, with what that request asked for, and sends
 * the same key when the creator asks for the same render again. Once the server has answered with a
 * job, the key is dropped, and the next request -- a retry of a render that failed, say -- gets a new
 * one. A different render (a new screenplay, cast or direction) gets a new one too. A final is the
 * same render whichever preview of the same versions approved it, so its animatic is not compared.
 *
 * The fake server below applies the route's own rule: a repeated key returns the existing job.
 */
import {expect, test} from "bun:test";
import {openDesk, ok, refused, pathOf} from "./desk-page.js";

const output = {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c", manifestUrl: "/f"};

/**
 * `POST /jobs` as the route answers it. `reply(stage, n)` may return a response (or throw) to replace
 * the n-th reply of that stage *after* the job is admitted; `status(stage, n)` is the n-th admitted
 * job's final status.
 */
function server({reply = () => undefined, status = () => "done"} = {}) {
  const jobs = new Map(), posts = {animatic: [], final: []};
  const admitted = stage => [...jobs.values()].filter(j => j.stage === stage);
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    if (path === "/api/projects" && options.method === "POST") return ok({projectId: "p1", token: "t.sig"});
    if (path === "/api/projects/p1/jobs") {
      const body = JSON.parse(options.body), stage = body.stage === "final" ? "final" : "animatic";
      posts[stage].push(body);
      const key = body.idempotencyKey ?? `${stage}:derived`;
      if (!jobs.has(key)) {
        const n = admitted(stage).length + 1;
        jobs.set(key, {id: `${stage}-${n}`, stage, status: status(stage, n), failureReason: "The provider stopped.", castingVersion: 0, directionVersion: 0, output, storyboard: []});
      }
      return reply(stage, posts[stage].length) ?? ok({jobId: jobs.get(key).id});
    }
    const job = [...jobs.values()].find(j => path === `/api/jobs/${j.id}`);
    if (job) return ok(job);
    return ok({});
  };
  return {fetch, posts, admitted: stage => admitted(stage).length};
}
const lost = () => {throw new TypeError("Failed to fetch");};

test("pressing Create film again after the preview's reply was lost resends its key, and one preview is admitted", async () => {
  const api = server({reply: (stage, n) => stage === "animatic" && n === 1 ? lost() : undefined});
  const desk = await openDesk({fetch: api.fetch});
  try {
    const submit = desk.q("#screenplay-form").listeners.submit[0];
    await submit({preventDefault() {}}); await desk.settle();
    expect(desk.q("#status").textContent).toContain("Failed to fetch");
    expect(desk.q("#submit").disabled).toBe(false);
    void submit({preventDefault() {}}); await desk.settle();
    expect(api.posts.animatic.length).toBe(2);
    expect(api.posts.animatic[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.posts.animatic[1]).toEqual(api.posts.animatic[0]);
    // The server returned the preview it had already admitted; nothing was rendered twice.
    expect(api.admitted("animatic")).toBe(1);
    expect(desk.q("#animatic").hidden).toBe(false);
  } finally {desk.restore();}
});

test("approving again after the final's reply was lost to a gateway error resends its key, and one final is admitted", async () => {
  const api = server({reply: (stage, n) => stage === "final" && n === 1 ? refused(502, "Bad gateway") : undefined});
  const desk = await openDesk({fetch: api.fetch});
  try {
    const submit = desk.q("#screenplay-form").listeners.submit[0];
    const pressed = submit({preventDefault() {}}); await desk.settle();
    desk.q("#approve-animatic").onclick(); await pressed;
    expect(desk.q("#status").textContent).toContain("Bad gateway");
    // The creator presses Create film again. The preview request was answered, so it is a new preview;
    // they approve it, and the final of the same screenplay, cast and direction resends its key.
    const again = submit({preventDefault() {}}); await desk.settle();
    desk.q("#approve-animatic").onclick(); await again;
    expect(api.posts.final.length).toBe(2);
    expect(api.posts.final[0]).toEqual({idempotencyKey: api.posts.final[0].idempotencyKey, stage: "final", animaticJobId: "animatic-1", reuseUnchanged: false});
    expect(api.posts.final[1]).toEqual({...api.posts.final[0], animaticJobId: "animatic-2"});
    expect(api.admitted("final")).toBe(1);
    expect(desk.q("#status").textContent).toContain("Export complete");
    expect(desk.q("#result").hidden).toBe(false);
  } finally {desk.restore();}
});

test("a render that failed after the server answered can be asked for again, with a new key, and is admitted again", async () => {
  // The first reply is lost; the retry finds that render; it then fails; the creator asks once more.
  const api = server({reply: (stage, n) => stage === "animatic" && n === 1 ? lost() : undefined, status: (stage, n) => n === 1 ? "failed" : "done"});
  const desk = await openDesk({fetch: api.fetch});
  try {
    const submit = desk.q("#screenplay-form").listeners.submit[0];
    await submit({preventDefault() {}}); await desk.settle();
    void submit({preventDefault() {}}); await desk.settle();
    expect(api.posts.animatic[1].idempotencyKey).toBe(api.posts.animatic[0].idempotencyKey);
    expect(desk.q("#status").textContent).toContain("The provider stopped.");
    void submit({preventDefault() {}}); await desk.settle();
    expect(api.posts.animatic.length).toBe(3);
    expect(api.posts.animatic[2].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.posts.animatic[2].idempotencyKey).not.toBe(api.posts.animatic[0].idempotencyKey);
    expect(api.admitted("animatic")).toBe(2);
    expect(desk.q("#animatic").hidden).toBe(false);
  } finally {desk.restore();}
});

test("a different render after a lost reply -- the screenplay changed -- gets a new key, which is itself resent", async () => {
  const api = server({reply: (stage, n) => stage === "animatic" && n <= 2 ? lost() : undefined});
  const desk = await openDesk({fetch: api.fetch});
  try {
    const submit = desk.q("#screenplay-form").listeners.submit[0];
    await submit({preventDefault() {}}); await desk.settle();
    desk.q("#script").value = "INT. LIGHTHOUSE - NIGHT\n\nShe winds the lamp. It turns.";
    await submit({preventDefault() {}}); await desk.settle();
    void submit({preventDefault() {}}); await desk.settle();
    const [first, second, third] = api.posts.animatic.map(body => body.idempotencyKey);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    // One render of each screenplay.
    expect(api.admitted("animatic")).toBe(2);
  } finally {desk.restore();}
});
