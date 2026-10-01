// Kept as a re-export so renderer imports keep working; the implementation lives in
// shared so the backend (CLI tool version checks) can use the same comparison.
export { compareAppVersions } from '@shared/lib/version-compare'
