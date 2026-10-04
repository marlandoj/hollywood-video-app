import type {Job} from "../../queue/src/index";

/**
 * The jobs of one project.
 *
 * `scopedJobs(projectId)` narrows the *store* on PostgreSQL and hands back the shared store on the
 * JSON backend — which is what `createApiServer()` defaults to and what `docker-compose.yml` runs —
 * where `all()` is every job in the studio. HV-029-06 found the one listing in `server.ts` that had
 * not written the filter by hand: a stranger with their own free project could read another
 * project's character-sheet jobs, because a character id is not a secret from anyone the owner
 * shares an actor with. It put the filter in one place there, and asserted over the source that
 * `all()` is called nowhere else in that file.
 *
 * HV-029-07 finishes the sentence. Twenty more call sites in `delivery-api`, `edit-api`,
 * `graphic-api`, `lipsync-api`, `sound-api` and `living-script-generation-api` were handed the same
 * store and wrote the same conjunct by hand. Every one of them was **correct** — read one at a
 * time, on purpose, before this was written. That is exactly what the thirteen correct ones in
 * `server.ts` were, and it is what made the fourteenth invisible.
 *
 * So the filter lives here, `all()` is called nowhere else under `packages/api/src`, and a test
 * asserts that over the source. A new listing that reaches for the store directly fails the test
 * rather than the review.
 */
export type ProjectJobStore = (projectId: string) => {
  all(): Job[] | Promise<Job[]>;
  /** HV-030-32: the narrower reads a store may answer without returning every job body. */
  withKey?(projectId: string, idempotencyKey: string): Job | undefined | Promise<Job | undefined>;
  runningCount?(projectId: string): number | Promise<number>;
  withStage?(projectId: string, stage: Job["stage"], status: Job["status"]): Job[] | Promise<Job[]>;
};
export async function projectJobs(store: ProjectJobStore, projectId: string): Promise<Job[]> {
  return (await store(projectId).all()).filter(job => job.projectId === projectId);
}

/*
 * HV-030-32: three questions a finishing route asks, answered without reading every job of the project.
 *
 * On staging a feature's project holds each sequence's rough cut, final, voices and score, and a
 * dialogue or score job carries the film it was made from: tens of megabytes of job bodies by the tenth
 * sequence. The dialogue and score routes, and the render route, read all of them to find one request
 * key and to count the running jobs. These ask the store only what they need: PostgreSQL answers from
 * its (project, key) and (project, status) indexes, and the JSON store, which reads its whole file
 * either way, hands back only the matching jobs. A store that can't answer falls back to the same
 * filter over `projectJobs`. Each answer is filtered by the project here as well.
 */
/** The project's job with this request key, if there is one. */
export async function projectJobWithKey(store: ProjectJobStore, projectId: string, idempotencyKey: string): Promise<Job | undefined> {
  const scoped = store(projectId), found = scoped.withKey ? [await scoped.withKey(projectId, idempotencyKey)] : await projectJobs(store, projectId);
  return found.find(job => job?.projectId === projectId && job.idempotencyKey === idempotencyKey);
}
/** How many of the project's jobs are running. */
export async function projectRunningCount(store: ProjectJobStore, projectId: string): Promise<number> {
  const scoped = store(projectId);
  return scoped.runningCount ? await scoped.runningCount(projectId) : (await projectJobs(store, projectId)).filter(job => job.status === "running").length;
}
/** The project's jobs of one stage in one state, in queue order. */
export async function projectJobsAt(store: ProjectJobStore, projectId: string, stage: Job["stage"], status: Job["status"]): Promise<Job[]> {
  const scoped = store(projectId), jobs = scoped.withStage ? await scoped.withStage(projectId, stage, status) : await projectJobs(store, projectId);
  return jobs.filter(job => job.projectId === projectId && job.stage === stage && job.status === status);
}
