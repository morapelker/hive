import type { LoginStage } from '@shared/types/usage'

/** Copy for each automated sign-in stage; the manual flow (stage null) keeps the Chrome hint. */
export const LOGIN_STAGE_COPY: Record<LoginStage, string> = {
  'opening-browser': 'opening a sign-in window…',
  'entering-email': 'entering your email…',
  'waiting-for-code': 'waiting for the sign-in code…',
  'entering-code': 'entering the sign-in code…',
  authorizing: 'authorizing…',
  redirecting: 'finishing sign-in…',
  'needs-human': 'finish the sign-in in the Chrome window'
}

export function loginBannerText(
  providerName: string,
  stage: LoginStage | null,
  stageDetail: string | null
): string {
  if (!stage) return `Signing in to ${providerName} — complete the sign-in in Chrome…`
  // The driver explains what it could not get past; that beats generic copy.
  if (stage === 'needs-human' && stageDetail) return stageDetail
  return `Signing in to ${providerName} — ${LOGIN_STAGE_COPY[stage]}`
}
