# Review links

An accountless review link (FR-045..047, AC-015) lets someone watch one cut and, with
`approve` permission, approve it or request changes. It expires after 7 days, when the
owner revokes it, or when its view limit is reached.

## What counts as a view (HV-029-05)

A view is **one viewer who was shown the cut**.

- **Opening costs nothing until the cut is actually served.** A link opened before the
  render finishes (404), whose cut the permission gate refuses (409), or that loses a
  first-view binding race (409) keeps all its views.
- **A reload is not another viewer.** The review page makes a random id per browser tab,
  keeps it in `sessionStorage` (not a cookie), and sends it as `x-hv-review-viewer` on
  that link's own two API calls. The link stores only its SHA-256, one per counted viewer.
  A new tab or another device is another viewer.
- **Except where the browser will not keep it (HV-029-13, G15).** Where `sessionStorage`
  throws or keeps nothing (Safari private browsing, a sandboxed iframe, some webviews), the
  page cannot remember the id, so every load is a new viewer and a reload spends a view.
  The page reads the id back after writing it; when it is not there and the link has an
  owner-chosen limit, the reviewer sees a polite status: *"This browser does not let this
  page remember you, so each reload will use another view of this link. Keep this page open
  until you have decided."* The owner's copy says reloading does not count **in most
  browsers**. There is no fallback: no cookie, no `localStorage`, no id in the URL (ADR-0018).
  The review view carries `maxViews` only on a link minted with one, which is how the page
  knows the note applies.
- **A counted viewer can always come back and decide**, including the one who took the
  last view. Before this, a decision was refused once the views were used, and deciding
  spent a view of its own, so whoever watched on the third view could not approve.
- **The owner chooses the limit**, from 1 to 25 (`maxViews` when creating the link; the
  "Viewers allowed" box on the export). Absent, it is FR-047's 3.

A request without a viewer id (an older client, a script) is counted on every serve, as
before, and on such a link anyone may decide up to and including the last view.

## What link previews do

The token sits in the URL fragment (`#/review/<token>`), which a browser never sends to a
server, so a chat app's link preview that fetches the page never reaches the API and
never spends a view. A preview service that runs the page's JavaScript would count as one
viewer: rare, and now at most one view rather than one per fetch.

## Privacy

The viewer id is random, per tab and per link, and is gone when the tab closes. The server
keeps only its hash inside the link, and the hash is deleted with the link. It is not a
cookie, it is not sent to any other route, and it identifies no one (ADR-0018).

## Comments and per-stage approvals (HV-029-14)

- **Where in the cut.** A reviewer who may decide may pin comments to frames of the one cut the
  link is bound to: `POST /api/reviews/<token>/comments` with `{frame, text}`, frames at 30 fps
  from the cut's first frame. The gates are those of a decision:
  - an `approve` link (a `read` link only watches);
  - opened, so it names its cut;
  - on a counting link, by a counted viewer;
  - not revoked;
  - the cut still retained.
- **Bounds.** The frame is from 0 to 431,999, which is four hours. The text is 1–500 characters.
  A link holds at most 50 comments. The text passes the content-policy gate (`checkPrompt`). A
  refusal is 422 `content_policy`, and nothing is kept.
- **Identity.** A comment keeps its frame, text and time, when it was resolved, and at most the
  link's own viewer hash, on a link that counts viewers. The owner sees that as "viewer N" of the
  link, never the hash.
- **The owner's view.** `GET /api/projects/<id>/reviews` lists the project's links by digest. Each
  has its bound job, its decision and its comments with `HH:MM:SS:FF` timecodes. The view also has
  one row per stage: rough cut (animatic), final, picture edit, sound mix, deliverable. The owner
  resolves or reopens a comment with `POST /api/projects/<id>/review-comments/<commentId>`
  `{resolved}`.
- **Stage.** A decision records the stage it approves, derived from the bound cut's job stage.
  Picture and assembly edits are the picture edit. Sound mixes, dialogue replacements and lip sync
  are the sound mix. Delivery is the deliverable.
- **Retention.** Comments and the stage live in the link record. They are exported, archived and
  restored with it, and deleted with it when the project is swept or taken down. They need no
  state schema version of their own.
- **On screen (HV-029-15).** On the review page, the comment box appears once the cut is showing
  on an approve link. Typing pauses the cut, and the comment is pinned to the frame on screen. On
  the owner's export, **Reviews** lists the stage lines and every comment. A comment's timecode
  moves the player to that frame, when the comment is on the cut being shown. Resolve and Reopen
  are sent to the server.
