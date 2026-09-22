# Importing a screenplay

HV-016 is in progress. A **Final Draft** script (`.fdx`) can be read into the Fountain screenplay this
studio works from. The importer converts and shows the result back; it never saves on the writer's
behalf, so what it could not carry across can be read before anything is committed.

Fountain remains the studio's own format, and pasting Fountain is unchanged.

## Creator flow

1. Export or open the `.fdx` and send its contents to
   `POST /api/projects/:id/script/import` as `{"format":"final-draft","document":"<the file>"}`,
   owner-only, up to 8 MiB.
2. The answer carries the converted screenplay, the **notes** saying what did not come across, how
   many scenes the studio reads in it, and the parser's own warnings.
3. The writer reads it, edits it if they want to, and saves it the usual way with
   `PUT /api/projects/:id/script`. Until they do, the project's screenplay is unchanged.

## What is carried across

| Final Draft | Becomes |
|---|---|
| Scene Heading | a scene heading, forced with a leading `.` when Fountain would not recognise it (`THE CLIFF PATH - LATER`) |
| Action, General, Shot | action, with a wrapped paragraph joined into one line |
| Character | an upper-case cue |
| Dialogue | the speech under its cue, one paragraph per line |
| Transition | a transition when the studio's parser recognises it, and action otherwise, with a note |

## What is not, and why it is said rather than dropped

- **Parentheticals.** The studio's screenplay has no parenthetical element, and a parenthetical left
  inside a speech would be spoken by the voice vendor and burned into the captions. They are counted
  and reported so the writer can put back the ones that matter as direction.
- **Script notes.** Final Draft keeps them inside the paragraph they annotate. They are removed
  before anything is read and reported, because they are notes to yourself: imported, their words
  would be read as action, reach the shot prompt, and be spoken and captioned.
- **The title page**, bold, italic and underline styling: reported, and the words are kept.
- **Dual dialogue** becomes two speeches, one after the other, and says so.
- **Anything else** — a cast list, an act break, a Final Draft element this importer does not know —
  is **refused by name**, not skipped. So is a character cue the studio's screenplay cannot hold, a
  speech with no character before it, and a script with no scene headings at all.

An importer that silently loses a line is worse than one that will not run, because the writer cannot
see what went missing.

Three ways it could still lose one were found and closed in HV-016-03, and they are worth stating
because each broke that rule in a different direction:

- **A script note inside another script note** put the outer note's words into the screenplay while
  reporting the note removed — the words reached the film and the report said they had not. A nested
  note is refused now.
- **A `<Text>` run that is never closed** ended the paragraph silently, so the rest of the writer's
  line vanished with no note. It is refused.
- **An element name longer than two hundred characters**, or one whose quote is never closed, made
  the pattern that reads it fail and the paragraph import as action — stepping around the refusal
  that names the element. It is refused.

## Bounds and safety

The reader is written by hand and bounded at every step, like the retained caption reader: at most
4 MiB of document, 20,000 paragraphs, 20,000 characters in a paragraph, and 200,000 characters of
resulting screenplay. **The bound on the input is a bound on the work**: every search is a linear
scan, and so is the whitespace normalizer — which it was not until HV-016-03, when a paragraph full
of carriage returns was measured taking 257 ms and a document full of those paragraphs, inside every
bound above, took fifty-four seconds of one thread. The same document now reads in about fifty
milliseconds. Every tag is found by **scanning**, never by a pattern of the shape
`<Tag[^>]*>`, which is quadratic on a file full of unterminated tags — so the bound on the input is
also the bound on the work, and a hostile document is refused in milliseconds rather than minutes.
Every control character is refused, however it is written; tab, newline and carriage return are text. Only the five XML names (`&amp; &lt; &gt; &quot; &apos;`) and numeric character
references to real code points resolve; any other entity, and any unescaped `&`, is refused.

A document type or entity declaration (`<!DOCTYPE`, `<!ENTITY`) is refused before anything is read.
That is the one construct that can make a parser fetch or expand something the writer never wrote,
and the studio has no need of it.

## What this does not do

PDF import is not built. FULL-SCOPE scopes it as "OCR + structure recovery", which is a different
problem from reading a structured file and needs its own work. Celtx, Highland and Markdown outlines
are not imported. Export to FDX or PDF is not built either — the screenplay leaves this studio as
Fountain.

The importer does not check the screenplay against the content policy. That gate runs where it always
has, on every shot at generation, over the combined heading, action and dialogue — an imported script
is refused there exactly as a pasted one is.
