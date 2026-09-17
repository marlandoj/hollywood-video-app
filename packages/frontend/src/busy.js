/**
 * The one place `aria-busy` is set, because it must never cover a live region.
 *
 * `aria-busy="true"` tells assistive technology that an element is mid-change
 * and that it may wait before exposing what changed. Every workbench panel in
 * this app holds its `role="status"` element *inside* the panel, and each one
 * set `aria-busy` on the panel around its own async work — so the success
 * message, written inside the operation, and the error message, written in the
 * `catch` that runs before the `finally`, were both announced inside the window
 * where the announcement was suppressed. A screen-reader user pressed a button
 * and heard nothing, whether it worked or failed.
 *
 * So the rule this module owns: mark the busy subtrees, never a subtree that
 * carries a live region. Where a subtree holds no live region at all — a lone
 * button, a panel with only controls — the element itself is marked, which is
 * exactly what the eleven hand-written copies did, so nothing is lost there.
 *
 * `busyRegions` walks `children` and reads attributes with `getAttribute`, both
 * of which the browser DOM and this repository's test element expose, so the
 * helper is the same code in both.
 */

/** Roles that are implicitly live: ARIA 1.2 maps these to an aria-live value. */
export const LIVE_ROLES = new Set(["status", "alert", "log"]);

/** What each root marked, so a clear removes its own marks and only its own. */
const marked = new WeakMap();
/**
 * How many roots currently mark each element. `editorial.js` marks its whole
 * panel, and the `edit-assemblies` panel mounted inside it marks its own
 * subtree, so one element can be claimed twice; the attribute is written when
 * the count reaches one and removed when it returns to zero. Without this, the
 * inner panel finishing first would strip a mark the outer one still holds.
 */
const claims = new WeakMap();

/** True when this element is itself a live region. */
export function isLiveRegion(element) {
  const live = element.getAttribute?.("aria-live");
  if (live && live !== "off") return true;
  return LIVE_ROLES.has(element.getAttribute?.("role") ?? "");
}

function holdsLiveRegion(element) {
  if (isLiveRegion(element)) return true;
  for (const child of element.children ?? []) if (holdsLiveRegion(child)) return true;
  return false;
}

/**
 * The elements to mark for `root`: `root` itself when nothing under it is a
 * live region, and otherwise the shallowest descendants that carry none — so
 * the whole of `root` except its live regions ends up marked.
 */
export function busyRegions(root) {
  if (!holdsLiveRegion(root)) return [root];
  const regions = [];
  const walk = element => {
    if (holdsLiveRegion(element)) { for (const child of element.children ?? []) walk(child); return; }
    regions.push(element);
  };
  for (const child of root.children ?? []) walk(child);
  return regions;
}

/**
 * Set or clear the busy state for `root`. Clearing removes exactly what this
 * function marked for that root and nothing else, so a nested panel marking
 * itself cannot clear its container's marks or have its own cleared.
 */
export function applyBusy(root, busy) {
  for (const element of marked.get(root) ?? []) {
    const held = (claims.get(element) ?? 1) - 1;
    if (held > 0) claims.set(element, held);
    else { claims.delete(element); element.removeAttribute("aria-busy"); }
  }
  marked.delete(root);
  if (!busy) return;
  const regions = busyRegions(root);
  for (const element of regions) {
    claims.set(element, (claims.get(element) ?? 0) + 1);
    element.setAttribute("aria-busy", "true");
  }
  if (regions.length) marked.set(root, regions);
}

/** `applyBusy(root, true)`, returning the call that clears it — for try/finally. */
export function markBusy(root) {
  applyBusy(root, true);
  return () => applyBusy(root, false);
}
