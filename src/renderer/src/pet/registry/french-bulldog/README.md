# Shiba the Frenchie

The French bulldog follows the pug's sprite-sheet pipeline. Its idle portrait is a PNG and
every working style is a WebP atlas of 24 run-cycle poses (6 columns × 4 rows, 384 px cells,
one 0.8 second loop at 30 fps). The atlases were approved in `docs/french-bulldog-preview.html`
("Smooth · 30 fps", design study 05) and are extracted from that file verbatim:

```sh
pnpm -C apps/tedooo-code extract:french-bulldog
pnpm -C apps/tedooo-code preview:french-bulldog
```

The second command opens `src/renderer/french-bulldog-preview.html` through Vite with the real
`SpriteSheetSprite` and `PetSprite` renderers, a 0–20 slider, an exact-count input and the
speed controls. It is a development preview, not a production route.

## Progression

Milestones are 1, 2, 3, 4, 5, 10, 15 and 20 active sessions and each upgrade keeps the ones
before it. `workingVariantIndex()` picks the last style whose minimum the count reaches;
`workingSpriteSheet.variantSessions` lists the minimums.

| Sessions | Atlas                               | Appearance                                             |
| -------- | ----------------------------------- | ------------------------------------------------------ |
| 0        | `assets/french-bulldog.png`         | Off-duty Frenchie: the seated portrait                 |
| 1        | `assets/french-bulldog-run-1.webp`  | Little hustle: the plush Frenchie, running             |
| 2        | `assets/french-bulldog-run-2.webp`  | Dressed for the job: terracotta bandana                |
| 3        | `assets/french-bulldog-run-3.webp`  | Tiny royalty: gold crown between the bat ears          |
| 4        | `assets/french-bulldog-run-4.webp`  | Cape expectations: coral cape with a blank patch       |
| 5–9      | `assets/french-bulldog-run-4.webp`  | Certified superdog: the patch counts, golden sparks    |
| 10–14    | `assets/french-bulldog-run-10.webp` | Cleared for takeoff: midnight-blue cape, brass goggles |
| 15–19    | `assets/french-bulldog-run-15.webp` | Above and beyond: plum cape and ivory wings            |
| 20+      | `assets/french-bulldog-run-20.webp` | Out of this world: cosmic cape, jetpack, icy sparks    |

## How it differs from the pug

The design's decorations are authored directly in the 400-unit box, so `badge.cellSize` is
400 and the anchors are used as-is. The cape patch is blank at four sessions (no emblem) and
shows the count from five in Georgia 600, rotated −7.45°. The count is 25 units through two
digits and 58 ÷ digits beyond, which `fullSizeDigits: 2.32` reproduces exactly
(25 × 2.32 ÷ 3 = 58 ÷ 3). Sparkles are the curved "glint" shape at 3% of the box, twinkling
between 0.45 and 1 opacity, gold until the cosmic outfit turns them ice blue. The running art
fills the whole sprite box, so there is no inset.

The main-process mirror in `pet-window.ts` lists the pet's id, name and idle assets.
