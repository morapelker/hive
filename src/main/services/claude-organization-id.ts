/**
 * The organization a Claude account's requests are billed to, as Anthropic
 * names it on a response: one place for the header name and for what counts
 * as an id, shared by everything that learns it (the proxied traffic in the
 * live usage updater, the usage poll, the profile request).
 */
import { normalizeOrgUuid } from '../db/types'

/** The response header that names the organization a request was billed to. */
export const ANTHROPIC_ORGANIZATION_HEADER = 'anthropic-organization-id'

/**
 * What an organization id may look like (a uuid today). The stored value is
 * later written into the CLI's identity file, so anything else is not taken.
 */
const ORGANIZATION_ID_PATTERN = /^[0-9a-z][0-9a-z_-]{0,127}$/

/**
 * An organization id in the form it is stored and compared in, or null when
 * the value is missing or does not look like an id.
 */
export function parseOrganizationId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const organization = normalizeOrgUuid(value)
  return organization !== null && ORGANIZATION_ID_PATTERN.test(organization) ? organization : null
}

/** Enough of an organization id to recognise it in a log line. */
export function shortOrganizationId(organization: string): string {
  return organization.slice(0, 8)
}
