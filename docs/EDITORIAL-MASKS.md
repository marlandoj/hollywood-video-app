# Authored masks and track mattes

This increment implements manual picture masks, polygon rotoscoping, track mattes and foreground placement in the existing editorial workflow. It is in development. The checks listed below do not establish release readiness or complete the full P10 effects scope.

## Authoring

Select a picture clip and open **Masks and mattes**. Load an exact original source frame, including retained handles outside the trimmed clip. The frame response is bound to the saved sequence history, original revision, frame address, dimensions and PNG checksum. Switching frames cancels the previous request. A failed or withdrawn source is an error rather than a blank matte.

Add a rectangle, ellipse or polygon. Rectangles and ellipses have draggable corners and a center handle. A new polygon can be drawn by clicking vertices and choosing **Finish polygon**, or by pressing Enter. Escape cancels drawing. Vertices can also be selected from the coordinate controls and moved with the pointer or numeric source-pixel fields. Arrow keys move a selected handle by one source pixel; Shift uses ten pixels and Alt a tenth. Numeric coordinates are converted to the saved integer representation.

Masks have ordered replace, union, intersection or subtraction operations, inversion and a feather radius in original source pixels. The first mask starts the coverage stack. Reordering keeps later masks' existing operations, so review a moved replacement mask that now erases earlier coverage.

Keys use original source frame numbers. Geometry edits author the current source key in the local draft. Keys can be added, updated, removed or visited with previous/next controls. Each key chooses hold or linear interpolation toward the next key; values hold outside the authored key range. Polygon vertex IDs and ordering remain stable across keys. Adding or removing a vertex on an animated polygon requires explicit confirmation that the change affects every key. Redrawing a polygon is available before additional animation keys are authored.

Choose another existing picture layer as an alpha or luminance matte. The matte uses that track's timeline timing, independently of the foreground's source-mask clock. A track gap gives zero coverage, or full coverage when inverted. The separate **Picture track visibility and matte-only roles** controls determine whether a layer is hidden from the final image while remaining available to consumers. They show its retained intervals and consumer count. Same-layer references and dependency cycles are rejected.

Foreground placement translates by a fraction of timeline dimensions, scales the fitted picture, and rotates clockwise. Masking happens in original source coordinates before crop, fit and placement. Placement and matte choices do not rewrite the source's masks or key timing.

## Drafts and saved output

Pointer movement and local field edits do not create history events or issue provider requests. **Apply masks and mattes** submits one atomic composite operation through the existing saved-request and history-recovery workflow. Track-role changes use a separate atomic operation. Undo, redo and branches retain the source-bound settings.

The browser stores a recovery draft for the project, sequence and clip. It records the original source and saved history revision. A recovered draft is not silently applied. A stale-history draft requires an explicit restore onto the current saved clip. A draft belonging to another original stays preserved for review on its original branch. Resolve recovered data before editing a replacement draft. Recovery retains completed, valid geometry edits; unfinished polygon traces and temporarily invalid input text must be finished in the open editor. Invalid fields block Apply.

Changing a masked original requires an explicit **Remove source-bound masks** or **Rebind masks and review every source key** choice. Rebinding preserves the complete key set; a shorter or incompatible original can therefore require correction instead of silently dropping keys. Replacing with the exact same original retains its masks. Independent matte and placement settings remain attached to the clip.

The mask viewport distinguishes **Original with draft outline** from **Draft mask coverage**. Coverage is rasterized at original resolution only when requested, using the shared sampler; it can be cancelled by later edits. This coverage mode displays the authored mask stack before placement and track mattes. It does not impersonate the saved final composite. **Show saved composite** requires a clean draft and seeks the existing saved-cut preview to the nearest retained frame in the selected clip.

Export review lists saved masks, key ranges, feathering, matte channels, inverted gaps, placement and matte-only roles. Saved composition warnings identify source-key and dissolve-handle review, matte gaps and unused matte-only tracks. The frontend requires the quote and composition review to match the open timeline revision. The accepted export remains bound to its reviewed saved history and composition warning revision. Effects use a distinct composition recipe and snapshot schema 6 so old archive readers cannot silently discard effect-bearing branches. Existing no-effect histories and their recipes remain supported.

## Bounds and qualification

The admitted model allows at most eight masks per picture clip, 64 vertices per polygon, 512 keys per mask and 65,536 retained mask point samples across a timeline. One composite payload is capped at 2 MiB. Coordinates range from one source dimension before the origin to twice the source dimension; feathering is bounded to 128 source pixels. Placement scale ranges from 25% to 400%, and rotation from −360° to 360°. The existing four picture layers bound matte dependencies. These admission limits are not maximum-scale performance claims.

Composed timeline-frame GET requests and their OPTIONS preflights share a separate sliding-window limit of 8,000 requests per client address per minute, configurable with `HV_RATE_LIMIT_COMPOSITE_FRAMES_PER_MINUTE`. This allowance covers the request count of two 30 fps streams with per-frame preflights (7,200 requests per minute); it does not guarantee realtime rendering or playback. Original-source frame GET/OPTIONS requests use the existing artifact allowance of 600 per minute so scrubbing does not consume the edit API's separate 120-per-minute allowance. Delivery slots, preparation sessions, cache capacity and renderer concurrency keep their existing bounds.

Focused frontend checks cover stable polygon topology and interpolation, key deletion/hold behavior, ordered mask replacement, draft history/source identity, source-frame zero and out-of-trim requests, stale source/history responses, PNG hashes and byte bounds, cancellation and bitmap disposal, pointer drawing commit/cancel boundaries, source-pixel keyboard movement, exact lost-response mask recovery and stale export warnings. Browser bundles for the editor, viewport, draft helpers and original-frame loader build locally.

Real owner pointer/keyboard flows, desktop and 390-pixel layouts, stale-tab and lost-response recovery, browser/full-conform pixel comparisons, export/archive qualification and sustained performance are still required on the integrated final revision. Automatic tracking or segmentation, chroma key/despill, adjustment layers, sky replacement, depth effects, particles and the rest of the studio scope remain separate work. No production deployment or production-media quality claim is made here.
