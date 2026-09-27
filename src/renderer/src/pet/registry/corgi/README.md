# Corgi activity styles

The working corgi automatically changes appearance with the number of active
**sessions**. Styles are cumulative and always enabled. At five sessions it gains a numbered
cape; the same animation then displays the actual count (6, 20, 123, etc.). Idle
and attention states use the existing static corgi.

Speed scaling is independent for every pet: when enabled, the animation speeds
up with the session count to the configured maximum; when disabled, it runs at
1×. Neither the speed toggle nor its limit affects the style or cape number.
Pets without `workingLottieVariants` keep their single working animation.

| Sessions | Asset                         | Appearance                                           |
| -------- | ----------------------------- | ---------------------------------------------------- |
| 1        | `assets/corgi-anim.lottie`    | Original, unchanged                                  |
| 2        | `assets/corgi-level-2.lottie` | Long wagging tail with a cream tip                   |
| 3        | `assets/corgi-level-3.lottie` | Tail and gold crown                                  |
| 4        | `assets/corgi-level-4.lottie` | Tail, crown, and rippling red cape                   |
| 5+       | `assets/corgi-level-5.lottie` | Actual session count on the cape, with golden sparks |

## Editable cape number

Level five contains a native Lottie text layer parented to the cape and a text
slot named `session-count`. Its default text is `5`. All ten digit outlines are
embedded, so the file works without a font download or HTML overlay.

The app uses the manifest's `workingSessionCounter` configuration and
`sessionCounterSlots()` to set the count. `DotLottieSprite` applies the latest
text slots after loading and updates them in place when the count changes. It
keeps the player and its current frame, so a change from 5 to 6 or 20 does not
restart the run. Unchanged text slots are not reapplied when speed or other
settings change, avoiding the player restoring its default glyphs. Longer numbers shrink to fit; the number is never capped at 20
or abbreviated.

To customize the same file directly with dotLottie-web:

```ts
// Run after the player emits 'load', and whenever the count changes.
const text = String(workingSessionCount)
player.setTextSlot('session-count', {
  t: text,
  s: 90 * Math.min(1, 2 / text.length)
})
```

`workingSessionCounter` is optional and can describe another pet's slot name,
minimum session count, font size, and number of digits that fit at full size.
The renderer also accepts a generic `textSlots` map for other editable text.

## Preview and regenerate

From the repository root:

```sh
pnpm -C apps/hive preview:corgi
pnpm -C apps/hive generate:corgi
```

The first command opens `src/renderer/corgi-preview.html` through Vite. It shows
sessions 1–20 together, with synchronized playback, a frame scrubber, and
light/dark/checkerboard backgrounds. The real `PetSprite` at S/M/L sizes has a
0–20 slider, an exact-count input that also accepts larger values, and independent
speed controls. The gallery stays at 1× for comparison. Numbered
cards download the reusable template, whose default number is five. This is a
development preview, not a production route.

The generator reads the original archive and writes only levels 2–5. It preserves
the original composition, frame rate, run cycle, colors, and character rig. The
original file doubles as level one. The additions use native Lottie shapes and
keyframes: the tail and cape follow the body, the crown follows the head, and the
cape's shape paths animate independently. Generation is deterministic; edit the
generator before rebuilding the archives.

The checked-in `digit-glyphs.json` contains outlines from the bundled Geist font
at weight 800. Its source and SIL OFL notice are in `src/renderer/src/assets/fonts`. To rebuild
those outlines (an optional authoring step), run:

```sh
uv run apps/hive/scripts/generate-corgi-digits.py
pnpm -C apps/hive generate:corgi
```

Normal animation generation needs only Node; neither Python nor font tools are
used at runtime.

## Visual verification

Inspected all twenty counts together and checked the numbered cape throughout
the run cycle. Verified counts 5, 10, 20, 88, 100, and 123456 at all 60 frames,
including that the rendered number remains on the red cloth. Checked changing
counts, normal speed, desktop sizes, and light/dark backgrounds.

The pet tests cover variant selection, player replacement/cleanup, in-place
number changes (including updates during loading), fitting longer counts,
static states, independent speed scaling with and without variants, and the settings UI.
