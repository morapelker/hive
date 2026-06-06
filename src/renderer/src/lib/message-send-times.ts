/**
 * Tracks when the user last sent a message for each session.
 *
 * Written by handleSend in SessionView. Read by both SessionView's idle
 * handler and the global listener's idle handler to compute completion
 * badge duration. Never deleted on idle — only reset on the next send.
 */
export const messageSendTimes = new Map<string, number>()

/**
 * Tracks the session mode ('plan' | 'build') at the time the user last
 * sent a message. Used to derive whether a completed session should show
 * "Plan ready" or "Ready" in the sidebar.
 */
export const lastSendMode = new Map<string, 'plan' | 'build'>()

/**
 * Tracks when the user last *explicitly* sent a message for each session.
 * Unlike messageSendTimes (which tracks ALL sends including auto follow-ups
 * and pending messages for the completion badge), this only records sends
 * triggered by actual user action — used for the elapsed timer in the input area.
 */
export const userExplicitSendTimes = new Map<string, number>()

/**
 * Tracks the Hive Enterprise prompt id for the currently active model dispatch in a session.
 * Written at dispatch start and cleared after idle telemetry is sent.
 */
export const currentPromptIdBySession = new Map<string, string>()
