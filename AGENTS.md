<!-- ux-laws:start -->
## UX design principles

Apply these when generating or reviewing any user interface. They describe how people perceive,
decide, and remember, so they hold regardless of framework, platform, or the tool producing the UI.

1. Hick's Law: one primary decision per screen, at most 5 to 7 visible options, the rest behind progressive disclosure.
2. Fitts's Law: interactive targets at least 44x44 px with at least 8 px spacing; the primary action sits next to the user's current focus.
3. Jakob's Law: conventional layouts and controls; no novel interaction pattern without a stated reason.
4. Law of Proximity: whitespace between groups is visibly larger than whitespace within a group.
5. Miller's Law: chunk content into labeled groups of 3 to 5; no flat list over about 7 items without grouping, search, or sort.
6. Doherty Threshold: visible feedback within 100 ms, completion within 1 s, progress indication beyond that; optimistic UI and skeletons for network work.
7. Von Restorff Effect: exactly one dominant action per screen, distinguished by shape and weight as well as color.
8. Serial Position Effect: most important items first and last; low priority in the middle.
9. Peak-End Rule: every flow ends in a designed success state with a summary and a next step; never on a blank page or bare toast.
10. Zeigarnik Effect: multi-step tasks show a step count, current position, and what remains.
11. Law of Prägnanz: simple aligned layouts with minimal ornamentation; if it needs explaining, simplify it.
12. Law of Similarity: same function, same appearance, everywhere; never style two things alike unless they behave alike.
13. Uniform Connectedness: related fields and controls share a container, border, or background; sequences use connecting lines.
14. Tesler's Law: the system absorbs complexity; sensible defaults, inferred values, advanced options on request.
15. Postel's Law: accept flexible input and normalize it; validate inline; every error says what went wrong and how to fix it; destructive actions are undoable or confirmed.
16. Parkinson's Law: fewest steps and fields; autofill and remembered values so tasks finish faster than expected.
17. Occam's Razor: remove any element that does not serve the current task; when two designs work equally, ship the simpler one.
18. Pareto Principle: the features used most get prime placement and the fastest path; the rest go behind a menu.
19. Goal-Gradient Effect: show honest head-start progress and what is left; never fabricate progress.
20. Chunking: group codes, numbers, and long content into meaningful labeled units.

Precedence when laws conflict: Tesler bounds Hick (relocate complexity, do not delete required options). Similarity bounds Von Restorff (one thing stands out, not three). Jakob bounds novelty (deviate only with a reason). Postel bounds Occam for input and errors. Honesty bounds Goal-Gradient. Empirical laws outrank heuristics; Parkinson, Occam, and Pareto are heuristics.
<!-- ux-laws:end -->
