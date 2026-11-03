# Bella the Tennis Player

Bella is the first canvas-atlas pet: a female mixed-breed dog whose run cycle is drawn by
`CanvasAtlasSprite` from lossless WebP atlases with fractional-frame blending, rather than by
`SpriteSheetSprite`'s stepped CSS transforms. Her idle portrait is a PNG and every working style is
a 128-frame atlas (16 columns × 8 rows, 256 px cells; the flame stage uses 352 × 256 cells) looping
once every 1,920 ms at normal speed.

The artwork and the animation metadata come from the approved "Bella the Tennis Player" package
(its `animation.json` is `manifest.json`'s `workingAtlas`: sheet dimensions, timing and the
per-frame counter anchors, verbatim; the session thresholds were later lowered, so the atlas file
names still carry the package's original thresholds, and the counter typography was later enlarged
and outlined so the number reads at desktop sizes). The manifest is the
source of truth in the repo; the other fields are the collection's usual idle, bubble and size
settings.

```sh
pnpm preview:bella
```

This opens `src/renderer/bella-preview.html` through Vite with the real `CanvasAtlasSprite` and
`PetSprite`, an exact-count input, the state and speed controls, a pause button and the three
desktop sizes. It is a development preview, not a production route.

## Seated idle and question pose

`assets/bella-sitting.png` is the approved seated portrait for idle and question states, and
the working fallback (including zero sessions). Permission and plan-ready states retain the
original standing portrait. Running atlases and the question bubble/motion are unchanged.

Open [the pose comparison](../../../../../../docs/bella-sitting-preview.html) directly in a
browser to compare the old pose, seated Bella, and the corgi reference, including desktop sizes.
The image-generation prompt is recorded in `docs/assets/bella-sitting-proposal.txt`.

## Progression

Session states are cumulative. Session 0 shows the idle portrait; from one session on,
`workingVariantIndex()` picks the style with the highest `minSessions` the count reaches.

| Sessions | Atlas                      | Appearance                                             |
| -------- | -------------------------- | ------------------------------------------------------ |
| 0        | `assets/bella-sitting.png` | Sitting idle                                          |
| 1        | `assets/bella-run-1.webp`  | Running                                                |
| 2–3      | `assets/bella-run-4.webp`  | Black sunglasses                                       |
| 4–5      | `assets/bella-run-6.webp`  | Pink polo with the live session count                  |
| 6–9      | `assets/bella-run-10.webp` | White pleated tennis skirt                             |
| 10–14    | `assets/bella-run-14.webp` | White tennis visor                                     |
| 15+      | `assets/bella-run-21.webp` | Vivid pink polo, pink visor bow, long pink flame trail |

## How it renders

`createAtlasRenderer()` in `atlasCanvas.ts` is a port of the package's reference player. The clock is
continuous across count and outfit changes; the fractional frame blends the two neighbouring poses,
including frame 127 into frame 0, on a scratch canvas: the first pose with source-over at `1 - mix`
and the second added with `lighter` at `mix`, which sums premultiplied colour and alpha so
translucent edges never dim. From four sessions the actual count is drawn at the interpolated
`counterAnchors` of the frame pair, in cell pixels, rotated 0.04 rad and skewed −0.07 so it leans
with the torso. `counter.style` picks how it sits on the polo; the shipped style is `jersey`: white
digits (weight 700, 34 / 30 / 24 px for one, two and three or more digits) with a 3 px `#b00068`
outline, like a printed kit number. The renderer also knows `print` (the digits multiplied into the
fabric so the polo's folds show through), `patch` (a round badge under the digits), `bib` (a pinned
tag sized to the digits) and `plain` (bare text, the package's original 16.625 px look). The
preview's "Number style" select compares them on the live renderer. The count is never capped.

The canvas keeps the pet box's height and takes the style's cell aspect for its width: 64 × 64,
96 × 96 and 128 × 128 CSS px for the normal stages, 88 × 64, 132 × 96 and 176 × 128 for the flame
stage. It is anchored to the box's right edge, so the flame extends to the left. `PetSprite` puts
the box at the right of a stage that is `stageWidthRatio` (352 / 256) times the box's width, and the
main process (`pet-window.ts`) gives Bella's window the same width, so the complete flame trail
stays visible and the dog never moves when the stage changes. The backing store follows
`devicePixelRatio`.

Speed scaling multiplies the clock; the preview's pause button and the system's reduced-motion
preference hold it on the current pose. The run opts out of the overlay's drop shadow
(`workingAtlas.shadow: false`); the idle portrait keeps it. A new style keeps drawing the previous
atlas until its own is decoded, and decoded atlases are cached per URL.
