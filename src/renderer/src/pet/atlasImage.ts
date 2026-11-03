const cache = new Map<string, Promise<HTMLImageElement>>()

async function decodeImage(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = src
  if (typeof image.decode === 'function') {
    await image.decode()
  } else {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error(`Failed to load pet atlas ${src}`))
    })
  }
  return image
}

/**
 * Decodes a run-cycle atlas once per URL and keeps it, so a style the count returns to never
 * waits for a second decode. A failed decode is forgotten so the next request retries.
 */
export function loadAtlasImage(src: string): Promise<HTMLImageElement> {
  let pending = cache.get(src)
  if (!pending) {
    pending = decodeImage(src)
    pending.catch(() => cache.delete(src))
    cache.set(src, pending)
  }
  return pending
}
