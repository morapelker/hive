// `scheme://user:password@host` → `scheme://user:***@host` in any text (SQL, mongosh, errors,
// documents). Shared by the SQL and the mongosh secret maskers, on the server (history, the
// assistant) and in the renderer (persisted drafts).
//
// Linear on every input: a scheme only starts after a character that cannot be part of one, so
// a long run such as `a-b-c-…` or `a.b.c.…` is scanned once from its first character instead of
// once from every word boundary inside it (which was quadratic). Userinfo cannot contain
// whitespace, '/' or a quote unencoded; the password is greedy up to the LAST '@' before the
// host, so a password with a raw '@' is still fully masked.
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]*):([^\s/'"`]*)@/gi

/** Masks the password of every `scheme://user:password@` in `text`. */
export function maskUrlCredentials(text: string): string {
  return text && text.includes('://') ? text.replace(URL_USERINFO, '$1:***@') : text
}
