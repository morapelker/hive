import { getImageMimeType, isImageFile } from '@shared/types/file-utils'

/**
 * Builds the document the HTML preview shows (HtmlPreview.tsx).
 *
 * The preview is an `<iframe srcdoc>`, so the file is not loaded from its own location: a
 * relative reference (`style.css`, `shots/one.png`) would resolve against the app, not against
 * the file's folder. The stylesheets and images the file takes from disk are therefore read
 * here and inlined, and a `<base href="about:srcdoc">` makes whatever is left unresolvable
 * instead of pointing into the app, while `#section` links still move within the document.
 */

export interface HtmlPreviewAssetReaders {
  /** The UTF-8 text of a local file, or null when it cannot be read. */
  readText: (path: string) => Promise<string | null>
  /** A local image as a `data:` URI, or null when it cannot be read. */
  readImageDataUri: (path: string) => Promise<string | null>
}

/** How deep `@import` is followed from a stylesheet. */
const MAX_IMPORT_DEPTH = 5

/** Total size of the images inlined into one preview; past it, images are left out. */
const MAX_INLINED_IMAGE_CHARS = 64 * 1024 * 1024

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)\s]*))\s*\)/gi
// Only the unconditional form: an import with a media query, a layer or a supports condition
// cannot be replaced by the sheet's text and is left as it is.
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?\s*;/gi

/**
 * The path on disk a reference in `fromFilePath` points at, or null when it is not a relative
 * reference to a file: a URL with a scheme, a protocol-relative URL, a fragment, or a
 * root-relative path (a file on disk has no site root).
 */
export function resolveLocalAssetPath(fromFilePath: string, reference: string): string | null {
  const trimmed = reference.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return null
  }
  if (URL_SCHEME.test(trimmed)) return null

  const withoutQuery = trimmed.split(/[?#]/, 1)[0]
  if (!withoutQuery) return null
  let relative = withoutQuery
  try {
    relative = decodeURIComponent(withoutQuery)
  } catch {
    // Not percent-encoded after all: use it as written.
  }

  const separator = fromFilePath.includes('/') || !fromFilePath.includes('\\') ? '/' : '\\'
  const segments = fromFilePath.split(/[\\/]/)
  segments.pop()
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Never above the root ('' of a POSIX path, the drive of a Windows one).
      if (segments.length > 1) segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join(separator)
}

interface BuildContext {
  readers: HtmlPreviewAssetReaders
  images: Map<string, Promise<string | null>>
  inlinedImageChars: number
}

function loadImage(context: BuildContext, path: string): Promise<string | null> {
  let pending = context.images.get(path)
  if (!pending) {
    pending = context.readers
      .readImageDataUri(path)
      .then((uri) => {
        if (!uri) return null
        if (context.inlinedImageChars + uri.length > MAX_INLINED_IMAGE_CHARS) return null
        context.inlinedImageChars += uri.length
        return uri
      })
      .catch(() => null)
    context.images.set(path, pending)
  }
  return pending
}

/** A local image reference as a data URI; null when it is not one or cannot be read. */
function inlineImage(
  context: BuildContext,
  fromFilePath: string,
  reference: string
): Promise<string | null> {
  const path = resolveLocalAssetPath(fromFilePath, reference)
  if (!path || !isImageFile(path) || !getImageMimeType(path)) return Promise.resolve(null)
  return loadImage(context, path)
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replace: (match: RegExpMatchArray) => Promise<string>
): Promise<string> {
  const matches = Array.from(input.matchAll(pattern))
  if (matches.length === 0) return input
  const replacements = await Promise.all(matches.map(replace))
  let output = ''
  let cursor = 0
  matches.forEach((match, index) => {
    const start = match.index ?? 0
    output += input.slice(cursor, start) + replacements[index]
    cursor = start + match[0].length
  })
  return output + input.slice(cursor)
}

/**
 * CSS with the local images of its `url(...)` inlined and its local `@import`s replaced by the
 * imported sheets. `cssFilePath` is the file the CSS is written in: its references are relative
 * to that file. `ancestors` are the sheets being imported on the way here (an import cycle ends).
 */
async function inlineCssAssets(
  context: BuildContext,
  css: string,
  cssFilePath: string,
  ancestors: readonly string[]
): Promise<string> {
  // Images first, on this file's own text: an imported sheet has resolved its own already,
  // against its own folder.
  const withImages = await replaceAsync(css, CSS_URL, async (match) => {
    const uri = await inlineImage(context, cssFilePath, match[1] ?? match[2] ?? match[3] ?? '')
    return uri ? `url("${uri}")` : match[0]
  })
  if (ancestors.length >= MAX_IMPORT_DEPTH) return withImages
  return replaceAsync(withImages, CSS_IMPORT, async (match) => {
    const imported = await loadStylesheet(
      context,
      cssFilePath,
      match[1] ?? match[2] ?? match[3] ?? '',
      ancestors
    )
    return imported ?? match[0]
  })
}

/** The text of a local `.css` file, ready to inline; null when it is not one or cannot be read. */
async function loadStylesheet(
  context: BuildContext,
  fromFilePath: string,
  reference: string,
  ancestors: readonly string[]
): Promise<string | null> {
  const path = resolveLocalAssetPath(fromFilePath, reference)
  if (!path || !/\.css$/i.test(path) || ancestors.includes(path)) return null
  const css = await context.readers.readText(path).catch(() => null)
  if (css === null) return null
  return inlineCssAssets(context, css, path, [...ancestors, path])
}

/** CSS that can sit in a `<style>` element: it must not hold the element's own end tag. */
function asStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1')
}

/** The first URL of a `srcset`, for an image that has no `src`. */
function firstSrcsetUrl(srcset: string): string | null {
  const first = srcset.trim().split(/\s+/, 1)[0]?.replace(/,+$/, '')
  return first || null
}

/**
 * The document to show for the HTML file at `filePath`: `html` with its local stylesheets and
 * images inlined. Nothing in it is trusted: the preview frame runs no script, and what is
 * inlined is limited to `.css` files and images.
 */
export async function buildHtmlPreviewDocument(
  html: string,
  filePath: string,
  readers: HtmlPreviewAssetReaders
): Promise<string> {
  const context: BuildContext = { readers, images: new Map(), inlinedImageChars: 0 }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const work: Promise<void>[] = []

  // The file's own <base> would point its references somewhere else again, a refresh would
  // navigate the frame away, and a policy written for the file's real location (img-src
  // 'self') would block the inlined copies.
  doc.querySelectorAll('base').forEach((element) => element.remove())
  doc.querySelectorAll('meta[http-equiv]').forEach((element) => {
    const directive = element.getAttribute('http-equiv')?.trim().toLowerCase()
    if (directive === 'refresh' || directive === 'content-security-policy') element.remove()
  })

  doc.querySelectorAll('link[rel][href]').forEach((link) => {
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
    if (!rel.includes('stylesheet')) return
    work.push(
      loadStylesheet(context, filePath, link.getAttribute('href') ?? '', []).then((css) => {
        if (css === null) return
        const style = doc.createElement('style')
        const media = link.getAttribute('media')
        if (media) style.setAttribute('media', media)
        style.textContent = asStyleText(css)
        link.replaceWith(style)
      })
    )
  })

  doc.querySelectorAll('style').forEach((style) => {
    const css = style.textContent ?? ''
    if (!/url\(|@import/i.test(css)) return
    work.push(
      inlineCssAssets(context, css, filePath, []).then((inlined) => {
        style.textContent = asStyleText(inlined)
      })
    )
  })

  doc.querySelectorAll('[style]').forEach((element) => {
    const css = element.getAttribute('style') ?? ''
    if (!/url\(/i.test(css)) return
    work.push(
      replaceAsync(css, CSS_URL, async (match) => {
        const uri = await inlineImage(context, filePath, match[1] ?? match[2] ?? match[3] ?? '')
        // Single quotes: the value is serialised inside a double-quoted attribute.
        return uri ? `url('${uri}')` : match[0]
      }).then((inlined) => element.setAttribute('style', inlined))
    )
  })

  // One source per image: the candidates of a srcset would each need inlining, and `src` is
  // the one every image has.
  doc.querySelectorAll('picture > source').forEach((source) => source.remove())
  doc.querySelectorAll('img').forEach((img) => {
    const srcset = img.getAttribute('srcset')
    img.removeAttribute('srcset')
    img.removeAttribute('sizes')
    const src = img.getAttribute('src') || (srcset ? firstSrcsetUrl(srcset) : null)
    if (!src) return
    if (src.startsWith('//')) {
      // Protocol-relative: there is no protocol to take from an about:srcdoc base.
      img.setAttribute('src', `https:${src}`)
      return
    }
    img.setAttribute('src', src)
    work.push(
      inlineImage(context, filePath, src).then((uri) => {
        if (uri) img.setAttribute('src', uri)
      })
    )
  })

  await Promise.all(work)

  const base = doc.createElement('base')
  base.setAttribute('href', 'about:srcdoc')
  doc.head.prepend(base)

  // The file's own doctype, when it has one. (A srcdoc document is laid out in standards mode
  // either way.)
  const doctype = doc.doctype ? `${new XMLSerializer().serializeToString(doc.doctype)}\n` : ''
  return doctype + doc.documentElement.outerHTML
}
