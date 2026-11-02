# Udi the German Shepherd

Udi is the second sprite-sheet pet, built the same way as the pug. His idle portrait is a PNG and
every working style is a lossless WebP atlas of 64 run-cycle poses (8 columns × 8 rows, 352 px
cells, exact for the pet on a 2x display; one 1.0 second loop at 64 fps, one frame per 60 Hz refresh, a touch
slower than the pug and the frenchie's 0.8 s so his bigger stride reads calmly). The artwork was approved in
`docs/udi-preview.html` ("Smooth · 64 fps") and is extracted from that file verbatim:

```sh
pnpm extract:udi
pnpm preview:udi
```

The second command opens `src/renderer/udi-preview.html` through Vite with the real
`SpriteSheetSprite` and `PetSprite` renderers, a 0–20 slider, an exact-count input and the speed
controls. It is a development preview, not a production route.

## Progression

Milestones follow the corgi and the pug: 1, 2, 3, 4, 5, 10, 15 and 20 active sessions. Each
upgrade keeps the ones before it. `workingVariantIndex()` picks the last style whose minimum the
count reaches; `workingSpriteSheet.variantSessions` lists the minimums. Udi's base look already
includes his sunflower-yellow bandana and the football he chases; the upgrade for two sessions is
still being chosen, so that entry reuses the level-1 atlas.

| Sessions | Atlas                                | Appearance                                               |
| -------- | ------------------------------------ | -------------------------------------------------------- |
| 1        | `assets/german-shepherd-run-1.webp`  | Yellow bandana, chasing a football                       |
| 2        | `assets/german-shepherd-run-1.webp`  | Open slot (same as 1 until an upgrade is chosen)         |
| 3        | `assets/german-shepherd-run-3.webp`  | Navy baseball cap worn backwards                         |
| 4        | `assets/german-shepherd-run-4.webp`  | Sky-blue cape with an embroidered paw on the badge       |
| 5–9      | `assets/german-shepherd-run-4.webp`  | Same cape; the badge shows the actual count, plus sparks |
| 10–14    | `assets/german-shepherd-run-10.webp` | Sapphire cape and gold aviators against the cap          |
| 15–19    | `assets/german-shepherd-run-15.webp` | Amethyst cape and ivory wings                            |
| 20+      | `assets/german-shepherd-run-20.webp` | Midnight starry cape and a golden comet trail            |

## How it renders

Identical to the pug: `SpriteSheetSprite` steps the atlas through its grid with a Web Animations
transform, the badge is an SVG layer whose `translate` follows the cape (`badge.anchors` holds the
badge centre for the eight key poses per style, in the 448 px key-pose cell, `cellSize` 448; the atlas cell
size does not matter since anchors become a fraction of the box), the count
is drawn in Georgia 700 at 30 units of a 400-unit box from five sessions and shrinks for three or
more digits, and three sparkles twinkle from five sessions onward. Speed scaling sets
`playbackRate` on every animation; a count change that keeps the same atlas only swaps the badge.

The run cycle opts out of the overlay's drop shadow (`workingSpriteSheet.shadow: false`): the sprite
fills its box, so the shadow sat as a dark blob behind the hind paws on anything lighter than black.
The idle portrait keeps it.

The main-process mirror in `pet-window.ts` lists the pet's id, name and idle assets.

## Artwork pipeline

The idle portrait and the eight-pose run sheets were generated with the Tedooo image gateway from
a photo of the real Udi, with the corgi and pug portraits as style references; outfits were added as
per-sheet edits. Each pose was sliced with one shared scale anchored on the plain level-1 body, so
Udi stays the same size and place when an outfit is added. Generation haze is removed before slicing (a
uniform tint read off the sheet border is subtracted, and semi-transparent pixels more than 6 px from the
opaque fur, such as speed lines and halos, are dropped; level 20's comet tail is exempt), because a faint cream
haze is invisible on the study page but a grey cloud on a dark desktop. Every sheet then got one more
precise-object edit: both hind legs lit in the same tan as the front legs, because the generator had painted the far
hind leg and the gap between the hind legs as a dark shadow, which the interpolation smeared into black blobs between
the back feet as the legs crossed (the frenchie's far leg is fawn like the near one, so it never had this). The
gateway returned those edits on a near-opaque backdrop, so only their colour was kept, under each original sheet's
alpha, after checking that no pose had moved; silhouettes and badge anchors are unchanged. The 64-frame atlases turn the eight key
poses into FILM (Frame Interpolation for Large Motion) in-betweens by three-deep bisection: colour is interpolated from the
fully opaque bled fur and alpha from its own mask run, so moving edges never go black and the fur
never dissolves. Prompts and the full pipeline notes are embedded in `docs/udi-preview.html` and its
"Download all" pack, which also includes a draft of this manifest.
