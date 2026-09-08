# Living Screenplay implementation

This is an intermediate P1/P8 implementation. The source patch and generation-impact compilers exist; an owner cannot yet perform a linked screenplay/cut revision through the interface. The full requirements in FULL-SCOPE.md remain the completion boundary.

`living-script-patch.ts` derives a physical dialogue-line identity from an authenticated retained source receipt. The request binds that source index and the exact current screenplay version and text. The result preserves every unrelated character, original line endings and surrounding whitespace, records the old/new line identities, and explicitly leaves the future rendered-source identity unresolved. Repeated equal dialogue is distinguished by source, scene, beat and physical position. Notes, boneyard and supplied project locks are protected. Changed source/current versions require branch resolution. Original screenplay text remains distinct from performed or localized text.

The initial compiler accepts a single spoken-line replacement that preserves parsed topology. Structural and arbitrary multi-line changes still need their own impact and merge handling; they are not removed from the program scope. A proposed next version in a patch receipt is not a committed screenplay version.

`living-script-generation.ts` compares every before/after shot using the same pinned per-shot input hashes used by normal selective rendering. The report includes regenerated, new, removed and unchanged shots, source receipts, candidate cast/direction/provider bindings and planned duration changes. Additional reviewed changes outside the selected dialogue line remain visible in the changed-shot set. Stale saved direction/coverage cannot be silently reapplied, and foreign-project or wrong-stage bindings are rejected.

Unchanged shot receipts are reuse candidates. Their presence does not authorize media access or prove current carrier availability. Admission, processing and publication must recheck the original permissions, exact source bytes, current bindings and provider/cost limits. The impact compiler does not dispatch generation or commit project state.

The generation integration test uses a real synthetic retained film and the existing owner script-save/selective-render path. It confirms that the compiler's changed-shot set matches fresh rendering, unaffected media is independently copied with matching hashes, captions change, and the previous persisted job and captions remain intact. This test does not establish a linked atomic acceptance workflow.

## Remaining integration

1. Persist versioned proposals bound to current script, full saved edit history, source receipts, complete cast/direction/coverage/provider context and all impacted occurrences. Preserve drafts and exact request identities through stale responses and reloads.
2. Review explicit old-to-new source-clock mappings, actual generated duration and measured speech, all downstream clips/captions, partial ranges, repeated occurrences, ramps/holds, L/J cuts, dissolves and masks/mattes. Retain prior accepted assemblies; derive new versions instead of changing their frozen parents.
3. Execute the reviewed affected-shot generation and unchanged-media retention through durable, fenced, cost-accounted jobs. Store complete independent output and recovery evidence before publication.
4. Compare actual before/after media, then atomically accept a linked screenplay revision and independent cut under current script/history/library version checks. Preserve previous exports and explicit selection/rollback.
5. Integrate the owner line editor, impact review, generation recovery, result comparison and acceptance. Exercise desktop/mobile and keyboard flows, PostgreSQL/S3 concurrency and independent archive restoration.
6. Complete reverse timeline-to-script trim/reorder proposals, broader structural edits and branch/merge handling. A partial audio trim must not invent which words to remove.

Production acting and semantic continuity, provider/licence qualification, the broader Writers' Room and editorial requirements, and deployment remain separate unfulfilled program gates. No new paid provider inference is required for the deterministic development fixtures.
