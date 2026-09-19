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
