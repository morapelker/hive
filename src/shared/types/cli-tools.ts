import type { ScriptOutputEvent } from './script'

/** The CLI tools Hive knows how to detect, install and add skills for. */
export type CliToolId = 'playwright-cli' | 'tcu'

export const CLI_TOOL_IDS: readonly CliToolId[] = ['playwright-cli', 'tcu']

export type CliToolSkillStatus = {
  /** `<project>/.claude/skills/<skillId>/SKILL.md` exists. */
  inProject: boolean
  /** `<configDir>/skills/<skillId>/SKILL.md` exists (installed for every project). */
  inGlobal: boolean
  /** The project copy differs from the skill shipped with the installed CLI. */
  projectOutdated: boolean
  /** The global copy differs from the skill shipped with the installed CLI. */
  globalOutdated: boolean
}

export type CliToolStatus = {
  id: CliToolId
  name: string
  description: string
  /** Directory name of the skill (the key Claude Code uses). */
  skillId: string
  /** The newest version Hive knows about (embedded, not fetched). */
  latestVersion: string
  platformSupported: boolean
  binaryPath: string | null
  installedVersion: string | null
  /** installedVersion >= latestVersion. False when not installed. */
  upToDate: boolean
  skill: CliToolSkillStatus
  /** The command a user can run in a terminal when Hive can't install itself. */
  manualInstallCommand: string
  /** Hive can run the install/update itself on this machine. */
  canAutoInstall: boolean
  /** Something the user has to do after installing (e.g. grant permissions). */
  installHint?: string
}

export type CliToolsListing = {
  tools: CliToolStatus[]
}

export type CliToolActionResult = {
  success: boolean
  error?: string
  /** Captured command output (also streamed on the tool's channel while running). */
  output?: string
  /** The tool's status after the action, when it could be determined. */
  status?: CliToolStatus
}

/** Events streamed while a tool or skill install runs. */
export type CliToolOutputEvent = ScriptOutputEvent

/** EventBus channel carrying `CliToolOutputEvent`s for one tool. */
export const cliToolOutputChannel = (toolId: CliToolId): string => `cli-tools:${toolId}`
