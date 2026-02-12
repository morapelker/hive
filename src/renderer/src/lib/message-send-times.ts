/**
 * Tracks when the user last sent a message for each session.
 *
 * Written by handleSend in SessionView. Read by both SessionView's idle
 * handler and the global listener's idle handler to compute completion
 * badge duration. Never deleted on idle — only reset on the next send.
 */
export const messageSendTimes = new Map<string, number>()
