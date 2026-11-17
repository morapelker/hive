import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEV_FOLDER,
  DEV_FOLDER_MAX_PREVIOUS,
  DEV_FOLDER_RPC,
  DEV_FOLDER_SETTING_KEY,
  isAbsoluteFolderPath,
  isDevFolderMovePlan,
  isDevFolderMoveResult,
  isDevFolderState,
  parseStoredDevFolder,
  serializeStoredDevFolder,
  type DevFolderMovePlan,
  type DevFolderMoveResult,
  type DevFolderState
} from './dev-folder'

const EMPTY = { path: null, previousPaths: [] }

const row = (value: unknown): string => JSON.stringify(value)

/** What the parser makes of one value in the `path` field. */
const pathOf = (value: unknown): string | null => parseStoredDevFolder(row({ path: value })).path

describe('dev folder constants', () => {
  it('names its own settings row and the default folder', () => {
    expect(DEV_FOLDER_SETTING_KEY).toBe('dev_folder')
    expect(DEV_FOLDER_SETTING_KEY).not.toBe('app_settings')
    expect(DEFAULT_DEV_FOLDER).toBe('~/hive-projects')
    expect(DEV_FOLDER_MAX_PREVIOUS).toBe(20)
  })

  it('names the four RPC methods in the settingsOps domain', () => {
    expect(DEV_FOLDER_RPC).toEqual({
      get: 'settingsOps.getDevFolder',
      set: 'settingsOps.setDevFolder',
      planMove: 'settingsOps.planDevFolderMove',
      moveProject: 'settingsOps.moveProjectToDevFolder'
    })
  })
})

describe('isAbsoluteFolderPath', () => {
  it.each(['/', '/Users/x/Dev', 'C:\\Dev', 'c:/Dev', '\\\\server\\share', '//server/share'])(
    'accepts %j',
    (value) => {
      expect(isAbsoluteFolderPath(value)).toBe(true)
    }
  )

  it.each(['', 'Dev', './Dev', '../Dev', '~', '~/Dev', 'C:', 'C:Dev', ' /Users/x', '\\Dev'])(
    'refuses %j',
    (value) => {
      expect(isAbsoluteFolderPath(value)).toBe(false)
    }
  )
})

describe('parseStoredDevFolder', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['text that is not JSON', '{"path":"/Users/x/Dev"'],
    ['a word', 'nope'],
    ['a JSON string', '"/Users/x/Dev"'],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
    ['JSON true', 'true'],
    ['an array', '["/Users/x/Dev"]'],
    ['an empty object', '{}']
  ])('reads %s as the default folder with nothing before it', (_name, raw) => {
    expect(parseStoredDevFolder(raw)).toEqual(EMPTY)
  })

  it('returns a fresh object every time', () => {
    const first = parseStoredDevFolder(null)
    first.previousPaths.push('/changed')
    expect(parseStoredDevFolder(null)).toEqual(EMPTY)
    expect(parseStoredDevFolder('{nope')).toEqual(EMPTY)
  })

  it('keeps an absolute path and the folders before it', () => {
    expect(
      parseStoredDevFolder(row({ path: '/Users/x/Dev', previousPaths: ['/Users/x/Old', '/b'] }))
    ).toEqual({ path: '/Users/x/Dev', previousPaths: ['/Users/x/Old', '/b'] })
  })

  it('keeps an explicit null path', () => {
    expect(parseStoredDevFolder(row({ path: null, previousPaths: ['/b'] }))).toEqual({
      path: null,
      previousPaths: ['/b']
    })
  })

  it('ignores fields it does not know', () => {
    expect(
      parseStoredDevFolder(row({ path: '/a', previousPaths: [], previousPath: '/b', extra: 1 }))
    ).toEqual({ path: '/a', previousPaths: [] })
  })

  it.each([42, true, {}, ['/Users/x/Dev'], '', 'Dev', './Dev', 'Dev/projects', '~', '~/Dev'])(
    'reads the path %j as not set',
    (value) => {
      expect(pathOf(value)).toBeNull()
    }
  )

  it.each([
    '/',
    '//',
    '///',
    '\\',
    '\\\\',
    '\\\\\\',
    '/\\',
    'C:\\',
    'C:/',
    'c:\\\\',
    'C:\\/',
    'C:'
  ])('refuses the bare root %j', (value) => {
    expect(pathOf(value)).toBeNull()
    expect(parseStoredDevFolder(row({ path: null, previousPaths: [value] }))).toEqual(EMPTY)
  })

  it('refuses a path with a NUL character', () => {
    expect(pathOf('/Users/x/De\0v')).toBeNull()
  })

  it('does not trim: a folder name may start or end with a space', () => {
    expect(pathOf('/Users/x/Dev ')).toBe('/Users/x/Dev ')
    expect(pathOf('/Users/x/ Dev')).toBe('/Users/x/ Dev')
    expect(pathOf('/Users/x/Dev /')).toBe('/Users/x/Dev ')
    expect(pathOf('/Users/x/Dev\n')).toBe('/Users/x/Dev\n')
    // A leading space makes it a relative path, which is refused rather than repaired.
    expect(pathOf(' /Users/x/Dev')).toBeNull()
  })

  it('strips trailing slashes from a POSIX path', () => {
    expect(pathOf('/Users/x/Dev/')).toBe('/Users/x/Dev')
    expect(pathOf('/Users/x/Dev///')).toBe('/Users/x/Dev')
    expect(pathOf('//server/share/')).toBe('//server/share')
  })

  it('keeps a trailing backslash of a POSIX path: it is part of the name', () => {
    expect(pathOf('/Users/x/we\\ird\\')).toBe('/Users/x/we\\ird\\')
    expect(pathOf('/Users/x/we\\ird\\/')).toBe('/Users/x/we\\ird\\')
  })

  it('strips trailing separators of either kind from a Windows path', () => {
    expect(pathOf('C:\\Dev\\')).toBe('C:\\Dev')
    expect(pathOf('C:\\Dev\\\\')).toBe('C:\\Dev')
    expect(pathOf('C:/Dev/')).toBe('C:/Dev')
    expect(pathOf('C:\\Dev/\\')).toBe('C:\\Dev')
    expect(pathOf('\\\\server\\share\\')).toBe('\\\\server\\share')
  })

  it('keeps a path as it is spelled otherwise', () => {
    // Shape only: which folder a spelling names is for the server to say.
    expect(pathOf('/Users/x/Dev/../Other')).toBe('/Users/x/Dev/../Other')
    expect(pathOf('/Users/x//Dev/.')).toBe('/Users/x//Dev/.')
  })

  it.each([
    ['a string', '/b'],
    ['an object', { 0: '/b' }],
    ['null', null],
    ['a number', 3]
  ])('reads previousPaths given as %s as empty', (_name, value) => {
    expect(parseStoredDevFolder(row({ path: '/a', previousPaths: value }))).toEqual({
      path: '/a',
      previousPaths: []
    })
  })

  it('drops entries that are not usable paths and keeps the order of the rest', () => {
    const previousPaths = ['/c', 7, null, 'relative', '~/x', '/', '', ['/d'], '/b', 'C:\\', '/a']
    expect(parseStoredDevFolder(row({ path: '/now', previousPaths })).previousPaths).toEqual([
      '/c',
      '/b',
      '/a'
    ])
  })

  it('drops exact duplicates, also those that only differ by a trailing slash', () => {
    const previousPaths = ['/b', '/c', '/b', '/b/', '/c//', '/d']
    expect(parseStoredDevFolder(row({ path: '/now', previousPaths })).previousPaths).toEqual([
      '/b',
      '/c',
      '/d'
    ])
  })

  it('does not treat other spellings or letter cases as duplicates', () => {
    const previousPaths = ['/Users/x/dev', '/Users/x/DEV', '/Users/x/y/../dev']
    expect(parseStoredDevFolder(row({ path: '/now', previousPaths })).previousPaths).toEqual(
      previousPaths
    )
  })

  it('drops the folder in effect from the folders before it', () => {
    const previousPaths = ['/now', '/b', '/now/', '/NOW']
    expect(parseStoredDevFolder(row({ path: '/now/', previousPaths }))).toEqual({
      path: '/now',
      previousPaths: ['/b', '/NOW']
    })
  })

  it('cannot drop the default folder while the path is null: it does not know the home folder', () => {
    const previousPaths = ['/Users/x/hive-projects', '/b']
    expect(parseStoredDevFolder(row({ path: null, previousPaths })).previousPaths).toEqual(
      previousPaths
    )
  })

  it(`keeps the first ${DEV_FOLDER_MAX_PREVIOUS} folders before`, () => {
    const many = Array.from({ length: DEV_FOLDER_MAX_PREVIOUS + 7 }, (_, index) => `/old/${index}`)
    const parsed = parseStoredDevFolder(row({ path: '/now', previousPaths: many }))
    expect(parsed.previousPaths).toEqual(many.slice(0, DEV_FOLDER_MAX_PREVIOUS))
  })

  it('counts only kept entries towards the cap', () => {
    const many = Array.from({ length: DEV_FOLDER_MAX_PREVIOUS }, (_, index) => `/old/${index}`)
    const noisy = ['relative', '/now', '/old/0', ...many, '/old/extra']
    const parsed = parseStoredDevFolder(row({ path: '/now', previousPaths: noisy }))
    expect(parsed.previousPaths).toEqual(many)
  })
})

describe('serializeStoredDevFolder', () => {
  it('round-trips through the parser', () => {
    const stored = { path: '/Users/x/Dev', previousPaths: ['/Users/x/hive-projects', '/b'] }
    expect(parseStoredDevFolder(serializeStoredDevFolder(stored))).toEqual(stored)
    expect(parseStoredDevFolder(serializeStoredDevFolder(EMPTY))).toEqual(EMPTY)
  })

  it('writes the two fields and nothing else', () => {
    const withExtra = { path: '/a', previousPaths: ['/b'], leftBehind: 3 }
    expect(JSON.parse(serializeStoredDevFolder(withExtra))).toEqual({
      path: '/a',
      previousPaths: ['/b']
    })
  })
})

describe('shape guards', () => {
  const state: DevFolderState = {
    path: '/Users/x/Dev',
    isDefault: false,
    defaultPath: '/Users/x/hive-projects',
    exists: true,
    previousPaths: ['/Users/x/hive-projects'],
    leftBehind: { count: 2, folders: ['/Users/x/hive-projects'] }
  }

  it('isDevFolderState accepts a full state', () => {
    expect(isDevFolderState(state)).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an acknowledgement', { ok: true }],
    ['a string', '/Users/x/Dev'],
    ['a state without leftBehind', { ...state, leftBehind: undefined }],
    ['a null leftBehind', { ...state, leftBehind: null }],
    ['a leftBehind without folders', { ...state, leftBehind: { count: 0 } }],
    [
      'a leftBehind count that is not a number',
      { ...state, leftBehind: { count: '2', folders: [] } }
    ],
    ['a path that is not a string', { ...state, path: null }],
    ['previousPaths with a number in it', { ...state, previousPaths: ['/a', 1] }],
    ['exists that is not a boolean', { ...state, exists: 'yes' }],
    ['isDefault missing', { ...state, isDefault: undefined }],
    ['defaultPath missing', { ...state, defaultPath: undefined }]
  ])('isDevFolderState refuses %s', (_name, value) => {
    expect(isDevFolderState(value)).toBe(false)
  })

  const plan: DevFolderMovePlan = {
    devFolder: '/Users/x/Dev',
    sources: ['/Users/x/hive-projects'],
    candidates: [
      {
        projectId: 'p1',
        projectName: 'app',
        source: '/Users/x/hive-projects',
        fromPath: '/Users/x/hive-projects/app',
        toPath: '/Users/x/Dev/app',
        skipReason: null,
        detail: null
      }
    ]
  }

  it('isDevFolderMovePlan accepts a plan, also an empty one', () => {
    expect(isDevFolderMovePlan(plan)).toBe(true)
    expect(isDevFolderMovePlan({ devFolder: '/Users/x/Dev', sources: [], candidates: [] })).toBe(
      true
    )
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an acknowledgement', { ok: true }],
    ['a plan without candidates', { ...plan, candidates: undefined }],
    ['sources that are not strings', { ...plan, sources: [1] }],
    ['a null candidate', { ...plan, candidates: [null] }],
    ['a candidate without toPath', { ...plan, candidates: [{ projectId: 'p1', fromPath: '/a' }] }],
    ['a devFolder that is not a string', { ...plan, devFolder: null }]
  ])('isDevFolderMovePlan refuses %s', (_name, value) => {
    expect(isDevFolderMovePlan(value)).toBe(false)
  })

  const result: DevFolderMoveResult = {
    projectId: 'p1',
    projectName: 'app',
    action: 'moved',
    fromPath: '/Users/x/hive-projects/app',
    toPath: '/Users/x/Dev/app',
    skipReason: null,
    detail: null,
    warnings: [],
    movedPaths: [{ from: '/Users/x/hive-projects/app', to: '/Users/x/Dev/app' }]
  }

  it('isDevFolderMoveResult accepts each action', () => {
    expect(isDevFolderMoveResult(result)).toBe(true)
    expect(isDevFolderMoveResult({ ...result, action: 'skipped', movedPaths: [] })).toBe(true)
    expect(isDevFolderMoveResult({ ...result, action: 'failed', movedPaths: [] })).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an acknowledgement', { ok: true }],
    ['an unknown action', { ...result, action: 'done' }],
    ['a result without warnings', { ...result, warnings: undefined }],
    ['a result without movedPaths', { ...result, movedPaths: undefined }],
    ['a result without a project id', { ...result, projectId: undefined }]
  ])('isDevFolderMoveResult refuses %s', (_name, value) => {
    expect(isDevFolderMoveResult(value)).toBe(false)
  })
})
