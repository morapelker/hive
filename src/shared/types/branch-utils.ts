/**
 * Convert a ticket title into a safe git branch name.
 * Unlike canonicalizeBranchName (which takes 3 words for verbose session titles),
 * this uses the full title since ticket titles are short and intentional.
 *
 * Lives in shared/ so both main and renderer processes can import it
 * (git-service.ts has Node.js deps that crash the renderer).
 */
export function canonicalizeTicketTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-') // spaces and underscores → dashes
    .replace(/[^a-z0-9\-/.]/g, '') // remove invalid chars
    .replace(/-{2,}/g, '-') // collapse consecutive dashes
    .replace(/^-+|-+$/g, '') // strip leading/trailing dashes
    .slice(0, 50) // truncate
    .replace(/-+$/, '') // strip trailing dashes after truncation
}
