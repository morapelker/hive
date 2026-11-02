# Twix the Pug

The pug is the first sprite-sheet pet. Its idle portrait is a PNG and every working
style is a WebP atlas of 24 run-cycle poses (6 columns × 4 rows, 448 px cells, one
0.8 second loop at 30 fps). The atlases were approved in `docs/pug-preview.html`
("Smooth · 30 fps") and are extracted from that file verbatim:

```sh
pnpm -C apps/hive extract:pug
pnpm -C apps/hive preview:pug
```

The second command opens `src/renderer/pug-preview.html` through Vite with the real
`SpriteSheetSprite` and `PetSprite` renderers, a 0–20 slider, an exact-count input
and the speed controls. It is a development preview, not a production route.

## Progression

Milestones follow the corgi: 1, 2, 3, 4, 5, 10, 15 and 20 active sessions. Each
upgrade keeps the ones before it. `workingVariantIndex()` picks the last style whose
minimum the count reaches; `workingSpriteSheet.variantSessions` lists the minimums.

| Sessions | Atlas                    | Appearance                                               |
| -------- | ------------------------ | -------------------------------------------------------- |
| 1        | `assets/pug-run-1.webp`  | The plush pug, bounding along                            |
| 2        | `assets/pug-run-2.webp`  | Sage linen bandana                                       |
| 3        | `assets/pug-run-3.webp`  | Gold crown with a teal jewel                             |
| 4        | `assets/pug-run-4.webp`  | Coral cape with an embroidered paw on the badge          |
| 5–9      | `assets/pug-run-4.webp`  | Same cape; the badge shows the actual count, plus sparks |
| 10–14    | `assets/pug-run-10.webp` | Sapphire cape and brass goggles                          |
| 15–19    | `assets/pug-run-15.webp` | Amethyst cape and ivory wings                            |
| 20+      | `assets/pug-run-20.webp` | Midnight cape, embroidered stars, golden comet trail     |

## How it renders

`SpriteSheetSprite` shows the atlas behind a cropped window and steps it through the
grid with a Web Animations transform (`steps(1,end)`, 24 keyframes). The badge is an
SVG layer whose `translate` follows the cape: `badge.anchors` holds the badge centre
for eight key poses per style, in source-cell pixels (`cellSize` 443.5), and the
renderer interpolates them to one position per frame, wrapping at the loop seam. Below
five sessions the badge carries the paw emblem; from five on it shows the count in
Georgia 700 at 29 units (of a 400-unit box), shrinking for three or more digits and
never capped. Three sparkles twinkle from five sessions onward. All motion is
compositor-only transforms and opacity on a shared clock; no JavaScript runs per frame.

Speed scaling sets `playbackRate` on every animation. A count change that keeps the
same atlas (5 → 6, 4 → 5) only swaps the badge contents, so the run never restarts;
a new outfit joins the run at the current phase. The idle portrait is shown underneath
until the atlas has decoded.

The main-process mirror in `pet-window.ts` lists the pet's id, name and idle assets.
