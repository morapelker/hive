// Row detail field drafts (the text a field edits, what committing it stages: same parsing as
// the inline editor, JSON pretty-printed and stored compact without ever changing a number or an
// escape, JSON columns refusing non-JSON while jsonpath / json[] take any text), the cell
// inspector's Apply value, the row identity drafts belong to, and the panel's per-viewer
// preferences (defaults, clamping, broken storage).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCellEdit } from './cell-format'
import {
  clampRowDetailWidth,
  compactJsonText,
  fieldDraft,
  inspectorApplyValue,
  isJsonColumnType,
  prettyJsonText,
  readRowDetailPrefs,
  resolveFieldDraft,
  rowIdentity,
  ROW_DETAIL_DEFAULT_WIDTH,
  ROW_DETAIL_MAX_WIDTH,
  ROW_DETAIL_MIN_WIDTH,
  writeRowDetailPrefs
} from './row-detail'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('fieldDraft', () => {
  it('edits NULL as empty, JSON pretty-printed and everything else as its text', () => {
    expect(fieldDraft(null)).toEqual({ text: '', pretty: false })
    expect(fieldDraft(undefined)).toEqual({ text: '', pretty: false })
    expect(fieldDraft(42)).toEqual({ text: '42', pretty: false })
    expect(fieldDraft(true)).toEqual({ text: 'true', pretty: false })
    expect(fieldDraft('{"a":1,"b":[1,2]}')).toEqual({
      text: '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}',
      pretty: true
    })
    // looks like JSON but is not: plain text
    expect(fieldDraft('{not json')).toEqual({ text: '{not json', pretty: false })
    expect(fieldDraft({ $t: 'bin', hex: 'cafe', len: 2 })).toEqual({
      text: '0xcafe',
      pretty: false
    })
  })
})

describe('JSON text', () => {
  // The source spelling of every number (V8's reviver source access): the oracle of a lossless
  // round trip.
  const losslessReparse = (text: string): string => {
    const raw = (JSON as unknown as { rawJSON: (t: string) => unknown }).rawJSON
    return JSON.stringify(
      JSON.parse(text, (_k, v: unknown, ctx?: { source?: string }) =>
        typeof v === 'number' && ctx?.source !== undefined ? raw(ctx.source) : v
      ),
      null,
      2
    )
  }

  it('re-spaces like JSON.stringify(v, null, 2) and back, for any JSON object or array', () => {
    const samples: unknown[] = [
      {},
      [],
      { a: 1, b: [1, 2, { c: null }], d: {}, e: [], f: 'x, y: {z}', g: true },
      [[[]], [{}], 'q"uote\\back\nline', -0.5, 1e-7],
      { 'k e:y': { '': [false, null, 'é'] } }
    ]
    for (const value of samples) {
      for (const text of [JSON.stringify(value), JSON.stringify(value, null, 4)]) {
        expect(prettyJsonText(text)).toBe(JSON.stringify(value, null, 2))
        expect(compactJsonText(text)).toBe(JSON.stringify(value))
      }
    }
    // only objects / arrays, only valid JSON
    for (const text of ['42', '"s"', 'null', '{not json', '[1,]', '', '  ']) {
      expect(prettyJsonText(text)).toBeNull()
      expect(compactJsonText(text)).toBeNull()
    }
  })

  it('never changes a token: big integers, number spellings, escapes, duplicate keys', () => {
    const text =
      '{"id": 1234567890123456789, "ratio": 1.0, "big": 1E400, "s": "\\u00e9\\/\\"", "d": 1, "d": 2, "z": -0}'
    expect(compactJsonText(text)).toBe(
      '{"id":1234567890123456789,"ratio":1.0,"big":1E400,"s":"\\u00e9\\/\\"","d":1,"d":2,"z":-0}'
    )
    const pretty = prettyJsonText(text)!
    expect(pretty).toContain('"id": 1234567890123456789,')
    expect(pretty).toContain('"ratio": 1.0,')
    expect(pretty).toContain('"s": "\\u00e9\\/\\"",')
    expect(pretty.match(/"d"/g)).toHaveLength(2)
    // where JSON.parse is lossless the result is what a source-preserving parse gives
    const plain = '{"id":12345678901234567890,"n":[1.50,2e3]}'
    expect(prettyJsonText(plain)).toBe(losslessReparse(plain))
  })

  it('handles long values in linear time', () => {
    const text = JSON.stringify({ s: `${'x'.repeat(2_000_000)}"`, n: [1, 2, 3] })
    const started = performance.now()
    expect(compactJsonText(prettyJsonText(text)!)).toBe(text)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('isJsonColumnType', () => {
  it('is true for JSON document types only', () => {
    for (const type of ['json', 'jsonb', 'JSON', 'Nullable(JSON)', 'JSON(max_dynamic_paths=8)'])
      expect(isJsonColumnType(type)).toBe(true)
    for (const type of ['jsonpath', 'jsonb[]', 'json[]', '_jsonb', 'my_json_enum', 'text', ''])
      expect(isJsonColumnType(type)).toBe(false)
    expect(isJsonColumnType(undefined)).toBe(false)
  })
})

describe('resolveFieldDraft', () => {
  const draftOf = (value: Parameters<typeof fieldDraft>[0]) => fieldDraft(value)

  it('changes nothing for an untouched draft (a NULL left empty stays NULL)', () => {
    expect(resolveFieldDraft('', draftOf(null), null)).toEqual({ kind: 'unchanged' })
    expect(resolveFieldDraft('Ann', draftOf('Ann'), 'Ann')).toEqual({ kind: 'unchanged' })
  })

  it('parses like the inline editor: numbers stay numeric, booleans parse, text stays text', () => {
    expect(resolveFieldDraft('10', draftOf(1), 1)).toEqual({ kind: 'value', value: 10 })
    expect(resolveFieldDraft('1.50', draftOf(1), 1)).toEqual({ kind: 'value', value: '1.50' })
    expect(resolveFieldDraft('false', draftOf(true), true)).toEqual({
      kind: 'value',
      value: false
    })
    expect(resolveFieldDraft('', draftOf('Ann'), 'Ann')).toEqual({ kind: 'value', value: '' })
    expect(resolveFieldDraft('Bob', draftOf(null), null)).toEqual({ kind: 'value', value: 'Bob' })
    // the same decision the grid's inline editor makes
    expect(resolveCellEdit('10', false, 1)).toEqual({ changed: true, value: 10 })
    expect(resolveCellEdit('', false, null)).toEqual({ changed: false, value: '' })
    expect(resolveCellEdit('x', true, 'x')).toEqual({ changed: true, value: null })
  })

  it('stores pretty-printed JSON compact again, and only when it changed', () => {
    const original = '{"a":1}'
    const base = draftOf(original)
    expect(resolveFieldDraft('{\n  "a": 2\n}', base, original, 'jsonb')).toEqual({
      kind: 'value',
      value: '{"a":2}'
    })
    // reformatted but equal: nothing to stage
    expect(resolveFieldDraft('{ "a": 1 }', base, original, 'jsonb')).toEqual({
      kind: 'unchanged'
    })
    // a text column holding JSON-looking text may become plain text
    expect(resolveFieldDraft('plain', base, original, 'text')).toEqual({
      kind: 'value',
      value: 'plain'
    })
  })

  it('keeps every number and escape of the value when one field of a JSON document changes', () => {
    const original = '{"id": 1234567890123456789, "name": "Alice", "ratio": 1.0, "s": "\\u00e9"}'
    const base = draftOf(original)
    expect(base.pretty).toBe(true)
    expect(base.text).toContain('"id": 1234567890123456789')
    expect(base.text).toContain('"ratio": 1.0')
    const edited = base.text.replace('"Alice"', '"Alicia"')
    expect(resolveFieldDraft(edited, base, original, 'json')).toEqual({
      kind: 'value',
      value: '{"id":1234567890123456789,"name":"Alicia","ratio":1.0,"s":"\\u00e9"}'
    })
    // the value's own spacing (MySQL / jsonb print ", " and ": "): reformatting is no change
    expect(resolveFieldDraft(compactJsonText(original)!, base, original, 'jsonb')).toEqual({
      kind: 'unchanged'
    })
  })

  it('takes jsonpath and json[] / jsonb[] values as text, like the inline editor', () => {
    expect(resolveFieldDraft('$.a.c', draftOf('$.a.b'), '$.a.b', 'jsonpath')).toEqual({
      kind: 'value',
      value: '$.a.c'
    })
    const array = '{"{\\"a\\": 1}","{\\"b\\": 2}"}'
    const edited = '{"{\\"a\\": 1}","{\\"b\\": 3}"}'
    expect(resolveFieldDraft(edited, draftOf(array), array, 'jsonb[]')).toEqual({
      kind: 'value',
      value: edited
    })
    expect(resolveFieldDraft(edited, draftOf(array), array, 'json[]')).toEqual({
      kind: 'value',
      value: edited
    })
  })

  it('refuses text that is not JSON in a JSON column, but takes JSON scalars', () => {
    expect(resolveFieldDraft('{"a":', draftOf('{"a":1}'), '{"a":1}', 'json')).toEqual({
      kind: 'invalid',
      message: 'Not valid JSON'
    })
    expect(resolveFieldDraft('', draftOf('{"a":1}'), '{"a":1}', 'JSON')).toMatchObject({
      kind: 'invalid'
    })
    expect(resolveFieldDraft('42', draftOf('{"a":1}'), '{"a":1}', 'json')).toEqual({
      kind: 'value',
      value: '42'
    })
    expect(resolveFieldDraft('"hi"', draftOf(null), null, 'jsonb')).toEqual({
      kind: 'value',
      value: '"hi"'
    })
  })
})

describe('inspectorApplyValue', () => {
  const json = '{"id": 1234567890123456789, "r": 1.0}'
  const pretty = prettyJsonText(json)

  it('stages nothing for an untouched or only re-spaced value', () => {
    expect(
      inspectorApplyValue({ value: json, text: json, pretty, draft: pretty!, draftNull: false })
    ).toBeUndefined()
    expect(
      inspectorApplyValue({
        value: json,
        text: json,
        pretty,
        draft: compactJsonText(json)!,
        draftNull: false
      })
    ).toBeUndefined()
    expect(
      inspectorApplyValue({
        value: 'abc',
        text: 'abc',
        pretty: null,
        draft: 'abc',
        draftNull: false
      })
    ).toBeUndefined()
    expect(
      inspectorApplyValue({ value: null, text: '', pretty: null, draft: '', draftNull: true })
    ).toBeUndefined()
  })

  it('stages the edited JSON compact with its tokens as typed, NULL, or the text', () => {
    expect(
      inspectorApplyValue({
        value: json,
        text: json,
        pretty,
        draft: pretty!.replace('1.0', '2.50'),
        draftNull: false
      })
    ).toBe('{"id":1234567890123456789,"r":2.50}')
    expect(
      inspectorApplyValue({ value: json, text: json, pretty, draft: pretty!, draftNull: true })
    ).toBeNull()
    // no longer JSON: the text as typed (a JSON column refuses it before Apply)
    expect(
      inspectorApplyValue({ value: json, text: json, pretty, draft: 'plain', draftNull: false })
    ).toBe('plain')
    expect(
      inspectorApplyValue({ value: null, text: '', pretty: null, draft: '', draftNull: false })
    ).toBe('')
    expect(
      inspectorApplyValue({ value: 'a', text: 'a', pretty: null, draft: 'b', draftNull: false })
    ).toBe('b')
  })
})

describe('rowIdentity', () => {
  const columns = [{ name: 'id' }, { name: 'name' }]

  it('names the row by the caller key, else its primary key, else its position', () => {
    expect(rowIdentity('pk:7', [7, 'a'], 3, false, columns, ['id'])).toEqual({
      key: 'key:pk:7',
      stable: true
    })
    expect(rowIdentity(null, [7, 'a'], 3, false, columns, ['id'])).toEqual({
      key: 'pk:[7]',
      stable: true
    })
    // the same position holding another row is another identity
    expect(rowIdentity(null, [9, 'a'], 3, false, columns, ['id']).key).not.toBe('pk:[7]')
    expect(rowIdentity(null, [7, 'a'], 3, false, columns, undefined)).toEqual({
      key: 'at:3',
      stable: false
    })
    expect(rowIdentity(null, [null, 'a'], 5, true, columns, ['id'])).toEqual({
      key: 'new:5',
      stable: false
    })
    expect(rowIdentity(null, [7, 'a'], 3, false, columns, ['missing']).stable).toBe(false)
    expect(rowIdentity(null, null, null, false, columns, ['id']).key).toBe('none')
  })
})

describe('row detail preferences', () => {
  it('defaults to closed at the default width and remembers changes', () => {
    expect(readRowDetailPrefs()).toEqual({ open: false, width: ROW_DETAIL_DEFAULT_WIDTH })
    writeRowDetailPrefs({ open: true })
    writeRowDetailPrefs({ width: 410 })
    expect(readRowDetailPrefs()).toEqual({ open: true, width: 410 })
  })

  it('clamps the width and ignores malformed or unavailable storage', () => {
    expect(clampRowDetailWidth(10)).toBe(ROW_DETAIL_MIN_WIDTH)
    expect(clampRowDetailWidth(5000)).toBe(ROW_DETAIL_MAX_WIDTH)
    localStorage.setItem('hive-data-row-detail', '{"open":"yes","width":"wide"}')
    expect(readRowDetailPrefs()).toEqual({ open: false, width: ROW_DETAIL_DEFAULT_WIDTH })
    localStorage.setItem('hive-data-row-detail', 'not json')
    expect(readRowDetailPrefs()).toEqual({ open: false, width: ROW_DETAIL_DEFAULT_WIDTH })
    const denied = (): never => {
      throw new Error('denied')
    }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied })
    expect(() => writeRowDetailPrefs({ open: true })).not.toThrow()
    expect(readRowDetailPrefs()).toEqual({ open: false, width: ROW_DETAIL_DEFAULT_WIDTH })
  })
})
