export interface PRReviewComment {
  id: number // GitHub comment ID
  worktree_id: string
  pull_number: number
  node_id: string
  diff_hunk: string
  path: string // file path the comment is on
  position: number | null // line in the diff
  line: number | null // line in the file
  original_line: number | null
  side: 'LEFT' | 'RIGHT'
  start_line: number | null // for multi-line comments
  start_side: 'LEFT' | 'RIGHT' | null
  in_reply_to_id: number | null // threading link
  body: string
  author_login: string
  author_avatar_url: string
  commit_id: string
  original_commit_id: string
  created_at: string
  updated_at: string
  is_outdated: boolean // commit_id !== PR head
  fetched_at: string // cache timestamp
}

export interface PRReviewThread {
  rootComment: PRReviewComment
  replies: PRReviewComment[]
}
