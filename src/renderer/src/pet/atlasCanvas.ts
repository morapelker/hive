import type {
  PetCanvasAtlas,
  PetCanvasAtlasCounter,
  PetCanvasAtlasVariant
} from '@shared/types/pet'

/** A point on the run cycle: the frame to show, the one after it, and how far between them. */
export interface AtlasFrame {
  index: number
  next: number
  mix: number
}

/** The fractional frame at a time on the continuous clock; the last frame blends into the first. */
export function atlasFrameAt(
  atlas: Pick<PetCanvasAtlas, 'frames' | 'cycleMs'>,
  timeMs: number
): AtlasFrame {
  const cycle = atlas.cycleMs
  const clock = ((((timeMs % cycle) + cycle) % cycle) / cycle) * atlas.frames
  const index = Math.floor(clock) % atlas.frames
  return { index, next: (index + 1) % atlas.frames, mix: clock - index }
}

/** The counter centre between two frames' anchors, interpolated with the frame blend. */
export function counterAnchorAt(anchors: number[][], frame: AtlasFrame): [number, number] {
  const from = anchors[frame.index]
  const to = anchors[frame.next]
  return [
    from[0] * (1 - frame.mix) + to[0] * frame.mix,
    from[1] * (1 - frame.mix) + to[1] * frame.mix
  ]
}

/** Font size in cell pixels for a count; three or more digits share the smallest size. */
export function counterFontSize(
  counter: Pick<PetCanvasAtlasCounter, 'fontSizes'>,
  count: number
): number {
  const digits = Math.min(3, String(count).length)
  return counter.fontSizes[String(digits)] ?? counter.fontSizes['3']
}

export function counterFont(
  counter: Pick<PetCanvasAtlasCounter, 'fontSizes' | 'fontWeight' | 'fontFamily'>,
  count: number
): string {
  return `${counter.fontWeight} ${counterFontSize(counter, count)}px ${counter.fontFamily}`
}

/** Displayed width of a style for a displayed height, keeping the cell's aspect ratio. */
export function atlasStageWidth(
  variant: Pick<PetCanvasAtlasVariant, 'cellWidth' | 'cellHeight'>,
  height: number
): number {
  return (height * variant.cellWidth) / variant.cellHeight
}

/** Corner radius and side padding of a bib, as fractions of its height. */
const BIB_CORNER = 0.2
const BIB_PADDING = 0.3

/**
 * Prints the count at its anchor, rotated and skewed with the torso. `patch` and `bib` lay their
 * badge down first; `print` multiplies the ink into the fabric so the polo's shading shows
 * through; `jersey` (and any style with an outline, except `print`) strokes the digits before
 * filling them.
 */
export function drawCounter(
  context: CanvasRenderingContext2D,
  counter: PetCanvasAtlasCounter,
  count: number,
  [x, y]: [number, number]
): void {
  const text = String(count)
  const style = counter.style ?? 'plain'
  context.translate(x, y)
  context.rotate(counter.rotationRadians)
  context.transform(1, 0, counter.skewX, 1, 0, 0)
  context.font = counterFont(counter, count)
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  const badge = counter.badge
  if (badge && (style === 'patch' || style === 'bib')) {
    context.beginPath()
    if (style === 'patch') {
      context.arc(0, 0, badge.size / 2, 0, Math.PI * 2)
    } else {
      const width = context.measureText(text).width + badge.size * BIB_PADDING * 2
      context.roundRect(-width / 2, -badge.size / 2, width, badge.size, badge.size * BIB_CORNER)
    }
    context.fillStyle = badge.fill
    context.fill()
    if (badge.rimWidth > 0) {
      context.lineWidth = badge.rimWidth
      context.strokeStyle = badge.rim
      context.stroke()
    }
  }

  if (style === 'print') context.globalCompositeOperation = 'multiply'
  const outline = counter.outline
  if (outline && outline.width > 0 && style !== 'print') {
    context.lineJoin = 'round'
    context.lineWidth = outline.width
    context.strokeStyle = outline.color
    context.strokeText(text, 0, 0)
  }
  context.fillStyle = counter.color
  context.fillText(text, 0, 0)
  context.globalCompositeOperation = 'source-over'
}

export type AtlasDraw = (
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  variant: PetCanvasAtlasVariant,
  count: number,
  timeMs: number
) => void

/**
 * A canvas renderer for one atlas: a port of the approved reference player. The two frames
 * around the clock are blended on a scratch canvas, the first with source-over at `1 - mix`
 * and the second added with `lighter` at `mix`, which sums the premultiplied colours and
 * alphas; drawing the second frame with source-over would dim translucent edges and make the
 * silhouette breathe. Keep one renderer per sprite so the scratch canvas is reused.
 */
export function createAtlasRenderer(atlas: PetCanvasAtlas): AtlasDraw {
  let blend: HTMLCanvasElement | null = null

  return function drawAtlas(canvas, image, variant, count, timeMs): void {
    const context = canvas.getContext('2d')
    if (!context) return
    const { cellWidth: width, cellHeight: height } = variant
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.save()
    const scale = Math.min(canvas.width / width, canvas.height / height)
    context.translate((canvas.width - width * scale) / 2, (canvas.height - height * scale) / 2)
    context.scale(scale, scale)

    const frame = atlasFrameAt(atlas, timeMs)
    blend ??= document.createElement('canvas')
    if (blend.width !== width || blend.height !== height) {
      blend.width = width
      blend.height = height
    }
    const scratch = blend.getContext('2d')
    if (!scratch) {
      context.restore()
      return
    }
    scratch.clearRect(0, 0, width, height)
    scratch.globalCompositeOperation = 'source-over'
    scratch.globalAlpha = 1 - frame.mix
    scratch.drawImage(
      image,
      (frame.index % atlas.columns) * width,
      Math.floor(frame.index / atlas.columns) * height,
      width,
      height,
      0,
      0,
      width,
      height
    )
    scratch.globalCompositeOperation = 'lighter'
    scratch.globalAlpha = frame.mix
    scratch.drawImage(
      image,
      (frame.next % atlas.columns) * width,
      Math.floor(frame.next / atlas.columns) * height,
      width,
      height,
      0,
      0,
      width,
      height
    )
    scratch.globalAlpha = 1
    scratch.globalCompositeOperation = 'source-over'
    context.drawImage(blend, 0, 0)

    const counter = atlas.counter
    if (counter && count >= counter.minSessions && variant.counterAnchors) {
      drawCounter(context, counter, count, counterAnchorAt(variant.counterAnchors, frame))
    }
    context.restore()
  }
}
