# Accessibility audit — WCAG 2.2 AA, from code and DOM

epic: HV-039 · release: 2 "Voice and crew depth" · audited at `origin/main` 9a21e58, re-checked at
e9e0936 after HV-039-22, HV-039-23, HV-029-15 and HV-026-07 merged (2026-09-30)

This audit checks the creator UI (`packages/frontend/src/index.html` and the modules it loads) and the
operator console (`operator.html`, `operator.css`, `operator.js`) against the WCAG 2.2 AA success
criteria that can be decided from source and from the DOM the modules build. It is **not** a
conformance claim. Nothing here was run in a browser or with a screen reader, and three kinds of
question cannot be answered without one: what a screen reader actually announces, what a browser
does with focus when the focused control is disabled, and how large a target is once laid out.
Those cells say **N**, with the reason.

Line numbers are for `origin/main` 9a21e58. The review-comment findings are for e9e0936, and
`review-notes.js` line numbers are from that commit.

## How it was checked

- **Stylesheets** were parsed rule by rule. Contrast is the computed ratio from
  `packages/frontend/test/contrast.test.ts` (HV-039-01). Focus rings and target sizes were resolved
  through the cascade by `packages/frontend/test/focus-target.test.ts` (HV-039-21), which matches
  selectors against elements described as the modules build them.
- **Form controls** were checked on the live DOM the test suite builds. A preload wrapped
  `document.createElement` in every DOM stub the 66 frontend test files use, and after the suite
  checked each `input`, `select` and `textarea` for a programmatic name (a `<label for>`, a wrapping
  `<label>`, `aria-label` or `aria-labelledby`). 3,933 controls across 26 modules: **every one had a
  name**. `casting.js` and `actor-library.js` are not mounted by any test and were read instead;
  every control there has a `<label for>` or a wrapping label.
- **Pointer and key handlers** were found the same way: every element with a click, pointer or key
  handler that is not a native control. There are two — the mask viewport canvas
  (`mask-viewport.js:74-77`) and the viewfinder source stage (`viewfinder.js:53`) — and both have
  keyboard alternatives (below).
- Everything else was read: images and their `alt`, roles, live regions, headings, fieldsets.

## Result

P pass · F fail · N not verifiable from code · – not applicable. 15 criteria × 15 panels = 225 cells.

| | P | F | N | – |
|---|---|---|---|---|
| First audit (`main` 9a21e58) | 186 | 6 | 21 | 12 |
| Re-checked (`main` e9e0936) | 186 | 3 | 24 | 12 |

The re-check counts HV-039-22 and HV-039-23 as merged, which turns 3 failures into 2 passes and
one N. HV-029-15 added timecoded review comments to the Review panel, which turns 3 of its passes
into 1 F and 2 N (2.4.3, 2.4.6, 2.4.7, below). HV-026-07 changed no frontend file. The matrix
below is the re-check.

| SC | Shell | Studio | Cast | Direction | Takes | Motion | Dialogue | Voice | Lip-sync | Sound | Editorial | Masks | Graphics | Review | Operator |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.1.1 | – | P | P | P | P | P | P | P | P | F | F | P | P | P | P |
| 1.3.1 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 1.4.3 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 1.4.11 | P | P | P | P | P | N | P | P | P | P | P | N | P | P | P |
| 2.1.1 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 2.4.3 | P | P | P | P | N | N | N | N | N | N | P | N | N | N | P |
| 2.4.6 | P | P | P | P | P | P | P | P | P | P | P | P | P | F | P |
| 2.4.7 | P | N | N | N | N | N | P | P | P | N | N | P | N | N | P |
| 2.4.11 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 2.5.7 | – | – | – | P | – | P | – | – | P | – | – | P | – | – | – |
| 2.5.8 | N | N | N | N | P | P | P | P | P | P | P | P | P | P | P |
| 3.3.1 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 3.3.2 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 4.1.2 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |
| 4.1.3 | P | P | P | P | P | P | P | P | P | P | P | P | P | P | P |

**Panels.** Shell: `index.html` header, landmarks and screenplay form. Studio: `studio.js`. Cast:
`casting.js`, `character-sheets.js`, `actor-library.js`. Direction: `direction.js`,
`viewfinder.js`, `camera-path.js`, `frame-anchors.js`, `coverage.js`, `scene-cuts.js`,
`performances.js`. Takes: `takes.js`, `take-player.js`. Motion: `subject-motion.js`. Dialogue:
`dialogue-replacement.js`, `narration-editor.js`. Voice: `audio-studio.js`, `audio-phrases.js`,
`picture-performance.js`. Lip-sync: `lipsync.js`. Sound: `sound-studio.js`. Editorial:
`editorial.js`, `edit-assemblies*.js`, `edit-script*.js`, `preview-*.js`, `living-script*.js`.
Masks: `mask-editor.js`, `mask-viewport.js`. Graphics: `graphic-studio.js`. Review: the animatic,
export and review-link sections of `index.html`, and `review-notes.js` (HV-029-15). Operator:
`operator.*`.

### What the increments change

| Increment | Cells | After |
|---|---|---|
| HV-039-22 (merged) | Masks 3.3.2 F | P |
| HV-039-23 (merged) | Graphics 1.3.1 F, 2.4.6 F → P; Graphics 2.4.3 F → N | in the re-check |
| HV-039-21 | 2.5.8 × 4 N, 2.4.7 × 9 N (Review included) | P |
| HV-039-24 | Sound 1.1.1 F, Editorial 1.1.1 F | P |

HV-039-24's guard also found the cast desk's "Project cast" `div` (`casting.js:18`), named with
no role, and gives it `role="group"`. That was not a cell of its own: the cards inside it have
headings.

Once HV-039-21 and -24 land: **P 201 · F 1 · N 11 · – 12**. The one failure left is the Review
panel's Resolve and Reopen buttons (2.4.6). The 11 N cells still need a person with a browser and
a screen reader. They are listed under "Open".

## Per criterion

### 1.1.1 Non-text content

- **P** Storyboard frames carry their caption as `alt` (`studio.js:678`, `index.html:702`).
  Reference images, sheet views, anchor thumbnails, viewfinder frames, graphics frames, the lip-sync
  frame and the subject-motion source all have `alt`. The editorial timeline is an `svg`
  `role="img"` with a count-and-duration name (`editorial.js:123`), and the clips are listed below it
  as controls. The operator chart is `role="img"` with a table alternative. Decorative overlays (the
  viewfinder crop box, the lip-sync marker) are `aria-hidden`.
- **F Sound** — `sound-studio.js:42`. Each cue on the timeline is a `<span>` with `aria-label` and
  `title` and no role. `aria-label` on a generic element is not exposed (ARIA 1.2 prohibits naming
  `generic`), so the cue's timing sentence reaches only a mouse user who hovers. The same values are
  in the cue editor's fields, so nothing is lost outright, but the timeline itself has no text
  alternative. Fixed in HV-039-24.
- **F Editorial** — `preview-controller.js:66`, `preview-comparison.js:43`. The preview canvases
  carry `aria-label` with no role, so the same problem applies: the name "Preview of the saved cut"
  or "Version A picture" is not exposed. Fixed in HV-039-24.

### 1.3.1 Info and relationships

- **P** Every form control has a programmatic label (3,933 checked, see "How it was checked").
  Checkbox groups and multi-field groups use `fieldset`/`legend` (`viewfinder.js:9`, `casting.js`,
  `audio-studio.js`, `dialogue-replacement.js`, `takes.js` and six more). The operator tables use
  `th scope="col"` inside named, focusable scroll regions.
- **F Graphics** (first audit; **P** since HV-039-23 merged) — `graphic-studio.js:31`. Each credit row is a `fieldset` with no `legend`,
  holding a "Role" field, a "Name" field and a "Remove credit" button. With twelve rows there are
  twelve identically named sets and nothing tying a field to its row. Fixed by HV-039-23. The four
  section fieldsets (`graphic-studio.js:6`) also have no legend. They are there so that `disabled`
  can lock a section while a request runs. Only the editor section opens with a heading, and whether
  the other three need a name is left open.
- Noted, not failed: `<div id="storyboard" aria-label="Storyboard by scene">` (`index.html:323`)
  names a generic element, so the name is never exposed. Each scene's `summary` still conveys the
  grouping.

### 1.4.3 Contrast (minimum) and 1.4.11 Non-text contrast

- **P** All 22 token pairs clear their thresholds, computed (`contrast.test.ts`). The colour
  literals in the modules, which that test does not read, were computed for this audit: the sound
  cue label (`#fff` on `#466864`, 6.1:1), and the editorial clip fills against their lane (`#797bca`
  4.2:1, `#4a9992` 4.8:1, `#b58bba` 5.6:1 on `#17232c`). The viewfinder crop box is drawn
  white-on-black with a scrim (`index.html:255`), so it holds 3:1 over any image.
- **N Motion, Masks** — the subject-motion tracks (`subject-motion.js:69`) and the mask outline
  (`mask-viewport.js:68`, one colour, `#f2c76c`) are drawn over the creator's own image. Whether they
  hold 3:1 depends on the image.

### 2.1.1 Keyboard, and 2.5.7 Dragging movements

- **P** Every handler outside a native control belongs to one of two drag surfaces, and both have
  keyboard and single-pointer alternatives. The viewfinder's crop has position and size sliders that
  take arrow keys (`viewfinder.js:15-18`), and the camera path works through that same crop. The
  mask viewport has arrow keys plus coordinate fields for every corner and vertex
  (`mask-editor.js`, "Shape coordinates and vertices"). Subject-motion point placement
  (`subject-motion.js:73`) and the lip-sync speaker point (`lipsync.js:24`) are single clicks, and
  keyboard activation moves focus to their numeric fields. Assembly range reordering uses buttons.
- Keyboard parity gap, counted under 3.3.2: for a rectangle or ellipse mask, the viewport's arrow
  keys move whichever handle a *pointer* last selected. `selectedHandle` is set only in
  `pointerdown` (`mask-viewport.js:74`), and it starts as the whole shape. A keyboard user can
  resize only through the fields.

### 2.4.3 Focus order

- **P** HV-039-04 to -17 put focus back after every step, save, close and removal in the studio,
  cast desk, shot direction, frame anchors, picture editorial and the assembly studio, each with a
  test (`studio-focus`, `desk-focus`, `direction-focus`, `frame-anchors-focus`, `editorial-focus`,
  `edit-assemblies-focus`, `desk-close-focus*`). The operator console focuses the trace heading
  (`tabindex="-1"`) when a trace opens.
- **F Graphics** (first audit; **N** since HV-039-23 merged) — `graphic-studio.js:31`. "Remove credit" removes its own row, the focused button
  with it, and focus falls to the page body in every browser. Fixed by HV-039-23. Other graphics
  actions stay **N**, for the reason below.
- **N Review** — `review-notes.js:47`, `:95`. "Comment at" and each Resolve or Reopen button
  disable themselves while their request is out, which raises the same focus-fixup question as the
  next item. A comment's timecode button moves focus to the export player on purpose (`:87`).
- **N Takes, Motion, Dialogue, Voice, Lip-sync, Sound, Masks.** Each panel's `run` disables every
  control while its request runs, the pressed one included: `takes.js:13`, `subject-motion.js:84`,
  `dialogue-replacement.js:26`, `audio-studio.js:58-59`, `lipsync.js:9`, `sound-studio.js:30-33`. The
  mask editor gates changes the same way. HTML's focus fixup rule moves focus off a control that
  becomes disabled, and browsers differ on when they apply it. Whether focus comes back on the
  re-enabled control has to be checked in a browser.

### 2.4.6 Headings and labels

- **P** Every panel opens with an `h2` or `h3` naming it. Steps are headed "Step N of 3 · …".
  Control names say what they change ("Frame width and height · 40%", "Keyframe time in percent").
- **F Graphics** (first audit) — `graphic-studio.js:31`, the credit rows as under 1.3.1: "Role",
  "Name" and "Remove credit", repeated identically in every row. Fixed by HV-039-23, merged.
- **F Review** — `review-notes.js:89-99`. Every comment in the owner's list has a button named
  "Resolve" or "Reopen", with nothing in its name saying which comment it resolves. Listed by a
  screen reader's buttons view, twelve comments give twelve identical "Resolve" buttons. This is the
  same shape HV-039-23 fixed for credit rows. It is not fixed by these increments. The timecode
  button beside it is named "Play from 00:00:02:09", which contains its visible text.

### 2.4.7 Focus visible and 2.4.11 Focus not obscured (minimum)

- **P** The product's ring (3px `--accent`, offset 3px, at least 5.5:1 on every surface) is on
  `textarea`, `button`, `a`, `input` and `summary` everywhere (`index.html:46`, `:221`). It is also
  on `select` in the cast and direction panels, the dialogue and voice desks and the
  dialogue-revision studio (`:242`, `:110`, `:77`), and on the mask viewport (`:165`). The operator
  console puts it on every `:focus-visible` element. No stylesheet removes an outline. Nothing is
  `position: fixed` or `sticky`, so no author content can cover a focused element (2.4.11 **P**).
- **N Studio, Cast, Direction, Takes, Motion, Sound, Editorial, Graphics.** These panels fall back
  to the browser's default ring for some focusable element:
  - a `select` in the sound session, picture editorial, the assembly studio or the graphics desk,
    none of which has a `select:focus-visible` rule;
  - every heading that focus-return code focuses (`tabIndex = -1` at `studio.js:585,596`,
    `casting.js:123,261`, `direction.js:28,146`, `takes.js:74`, `subject-motion.js:88`,
    `editorial.js:132`, `edit-assemblies.js:28`).

  - in the Review panel (e9e0936), the export player, which a comment's timecode focuses
    (`review-notes.js:87`), and every `video` and `audio` with controls.

  The default ring differs by browser, and nothing holds it to 3:1 on this dark palette. Fixed in
  HV-039-21: `select`, `video`, `audio` and `[tabindex]` join the product's ring. The comment box's
  textarea and buttons already had it.
- Partly clipped, not obscured: entries in `.edit-script-list` (`index.html:175`) sit in a scroll
  container, which clips the left and right of their offset ring. The top and bottom stay visible.

### 2.5.8 Target size (minimum)

- **P** Every button is at least 2.75rem (44px) tall (`index.html:53`, `operator.css`). Most panels
  size their checkboxes at 44px (`index.html:51,71,105,142,192,211,275`). Links in the export actions
  are at least 24px tall. Links inside sentences are exempt.
- **N Shell, Studio, Cast, Direction.** Checkboxes with no size rule render at the browser's 13×13
  CSS px:
  - the Advanced switch (`index.html:294`) and screenplay rights (`:305`);
  - the studio's rights and cast consent boxes (`studio.js:619,665`);
  - cast consent and grants (`casting.js:81,174`) and sheet views (`character-sheets.js:49,54`);
  - the shared-actor import (`actor-library.js:8`);
  - coverage flags (`direction.js:41`) and anchor attestations (`frame-anchors.js:7,13`).

  An undersized target passes only through the spacing exception, which depends on the layout
  around it. Fixed in HV-039-21 so that no checkbox or radio can render under 24×24.

### 3.3.1 Error identification and 3.3.2 Labels or instructions

- **P** Each panel writes its refusals as text into its status line (`data-state="error"` plus
  words, never colour alone). Required, numeric and range fields use native constraint validation
  (`reportValidity`, `setCustomValidity` at `camera-path.js:22`). The operator's trace filter sets
  `aria-invalid`. Errors are not tied to their field with `aria-describedby` anywhere in the creator
  UI. 3.3.1 does not require that; it would help.
- **F Masks** (first audit; **P** since HV-039-22 merged) — `mask-viewport.js:17`. The viewport's name says "Select a handle, then move it with
  the arrow keys", but no key selects a handle (see 2.1.1). For a rectangle or ellipse the arrows
  move the whole shape unless a pointer chose a corner first. The instruction is wrong for keyboard
  users. Fixed by HV-039-22: Space and Shift+Space choose the next and previous handle in the
  viewport, and the name and the editor's paragraph say so.

### 4.1.2 Name, role, value

- **P** Every control is named (above). The toggles expose state with `aria-pressed`
  (`edit-script.js:54`, `take-player.js:10`). The mask viewport is `role="application"` with a name,
  a description and a live value (HV-039-03). There are no icon-only buttons, and apart from the two
  drag surfaces under 2.1.1 no `div` or `span` takes input.

### 4.1.3 Status messages

- **P Review (e9e0936).** The comment box and the owner's list each have their own `role="status"`
  line (`#review-comment-status`, `#reviews-status`). The comment textarea has a `<label for>`, the
  owner's list is an `ol` inside a section named by its heading, and every button in it is at least
  44px tall.

- **P** Every panel has a `role="status"` line. `aria-busy` never covers a live region (HV-039-02,
  `busy.js`). Poll updates write only when their words change (HV-039-07, -11, -12). The export's
  review-link output and the review page's status are live regions (`index.html:342,357,363`).

## Open: needs a person with a browser and a screen reader

1. Focus after an action in the Takes, Motion, Dialogue, Voice, Lip-sync, Sound, Masks, Graphics
   and Review panels (2.4.3). Press each action button from the keyboard, then check where focus is.
2. The subject-motion tracks and the mask outline over light and busy images (1.4.11).
3. What NVDA, JAWS and VoiceOver announce for the mask viewport (`role="application"`) and its live
   value, and whether the arrow keys and Space reach it in browse mode.
4. Reflow at 320px (1.4.10), text spacing (1.4.12), and zoom to 200% (1.4.4). These are not in this
   audit's criterion list and cannot be judged from code.
5. Captions and transcripts for generated audio (1.2.x). Also outside this list: exports carry a
   captions track (`index.html:545-552`), but auditions and sound previews have none.
