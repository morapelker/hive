/** A Claude Code skill discovered on disk (`<skillsDir>/<id>/SKILL.md`). */
export type SkillInfo = {
  /** The skill's directory name. Claude Code keys `skillOverrides` by this, not
   * by the frontmatter `name`, so it is the id used to enable/disable a skill. */
  id: string
  /** Frontmatter `name` when it differs from the directory name, else the id. */
  name: string
  description: string | null
}

export type ProjectSkillInfo = SkillInfo & {
  /** False when the effective `skillOverrides` value for this project is "off". */
  enabled: boolean
}

export type ProjectSkillsListing = {
  /** Skills from the user's Claude config dir (`~/.claude/skills`). Read-only. */
  globalSkills: SkillInfo[]
  /** Skills from `<project>/.claude/skills`. */
  projectSkills: ProjectSkillInfo[]
}

export type SetDisabledSkillsResult = {
  success: boolean
  error?: string
}
