# Milla the Swimmer

Milla is a cocker spaniel with long curly ears, drawn from a photo of a real dog in Bella's plush
style. She is a canvas-atlas pet like [Bella](../bella/README.md): the same renderer
(`CanvasAtlasSprite` and `createAtlasRenderer()`), the same atlas layout (128 frames, 16 columns ×
8 rows, 256 px cells), the same 1,920 ms loop and Bella's own run cycle, pose for pose. Where Bella
collects a tennis kit as sessions grow, Milla collects a pink swim kit.

## Progression

Session states are cumulative. Session 0 shows the sitting portrait; from one session on,
`workingVariantIndex()` picks the style with the highest `minSessions` the count reaches.

| Sessions | Atlas                       | Appearance                                                 |
| -------- | --------------------------- | ---------------------------------------------------------- |
| 0        | `assets/milla-sitting.webp` | Sitting                                                    |
| 1        | `assets/milla-run-1.webp`   | Running                                                    |
| 2–3      | `assets/milla-run-2.webp`   | Pink swimming goggles                                      |
| 4–5      | `assets/milla-run-4.webp`   | Pink swimsuit with the live session count                  |
| 6–9      | `assets/milla-run-6.webp`   | White swimming cap with a pink stripe                      |
| 10+      | `assets/milla-run-10.webp`  | Gold medal, running through a splash pool (her final look) |

The sitting portrait also stands in for the question, permission and plan-ready states, with the
usual bubbles and glow on top.

From four sessions the count is drawn on the swimsuit in Bella's `jersey` style (white digits,
weight 700, 34 / 30 / 24 px, a 3 px `#b00068` outline). The anchors were measured on Milla's
swimsuit in every frame: the roomiest point of the fabric panel behind the ears, smoothed around
the loop. Her fur is pixel-identical from stage to stage, so the swimsuit, cap and medal stages
share one anchor track.

The pool fits inside the 256 px cell, so unlike Bella's flame stage Milla needs no
`stageWidthRatio`: her box and the pet window stay square at every stage.

## How the art was made

- **Sitting portrait:** the photo redrawn in Bella's style, pose, scale and paw baseline, so nothing
  jumps when she starts running.
- **Run:** Bella's 8 key poses were repainted with Milla in place, and FILM interpolated the
  in-betweens to 128 frames, so her bounce tracks Bella's (correlation 0.97).
- **Outfits:** each is one image edit on top of the previous stage, keeping only the changed pixels.
  The kit was made blue and recoloured to pink, so colour is the only difference between the two.
- **Splash pool:** a single pool painting, the same in every frame, under the run, with splashes
  cut from an edit of the 8 key poses and interpolated by FILM on top.

The atlases are lossy WebP (quality 90, alpha 95): 7.5 MB in all, against 25.3 MB lossless, with no
visible difference at the desktop sizes.
