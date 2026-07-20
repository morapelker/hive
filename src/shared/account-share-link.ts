/** hive://share-account link building/parsing shared by main and renderer. */

export const SHARE_ACCOUNT_LINK_HOST = 'share-account'

export function buildShareAccountLink(args: {
  serverUrl: string
  token: string
  key: string
}): string {
  const params = new URLSearchParams({
    server: args.serverUrl.replace(/\/+$/, ''),
    token: args.token,
    key: args.key
  })
  return `hive://${SHARE_ACCOUNT_LINK_HOST}?${params.toString()}`
}
