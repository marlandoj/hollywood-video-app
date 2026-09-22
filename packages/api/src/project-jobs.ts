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
export type ProjectJobStore = (projectId: string) => {all(): Job[] | Promise<Job[]>};
export async function projectJobs(store: ProjectJobStore, projectId: string): Promise<Job[]> {
  return (await store(projectId).all()).filter(job => job.projectId === projectId);
}
