import { describe, expect, it } from 'vitest'

import {
  parseRemoteLaunch,
  remoteLaunchProgressChannel,
  REMOTE_LAUNCH_STEPS,
  type RemoteLaunchClientInfo,
  type RemoteLaunchHostInfo
} from '../types/remote-launch'

describe('REMOTE_LAUNCH_STEPS', () => {
  it('lists the expected steps in order', () => {
    expect(REMOTE_LAUNCH_STEPS).toEqual([
      'connect',
      'branch-check',
      'clone',
      'worktree',
      'file-transfer',
      'setup-script',
      'launch'
    ])
  })
})

describe('remoteLaunchProgressChannel', () => {
  it('builds an event-bus channel name from the launch id', () => {
    expect(remoteLaunchProgressChannel('abc-123')).toBe('remote-launch:progress:abc-123')
  })
})

describe('parseRemoteLaunch', () => {
  const clientInfo: RemoteLaunchClientInfo = {
    role: 'client',
    url: 'https://hive.example.com',
    remoteSessionId: 'session-1',
    remoteWorktreeId: 'worktree-1',
    remoteProjectId: 'project-1',
    tmuxSession: 'hive-session-1',
    branch: 'feature/foo',
    worktreePath: '/home/hive/worktrees/foo',
    launchedAt: '2026-07-09T00:00:00.000Z'
  }

  const hostInfo: RemoteLaunchHostInfo = {
    role: 'host',
    launchId: 'launch-1',
    tmuxSession: 'hive-session-1',
    promptFile: '/tmp/prompt.txt'
  }

  it('parses valid client JSON', () => {
    expect(parseRemoteLaunch(JSON.stringify(clientInfo))).toEqual(clientInfo)
  })

  it('parses valid host JSON', () => {
    expect(parseRemoteLaunch(JSON.stringify(hostInfo))).toEqual(hostInfo)
  })

  it('returns null for null input', () => {
    expect(parseRemoteLaunch(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(parseRemoteLaunch(undefined)).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseRemoteLaunch('')).toBeNull()
  })

  it('returns null for garbage/invalid JSON', () => {
    expect(parseRemoteLaunch('not json')).toBeNull()
    expect(parseRemoteLaunch('{"role":')).toBeNull()
  })

  it('returns null when the role is missing or unrecognized', () => {
    expect(parseRemoteLaunch(JSON.stringify({ ...clientInfo, role: undefined }))).toBeNull()
    expect(parseRemoteLaunch(JSON.stringify({ ...clientInfo, role: 'admin' }))).toBeNull()
    expect(parseRemoteLaunch('{}')).toBeNull()
    expect(parseRemoteLaunch('null')).toBeNull()
    expect(parseRemoteLaunch('"just a string"')).toBeNull()
    expect(parseRemoteLaunch('42')).toBeNull()
  })
})
