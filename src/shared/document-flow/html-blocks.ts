import { isDataUri, type FigureRegistry, type RawBlock } from './block-assembly'
import { decodeEntities, tokenizeHtml, type HtmlAttributes, type HtmlToken } from './html-tokenizer'

// Turns HTML into flat text blocks. One pass over the tokens with an element stack; the stack
// recovers from the markup hand-written and exported documents really contain (unclosed <li>
// and <p>, stray or crossed end tags) instead of trusting it.

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** Subtrees that never hold spec text. `head` still yields the title (a raw-text token). */
const DROPPED_ELEMENTS = new Set(['script', 'style', 'nav', 'noscript', 'template', 'head', 'svg'])

const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'html',
  'legend',
  'li',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

const HEADING_LEVELS = new Map([
  ['h1', 1],
  ['h2', 2],
  ['h3', 3],
  ['h4', 4],
  ['h5', 5],
  ['h6', 6]
])
const LIST_ELEMENTS = new Set(['ul', 'ol', 'menu', 'dir'])
const CELL_ELEMENTS = new Set(['td', 'th'])
const TABLE_SECTION_ELEMENTS = new Set(['thead', 'tbody', 'tfoot'])
const TABLE_STRUCTURE_ELEMENTS = new Set([
  'table',
  'caption',
  'tr',
  ...CELL_ELEMENTS,
  ...TABLE_SECTION_ELEMENTS
])
const CODE_ELEMENTS = new Set(['code', 'kbd', 'samp', 'tt'])
const STRIKE_ELEMENTS = new Set(['del', 's', 'strike'])
const BADGE_ELEMENTS = new Set(['span', 'b', 'strong', 'em', 'i', 'mark', 'small'])
/**
 * Class names authors give tags and status chips ("badge", "tag-new", "status", "s1", "fix",
 * "dat"). Word and Google Docs exports style every run ("c3", "MsoNormal"), so a class alone
 * says nothing.
 */
const CHIP_CLASS_PATTERN = /(?:^|[^a-z])(?:badge|tag|chip|pill|status|label|fix|chg|new|dat|s\d)/i

const BADGE_MAX_CHARS = 30
/** Status qualifiers ("SQL READY · RUN BY HAND AFTER E'S · …") are chips well past 30. */
const CHIP_MAX_CHARS = 120

/** "- item", "1) item": a line that starts like a list item, after a line break. */
const LIST_MARKER_PATTERN = /^\s*(?:[-*+•◦▪‣]|\d{1,9}[.)])\s/

interface Frame {
  name: string
  id: string | null
  /** Root of a subtree whose content is discarded. */
  dropped: boolean
  /** Text or an image was emitted somewhere inside. */
  hasContent: boolean
  /** Inline wrappers: the buffer part this element's text starts at (-1: not tracked). */
  mark: number
  /** Buffer generation `mark` belongs to; a flush in between invalidates it. */
  generation: number
  /** The class name says tag or status chip: the longer badge limit applies. */
  chip: boolean
  /** Headings. */
  level: number
  anchor: string | null
  /** `ol`: the number the next item gets (null: not an ordered list). */
  nextNumber: number | null
  /** `li`: its "3. " marker until the first text is emitted. */
  marker: string
  pre: boolean
  /** The outermost open `tr`: the cells collected so far. */
  cells: string[] | null
}

/**
 * Language of a block the bilingual template toggles: class token `L` plus a 2-3 letter
 * language token ("L en", "L he").
 */
function languageOf(attrs: HtmlAttributes | null): string | null {
  const className = attrs?.get('class')
  if (!className || className.indexOf('L') === -1) return null
  const classes = className.split(/\s+/)
  if (!classes.includes('L')) return null
  const language = classes.find((token) => token !== 'L' && /^[a-zA-Z]{2,3}$/.test(token))
  return language ? language.toLowerCase() : null
}

/**
 * The one language to keep when blocks exist in several. Visibility cannot decide: every
 * `.L` block is `display:none` until a class on <body> reveals one.
 */
function languageToKeep(tokens: readonly HtmlToken[]): string | null {
  const languages: string[] = []
  for (const token of tokens) {
    if (token.kind !== 'open') continue
    const language = languageOf(token.attrs)
    if (language && !languages.includes(language)) languages.push(language)
  }
  if (languages.length < 2) return null
  return languages.includes('en') ? 'en' : languages[0]
}

function isHidden(attrs: HtmlAttributes | null): boolean {
  if (!attrs) return false
  if (attrs.has('hidden')) return true
  if (attrs.get('aria-hidden')?.trim().toLowerCase() === 'true') return true
  const style = attrs.get('style')
  return style !== undefined && style.toLowerCase().replace(/\s+/g, '').includes('display:none')
}

/**
 * A tag or status marker ("FIX", "✓ DONE", "SQL READY · RUN BY HAND"): at least one upper-case
 * word, and hardly anything that is not an upper-case letter, a digit or a symbol.
 */
function isBadgeText(text: string, maxChars: number): boolean {
  if (text.length > maxChars || /[`[\]]/.test(text)) return false
  let total = 0
  let weak = 0
  let run = 0
  let longestRun = 0
  for (const char of text) {
    if (char === ' ') {
      run = 0
      continue
    }
    total++
    const upper = char.toUpperCase()
    if (upper !== char.toLowerCase()) {
      if (char === upper) {
        run++
        if (run > longestRun) longestRun = run
        continue
      }
      weak++
    } else if (/\p{L}/u.test(char)) {
      weak++
    }
    run = 0
  }
  return longestRun >= 2 && weak * 5 <= total
}

export function htmlToBlocks(
  html: string,
  figures: FigureRegistry
): { title: string | null; blocks: RawBlock[] } {
  const tokens = tokenizeHtml(html)
  const keepLanguage = languageToKeep(tokens)

  const blocks: RawBlock[] = []
  const stack: Frame[] = []
  let title: string | null = null
  /** Text of the block in progress, in the pieces it arrived in; joined only when it ends. */
  let parts: string[] = []
  let trailingSpace = false
  let generation = 0
  /** A line break was the last thing added: a list marker next starts a new block. */
  let afterBreak = false
  /** A badge from a plain element that opened the block: bare when it turns out to be all of it. */
  let leadingWeakBadge: string | null = null
  let dropDepth = 0
  let preDepth = 0
  let activeRow: Frame | null = null
  let activeCell: Frame | null = null

  const inPre = (): boolean => preDepth > 0 && activeCell === null

  const markContent = (): void => {
    for (let index = stack.length - 1; index >= 0 && !stack[index].hasContent; index--) {
      stack[index].hasContent = true
    }
  }

  const append = (text: string): void => {
    parts.push(text)
    trailingSpace = text.endsWith(' ')
  }

  const separate = (): void => {
    if (parts.length > 0 && !trailingSpace) append(' ')
  }

  const lineBreak = (): void => {
    if (inPre()) {
      append('\n')
    } else {
      separate()
      afterBreak = true
    }
  }

  const appendText = (text: string): void => {
    if (dropDepth > 0) return
    if (inPre()) {
      append(text)
      if (text.trim()) markContent()
      return
    }
    const collapsed = text.replace(/\s+/g, ' ')
    if (collapsed === '') return
    if (collapsed === ' ') {
      separate()
      return
    }
    const joined = collapsed.charCodeAt(0) === 32 && (parts.length === 0 || trailingSpace)
    const piece = joined ? collapsed.slice(1) : collapsed
    // "1) Add export<br>2) Add history": lines that start like list items are blocks of their own.
    if (afterBreak && LIST_MARKER_PATTERN.test(piece)) flush()
    afterBreak = false
    append(piece)
    markContent()
  }

  const takeBuffer = (): string => {
    const text = parts.join('')
    parts = []
    trailingSpace = false
    afterBreak = false
    leadingWeakBadge = null
    generation++
    return text
  }

  /** A heading or cell that is nothing but one badge from a plain element reads better bare. */
  const unwrapWholeBadge = (text: string, weak: string | null): string =>
    text === weak ? text.slice(1, -1) : text

  /** Nesting depth of the list item at `index` of the stack (0: top level). */
  const listDepth = (index: number): number => {
    let lists = 0
    for (let below = 0; below < index; below++) {
      if (LIST_ELEMENTS.has(stack[below].name)) lists++
    }
    return Math.max(0, lists - 1)
  }

  /**
   * End the block in progress. Its kind comes from the nearest element that gives text a
   * role (heading, list item); everything else is a paragraph. Inside a table cell there are
   * no blocks: the boundary is a space and the row is emitted when it closes.
   */
  const flush = (): void => {
    if (activeCell) {
      separate()
      return
    }
    if (preDepth > 0) {
      const code = takeBuffer().replace(/\r\n?/g, '\n').replace(/^\n/, '').trimEnd()
      if (code.trim()) blocks.push({ type: 'code', text: code })
      return
    }
    const weak = leadingWeakBadge
    const text = takeBuffer().trim()
    if (!text) return
    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]
      if (frame.level > 0) {
        blocks.push({
          type: 'heading',
          level: frame.level,
          anchor: frame.anchor,
          text: unwrapWholeBadge(text, weak)
        })
        return
      }
      if (frame.name === 'li') {
        blocks.push({
          type: 'list-item',
          text: `${'  '.repeat(listDepth(index))}${frame.marker}${text}`
        })
        frame.marker = ''
        return
      }
      if (frame.name === 'table') break
    }
    blocks.push({ type: 'paragraph', text })
  }

  /** Wrap what an inline element contributed: `code`, ~~struck~~, [BADGE]. */
  const closeInline = (frame: Frame): void => {
    if (frame.mark < 0 || frame.generation !== generation) return
    const contributed = parts.slice(frame.mark).join('')
    const inner = contributed.trim()
    if (!inner) return

    let wrapped: string
    if (CODE_ELEMENTS.has(frame.name)) {
      wrapped = `\`${inner}\``
    } else if (STRIKE_ELEMENTS.has(frame.name)) {
      wrapped = `~~${inner}~~`
    } else {
      if (!isBadgeText(inner, frame.chip ? CHIP_MAX_CHARS : BADGE_MAX_CHARS)) return
      wrapped = `[${inner}]`
      // Word and Google Docs style whole headings and cells as one run ("RELEASE PLAN").
      if (!frame.chip && frame.mark === 0) leadingWeakBadge = wrapped
    }

    const before = frame.mark > 0 ? parts[frame.mark - 1] : ''
    let lead = contributed.startsWith(' ') ? ' ' : ''
    // Adjacent chips are spaced by CSS only: "bug fix" + "CHANGE" must not read "fix[CHANGE]".
    if (wrapped.startsWith('[') && before !== '' && !/[\s([{/-]$/.test(before)) lead = ' '
    parts.length = frame.mark
    append(lead + wrapped + (contributed.endsWith(' ') ? ' ' : ''))
  }

  const emitRow = (cells: readonly string[]): void => {
    if (cells.some((cell) => cell !== '')) {
      blocks.push({ type: 'table-row', text: cells.join(' | ') })
    }
  }

  /** The cell's text joins its row. */
  const closeCell = (): void => {
    const weak = leadingWeakBadge
    const cell = takeBuffer().trim()
    activeRow?.cells?.push(unwrapWholeBadge(cell, weak))
    activeCell = null
  }

  /**
   * A heading makes a cell a layout container, not a table cell: the row is emitted with what
   * it has, and the rest of the cell is read as ordinary blocks. Anything else (a <pre> or <p>
   * in a Confluence, Google Docs or Word table) stays flattened into the row, so a data row
   * keeps its cells together.
   */
  const leaveCell = (): void => {
    closeCell()
    if (activeRow?.cells) {
      emitRow(activeRow.cells)
      activeRow.cells = []
    }
  }

  const popFrame = (): void => {
    const frame = stack[stack.length - 1]
    if (frame.dropped) {
      dropDepth--
    } else if (dropDepth === 0) {
      if (frame === activeCell) {
        closeCell()
      } else if (BLOCK_ELEMENTS.has(frame.name)) {
        flush()
        if (frame === activeRow) {
          emitRow(frame.cells ?? [])
          activeRow = null
        }
        if (frame.pre) preDepth--
      } else {
        closeInline(frame)
      }
    }
    stack.pop()
  }

  const popThrough = (index: number): void => {
    while (stack.length > index) popFrame()
  }

  /** Close the nearest open element named in `names`, unless a `barriers` element is nearer. */
  const closeImplied = (names: ReadonlySet<string>, barriers: ReadonlySet<string>): void => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const name = stack[index].name
      if (names.has(name)) {
        popThrough(index)
        return
      }
      if (barriers.has(name)) return
    }
  }

  /** Close an open element matching `matches` that only inline elements separate from the top. */
  const closeOpenBlock = (matches: (frame: Frame) => boolean): void => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]
      if (matches(frame)) {
        popThrough(index)
        return
      }
      if (BLOCK_ELEMENTS.has(frame.name)) return
    }
  }

  /** The end tags HTML lets authors omit: a new <li> ends the previous one, and so on. */
  const applyImpliedEndTags = (name: string): void => {
    if (name === 'li') closeImplied(new Set(['li']), LIST_ELEMENTS)
    else if (name === 'dt' || name === 'dd') closeImplied(new Set(['dt', 'dd']), new Set(['dl']))
    else if (name === 'tr') closeImplied(new Set(['tr']), new Set(['table']))
    else if (CELL_ELEMENTS.has(name)) closeImplied(CELL_ELEMENTS, new Set(['table', 'tr']))
    else if (TABLE_SECTION_ELEMENTS.has(name)) {
      closeImplied(TABLE_SECTION_ELEMENTS, new Set(['table']))
    }
    if (BLOCK_ELEMENTS.has(name) && !TABLE_STRUCTURE_ELEMENTS.has(name)) {
      closeOpenBlock((frame) => frame.name === 'p')
    }
    if (HEADING_LEVELS.has(name)) closeOpenBlock((frame) => frame.level > 0)
  }

  /**
   * A heading's anchor: its own id, else the id of an enclosing element the heading is the
   * first content of (`<section id="a"><h2>…`).
   */
  const inheritedAnchor = (): string | null => {
    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]
      if (frame.hasContent) return null
      if (frame.id) return frame.id
    }
    return null
  }

  const addFigure = (attrs: HtmlAttributes | null): void => {
    const src = (attrs?.get('src') ?? '').trim()
    if (!src) return
    const alt = decodeEntities(attrs?.get('alt') ?? '')
    const token = figures.add(isDataUri(src) ? src : decodeEntities(src), alt)
    appendText(` ${token} `)
  }

  const openElement = (token: Extract<HtmlToken, { kind: 'open' }>): void => {
    const { name, attrs } = token
    const isVoid = VOID_ELEMENTS.has(name) || token.selfClosing
    const frame: Frame = {
      name,
      id: null,
      dropped: false,
      hasContent: false,
      mark: -1,
      generation,
      chip: false,
      level: 0,
      anchor: null,
      nextNumber: null,
      marker: '',
      pre: false,
      cells: null
    }
    if (dropDepth > 0) {
      // </head> may be left out: an element that cannot live in <head> ends it, as in a browser
      // (unless it sits in a <template> or <noscript> of the head, which ends at its own end tag).
      if (BLOCK_ELEMENTS.has(name)) {
        const head = stack.findIndex((open) => open.dropped && open.name === 'head')
        if (head !== -1 && !stack.slice(head + 1).some((open) => DROPPED_ELEMENTS.has(open.name))) {
          popThrough(head)
        }
      }
      if (dropDepth > 0) {
        // Still tracked, so the end tag of the dropped root is matched correctly.
        if (!isVoid) stack.push(frame)
        return
      }
    }

    applyImpliedEndTags(name)
    const isBlock = BLOCK_ELEMENTS.has(name)

    const language = languageOf(attrs)
    const otherLanguage = keepLanguage !== null && language !== null && language !== keepLanguage
    // Language blocks are shown and hidden by script, so their own `hidden` state says nothing.
    const hidden = language === null && name !== 'html' && name !== 'body' && isHidden(attrs)
    if (DROPPED_ELEMENTS.has(name) || otherLanguage || hidden) {
      if (isBlock) flush()
      if (!isVoid) {
        frame.dropped = true
        stack.push(frame)
        dropDepth++
      }
      return
    }

    if (name === 'img') {
      addFigure(attrs)
      return
    }
    if (name === 'br') {
      lineBreak()
      return
    }
    if (name === 'hr') {
      flush()
      return
    }
    if (name === 'input' && attrs?.get('type')?.toLowerCase() === 'checkbox') {
      appendText(attrs.has('checked') ? '[x] ' : '[ ] ')
      return
    }

    const id = attrs?.get('id') ?? (name === 'a' ? attrs?.get('name') : undefined)
    frame.id = id ? decodeEntities(id).trim() || null : null

    if (isBlock) {
      if (activeCell !== null && HEADING_LEVELS.has(name)) leaveCell()
      flush()
      const level = HEADING_LEVELS.get(name)
      if (level !== undefined) {
        frame.level = level
        frame.anchor = frame.id ?? inheritedAnchor()
      } else if (name === 'ol') {
        const start = parseInt(attrs?.get('start') ?? '', 10)
        frame.nextNumber = Number.isNaN(start) ? 1 : start
      } else if (name === 'li') {
        const list = stack[stack.length - 1]
        if (list !== undefined && list.nextNumber !== null) {
          const value = parseInt(attrs?.get('value') ?? '', 10)
          const number: number = Number.isNaN(value) ? list.nextNumber : value
          frame.marker = `${number}. `
          list.nextNumber = number + 1
        }
        if (activeCell) appendText(frame.marker || '- ')
      } else if (name === 'pre') {
        frame.pre = activeCell === null
      } else if (name === 'tr' && activeRow === null) {
        // A row inside a cell (a nested table) stays part of that cell's text.
        frame.cells = []
      }
    } else if (!inPre()) {
      if (frame.id && !isVoid) {
        // `<h2><a id="rules"></a>Rules</h2>`: the anchor of a heading that has none itself.
        const heading = stack[stack.length - 1]
        if (heading !== undefined && heading.level > 0 && heading.anchor === null) {
          heading.anchor = frame.id
        }
      }
      if (CODE_ELEMENTS.has(name) || STRIKE_ELEMENTS.has(name) || BADGE_ELEMENTS.has(name)) {
        frame.mark = parts.length
        frame.chip = CHIP_CLASS_PATTERN.test(attrs?.get('class') ?? '')
      }
    }

    if (isVoid) return
    stack.push(frame)
    if (frame.pre) preDepth++
    if (frame.cells) {
      activeRow = frame
    } else if (CELL_ELEMENTS.has(name) && activeRow !== null && activeCell === null) {
      activeCell = frame
    }
  }

  const closeElement = (name: string): void => {
    const tableStructure = TABLE_STRUCTURE_ELEMENTS.has(name)
    for (let index = stack.length - 1; index >= 0; index--) {
      const frame = stack[index]
      if (frame.name === name) {
        popThrough(index)
        return
      }
      // A cell is a scope of its own: `</div>` inside it must not close a <div> around the table.
      if (!tableStructure && (CELL_ELEMENTS.has(frame.name) || frame.name === 'caption')) break
    }
    // A stray end tag is ignored, except the two that browsers still render as a break.
    if (dropDepth > 0) return
    if (name === 'p') flush()
    else if (name === 'br') lineBreak()
  }

  for (const token of tokens) {
    if (token.kind === 'text') {
      appendText(token.text)
    } else if (token.kind === 'open') {
      openElement(token)
    } else if (token.kind === 'close') {
      closeElement(token.name)
    } else if (token.name === 'title') {
      if (title === null && !stack.some((frame) => frame.name === 'svg')) {
        title = token.text.replace(/\s+/g, ' ').trim() || null
      }
    } else if (token.name === 'textarea' && !isHidden(token.attrs)) {
      appendText(token.text)
    }
  }
  popThrough(0)
  flush()

  return { title, blocks }
}
