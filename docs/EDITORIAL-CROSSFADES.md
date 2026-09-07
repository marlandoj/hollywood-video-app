# Editorial crossfades

Select a picture or sound clip and open **Crossfades between clips**. Choose its start or end boundary, enter a duration in frames, choose center/start/end alignment, and save. Linked picture and sound receive their own transitions in one history event. Save again to change the settings. Remove restores the original hard cut; Undo restores the saved transition.

The timeline draws an X over each transition window. Export review lists original source ranges, measured speech inside the fade, unknown speech timing, and whether captions follow the sound. Listen through the transition before selecting a rendered version.

## Saved timing and source handles

`EditTimeline.transitions` is an optional, nonempty array of at most 256 crossfades. Each record retains its identity, adjacent left/right clip identities, integer duration and alignment. Earlier timelines omit the field and retain their original revisions. Empty arrays and unsupported fields are rejected.

Clip timing, source receipts, crops, levels and original fade settings remain saved. Rendering borrows outgoing material after the cut and incoming material before it. Center alignment assigns the smaller half of an odd duration before the cut. Start and end alignment place the whole window on the corresponding side. Removing a transition requires no reconstruction of earlier clip settings.

Borrowed frames and samples use the existing integrated source clock. Speed ramps retain their endpoint speeds outside the saved curve; a freeze retains its picture frame and silent audio. Missing handles, out-of-range windows and nonadjacent clips fail before saving. No replacement frames or speech are generated.

An adjoining clip fade is replaced only when anchored to that cut edge and wholly covered by the transition. Outer fades and inherited fade phases continue unchanged. Shorten an adjoining fade or enlarge/realign the transition when those ranges conflict.

Roll and ripple edits preserve valid anchored boundaries. Splitting the outgoing clip transfers its transition to the new tail; splitting the incoming clip keeps its leading segment. Deleting either clip removes its associated transition in the same event. Invalid edits leave the saved sequence intact. History replay, response recovery, undo and branches retain exact transition identities.

## Picture, sound and captions

Picture uses a premultiplied dissolve represented by two source-over layers. For opacities `a` and `b` and progress `u`, incoming alpha is `b*u`; outgoing alpha is `a*(1-u)/(1-b*u)`, with an explicit zero-denominator endpoint. Q8 alpha preserves lower-layer contribution, including partial opacity. Original layer order remains stable when borrowed handles give two clips the same start frame.

A third picture on the same layer cannot overlap a crossfade: move it to another layer or shorten the transition. Crossfades sharing a clip or picture layer cannot overlap each other. Other sound clips continue to mix under existing lane and final peak checks.

Audio uses complementary linear Q20 gains at exact 48 kHz sample addresses. Clip level and outer-envelope phase apply in both normal and retimed paths. There is no hidden normalization or additional provider generation. Browser PCM rendering, server preview mix and full conform retain the same source addresses.

Captions linked to crossfaded audio borrow the same handles. Overlapping instances of the same retained source cue combine for display. Independent captions retain their own timing, and export review identifies that relationship. Speech-cut reporting uses extended source edges; crossfade review also identifies measured speech inside the fade itself.

## Retained exports and qualification

Only timelines with transitions select picture/conform recipe 4 and include the crossfade recipe. Earlier normal and retimed recipes remain unchanged. Preview cache identities include the transition recipe; storage estimates include additional span boundaries. Export validation checks each transition span's layer order, source addresses and compiled blend against the reviewed timeline.

The review receipt binds detailed crossfade review. Retained exports include that review and original source evidence. Recovery and archives replay saved operations and recreate previews from retained originals.

Local checks cover immutable history, source bounds, odd alignment, overlap refusal, inherited fades, exact clocks, opacity extrema, captions, response recovery and owner API admission. Real H.264 B-frame sources verify borrowed addresses. Independent YUV and PCM expectations check blends and unchanged ranges. Both preview audio paths match full conform, including retimed handles. Desktop and phone browser checks cover editing, review and playback. The PostgreSQL/S3 recovery fixture includes transitions and must pass in CI before merge.

These checks do not establish production listening quality, physical audiovisual synchronization, long-duration capacity, deployment or completion of the wider editorial and studio program.
