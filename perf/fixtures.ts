/** Deterministic 200-project fixture shaped like a real Hive workspace. */

const WORDS = [
  'tedooo',
  'hive',
  'api',
  'web',
  'mobile',
  'admin',
  'gateway',
  'auth',
  'billing',
  'search',
  'feed',
  'chat',
  'notifications',
  'analytics',
  'infra',
  'design',
  'kit',
  'shop',
  'orders',
  'catalog',
  'payments',
  'media',
  'uploader',
  'worker',
  'cron',
  'edge',
  'proxy',
  'cache',
  'mailer',
  'sms',
  'push',
  'cdn',
  'ios',
  'android',
  'desktop',
  'electron',
  'docs',
  'landing',
  'blog',
  'cms',
  'crm',
  'erp',
  'ops'
]
const SUFFIX = ['', '-service', '-app', '-server', '-client', '-lib', '-tools', '-v2']
const LANGS = [
  'typescript',
  'typescript',
  'typescript',
  'python',
  'go',
  'rust',
  'swift',
  'kotlin',
  null
]
const BRANCH_CITIES = ['paris', 'oslo', 'lima', 'quito', 'cairo', 'osaka', 'perth', 'delhi']
const WT_COUNTS = [3, 1, 0, 5, 2, 4, 3, 0, 1, 2]

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface FixtureProject {
  id: string
  name: string
  path: string
  kind: 'git'
  member_project_ids: null
  description: null
  tags: null
  language: string | null
  custom_icon: null
  detected_icon: string
  setup_script: null
  run_script: null
  archive_script: null
  worktree_create_script: null
  custom_commands: null
  auto_assign_port: boolean
  sort_order: number
  created_at: string
  last_accessed_at: string
}

export interface FixtureWorktree {
  id: string
  project_id: string
  name: string
  branch_name: string
  path: string
  status: 'active'
  is_default: boolean
  branch_renamed: number
  last_message_at: number | null
  session_titles: string
  last_model_provider_id: string | null
  last_model_id: string | null
  last_model_variant: string | null
  attachments: string
  created_at: string
  last_accessed_at: string
  github_pr_number: number | null
  github_pr_url: string | null
}

export function makeFixture(projectCount: number): {
  projects: FixtureProject[]
  worktreesByProject: Map<string, FixtureWorktree[]>
} {
  const rand = mulberry32(42)
  const projects: FixtureProject[] = []
  const worktreesByProject = new Map<string, FixtureWorktree[]>()
  const seen = new Set<string>()
  let i = 0
  while (projects.length < projectCount) {
    const w1 = WORDS[Math.floor(rand() * WORDS.length)]
    const w2 = rand() < 0.5 ? WORDS[Math.floor(rand() * WORDS.length)] : ''
    const suffix = SUFFIX[Math.floor(rand() * SUFFIX.length)]
    const name = [w1, w2].filter(Boolean).join('-') + suffix
    if (seen.has(name)) continue
    seen.add(name)
    const id = `proj-${String(i).padStart(3, '0')}`
    const now = new Date(1_700_000_000_000 + i * 3_600_000).toISOString()
    projects.push({
      id,
      name,
      path: `/Users/mor/Documents/dev/${name}`,
      kind: 'git',
      member_project_ids: null,
      description: null,
      tags: null,
      language: LANGS[Math.floor(rand() * LANGS.length)],
      custom_icon: null,
      detected_icon: 'none',
      setup_script: null,
      run_script: null,
      archive_script: null,
      worktree_create_script: null,
      custom_commands: null,
      auto_assign_port: false,
      sort_order: i,
      created_at: now,
      last_accessed_at: now
    })
    const count = WT_COUNTS[i % WT_COUNTS.length]
    const wts: FixtureWorktree[] = []
    for (let k = 0; k < count; k++) {
      const city = BRANCH_CITIES[(i + k) % BRANCH_CITIES.length]
      wts.push({
        id: `wt-${id}-${k}`,
        project_id: id,
        name: k === 0 ? name : `${name}--${city}`,
        branch_name: k === 0 ? 'main' : `${city}-${k}`,
        path:
          k === 0
            ? `/Users/mor/Documents/dev/${name}`
            : `/Users/mor/.hive-worktrees/${name}/${name}--${city}-${k}`,
        status: 'active',
        is_default: k === 0,
        branch_renamed: 0,
        last_message_at: k % 2 === 0 ? 1_700_000_000_000 + k * 60_000 : null,
        session_titles: '[]',
        last_model_provider_id: null,
        last_model_id: null,
        last_model_variant: null,
        attachments: '[]',
        created_at: now,
        last_accessed_at: now,
        github_pr_number: null,
        github_pr_url: null
      })
    }
    worktreesByProject.set(id, wts)
    i++
  }
  return { projects, worktreesByProject }
}
