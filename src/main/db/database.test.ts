import { describe, expect, it } from 'vitest'
import { join } from 'path'

import { resolveDatabasePath } from './database'

describe('database path resolution', () => {
  it('uses the server state database under the configured server base directory', () => {
    expect(resolveDatabasePath({ serverBaseDir: '/tmp/hive-server-test' })).toBe(
      join('/tmp/hive-server-test', 'userdata', 'state.sqlite')
    )
  })

  it('uses the desktop database under the user hive directory without server mode', () => {
    expect(resolveDatabasePath({ homeDir: '/tmp/hive-home-test' })).toBe(
      join('/tmp/hive-home-test', '.hive', 'hive.db')
    )
  })
})
