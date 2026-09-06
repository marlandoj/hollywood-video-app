# Dialogue replacement against retained picture

Implementation in progress on `codex/HV-dialogue-replacement`. The local media engine works against retained, measured film exports. The job queue, owner API, editor, version selection and PostgreSQL/S3 archive integration are pending. This is not yet a released ADR workflow or the completion of P7.

## Timing and picture contract

Each replacement is bound to a completed source job, its full shot records, screenplay line hashes, provider/cast/direction snapshots, and the exact export and provenance file hashes. A normalized plan pins the speech runtime fingerprint, chosen line text, voice controls and notes. Edits do not mutate the original screenplay, picture or previous result.

Each line keeps its original start sample. A new read may occupy the available gap until the next line starts, or the end of its own shot. A shorter read leaves silence. An overlong read is rejected with its required and available durations; no picture stretching, audio acceleration, truncation or shifting of later reads occurs. Notes remain intent rather than executed semantic emotion.

The engine copies H.264 picture packets into a new MP4 and encodes the replacement dialogue as AAC. It verifies the original and resulting elementary video stream SHA256, decoded frame count, resolution, zero start time and duration at 30 fps. The new branch also retains a lossless mono 22050 Hz PCM WAV, HLS, SRT/VTT captions and a structured report with original line identities, measured replacement boundaries and PCM hashes. The output WAV preserves untouched reads exactly; the AAC mix is newly encoded.

Inputs currently require an unexpired complete animatic or final export with measured speech, retained canonical WAVs and straight shot joins. Burned-in captions are refused because unchanged picture cannot remove the old text. Shots without speech must explicitly declare silent audio. Cuts containing unknown or mixed audio need isolated stems before replacement; this engine must not silently erase music or effects. Output uses temporary eSpeak NG speech, not production voices or lip-sync.

## Execution and integration boundaries

`inspectDialogueSource` pins source export and provenance hashes for admission. `createDialogueReplacement` validates and normalizes the source-bound edits. `replaceLockedDialogue` verifies those files and each source dialogue WAV, generates only changed reads, remuxes the picture, validates the result and publishes a new directory atomically. It never calls an image/video provider. Source files are read only; an existing destination is refused.

The caller must provide current owner/project/cast permission checks under its worker lease. The engine invokes that callback before processing, before each shot/read, and immediately before publishing. Subprocesses honor cancellation; unsuccessful branches remove only their generated scratch directory. Runtime changes, source changes, missing media, invalid WAVs, checksum failures and duration overflow all fail before publication. The report validator checks recorded text, voice controls, original starts, available windows, unchanged line hashes and export frame/sample counts.

The next integration must provide durable zero-provider-cost admission and job state, source artifact hydration under owner scope, current permission checks at admission and execution, lease fencing and crash recovery, source expiry/takedown handling, signed output links, editor comparison/adoption/rollback and portable archive validation. An empty callback in a media unit test does not prove those service boundaries. Replacement versions must retain their own media so undo selects an actual retained result rather than regenerating a nondeterministic read.

## Evidence

The local regression suite uses real eSpeak, FFmpeg and finished source jobs. It verifies changed text and measured captions, unchanged picture and untouched PCM, strict plan binding, overflow, active cancellation, revocation before publication, unsupported source captions, directory isolation and same-length tampering. A retained browser fixture final was also processed: Marla's greeting changed to “Welcome home.” while Kevin's original read and all 179 picture frames remained intact. No paid provider inference was used.
