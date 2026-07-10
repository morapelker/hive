import type { PetManifest, PetPosition, PetSettings, PetStatusPayload } from './types/pet'

export const DESKTOP_COMMAND_REQUEST_TYPE = 'hive-desktop-command'
export const DESKTOP_COMMAND_RESULT_TYPE = 'hive-desktop-command-result'
export const DESKTOP_BACKEND_EVENT_TYPE = 'hive-desktop-backend-event'

export type DesktopCommandName =
  | 'quitApp'
  | 'confirm'
  | 'projectOpenDirectoryDialog'
  | 'projectShowInFolder'
  | 'projectOpenPath'
  | 'projectWriteClipboardText'
  | 'projectReadClipboardText'
  | 'projectPickProjectIcon'
  | 'projectRemoveProjectIcon'
  | 'projectGetProjectIconPath'
  | 'gitShowInFinder'
  | 'kanbanOpenBoardImportFileDialog'
  | 'kanbanSaveBoardExportDialog'
  | 'backupOpenFileDialog'
  | 'backupSaveFileDialog'
  | 'systemGetAppVersion'
  | 'systemGetAppPaths'
  | 'systemIsPackaged'
  | 'openInApp'
  | 'openInChrome'
  | 'updateMenuState'
  | 'setKeepAwake'
  | 'sleepNow'
  | 'setSessionQueuedState'
  | 'updaterCheckForUpdate'
  | 'updaterDownloadUpdate'
  | 'updaterInstallUpdate'
  | 'updaterSetChannel'
  | 'updaterGetVersion'
  | 'showPet'
  | 'hidePet'
  | 'publishPetStatus'
  | 'setPetIgnoreMouse'
  | 'beginPetPointerInteraction'
  | 'endPetPointerInteraction'
  | 'movePet'
  | 'focusMainFromPet'
  | 'getPetConfig'
  | 'getCurrentPetStatus'
  | 'updatePetSettings'
  | 'markPetHatched'
  | 'createResponseLog'
  | 'appendResponseLog'
  | 'saveAttachment'
  | 'deleteAttachment'
  | 'settingsOpenWithEditor'
  | 'settingsOpenWithTerminal'
  | 'watchFileTree'
  | 'unwatchFileTree'
  | 'watchGitWorktree'
  | 'unwatchGitWorktree'
  | 'watchGitBranch'
  | 'unwatchGitBranch'
  | 'killScript'
  | 'terminalResize'
  | 'terminalDestroy'
  | 'terminalWrite'
  | 'terminalCreateClaudeCli'
  | 'remoteLaunchClaudeTmux'
  | 'terminalGhosttyInit'
  | 'terminalGhosttyIsAvailable'
  | 'terminalGhosttyCreateSurface'
  | 'terminalGhosttySetFrame'
  | 'terminalGhosttySetSize'
  | 'terminalGhosttyKeyEvent'
  | 'terminalGhosttyMouseButton'
  | 'terminalGhosttyMousePos'
  | 'terminalGhosttyMouseScroll'
  | 'terminalGhosttySetFocus'
  | 'terminalGhosttyPasteText'
  | 'terminalGhosttyFocusDiagnostics'
  | 'terminalGhosttyDestroySurface'
  | 'terminalGhosttyShutdown'
  | 'opencodeConnect'
  | 'opencodeReconnect'
  | 'opencodePrompt'
  | 'opencodeAbort'
  | 'opencodeSteer'
  | 'opencodeDisconnect'
  | 'opencodeGetMessages'
  | 'opencodeRefreshFromThread'
  | 'opencodeListModels'
  | 'opencodeSetModel'
  | 'opencodeModelInfo'
  | 'opencodeQuestionReply'
  | 'opencodeQuestionReject'
  | 'opencodePlanApprove'
  | 'opencodePlanReject'
  | 'opencodePermissionReply'
  | 'opencodePermissionList'
  | 'opencodeCommandApprovalReply'
  | 'opencodeSessionInfo'
  | 'opencodeUndo'
  | 'opencodeRedo'
  | 'opencodeCommand'
  | 'opencodeCommands'
  | 'opencodeRenameSession'
  | 'opencodeCapabilities'
  | 'opencodeFork'
  | 'telegramClaudeCliRegister'
  | 'telegramClaudeCliCancel'
  | 'telegramClaudeCliQuestionReply'
  | 'telegramClaudeCliQuestionReject'
  | 'telegramClaudeCliPlanReply'
  | 'terminalSetClaudeCliPlanAutoApprove'

export interface OpenInAppPayload {
  readonly appName: string
  readonly path: string
}

export interface OpenInAppResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenInChromePayload {
  readonly url: string
  readonly customCommand?: string
}

export interface OpenInChromeResult {
  readonly success: boolean
  readonly error?: string
}

export interface UpdateMenuStatePayload {
  readonly hasActiveSession: boolean
  readonly hasActiveWorktree: boolean
  readonly canUndo?: boolean
  readonly canRedo?: boolean
}

export interface SetKeepAwakePayload {
  readonly active: boolean
}

export interface SetSessionQueuedStatePayload {
  readonly sessionId: string
  readonly hasQueued: boolean
}

export interface ConfirmPayload {
  readonly message: string
}

export interface ProjectShowInFolderPayload {
  readonly path: string
}

export interface ProjectOpenPathPayload {
  readonly path: string
}

export interface ProjectWriteClipboardTextPayload {
  readonly text: string
}

export interface ProjectPickProjectIconPayload {
  readonly projectId: string
}

export interface ProjectPickProjectIconResult {
  readonly success: boolean
  readonly filename?: string
  readonly error?: string
}

export interface ProjectRemoveProjectIconPayload {
  readonly projectId: string
}

export interface ProjectRemoveProjectIconResult {
  readonly success: boolean
  readonly error?: string
}

export interface ProjectGetProjectIconPathPayload {
  readonly filename: string
}

export interface GitShowInFinderPayload {
  readonly filePath: string
}

export interface KanbanOpenBoardImportFileDialogResult {
  readonly filePath: string | null
}

export interface KanbanSaveBoardExportDialogPayload {
  readonly projectName: string
}

export interface KanbanSaveBoardExportDialogResult {
  readonly filePath: string | null
}

export interface BackupOpenFileDialogResult {
  readonly filePath: string | null
}

export interface BackupSaveFileDialogPayload {
  readonly defaultFileName: string
}

export interface BackupSaveFileDialogResult {
  readonly filePath: string | null
}

export interface SystemGetAppPathsResult {
  readonly userData: string
  readonly home: string
}

export interface UpdaterCheckForUpdatePayload {
  readonly manual?: boolean
}

export type UpdaterChannel = 'stable' | 'canary'

export interface UpdaterSetChannelPayload {
  readonly channel: UpdaterChannel
}

export type PublishPetStatusPayload = PetStatusPayload

export interface SetPetIgnoreMousePayload {
  readonly ignore: boolean
}

export type MovePetPayload = PetPosition

export interface FocusMainFromPetPayload {
  readonly worktreeId: string | null
}

export interface GetPetConfigResult {
  readonly settings: PetSettings
  readonly position: PetPosition
  readonly manifest: PetManifest
}

export type GetCurrentPetStatusResult = PetStatusPayload

export type UpdatePetSettingsPayload = Partial<PetSettings>

export interface CreateResponseLogPayload {
  readonly sessionId: string
}

export interface AppendResponseLogPayload {
  readonly filePath: string
  readonly data: unknown
}

export interface SaveAttachmentPayload {
  readonly dataBase64: string
  readonly originalName: string
}

export interface SaveAttachmentResult {
  readonly success: boolean
  readonly filePath?: string
  readonly error?: string
}

export interface DeleteAttachmentPayload {
  readonly filePath: string
}

export interface DeleteAttachmentResult {
  readonly success: boolean
  readonly error?: string
}

export interface SettingsOpenWithEditorPayload {
  readonly worktreePath: string
  readonly editorId: string
  readonly customCommand?: string
}

export interface SettingsOpenWithTerminalPayload {
  readonly worktreePath: string
  readonly terminalId: string
  readonly customCommand?: string
}

export interface SettingsOperationResult {
  readonly success: boolean
  readonly error?: string
}

export interface WatchFileTreePayload {
  readonly worktreePath: string
}

export interface UnwatchFileTreePayload {
  readonly worktreePath: string
}

export interface WatchGitWorktreePayload {
  readonly worktreePath: string
}

export interface UnwatchGitWorktreePayload {
  readonly worktreePath: string
}

export interface WatchGitBranchPayload {
  readonly worktreePath: string
}

export interface UnwatchGitBranchPayload {
  readonly worktreePath: string
}

export interface KillScriptPayload {
  readonly worktreeId: string
}

export interface KillScriptResult {
  readonly success: boolean
  readonly error?: string
}

export interface TerminalResizePayload {
  readonly terminalId: string
  readonly cols: number
  readonly rows: number
}

export interface TerminalDestroyPayload {
  readonly terminalId: string
}

export interface TerminalWritePayload {
  readonly terminalId: string
  readonly data: string
}

export interface TerminalCreateClaudeCliPayload {
  readonly sessionId: string
  readonly opts?: {
    readonly pendingPrompt?: string | null
  }
}

export interface TerminalCreateResult {
  readonly success: boolean
  readonly cols?: number
  readonly rows?: number
  readonly error?: string
}

export interface RemoteLaunchClaudeTmuxPayload {
  readonly sessionId: string
  readonly worktreePath: string
  readonly prompt: string
  readonly tmuxSessionName: string
}

export interface RemoteLaunchClaudeTmuxResult {
  readonly success: boolean
  readonly error?: string
  readonly tmuxSession?: string
}

export interface TelegramClaudeCliSessionPayload {
  readonly sessionId: string
}

export interface TerminalClaudeCliPlanAutoApprovePayload {
  readonly sessionId: string
  readonly enabled: boolean
}

export interface TelegramClaudeCliQuestionReplyPayload {
  readonly requestId: string
  readonly answers: string[][]
}

export interface TelegramClaudeCliQuestionRejectPayload {
  readonly requestId: string
}

export interface TelegramClaudeCliPlanReplyPayload {
  readonly requestId: string
  readonly approve: boolean
  readonly feedback?: string
}

export interface TelegramClaudeCliReplyResult {
  readonly success: boolean
}

export interface TerminalGhosttyAvailabilityResult {
  readonly available: boolean
  readonly initialized: boolean
  readonly platform: string
}

export interface TerminalGhosttyInitResult {
  readonly success: boolean
  readonly version?: string
  readonly error?: string
}

export interface TerminalGhosttyRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface TerminalGhosttyCreateSurfaceOptions {
  readonly cwd?: string
  readonly shell?: string
  readonly scaleFactor?: number
  readonly fontSize?: number
  readonly shiftEnterAsNewline?: boolean
}

export interface TerminalGhosttyCreateSurfacePayload {
  readonly terminalId: string
  readonly rect: TerminalGhosttyRect
  readonly opts?: TerminalGhosttyCreateSurfaceOptions
}

export interface TerminalGhosttySetFramePayload {
  readonly terminalId: string
  readonly rect: TerminalGhosttyRect
}

export interface TerminalGhosttySetSizePayload {
  readonly terminalId: string
  readonly width: number
  readonly height: number
}

export interface TerminalGhosttyKeyEvent {
  readonly action: number
  readonly keycode: number
  readonly mods: number
  readonly consumedMods?: number
  readonly text?: string
  readonly unshiftedCodepoint?: number
  readonly composing?: boolean
}

export interface TerminalGhosttyKeyEventPayload {
  readonly terminalId: string
  readonly event: TerminalGhosttyKeyEvent
}

export interface TerminalGhosttyMouseButtonPayload {
  readonly terminalId: string
  readonly state: number
  readonly button: number
  readonly mods: number
}

export interface TerminalGhosttyMousePosPayload {
  readonly terminalId: string
  readonly x: number
  readonly y: number
  readonly mods: number
}

export interface TerminalGhosttyMouseScrollPayload {
  readonly terminalId: string
  readonly dx: number
  readonly dy: number
  readonly mods: number
}

export interface TerminalGhosttySetFocusPayload {
  readonly terminalId: string
  readonly focused: boolean
}

export interface TerminalGhosttyPasteTextPayload {
  readonly terminalId: string
  readonly text: string
}

export interface TerminalGhosttyDestroySurfacePayload {
  readonly terminalId: string
}

export interface TerminalGhosttyFocusDiagnostic {
  readonly surfaceId: number
  readonly subviewCount: number
  readonly firstResponderClass: string
  readonly isHostView: boolean
  readonly isDescendant: boolean
  readonly hasWindow: boolean
}

export type TerminalGhosttyFocusDiagnosticsResult = readonly TerminalGhosttyFocusDiagnostic[]

export interface TerminalGhosttyCreateSurfaceResult {
  readonly success: boolean
  readonly surfaceId?: number
  readonly error?: string
}

export interface OpenCodeConnectPayload {
  readonly worktreePath: string
  readonly hiveSessionId: string
}

export interface OpenCodeConnectResult {
  readonly success: boolean
  readonly sessionId?: string
  readonly error?: string
}

export interface OpenCodeReconnectPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
  readonly hiveSessionId: string
}

export interface OpenCodeReconnectResult {
  readonly success: boolean
  readonly sessionStatus?: 'idle' | 'busy' | 'retry'
  readonly revertMessageID?: string | null
}

export type OpenCodePromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'file'
      readonly mime: string
      readonly url: string
      readonly filename?: string
    }

export type OpenCodePromptMessage = string | OpenCodePromptPart[]

export interface OpenCodePromptModel {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface OpenCodePromptOptions {
  readonly codexFastMode?: boolean
}

export interface OpenCodePromptPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
  readonly messageOrParts: OpenCodePromptMessage
  readonly model?: OpenCodePromptModel
  readonly options?: OpenCodePromptOptions
}

export interface OpenCodePromptResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeAbortPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeAbortResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeSteerPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
  readonly message: string
}

export interface OpenCodeSteerResult {
  readonly success: boolean
  readonly error?: string
  readonly insertedMessageId?: string
  readonly nextAssistantMessageId?: string
  readonly turnId?: string
}

export interface OpenCodeDisconnectPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeDisconnectResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeGetMessagesPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeGetMessagesResult {
  readonly success: boolean
  readonly messages: unknown[]
  readonly error?: string
}

export interface OpenCodeRefreshFromThreadPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeRefreshFromThreadResult {
  readonly success: boolean
  readonly count?: number
  readonly error?: string
}

export type OpenCodeAgentSdk = 'opencode' | 'claude-code' | 'claude-code-cli' | 'codex' | 'terminal'

export interface OpenCodeListModelsPayload {
  readonly agentSdk?: OpenCodeAgentSdk
}

export interface OpenCodeListModelsResult {
  readonly success: boolean
  readonly providers: unknown
  readonly error?: string
}

export interface OpenCodeSetModelInput {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly agentSdk?: OpenCodeAgentSdk
}

export interface OpenCodeSetModelPayload {
  readonly model: OpenCodeSetModelInput | null
}

export interface OpenCodeSetModelResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeModelInfoPayload {
  readonly worktreePath: string
  readonly modelId: string
  readonly agentSdk?: OpenCodeAgentSdk
}

export interface OpenCodeModelInfo {
  readonly id: string
  readonly name: string
  readonly limit: {
    readonly context: number
    readonly input?: number
    readonly output?: number
  }
}

export interface OpenCodeModelInfoResult {
  readonly success: boolean
  readonly model?: OpenCodeModelInfo
  readonly error?: string
}

export interface OpenCodeQuestionReplyPayload {
  readonly requestId: string
  readonly answers: string[][]
  readonly worktreePath?: string
}

export interface OpenCodeQuestionReplyResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeQuestionRejectPayload {
  readonly requestId: string
  readonly worktreePath?: string
}

export interface OpenCodeQuestionRejectResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodePlanApprovePayload {
  readonly worktreePath: string
  readonly hiveSessionId: string
  readonly requestId?: string
}

export interface OpenCodePlanApproveResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodePlanRejectPayload {
  readonly worktreePath: string
  readonly hiveSessionId: string
  readonly feedback: string
  readonly requestId?: string
}

export interface OpenCodePlanRejectResult {
  readonly success: boolean
  readonly error?: string
}

export type OpenCodePermissionDecision = 'once' | 'always' | 'reject'

export interface OpenCodePermissionReplyPayload {
  readonly requestId: string
  readonly reply: OpenCodePermissionDecision
  readonly worktreePath?: string
  readonly message?: string
}

export interface OpenCodePermissionReplyResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodePermissionListPayload {
  readonly worktreePath?: string
}

export interface OpenCodePermissionListResult {
  readonly success: boolean
  readonly permissions: unknown[]
  readonly error?: string
}

export interface OpenCodeCommandApprovalReplyPayload {
  readonly requestId: string
  readonly approved: boolean
  readonly remember?: 'allow' | 'block'
  readonly pattern?: string
  readonly worktreePath?: string
  readonly patterns?: string[]
}

export interface OpenCodeCommandApprovalReplyResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeSessionInfoPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeSessionInfoResult {
  readonly success: boolean
  readonly revertMessageID?: string | null
  readonly revertDiff?: string | null
  readonly error?: string
}

export interface OpenCodeUndoPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeUndoResult {
  readonly success: boolean
  readonly revertMessageID?: string
  readonly restoredPrompt?: string
  readonly revertDiff?: string | null
  readonly error?: string
}

export interface OpenCodeRedoPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
}

export interface OpenCodeRedoResult {
  readonly success: boolean
  readonly revertMessageID?: string | null
  readonly error?: string
}

export interface OpenCodeCommandPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
  readonly command: string
  readonly args: string
  readonly model?: OpenCodePromptModel
  readonly options?: OpenCodePromptOptions
}

export interface OpenCodeCommandResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeCommandsPayload {
  readonly worktreePath: string
  readonly sessionId?: string
}

export interface OpenCodeSlashCommand {
  readonly name: string
  readonly description?: string
  readonly template: string
  readonly agent?: string
  readonly model?: string
  readonly source?: string
  readonly path?: string
  readonly scope?: 'user' | 'repo' | 'system' | 'admin'
  readonly enabled?: boolean
  readonly subtask?: boolean
  readonly hints?: string[]
}

export interface OpenCodeCommandsResult {
  readonly success: boolean
  readonly commands: OpenCodeSlashCommand[]
  readonly error?: string
}

export interface OpenCodeRenameSessionPayload {
  readonly opencodeSessionId: string
  readonly title: string
  readonly worktreePath?: string
}

export interface OpenCodeRenameSessionResult {
  readonly success: boolean
  readonly error?: string
}

export interface OpenCodeCapabilitiesPayload {
  readonly sessionId?: string
}

export interface OpenCodeCapabilities {
  readonly supportsUndo: boolean
  readonly supportsRedo: boolean
  readonly supportsCommands: boolean
  readonly supportsPermissionRequests: boolean
  readonly supportsQuestionPrompts: boolean
  readonly supportsModelSelection: boolean
  readonly supportsReconnect: boolean
  readonly supportsPartialStreaming: boolean
  readonly supportsSteer: boolean
}

export interface OpenCodeCapabilitiesResult {
  readonly success: boolean
  readonly capabilities?: OpenCodeCapabilities | null
  readonly error?: string
}

export interface OpenCodeForkPayload {
  readonly worktreePath: string
  readonly opencodeSessionId: string
  readonly messageId?: string
}

export interface OpenCodeForkResult {
  readonly success: boolean
  readonly sessionId?: string
  readonly error?: string
}

export type DesktopCommandRequest =
  | QuitAppDesktopCommandRequest
  | ConfirmDesktopCommandRequest
  | ProjectOpenDirectoryDialogDesktopCommandRequest
  | ProjectShowInFolderDesktopCommandRequest
  | ProjectOpenPathDesktopCommandRequest
  | ProjectWriteClipboardTextDesktopCommandRequest
  | ProjectReadClipboardTextDesktopCommandRequest
  | ProjectPickProjectIconDesktopCommandRequest
  | ProjectRemoveProjectIconDesktopCommandRequest
  | ProjectGetProjectIconPathDesktopCommandRequest
  | GitShowInFinderDesktopCommandRequest
  | KanbanOpenBoardImportFileDialogDesktopCommandRequest
  | KanbanSaveBoardExportDialogDesktopCommandRequest
  | BackupOpenFileDialogDesktopCommandRequest
  | BackupSaveFileDialogDesktopCommandRequest
  | SystemGetAppVersionDesktopCommandRequest
  | SystemGetAppPathsDesktopCommandRequest
  | SystemIsPackagedDesktopCommandRequest
  | OpenInAppDesktopCommandRequest
  | OpenInChromeDesktopCommandRequest
  | UpdateMenuStateDesktopCommandRequest
  | SetKeepAwakeDesktopCommandRequest
  | SleepNowDesktopCommandRequest
  | SetSessionQueuedStateDesktopCommandRequest
  | UpdaterCheckForUpdateDesktopCommandRequest
  | UpdaterDownloadUpdateDesktopCommandRequest
  | UpdaterInstallUpdateDesktopCommandRequest
  | UpdaterSetChannelDesktopCommandRequest
  | UpdaterGetVersionDesktopCommandRequest
  | ShowPetDesktopCommandRequest
  | HidePetDesktopCommandRequest
  | PublishPetStatusDesktopCommandRequest
  | SetPetIgnoreMouseDesktopCommandRequest
  | BeginPetPointerInteractionDesktopCommandRequest
  | EndPetPointerInteractionDesktopCommandRequest
  | MovePetDesktopCommandRequest
  | FocusMainFromPetDesktopCommandRequest
  | GetPetConfigDesktopCommandRequest
  | GetCurrentPetStatusDesktopCommandRequest
  | UpdatePetSettingsDesktopCommandRequest
  | MarkPetHatchedDesktopCommandRequest
  | CreateResponseLogDesktopCommandRequest
  | AppendResponseLogDesktopCommandRequest
  | SaveAttachmentDesktopCommandRequest
  | DeleteAttachmentDesktopCommandRequest
  | SettingsOpenWithEditorDesktopCommandRequest
  | SettingsOpenWithTerminalDesktopCommandRequest
  | WatchFileTreeDesktopCommandRequest
  | UnwatchFileTreeDesktopCommandRequest
  | WatchGitWorktreeDesktopCommandRequest
  | UnwatchGitWorktreeDesktopCommandRequest
  | WatchGitBranchDesktopCommandRequest
  | UnwatchGitBranchDesktopCommandRequest
  | KillScriptDesktopCommandRequest
  | TerminalResizeDesktopCommandRequest
  | TerminalDestroyDesktopCommandRequest
  | TerminalWriteDesktopCommandRequest
  | TerminalCreateClaudeCliDesktopCommandRequest
  | RemoteLaunchClaudeTmuxDesktopCommandRequest
  | TerminalGhosttyInitDesktopCommandRequest
  | TerminalGhosttyIsAvailableDesktopCommandRequest
  | TerminalGhosttyCreateSurfaceDesktopCommandRequest
  | TerminalGhosttySetFrameDesktopCommandRequest
  | TerminalGhosttySetSizeDesktopCommandRequest
  | TerminalGhosttyKeyEventDesktopCommandRequest
  | TerminalGhosttyMouseButtonDesktopCommandRequest
  | TerminalGhosttyMousePosDesktopCommandRequest
  | TerminalGhosttyMouseScrollDesktopCommandRequest
  | TerminalGhosttySetFocusDesktopCommandRequest
  | TerminalGhosttyPasteTextDesktopCommandRequest
  | TerminalGhosttyFocusDiagnosticsDesktopCommandRequest
  | TerminalGhosttyDestroySurfaceDesktopCommandRequest
  | TerminalGhosttyShutdownDesktopCommandRequest
  | OpenCodeConnectDesktopCommandRequest
  | OpenCodeReconnectDesktopCommandRequest
  | OpenCodePromptDesktopCommandRequest
  | OpenCodeAbortDesktopCommandRequest
  | OpenCodeSteerDesktopCommandRequest
  | OpenCodeDisconnectDesktopCommandRequest
  | OpenCodeGetMessagesDesktopCommandRequest
  | OpenCodeRefreshFromThreadDesktopCommandRequest
  | OpenCodeListModelsDesktopCommandRequest
  | OpenCodeSetModelDesktopCommandRequest
  | OpenCodeModelInfoDesktopCommandRequest
  | OpenCodeQuestionReplyDesktopCommandRequest
  | OpenCodeQuestionRejectDesktopCommandRequest
  | OpenCodePlanApproveDesktopCommandRequest
  | OpenCodePlanRejectDesktopCommandRequest
  | OpenCodePermissionReplyDesktopCommandRequest
  | OpenCodePermissionListDesktopCommandRequest
  | OpenCodeCommandApprovalReplyDesktopCommandRequest
  | OpenCodeSessionInfoDesktopCommandRequest
  | OpenCodeUndoDesktopCommandRequest
  | OpenCodeRedoDesktopCommandRequest
  | OpenCodeCommandDesktopCommandRequest
  | OpenCodeCommandsDesktopCommandRequest
  | OpenCodeRenameSessionDesktopCommandRequest
  | OpenCodeCapabilitiesDesktopCommandRequest
  | OpenCodeForkDesktopCommandRequest
  | TelegramClaudeCliRegisterDesktopCommandRequest
  | TelegramClaudeCliCancelDesktopCommandRequest
  | TelegramClaudeCliQuestionReplyDesktopCommandRequest
  | TelegramClaudeCliQuestionRejectDesktopCommandRequest
  | TelegramClaudeCliPlanReplyDesktopCommandRequest
  | TerminalSetClaudeCliPlanAutoApproveDesktopCommandRequest

export interface QuitAppDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'quitApp'
}

export interface ConfirmDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'confirm'
  readonly payload: ConfirmPayload
}

export interface ProjectOpenDirectoryDialogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectOpenDirectoryDialog'
}

export interface ProjectShowInFolderDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectShowInFolder'
  readonly payload: ProjectShowInFolderPayload
}

export interface ProjectOpenPathDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectOpenPath'
  readonly payload: ProjectOpenPathPayload
}

export interface ProjectWriteClipboardTextDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectWriteClipboardText'
  readonly payload: ProjectWriteClipboardTextPayload
}

export interface ProjectReadClipboardTextDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectReadClipboardText'
}

export interface ProjectPickProjectIconDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectPickProjectIcon'
  readonly payload: ProjectPickProjectIconPayload
}

export interface ProjectRemoveProjectIconDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectRemoveProjectIcon'
  readonly payload: ProjectRemoveProjectIconPayload
}

export interface ProjectGetProjectIconPathDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'projectGetProjectIconPath'
  readonly payload: ProjectGetProjectIconPathPayload
}

export interface GitShowInFinderDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'gitShowInFinder'
  readonly payload: GitShowInFinderPayload
}

export interface KanbanOpenBoardImportFileDialogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'kanbanOpenBoardImportFileDialog'
}

export interface KanbanSaveBoardExportDialogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'kanbanSaveBoardExportDialog'
  readonly payload: KanbanSaveBoardExportDialogPayload
}

export interface BackupOpenFileDialogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'backupOpenFileDialog'
}

export interface BackupSaveFileDialogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'backupSaveFileDialog'
  readonly payload: BackupSaveFileDialogPayload
}

export interface SystemGetAppVersionDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'systemGetAppVersion'
}

export interface SystemGetAppPathsDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'systemGetAppPaths'
}

export interface SystemIsPackagedDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'systemIsPackaged'
}

export interface OpenInAppDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'openInApp'
  readonly payload: OpenInAppPayload
}

export interface OpenInChromeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'openInChrome'
  readonly payload: OpenInChromePayload
}

export interface UpdateMenuStateDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updateMenuState'
  readonly payload: UpdateMenuStatePayload
}

export interface SetKeepAwakeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'setKeepAwake'
  readonly payload: SetKeepAwakePayload
}

export interface SleepNowDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'sleepNow'
}

export interface SetSessionQueuedStateDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'setSessionQueuedState'
  readonly payload: SetSessionQueuedStatePayload
}

export interface UpdaterCheckForUpdateDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updaterCheckForUpdate'
  readonly payload: UpdaterCheckForUpdatePayload
}

export interface UpdaterDownloadUpdateDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updaterDownloadUpdate'
}

export interface UpdaterInstallUpdateDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updaterInstallUpdate'
}

export interface UpdaterSetChannelDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updaterSetChannel'
  readonly payload: UpdaterSetChannelPayload
}

export interface UpdaterGetVersionDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updaterGetVersion'
}

export interface ShowPetDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'showPet'
}

export interface HidePetDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'hidePet'
}

export interface PublishPetStatusDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'publishPetStatus'
  readonly payload: PublishPetStatusPayload
}

export interface SetPetIgnoreMouseDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'setPetIgnoreMouse'
  readonly payload: SetPetIgnoreMousePayload
}

export interface BeginPetPointerInteractionDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'beginPetPointerInteraction'
}

export interface EndPetPointerInteractionDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'endPetPointerInteraction'
}

export interface MovePetDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'movePet'
  readonly payload: MovePetPayload
}

export interface FocusMainFromPetDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'focusMainFromPet'
  readonly payload: FocusMainFromPetPayload
}

export interface GetPetConfigDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'getPetConfig'
}

export interface GetCurrentPetStatusDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'getCurrentPetStatus'
}

export interface UpdatePetSettingsDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'updatePetSettings'
  readonly payload: UpdatePetSettingsPayload
}

export interface MarkPetHatchedDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'markPetHatched'
}

export interface CreateResponseLogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'createResponseLog'
  readonly payload: CreateResponseLogPayload
}

export interface AppendResponseLogDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'appendResponseLog'
  readonly payload: AppendResponseLogPayload
}

export interface SaveAttachmentDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'saveAttachment'
  readonly payload: SaveAttachmentPayload
}

export interface DeleteAttachmentDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'deleteAttachment'
  readonly payload: DeleteAttachmentPayload
}

export interface SettingsOpenWithEditorDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'settingsOpenWithEditor'
  readonly payload: SettingsOpenWithEditorPayload
}

export interface SettingsOpenWithTerminalDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'settingsOpenWithTerminal'
  readonly payload: SettingsOpenWithTerminalPayload
}

export interface WatchFileTreeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'watchFileTree'
  readonly payload: WatchFileTreePayload
}

export interface UnwatchFileTreeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'unwatchFileTree'
  readonly payload: UnwatchFileTreePayload
}

export interface WatchGitWorktreeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'watchGitWorktree'
  readonly payload: WatchGitWorktreePayload
}

export interface UnwatchGitWorktreeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'unwatchGitWorktree'
  readonly payload: UnwatchGitWorktreePayload
}

export interface WatchGitBranchDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'watchGitBranch'
  readonly payload: WatchGitBranchPayload
}

export interface UnwatchGitBranchDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'unwatchGitBranch'
  readonly payload: UnwatchGitBranchPayload
}

export interface KillScriptDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'killScript'
  readonly payload: KillScriptPayload
}

export interface TerminalResizeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalResize'
  readonly payload: TerminalResizePayload
}

export interface TerminalDestroyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalDestroy'
  readonly payload: TerminalDestroyPayload
}

export interface TerminalWriteDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalWrite'
  readonly payload: TerminalWritePayload
}

export interface TerminalCreateClaudeCliDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalCreateClaudeCli'
  readonly payload: TerminalCreateClaudeCliPayload
}

export interface RemoteLaunchClaudeTmuxDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'remoteLaunchClaudeTmux'
  readonly payload: RemoteLaunchClaudeTmuxPayload
}

export interface TerminalGhosttyIsAvailableDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyIsAvailable'
}

export interface TerminalGhosttyInitDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyInit'
}

export interface TerminalGhosttyCreateSurfaceDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyCreateSurface'
  readonly payload: TerminalGhosttyCreateSurfacePayload
}

export interface TerminalGhosttySetFrameDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttySetFrame'
  readonly payload: TerminalGhosttySetFramePayload
}

export interface TerminalGhosttySetSizeDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttySetSize'
  readonly payload: TerminalGhosttySetSizePayload
}

export interface TerminalGhosttyKeyEventDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyKeyEvent'
  readonly payload: TerminalGhosttyKeyEventPayload
}

export interface TerminalGhosttyMouseButtonDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyMouseButton'
  readonly payload: TerminalGhosttyMouseButtonPayload
}

export interface TerminalGhosttyMousePosDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyMousePos'
  readonly payload: TerminalGhosttyMousePosPayload
}

export interface TerminalGhosttyMouseScrollDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyMouseScroll'
  readonly payload: TerminalGhosttyMouseScrollPayload
}

export interface TerminalGhosttySetFocusDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttySetFocus'
  readonly payload: TerminalGhosttySetFocusPayload
}

export interface TerminalGhosttyPasteTextDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyPasteText'
  readonly payload: TerminalGhosttyPasteTextPayload
}

export interface TerminalGhosttyFocusDiagnosticsDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyFocusDiagnostics'
}

export interface TerminalGhosttyDestroySurfaceDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyDestroySurface'
  readonly payload: TerminalGhosttyDestroySurfacePayload
}

export interface TerminalGhosttyShutdownDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalGhosttyShutdown'
}

export interface OpenCodeConnectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeConnect'
  readonly payload: OpenCodeConnectPayload
}

export interface OpenCodeReconnectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeReconnect'
  readonly payload: OpenCodeReconnectPayload
}

export interface OpenCodePromptDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodePrompt'
  readonly payload: OpenCodePromptPayload
}

export interface OpenCodeAbortDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeAbort'
  readonly payload: OpenCodeAbortPayload
}

export interface OpenCodeSteerDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeSteer'
  readonly payload: OpenCodeSteerPayload
}

export interface OpenCodeDisconnectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeDisconnect'
  readonly payload: OpenCodeDisconnectPayload
}

export interface OpenCodeGetMessagesDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeGetMessages'
  readonly payload: OpenCodeGetMessagesPayload
}

export interface OpenCodeRefreshFromThreadDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeRefreshFromThread'
  readonly payload: OpenCodeRefreshFromThreadPayload
}

export interface OpenCodeListModelsDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeListModels'
  readonly payload: OpenCodeListModelsPayload
}

export interface OpenCodeSetModelDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeSetModel'
  readonly payload: OpenCodeSetModelPayload
}

export interface OpenCodeModelInfoDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeModelInfo'
  readonly payload: OpenCodeModelInfoPayload
}

export interface OpenCodeQuestionReplyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeQuestionReply'
  readonly payload: OpenCodeQuestionReplyPayload
}

export interface OpenCodeQuestionRejectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeQuestionReject'
  readonly payload: OpenCodeQuestionRejectPayload
}

export interface OpenCodePlanApproveDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodePlanApprove'
  readonly payload: OpenCodePlanApprovePayload
}

export interface OpenCodePlanRejectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodePlanReject'
  readonly payload: OpenCodePlanRejectPayload
}

export interface OpenCodePermissionReplyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodePermissionReply'
  readonly payload: OpenCodePermissionReplyPayload
}

export interface OpenCodePermissionListDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodePermissionList'
  readonly payload: OpenCodePermissionListPayload
}

export interface OpenCodeCommandApprovalReplyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeCommandApprovalReply'
  readonly payload: OpenCodeCommandApprovalReplyPayload
}

export interface OpenCodeSessionInfoDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeSessionInfo'
  readonly payload: OpenCodeSessionInfoPayload
}

export interface OpenCodeUndoDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeUndo'
  readonly payload: OpenCodeUndoPayload
}

export interface OpenCodeRedoDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeRedo'
  readonly payload: OpenCodeRedoPayload
}

export interface OpenCodeCommandDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeCommand'
  readonly payload: OpenCodeCommandPayload
}

export interface OpenCodeCommandsDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeCommands'
  readonly payload: OpenCodeCommandsPayload
}

export interface OpenCodeRenameSessionDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeRenameSession'
  readonly payload: OpenCodeRenameSessionPayload
}

export interface OpenCodeCapabilitiesDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeCapabilities'
  readonly payload: OpenCodeCapabilitiesPayload
}

export interface OpenCodeForkDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'opencodeFork'
  readonly payload: OpenCodeForkPayload
}

export interface TelegramClaudeCliRegisterDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'telegramClaudeCliRegister'
  readonly payload: TelegramClaudeCliSessionPayload
}

export interface TelegramClaudeCliCancelDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'telegramClaudeCliCancel'
  readonly payload: TelegramClaudeCliSessionPayload
}

export interface TerminalSetClaudeCliPlanAutoApproveDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'terminalSetClaudeCliPlanAutoApprove'
  readonly payload: TerminalClaudeCliPlanAutoApprovePayload
}

export interface TelegramClaudeCliQuestionReplyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'telegramClaudeCliQuestionReply'
  readonly payload: TelegramClaudeCliQuestionReplyPayload
}

export interface TelegramClaudeCliQuestionRejectDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'telegramClaudeCliQuestionReject'
  readonly payload: TelegramClaudeCliQuestionRejectPayload
}

export interface TelegramClaudeCliPlanReplyDesktopCommandRequest {
  readonly type: typeof DESKTOP_COMMAND_REQUEST_TYPE
  readonly id: string
  readonly command: 'telegramClaudeCliPlanReply'
  readonly payload: TelegramClaudeCliPlanReplyPayload
}

export interface DesktopCommandResult {
  readonly type: typeof DESKTOP_COMMAND_RESULT_TYPE
  readonly id: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: string
}

export function makeDesktopCommandRequest(
  id: string,
  command: 'quitApp'
): QuitAppDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'confirm',
  payload: ConfirmPayload
): ConfirmDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectOpenDirectoryDialog'
): ProjectOpenDirectoryDialogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectShowInFolder',
  payload: ProjectShowInFolderPayload
): ProjectShowInFolderDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectOpenPath',
  payload: ProjectOpenPathPayload
): ProjectOpenPathDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectWriteClipboardText',
  payload: ProjectWriteClipboardTextPayload
): ProjectWriteClipboardTextDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectReadClipboardText'
): ProjectReadClipboardTextDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectPickProjectIcon',
  payload: ProjectPickProjectIconPayload
): ProjectPickProjectIconDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectRemoveProjectIcon',
  payload: ProjectRemoveProjectIconPayload
): ProjectRemoveProjectIconDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'projectGetProjectIconPath',
  payload: ProjectGetProjectIconPathPayload
): ProjectGetProjectIconPathDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'gitShowInFinder',
  payload: GitShowInFinderPayload
): GitShowInFinderDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'kanbanOpenBoardImportFileDialog'
): KanbanOpenBoardImportFileDialogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'kanbanSaveBoardExportDialog',
  payload: KanbanSaveBoardExportDialogPayload
): KanbanSaveBoardExportDialogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'backupOpenFileDialog'
): BackupOpenFileDialogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'backupSaveFileDialog',
  payload: BackupSaveFileDialogPayload
): BackupSaveFileDialogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'systemGetAppVersion'
): SystemGetAppVersionDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'systemGetAppPaths'
): SystemGetAppPathsDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'systemIsPackaged'
): SystemIsPackagedDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'openInApp',
  payload: OpenInAppPayload
): OpenInAppDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'openInChrome',
  payload: OpenInChromePayload
): OpenInChromeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updateMenuState',
  payload: UpdateMenuStatePayload
): UpdateMenuStateDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'setKeepAwake',
  payload: SetKeepAwakePayload
): SetKeepAwakeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'sleepNow'
): SleepNowDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'setSessionQueuedState',
  payload: SetSessionQueuedStatePayload
): SetSessionQueuedStateDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updaterCheckForUpdate',
  payload: UpdaterCheckForUpdatePayload
): UpdaterCheckForUpdateDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updaterDownloadUpdate'
): UpdaterDownloadUpdateDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updaterInstallUpdate'
): UpdaterInstallUpdateDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updaterSetChannel',
  payload: UpdaterSetChannelPayload
): UpdaterSetChannelDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updaterGetVersion'
): UpdaterGetVersionDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'showPet'
): ShowPetDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'hidePet'
): HidePetDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'publishPetStatus',
  payload: PublishPetStatusPayload
): PublishPetStatusDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'setPetIgnoreMouse',
  payload: SetPetIgnoreMousePayload
): SetPetIgnoreMouseDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'beginPetPointerInteraction'
): BeginPetPointerInteractionDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'endPetPointerInteraction'
): EndPetPointerInteractionDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'movePet',
  payload: MovePetPayload
): MovePetDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'focusMainFromPet',
  payload: FocusMainFromPetPayload
): FocusMainFromPetDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'getPetConfig'
): GetPetConfigDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'getCurrentPetStatus'
): GetCurrentPetStatusDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'updatePetSettings',
  payload: UpdatePetSettingsPayload
): UpdatePetSettingsDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'markPetHatched'
): MarkPetHatchedDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'createResponseLog',
  payload: CreateResponseLogPayload
): CreateResponseLogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'appendResponseLog',
  payload: AppendResponseLogPayload
): AppendResponseLogDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'saveAttachment',
  payload: SaveAttachmentPayload
): SaveAttachmentDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'deleteAttachment',
  payload: DeleteAttachmentPayload
): DeleteAttachmentDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'settingsOpenWithEditor',
  payload: SettingsOpenWithEditorPayload
): SettingsOpenWithEditorDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'settingsOpenWithTerminal',
  payload: SettingsOpenWithTerminalPayload
): SettingsOpenWithTerminalDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'watchFileTree',
  payload: WatchFileTreePayload
): WatchFileTreeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'unwatchFileTree',
  payload: UnwatchFileTreePayload
): UnwatchFileTreeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'watchGitWorktree',
  payload: WatchGitWorktreePayload
): WatchGitWorktreeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'unwatchGitWorktree',
  payload: UnwatchGitWorktreePayload
): UnwatchGitWorktreeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'watchGitBranch',
  payload: WatchGitBranchPayload
): WatchGitBranchDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'unwatchGitBranch',
  payload: UnwatchGitBranchPayload
): UnwatchGitBranchDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'killScript',
  payload: KillScriptPayload
): KillScriptDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalResize',
  payload: TerminalResizePayload
): TerminalResizeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalDestroy',
  payload: TerminalDestroyPayload
): TerminalDestroyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalWrite',
  payload: TerminalWritePayload
): TerminalWriteDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalCreateClaudeCli',
  payload: TerminalCreateClaudeCliPayload
): TerminalCreateClaudeCliDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'remoteLaunchClaudeTmux',
  payload: RemoteLaunchClaudeTmuxPayload
): RemoteLaunchClaudeTmuxDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyIsAvailable'
): TerminalGhosttyIsAvailableDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyInit'
): TerminalGhosttyInitDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyCreateSurface',
  payload: TerminalGhosttyCreateSurfacePayload
): TerminalGhosttyCreateSurfaceDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttySetFrame',
  payload: TerminalGhosttySetFramePayload
): TerminalGhosttySetFrameDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttySetSize',
  payload: TerminalGhosttySetSizePayload
): TerminalGhosttySetSizeDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyKeyEvent',
  payload: TerminalGhosttyKeyEventPayload
): TerminalGhosttyKeyEventDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyMouseButton',
  payload: TerminalGhosttyMouseButtonPayload
): TerminalGhosttyMouseButtonDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyMousePos',
  payload: TerminalGhosttyMousePosPayload
): TerminalGhosttyMousePosDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyMouseScroll',
  payload: TerminalGhosttyMouseScrollPayload
): TerminalGhosttyMouseScrollDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttySetFocus',
  payload: TerminalGhosttySetFocusPayload
): TerminalGhosttySetFocusDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyPasteText',
  payload: TerminalGhosttyPasteTextPayload
): TerminalGhosttyPasteTextDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyFocusDiagnostics'
): TerminalGhosttyFocusDiagnosticsDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyDestroySurface',
  payload: TerminalGhosttyDestroySurfacePayload
): TerminalGhosttyDestroySurfaceDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalGhosttyShutdown'
): TerminalGhosttyShutdownDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeConnect',
  payload: OpenCodeConnectPayload
): OpenCodeConnectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeReconnect',
  payload: OpenCodeReconnectPayload
): OpenCodeReconnectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodePrompt',
  payload: OpenCodePromptPayload
): OpenCodePromptDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeAbort',
  payload: OpenCodeAbortPayload
): OpenCodeAbortDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeSteer',
  payload: OpenCodeSteerPayload
): OpenCodeSteerDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeDisconnect',
  payload: OpenCodeDisconnectPayload
): OpenCodeDisconnectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeGetMessages',
  payload: OpenCodeGetMessagesPayload
): OpenCodeGetMessagesDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeRefreshFromThread',
  payload: OpenCodeRefreshFromThreadPayload
): OpenCodeRefreshFromThreadDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeListModels',
  payload: OpenCodeListModelsPayload
): OpenCodeListModelsDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeSetModel',
  payload: OpenCodeSetModelPayload
): OpenCodeSetModelDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeModelInfo',
  payload: OpenCodeModelInfoPayload
): OpenCodeModelInfoDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeQuestionReply',
  payload: OpenCodeQuestionReplyPayload
): OpenCodeQuestionReplyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeQuestionReject',
  payload: OpenCodeQuestionRejectPayload
): OpenCodeQuestionRejectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodePlanApprove',
  payload: OpenCodePlanApprovePayload
): OpenCodePlanApproveDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodePlanReject',
  payload: OpenCodePlanRejectPayload
): OpenCodePlanRejectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodePermissionReply',
  payload: OpenCodePermissionReplyPayload
): OpenCodePermissionReplyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodePermissionList',
  payload: OpenCodePermissionListPayload
): OpenCodePermissionListDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeCommandApprovalReply',
  payload: OpenCodeCommandApprovalReplyPayload
): OpenCodeCommandApprovalReplyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeSessionInfo',
  payload: OpenCodeSessionInfoPayload
): OpenCodeSessionInfoDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeUndo',
  payload: OpenCodeUndoPayload
): OpenCodeUndoDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeRedo',
  payload: OpenCodeRedoPayload
): OpenCodeRedoDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeCommand',
  payload: OpenCodeCommandPayload
): OpenCodeCommandDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeCommands',
  payload: OpenCodeCommandsPayload
): OpenCodeCommandsDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeRenameSession',
  payload: OpenCodeRenameSessionPayload
): OpenCodeRenameSessionDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeCapabilities',
  payload: OpenCodeCapabilitiesPayload
): OpenCodeCapabilitiesDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'opencodeFork',
  payload: OpenCodeForkPayload
): OpenCodeForkDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'telegramClaudeCliRegister',
  payload: TelegramClaudeCliSessionPayload
): TelegramClaudeCliRegisterDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'telegramClaudeCliCancel',
  payload: TelegramClaudeCliSessionPayload
): TelegramClaudeCliCancelDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'telegramClaudeCliQuestionReply',
  payload: TelegramClaudeCliQuestionReplyPayload
): TelegramClaudeCliQuestionReplyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'telegramClaudeCliQuestionReject',
  payload: TelegramClaudeCliQuestionRejectPayload
): TelegramClaudeCliQuestionRejectDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'telegramClaudeCliPlanReply',
  payload: TelegramClaudeCliPlanReplyPayload
): TelegramClaudeCliPlanReplyDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: 'terminalSetClaudeCliPlanAutoApprove',
  payload: TerminalClaudeCliPlanAutoApprovePayload
): TerminalSetClaudeCliPlanAutoApproveDesktopCommandRequest
export function makeDesktopCommandRequest(
  id: string,
  command: DesktopCommandName,
  payload?:
    | OpenInAppPayload
    | ConfirmPayload
    | ProjectShowInFolderPayload
    | ProjectOpenPathPayload
    | ProjectWriteClipboardTextPayload
    | ProjectPickProjectIconPayload
    | ProjectRemoveProjectIconPayload
    | ProjectGetProjectIconPathPayload
    | GitShowInFinderPayload
    | KanbanSaveBoardExportDialogPayload
    | BackupSaveFileDialogPayload
    | OpenInChromePayload
    | UpdateMenuStatePayload
    | SetKeepAwakePayload
    | SetSessionQueuedStatePayload
    | UpdaterCheckForUpdatePayload
    | UpdaterSetChannelPayload
    | PublishPetStatusPayload
    | SetPetIgnoreMousePayload
    | MovePetPayload
    | FocusMainFromPetPayload
    | UpdatePetSettingsPayload
    | CreateResponseLogPayload
    | AppendResponseLogPayload
    | SaveAttachmentPayload
    | DeleteAttachmentPayload
    | SettingsOpenWithEditorPayload
    | SettingsOpenWithTerminalPayload
    | WatchFileTreePayload
    | UnwatchFileTreePayload
    | WatchGitWorktreePayload
    | UnwatchGitWorktreePayload
    | WatchGitBranchPayload
    | UnwatchGitBranchPayload
    | KillScriptPayload
    | TerminalResizePayload
    | TerminalDestroyPayload
    | TerminalWritePayload
    | TerminalCreateClaudeCliPayload
    | TerminalGhosttyCreateSurfacePayload
    | TerminalGhosttySetFramePayload
    | TerminalGhosttySetSizePayload
    | TerminalGhosttyKeyEventPayload
    | TerminalGhosttyMouseButtonPayload
    | TerminalGhosttyMousePosPayload
    | TerminalGhosttyMouseScrollPayload
    | TerminalGhosttySetFocusPayload
    | TerminalGhosttyPasteTextPayload
    | TerminalGhosttyDestroySurfacePayload
    | OpenCodeConnectPayload
    | OpenCodeReconnectPayload
    | OpenCodePromptPayload
    | OpenCodeAbortPayload
    | OpenCodeSteerPayload
    | OpenCodeDisconnectPayload
    | OpenCodeGetMessagesPayload
    | OpenCodeRefreshFromThreadPayload
    | OpenCodeListModelsPayload
    | OpenCodeSetModelPayload
    | OpenCodeModelInfoPayload
    | OpenCodeQuestionReplyPayload
    | OpenCodeQuestionRejectPayload
    | OpenCodePlanApprovePayload
    | OpenCodePlanRejectPayload
    | OpenCodePermissionReplyPayload
    | OpenCodePermissionListPayload
    | OpenCodeCommandApprovalReplyPayload
    | OpenCodeSessionInfoPayload
    | OpenCodeUndoPayload
    | OpenCodeRedoPayload
    | OpenCodeCommandPayload
    | OpenCodeCommandsPayload
    | OpenCodeRenameSessionPayload
    | OpenCodeCapabilitiesPayload
    | OpenCodeForkPayload
    | TelegramClaudeCliSessionPayload
    | TelegramClaudeCliQuestionReplyPayload
    | TelegramClaudeCliQuestionRejectPayload
    | TelegramClaudeCliPlanReplyPayload
): DesktopCommandRequest {
  if (command === 'projectShowInFolder') {
    if (!payload) {
      throw new Error('Missing projectShowInFolder payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectShowInFolderDesktopCommandRequest
  }

  if (command === 'projectOpenPath') {
    if (!payload) {
      throw new Error('Missing projectOpenPath payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectOpenPathDesktopCommandRequest
  }

  if (command === 'projectWriteClipboardText') {
    if (!payload) {
      throw new Error('Missing projectWriteClipboardText payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectWriteClipboardTextDesktopCommandRequest
  }

  if (command === 'projectPickProjectIcon') {
    if (!payload) {
      throw new Error('Missing projectPickProjectIcon payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectPickProjectIconDesktopCommandRequest
  }

  if (command === 'projectRemoveProjectIcon') {
    if (!payload) {
      throw new Error('Missing projectRemoveProjectIcon payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectRemoveProjectIconDesktopCommandRequest
  }

  if (command === 'projectGetProjectIconPath') {
    if (!payload) {
      throw new Error('Missing projectGetProjectIconPath payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ProjectGetProjectIconPathDesktopCommandRequest
  }

  if (command === 'gitShowInFinder') {
    if (!payload) {
      throw new Error('Missing gitShowInFinder payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as GitShowInFinderDesktopCommandRequest
  }

  if (command === 'kanbanSaveBoardExportDialog') {
    if (!payload) {
      throw new Error('Missing kanbanSaveBoardExportDialog payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as KanbanSaveBoardExportDialogDesktopCommandRequest
  }

  if (command === 'backupSaveFileDialog') {
    if (!payload) {
      throw new Error('Missing backupSaveFileDialog payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as BackupSaveFileDialogDesktopCommandRequest
  }

  if (command === 'systemGetAppVersion') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as SystemGetAppVersionDesktopCommandRequest
  }

  if (command === 'systemGetAppPaths') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as SystemGetAppPathsDesktopCommandRequest
  }

  if (command === 'systemIsPackaged') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as SystemIsPackagedDesktopCommandRequest
  }

  if (command === 'confirm') {
    if (!payload) {
      throw new Error('Missing confirm payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as ConfirmDesktopCommandRequest
  }

  if (command === 'openInApp') {
    if (!payload) {
      throw new Error('Missing openInApp payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload: payload as OpenInAppPayload
    }
  }

  if (command === 'openInChrome') {
    if (!payload) {
      throw new Error('Missing openInChrome payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenInChromeDesktopCommandRequest
  }

  if (command === 'updateMenuState') {
    if (!payload) {
      throw new Error('Missing updateMenuState payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UpdateMenuStateDesktopCommandRequest
  }

  if (command === 'setKeepAwake') {
    if (!payload) {
      throw new Error('Missing setKeepAwake payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SetKeepAwakeDesktopCommandRequest
  }

  if (command === 'setSessionQueuedState') {
    if (!payload) {
      throw new Error('Missing setSessionQueuedState payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SetSessionQueuedStateDesktopCommandRequest
  }

  if (command === 'updaterCheckForUpdate') {
    if (!payload) {
      throw new Error('Missing updaterCheckForUpdate payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UpdaterCheckForUpdateDesktopCommandRequest
  }

  if (command === 'updaterDownloadUpdate') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as UpdaterDownloadUpdateDesktopCommandRequest
  }

  if (command === 'updaterInstallUpdate') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as UpdaterInstallUpdateDesktopCommandRequest
  }

  if (command === 'updaterSetChannel') {
    if (!payload) {
      throw new Error('Missing updaterSetChannel payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UpdaterSetChannelDesktopCommandRequest
  }

  if (command === 'updaterGetVersion') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as UpdaterGetVersionDesktopCommandRequest
  }

  if (command === 'publishPetStatus') {
    if (!payload) {
      throw new Error('Missing publishPetStatus payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as PublishPetStatusDesktopCommandRequest
  }

  if (command === 'setPetIgnoreMouse') {
    if (!payload) {
      throw new Error('Missing setPetIgnoreMouse payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SetPetIgnoreMouseDesktopCommandRequest
  }

  if (command === 'movePet') {
    if (!payload) {
      throw new Error('Missing movePet payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as MovePetDesktopCommandRequest
  }

  if (command === 'focusMainFromPet') {
    if (!payload) {
      throw new Error('Missing focusMainFromPet payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as FocusMainFromPetDesktopCommandRequest
  }

  if (command === 'updatePetSettings') {
    if (!payload) {
      throw new Error('Missing updatePetSettings payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UpdatePetSettingsDesktopCommandRequest
  }

  if (command === 'createResponseLog') {
    if (!payload) {
      throw new Error('Missing createResponseLog payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as CreateResponseLogDesktopCommandRequest
  }

  if (command === 'appendResponseLog') {
    if (!payload) {
      throw new Error('Missing appendResponseLog payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as AppendResponseLogDesktopCommandRequest
  }

  if (command === 'saveAttachment') {
    if (!payload) {
      throw new Error('Missing saveAttachment payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SaveAttachmentDesktopCommandRequest
  }

  if (command === 'deleteAttachment') {
    if (!payload) {
      throw new Error('Missing deleteAttachment payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as DeleteAttachmentDesktopCommandRequest
  }

  if (command === 'settingsOpenWithEditor') {
    if (!payload) {
      throw new Error('Missing settingsOpenWithEditor payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SettingsOpenWithEditorDesktopCommandRequest
  }

  if (command === 'settingsOpenWithTerminal') {
    if (!payload) {
      throw new Error('Missing settingsOpenWithTerminal payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as SettingsOpenWithTerminalDesktopCommandRequest
  }

  if (command === 'watchFileTree') {
    if (!payload) {
      throw new Error('Missing watchFileTree payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as WatchFileTreeDesktopCommandRequest
  }

  if (command === 'unwatchFileTree') {
    if (!payload) {
      throw new Error('Missing unwatchFileTree payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UnwatchFileTreeDesktopCommandRequest
  }

  if (command === 'watchGitWorktree') {
    if (!payload) {
      throw new Error('Missing watchGitWorktree payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as WatchGitWorktreeDesktopCommandRequest
  }

  if (command === 'unwatchGitWorktree') {
    if (!payload) {
      throw new Error('Missing unwatchGitWorktree payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UnwatchGitWorktreeDesktopCommandRequest
  }

  if (command === 'watchGitBranch') {
    if (!payload) {
      throw new Error('Missing watchGitBranch payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as WatchGitBranchDesktopCommandRequest
  }

  if (command === 'unwatchGitBranch') {
    if (!payload) {
      throw new Error('Missing unwatchGitBranch payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as UnwatchGitBranchDesktopCommandRequest
  }

  if (command === 'killScript') {
    if (!payload) {
      throw new Error('Missing killScript payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as KillScriptDesktopCommandRequest
  }

  if (command === 'terminalResize') {
    if (!payload) {
      throw new Error('Missing terminalResize payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalResizeDesktopCommandRequest
  }

  if (command === 'terminalDestroy') {
    if (!payload) {
      throw new Error('Missing terminalDestroy payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalDestroyDesktopCommandRequest
  }

  if (command === 'terminalWrite') {
    if (!payload) {
      throw new Error('Missing terminalWrite payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalWriteDesktopCommandRequest
  }

  if (command === 'terminalCreateClaudeCli') {
    if (!payload) {
      throw new Error('Missing terminalCreateClaudeCli payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalCreateClaudeCliDesktopCommandRequest
  }

  if (command === 'remoteLaunchClaudeTmux') {
    if (!payload) {
      throw new Error('Missing remoteLaunchClaudeTmux payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as RemoteLaunchClaudeTmuxDesktopCommandRequest
  }

  if (command === 'terminalGhosttyIsAvailable') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as TerminalGhosttyIsAvailableDesktopCommandRequest
  }

  if (command === 'terminalGhosttyInit') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as TerminalGhosttyInitDesktopCommandRequest
  }

  if (command === 'terminalGhosttyCreateSurface') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyCreateSurface payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyCreateSurfaceDesktopCommandRequest
  }

  if (command === 'terminalGhosttySetFrame') {
    if (!payload) {
      throw new Error('Missing terminalGhosttySetFrame payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttySetFrameDesktopCommandRequest
  }

  if (command === 'terminalGhosttySetSize') {
    if (!payload) {
      throw new Error('Missing terminalGhosttySetSize payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttySetSizeDesktopCommandRequest
  }

  if (command === 'terminalGhosttyKeyEvent') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyKeyEvent payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyKeyEventDesktopCommandRequest
  }

  if (command === 'terminalGhosttyMouseButton') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyMouseButton payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyMouseButtonDesktopCommandRequest
  }

  if (command === 'terminalGhosttyMousePos') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyMousePos payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyMousePosDesktopCommandRequest
  }

  if (command === 'terminalGhosttyMouseScroll') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyMouseScroll payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyMouseScrollDesktopCommandRequest
  }

  if (command === 'terminalGhosttySetFocus') {
    if (!payload) {
      throw new Error('Missing terminalGhosttySetFocus payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttySetFocusDesktopCommandRequest
  }

  if (command === 'terminalGhosttyPasteText') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyPasteText payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyPasteTextDesktopCommandRequest
  }

  if (command === 'terminalGhosttyFocusDiagnostics') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as TerminalGhosttyFocusDiagnosticsDesktopCommandRequest
  }

  if (command === 'terminalGhosttyDestroySurface') {
    if (!payload) {
      throw new Error('Missing terminalGhosttyDestroySurface payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalGhosttyDestroySurfaceDesktopCommandRequest
  }

  if (command === 'terminalGhosttyShutdown') {
    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command
    } as TerminalGhosttyShutdownDesktopCommandRequest
  }

  if (command === 'opencodeConnect') {
    if (!payload) {
      throw new Error('Missing opencodeConnect payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeConnectDesktopCommandRequest
  }

  if (command === 'opencodeReconnect') {
    if (!payload) {
      throw new Error('Missing opencodeReconnect payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeReconnectDesktopCommandRequest
  }

  if (command === 'opencodePrompt') {
    if (!payload) {
      throw new Error('Missing opencodePrompt payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodePromptDesktopCommandRequest
  }

  if (command === 'opencodeAbort') {
    if (!payload) {
      throw new Error('Missing opencodeAbort payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeAbortDesktopCommandRequest
  }

  if (command === 'opencodeSteer') {
    if (!payload) {
      throw new Error('Missing opencodeSteer payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeSteerDesktopCommandRequest
  }

  if (command === 'opencodeDisconnect') {
    if (!payload) {
      throw new Error('Missing opencodeDisconnect payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeDisconnectDesktopCommandRequest
  }

  if (command === 'opencodeGetMessages') {
    if (!payload) {
      throw new Error('Missing opencodeGetMessages payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeGetMessagesDesktopCommandRequest
  }

  if (command === 'opencodeRefreshFromThread') {
    if (!payload) {
      throw new Error('Missing opencodeRefreshFromThread payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeRefreshFromThreadDesktopCommandRequest
  }

  if (command === 'opencodeListModels') {
    if (!payload) {
      throw new Error('Missing opencodeListModels payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeListModelsDesktopCommandRequest
  }

  if (command === 'opencodeSetModel') {
    if (!payload) {
      throw new Error('Missing opencodeSetModel payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeSetModelDesktopCommandRequest
  }

  if (command === 'opencodeModelInfo') {
    if (!payload) {
      throw new Error('Missing opencodeModelInfo payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeModelInfoDesktopCommandRequest
  }

  if (command === 'opencodeQuestionReply') {
    if (!payload) {
      throw new Error('Missing opencodeQuestionReply payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeQuestionReplyDesktopCommandRequest
  }

  if (command === 'opencodeQuestionReject') {
    if (!payload) {
      throw new Error('Missing opencodeQuestionReject payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeQuestionRejectDesktopCommandRequest
  }

  if (command === 'opencodePlanApprove') {
    if (!payload) {
      throw new Error('Missing opencodePlanApprove payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodePlanApproveDesktopCommandRequest
  }

  if (command === 'opencodePlanReject') {
    if (!payload) {
      throw new Error('Missing opencodePlanReject payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodePlanRejectDesktopCommandRequest
  }

  if (command === 'opencodePermissionReply') {
    if (!payload) {
      throw new Error('Missing opencodePermissionReply payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodePermissionReplyDesktopCommandRequest
  }

  if (command === 'opencodePermissionList') {
    if (!payload) {
      throw new Error('Missing opencodePermissionList payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodePermissionListDesktopCommandRequest
  }

  if (command === 'opencodeCommandApprovalReply') {
    if (!payload) {
      throw new Error('Missing opencodeCommandApprovalReply payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeCommandApprovalReplyDesktopCommandRequest
  }

  if (command === 'opencodeSessionInfo') {
    if (!payload) {
      throw new Error('Missing opencodeSessionInfo payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeSessionInfoDesktopCommandRequest
  }

  if (command === 'opencodeUndo') {
    if (!payload) {
      throw new Error('Missing opencodeUndo payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeUndoDesktopCommandRequest
  }

  if (command === 'opencodeRedo') {
    if (!payload) {
      throw new Error('Missing opencodeRedo payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeRedoDesktopCommandRequest
  }

  if (command === 'opencodeCommand') {
    if (!payload) {
      throw new Error('Missing opencodeCommand payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeCommandDesktopCommandRequest
  }

  if (command === 'opencodeCommands') {
    if (!payload) {
      throw new Error('Missing opencodeCommands payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeCommandsDesktopCommandRequest
  }

  if (command === 'opencodeRenameSession') {
    if (!payload) {
      throw new Error('Missing opencodeRenameSession payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeRenameSessionDesktopCommandRequest
  }

  if (command === 'opencodeCapabilities') {
    if (!payload) {
      throw new Error('Missing opencodeCapabilities payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeCapabilitiesDesktopCommandRequest
  }

  if (command === 'opencodeFork') {
    if (!payload) {
      throw new Error('Missing opencodeFork payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as OpenCodeForkDesktopCommandRequest
  }

  if (command === 'telegramClaudeCliRegister' || command === 'telegramClaudeCliCancel') {
    if (!payload) {
      throw new Error(`Missing ${command} payload`)
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TelegramClaudeCliRegisterDesktopCommandRequest | TelegramClaudeCliCancelDesktopCommandRequest
  }

  if (command === 'telegramClaudeCliQuestionReply') {
    if (!payload) {
      throw new Error('Missing telegramClaudeCliQuestionReply payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TelegramClaudeCliQuestionReplyDesktopCommandRequest
  }

  if (command === 'telegramClaudeCliQuestionReject') {
    if (!payload) {
      throw new Error('Missing telegramClaudeCliQuestionReject payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TelegramClaudeCliQuestionRejectDesktopCommandRequest
  }

  if (command === 'telegramClaudeCliPlanReply') {
    if (!payload) {
      throw new Error('Missing telegramClaudeCliPlanReply payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TelegramClaudeCliPlanReplyDesktopCommandRequest
  }

  if (command === 'terminalSetClaudeCliPlanAutoApprove') {
    if (!payload) {
      throw new Error('Missing terminalSetClaudeCliPlanAutoApprove payload')
    }

    return {
      type: DESKTOP_COMMAND_REQUEST_TYPE,
      id,
      command,
      payload
    } as TerminalSetClaudeCliPlanAutoApproveDesktopCommandRequest
  }

  return {
    type: DESKTOP_COMMAND_REQUEST_TYPE,
    id,
    command
  }
}

export const makeDesktopCommandResult = (
  id: string,
  result:
    | { readonly ok: true; readonly value?: unknown }
    | { readonly ok: false; readonly error: string }
): DesktopCommandResult => ({
  type: DESKTOP_COMMAND_RESULT_TYPE,
  id,
  ...result
})

export const isDesktopCommandRequest = (value: unknown): value is DesktopCommandRequest => {
  if (!isRecord(value)) return false
  return (
    value.type === DESKTOP_COMMAND_REQUEST_TYPE &&
    typeof value.id === 'string' &&
    (value.command === 'quitApp' ||
      (value.command === 'confirm' && isConfirmPayload(value.payload)) ||
      value.command === 'projectOpenDirectoryDialog' ||
      (value.command === 'projectShowInFolder' && isProjectShowInFolderPayload(value.payload)) ||
      (value.command === 'projectOpenPath' && isProjectOpenPathPayload(value.payload)) ||
      (value.command === 'projectWriteClipboardText' &&
        isProjectWriteClipboardTextPayload(value.payload)) ||
      value.command === 'projectReadClipboardText' ||
      (value.command === 'projectPickProjectIcon' &&
        isProjectPickProjectIconPayload(value.payload)) ||
      (value.command === 'projectRemoveProjectIcon' &&
        isProjectRemoveProjectIconPayload(value.payload)) ||
      (value.command === 'projectGetProjectIconPath' &&
        isProjectGetProjectIconPathPayload(value.payload)) ||
      (value.command === 'gitShowInFinder' && isGitShowInFinderPayload(value.payload)) ||
      value.command === 'kanbanOpenBoardImportFileDialog' ||
      (value.command === 'kanbanSaveBoardExportDialog' &&
        isKanbanSaveBoardExportDialogPayload(value.payload)) ||
      value.command === 'backupOpenFileDialog' ||
      (value.command === 'backupSaveFileDialog' &&
        isBackupSaveFileDialogPayload(value.payload)) ||
      value.command === 'systemGetAppVersion' ||
      value.command === 'systemGetAppPaths' ||
      value.command === 'systemIsPackaged' ||
      (value.command === 'openInApp' && isOpenInAppPayload(value.payload)) ||
      (value.command === 'openInChrome' && isOpenInChromePayload(value.payload)) ||
      (value.command === 'updateMenuState' && isUpdateMenuStatePayload(value.payload)) ||
      (value.command === 'setKeepAwake' && isSetKeepAwakePayload(value.payload)) ||
      value.command === 'sleepNow' ||
      (value.command === 'setSessionQueuedState' &&
        isSetSessionQueuedStatePayload(value.payload)) ||
      (value.command === 'updaterCheckForUpdate' &&
        isUpdaterCheckForUpdatePayload(value.payload)) ||
      value.command === 'updaterDownloadUpdate' ||
      value.command === 'updaterInstallUpdate' ||
      (value.command === 'updaterSetChannel' && isUpdaterSetChannelPayload(value.payload)) ||
      value.command === 'updaterGetVersion' ||
      value.command === 'showPet' ||
      value.command === 'hidePet' ||
      (value.command === 'publishPetStatus' && isPublishPetStatusPayload(value.payload)) ||
      (value.command === 'setPetIgnoreMouse' && isSetPetIgnoreMousePayload(value.payload)) ||
      value.command === 'beginPetPointerInteraction' ||
      value.command === 'endPetPointerInteraction' ||
      (value.command === 'movePet' && isMovePetPayload(value.payload)) ||
      (value.command === 'focusMainFromPet' && isFocusMainFromPetPayload(value.payload)) ||
      value.command === 'getPetConfig' ||
      value.command === 'getCurrentPetStatus' ||
      (value.command === 'updatePetSettings' && isUpdatePetSettingsPayload(value.payload)) ||
      value.command === 'markPetHatched' ||
      (value.command === 'createResponseLog' && isCreateResponseLogPayload(value.payload)) ||
      (value.command === 'appendResponseLog' && isAppendResponseLogPayload(value.payload)) ||
      (value.command === 'saveAttachment' && isSaveAttachmentPayload(value.payload)) ||
      (value.command === 'deleteAttachment' && isDeleteAttachmentPayload(value.payload)) ||
      (value.command === 'settingsOpenWithEditor' &&
        isSettingsOpenWithEditorPayload(value.payload)) ||
      (value.command === 'settingsOpenWithTerminal' &&
        isSettingsOpenWithTerminalPayload(value.payload)) ||
      (value.command === 'watchFileTree' && isWatchFileTreePayload(value.payload)) ||
      (value.command === 'unwatchFileTree' && isUnwatchFileTreePayload(value.payload)) ||
      (value.command === 'watchGitWorktree' && isWatchGitWorktreePayload(value.payload)) ||
      (value.command === 'unwatchGitWorktree' && isUnwatchGitWorktreePayload(value.payload)) ||
      (value.command === 'watchGitBranch' && isWatchGitBranchPayload(value.payload)) ||
      (value.command === 'unwatchGitBranch' && isUnwatchGitBranchPayload(value.payload)) ||
      (value.command === 'killScript' && isKillScriptPayload(value.payload)) ||
      (value.command === 'terminalResize' && isTerminalResizePayload(value.payload)) ||
      (value.command === 'terminalDestroy' && isTerminalDestroyPayload(value.payload)) ||
      (value.command === 'terminalWrite' && isTerminalWritePayload(value.payload)) ||
      (value.command === 'terminalCreateClaudeCli' &&
        isTerminalCreateClaudeCliPayload(value.payload)) ||
      (value.command === 'remoteLaunchClaudeTmux' &&
        isRemoteLaunchClaudeTmuxPayload(value.payload)) ||
      value.command === 'terminalGhosttyInit' ||
      value.command === 'terminalGhosttyIsAvailable' ||
      (value.command === 'terminalGhosttyCreateSurface' &&
        isTerminalGhosttyCreateSurfacePayload(value.payload)) ||
      (value.command === 'terminalGhosttySetFrame' &&
        isTerminalGhosttySetFramePayload(value.payload)) ||
      (value.command === 'terminalGhosttySetSize' &&
        isTerminalGhosttySetSizePayload(value.payload)) ||
      (value.command === 'terminalGhosttyKeyEvent' &&
        isTerminalGhosttyKeyEventPayload(value.payload)) ||
      (value.command === 'terminalGhosttyMouseButton' &&
        isTerminalGhosttyMouseButtonPayload(value.payload)) ||
      (value.command === 'terminalGhosttyMousePos' &&
        isTerminalGhosttyMousePosPayload(value.payload)) ||
      (value.command === 'terminalGhosttyMouseScroll' &&
        isTerminalGhosttyMouseScrollPayload(value.payload)) ||
      (value.command === 'terminalGhosttySetFocus' &&
        isTerminalGhosttySetFocusPayload(value.payload)) ||
      (value.command === 'terminalGhosttyPasteText' &&
        isTerminalGhosttyPasteTextPayload(value.payload)) ||
      value.command === 'terminalGhosttyFocusDiagnostics' ||
      (value.command === 'terminalGhosttyDestroySurface' &&
        isTerminalGhosttyDestroySurfacePayload(value.payload)) ||
      value.command === 'terminalGhosttyShutdown' ||
      (value.command === 'opencodeConnect' && isOpenCodeConnectPayload(value.payload)) ||
      (value.command === 'opencodeReconnect' && isOpenCodeReconnectPayload(value.payload)) ||
      (value.command === 'opencodePrompt' && isOpenCodePromptPayload(value.payload)) ||
      (value.command === 'opencodeAbort' && isOpenCodeAbortPayload(value.payload)) ||
      (value.command === 'opencodeSteer' && isOpenCodeSteerPayload(value.payload)) ||
      (value.command === 'opencodeDisconnect' && isOpenCodeDisconnectPayload(value.payload)) ||
      (value.command === 'opencodeGetMessages' && isOpenCodeGetMessagesPayload(value.payload)) ||
      (value.command === 'opencodeRefreshFromThread' &&
        isOpenCodeRefreshFromThreadPayload(value.payload)) ||
      (value.command === 'opencodeListModels' && isOpenCodeListModelsPayload(value.payload)) ||
      (value.command === 'opencodeSetModel' && isOpenCodeSetModelPayload(value.payload)) ||
      (value.command === 'opencodeModelInfo' && isOpenCodeModelInfoPayload(value.payload)) ||
      (value.command === 'opencodeQuestionReply' &&
        isOpenCodeQuestionReplyPayload(value.payload)) ||
      (value.command === 'opencodeQuestionReject' &&
        isOpenCodeQuestionRejectPayload(value.payload)) ||
      (value.command === 'opencodePlanApprove' && isOpenCodePlanApprovePayload(value.payload)) ||
      (value.command === 'opencodePlanReject' && isOpenCodePlanRejectPayload(value.payload)) ||
      (value.command === 'opencodePermissionReply' &&
        isOpenCodePermissionReplyPayload(value.payload)) ||
      (value.command === 'opencodePermissionList' &&
        isOpenCodePermissionListPayload(value.payload)) ||
      (value.command === 'opencodeCommandApprovalReply' &&
        isOpenCodeCommandApprovalReplyPayload(value.payload)) ||
      (value.command === 'opencodeSessionInfo' && isOpenCodeSessionInfoPayload(value.payload)) ||
      (value.command === 'opencodeUndo' && isOpenCodeUndoPayload(value.payload)) ||
      (value.command === 'opencodeRedo' && isOpenCodeRedoPayload(value.payload)) ||
      (value.command === 'opencodeCommand' && isOpenCodeCommandPayload(value.payload)) ||
      (value.command === 'opencodeCommands' && isOpenCodeCommandsPayload(value.payload)) ||
      (value.command === 'opencodeRenameSession' &&
        isOpenCodeRenameSessionPayload(value.payload)) ||
      (value.command === 'opencodeCapabilities' && isOpenCodeCapabilitiesPayload(value.payload)) ||
      (value.command === 'opencodeFork' && isOpenCodeForkPayload(value.payload)) ||
      ((value.command === 'telegramClaudeCliRegister' ||
        value.command === 'telegramClaudeCliCancel') &&
        isTelegramClaudeCliSessionPayload(value.payload)) ||
      (value.command === 'telegramClaudeCliQuestionReply' &&
        isTelegramClaudeCliQuestionReplyPayload(value.payload)) ||
      (value.command === 'telegramClaudeCliQuestionReject' &&
        isTelegramClaudeCliQuestionRejectPayload(value.payload)) ||
      (value.command === 'telegramClaudeCliPlanReply' &&
        isTelegramClaudeCliPlanReplyPayload(value.payload)) ||
      (value.command === 'terminalSetClaudeCliPlanAutoApprove' &&
        isTerminalClaudeCliPlanAutoApprovePayload(value.payload)))
  )
}

export const isDesktopCommandResult = (value: unknown): value is DesktopCommandResult => {
  if (!isRecord(value)) return false
  return (
    value.type === DESKTOP_COMMAND_RESULT_TYPE &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  )
}

/**
 * Fire-and-forget event pushed from the desktop (Electron main) to the server
 * child over the Node IPC channel, to be forwarded into the server's event bus
 * and fanned out to WebSocket subscribers. Unlike DesktopCommandRequest/Result
 * this has no `id` and expects no response — it is the low-latency replacement
 * for the per-flush loopback HTTP POST to /api/events/publish. The distinct
 * `type` discriminator ensures it never matches the command request/result
 * guards used by the per-request IPC message handlers.
 */
export interface DesktopBackendEventMessage {
  readonly type: typeof DESKTOP_BACKEND_EVENT_TYPE
  readonly channel: string
  readonly payload: unknown
}

export const makeDesktopBackendEventMessage = (
  channel: string,
  payload: unknown
): DesktopBackendEventMessage => ({
  type: DESKTOP_BACKEND_EVENT_TYPE,
  channel,
  payload
})

export const isDesktopBackendEventMessage = (
  value: unknown
): value is DesktopBackendEventMessage =>
  isRecord(value) &&
  value.type === DESKTOP_BACKEND_EVENT_TYPE &&
  typeof value.channel === 'string'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isOpenInAppPayload = (value: unknown): value is OpenInAppPayload =>
  isRecord(value) && typeof value.appName === 'string' && typeof value.path === 'string'

const isOpenInChromePayload = (value: unknown): value is OpenInChromePayload =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  (value.customCommand === undefined || typeof value.customCommand === 'string')

const isPublishPetStatusPayload = (value: unknown): value is PublishPetStatusPayload =>
  isRecord(value) &&
  (value.state === 'idle' ||
    value.state === 'working' ||
    value.state === 'question' ||
    value.state === 'permission' ||
    value.state === 'plan_ready') &&
  (value.sourceWorktreeId === null || typeof value.sourceWorktreeId === 'string')

const isSetPetIgnoreMousePayload = (value: unknown): value is SetPetIgnoreMousePayload =>
  isRecord(value) && typeof value.ignore === 'boolean'

const isMovePetPayload = (value: unknown): value is MovePetPayload =>
  isRecord(value) &&
  typeof value.x === 'number' &&
  Number.isFinite(value.x) &&
  typeof value.y === 'number' &&
  Number.isFinite(value.y)

const isFocusMainFromPetPayload = (value: unknown): value is FocusMainFromPetPayload =>
  isRecord(value) && (value.worktreeId === null || typeof value.worktreeId === 'string')

const isUpdatePetSettingsPayload = (value: unknown): value is UpdatePetSettingsPayload =>
  isRecord(value) &&
  (value.enabled === undefined || typeof value.enabled === 'boolean') &&
  (value.petId === undefined || typeof value.petId === 'string') &&
  (value.size === undefined || value.size === 'S' || value.size === 'M' || value.size === 'L') &&
  (value.opacity === undefined ||
    (typeof value.opacity === 'number' && Number.isFinite(value.opacity))) &&
  (value.hasHatched === undefined || typeof value.hasHatched === 'boolean')

const isUpdateMenuStatePayload = (value: unknown): value is UpdateMenuStatePayload =>
  isRecord(value) &&
  typeof value.hasActiveSession === 'boolean' &&
  typeof value.hasActiveWorktree === 'boolean' &&
  (value.canUndo === undefined || typeof value.canUndo === 'boolean') &&
  (value.canRedo === undefined || typeof value.canRedo === 'boolean')

const isSetKeepAwakePayload = (value: unknown): value is SetKeepAwakePayload =>
  isRecord(value) && typeof value.active === 'boolean'

const isSetSessionQueuedStatePayload = (value: unknown): value is SetSessionQueuedStatePayload =>
  isRecord(value) && typeof value.sessionId === 'string' && typeof value.hasQueued === 'boolean'

const isConfirmPayload = (value: unknown): value is ConfirmPayload =>
  isRecord(value) && typeof value.message === 'string'

const isProjectShowInFolderPayload = (value: unknown): value is ProjectShowInFolderPayload =>
  isRecord(value) && typeof value.path === 'string'

const isProjectOpenPathPayload = (value: unknown): value is ProjectOpenPathPayload =>
  isRecord(value) && typeof value.path === 'string'

const isProjectWriteClipboardTextPayload = (
  value: unknown
): value is ProjectWriteClipboardTextPayload =>
  isRecord(value) && typeof value.text === 'string'

const isProjectPickProjectIconPayload = (
  value: unknown
): value is ProjectPickProjectIconPayload =>
  isRecord(value) && typeof value.projectId === 'string'

const isProjectRemoveProjectIconPayload = (
  value: unknown
): value is ProjectRemoveProjectIconPayload =>
  isRecord(value) && typeof value.projectId === 'string'

const isProjectGetProjectIconPathPayload = (
  value: unknown
): value is ProjectGetProjectIconPathPayload =>
  isRecord(value) && typeof value.filename === 'string'

const isGitShowInFinderPayload = (value: unknown): value is GitShowInFinderPayload =>
  isRecord(value) && typeof value.filePath === 'string'

const isKanbanSaveBoardExportDialogPayload = (
  value: unknown
): value is KanbanSaveBoardExportDialogPayload =>
  isRecord(value) && typeof value.projectName === 'string'

const isBackupSaveFileDialogPayload = (
  value: unknown
): value is BackupSaveFileDialogPayload =>
  isRecord(value) && typeof value.defaultFileName === 'string'

const isUpdaterCheckForUpdatePayload = (value: unknown): value is UpdaterCheckForUpdatePayload =>
  isRecord(value) && (value.manual === undefined || typeof value.manual === 'boolean')

const isUpdaterSetChannelPayload = (value: unknown): value is UpdaterSetChannelPayload =>
  isRecord(value) && (value.channel === 'stable' || value.channel === 'canary')

const isCreateResponseLogPayload = (value: unknown): value is CreateResponseLogPayload =>
  isRecord(value) && typeof value.sessionId === 'string'

const isAppendResponseLogPayload = (value: unknown): value is AppendResponseLogPayload =>
  isRecord(value) && typeof value.filePath === 'string' && 'data' in value

const isSaveAttachmentPayload = (value: unknown): value is SaveAttachmentPayload =>
  isRecord(value) && typeof value.dataBase64 === 'string' && typeof value.originalName === 'string'

const isDeleteAttachmentPayload = (value: unknown): value is DeleteAttachmentPayload =>
  isRecord(value) && typeof value.filePath === 'string'

const isSettingsOpenWithEditorPayload = (value: unknown): value is SettingsOpenWithEditorPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.editorId === 'string' &&
  (value.customCommand === undefined || typeof value.customCommand === 'string')

const isSettingsOpenWithTerminalPayload = (
  value: unknown
): value is SettingsOpenWithTerminalPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.terminalId === 'string' &&
  (value.customCommand === undefined || typeof value.customCommand === 'string')

const isWatchFileTreePayload = (value: unknown): value is WatchFileTreePayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isUnwatchFileTreePayload = (value: unknown): value is UnwatchFileTreePayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isWatchGitWorktreePayload = (value: unknown): value is WatchGitWorktreePayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isUnwatchGitWorktreePayload = (value: unknown): value is UnwatchGitWorktreePayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isWatchGitBranchPayload = (value: unknown): value is WatchGitBranchPayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isUnwatchGitBranchPayload = (value: unknown): value is UnwatchGitBranchPayload =>
  isRecord(value) && typeof value.worktreePath === 'string'

const isKillScriptPayload = (value: unknown): value is KillScriptPayload =>
  isRecord(value) && typeof value.worktreeId === 'string'

const isTerminalResizePayload = (value: unknown): value is TerminalResizePayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  typeof value.cols === 'number' &&
  typeof value.rows === 'number'

const isTerminalDestroyPayload = (value: unknown): value is TerminalDestroyPayload =>
  isRecord(value) && typeof value.terminalId === 'string'

const isTerminalWritePayload = (value: unknown): value is TerminalWritePayload =>
  isRecord(value) && typeof value.terminalId === 'string' && typeof value.data === 'string'

const isTerminalCreateClaudeCliPayload = (
  value: unknown
): value is TerminalCreateClaudeCliPayload =>
  isRecord(value) &&
  typeof value.sessionId === 'string' &&
  (!('opts' in value) ||
    value.opts === undefined ||
    (isRecord(value.opts) &&
      (!('pendingPrompt' in value.opts) ||
        value.opts.pendingPrompt === undefined ||
        value.opts.pendingPrompt === null ||
        typeof value.opts.pendingPrompt === 'string')))

const isRemoteLaunchClaudeTmuxPayload = (
  value: unknown
): value is RemoteLaunchClaudeTmuxPayload =>
  isRecord(value) &&
  typeof value.sessionId === 'string' &&
  typeof value.worktreePath === 'string' &&
  typeof value.prompt === 'string' &&
  typeof value.tmuxSessionName === 'string'

const isTerminalGhosttyRect = (value: unknown): value is TerminalGhosttyRect =>
  isRecord(value) &&
  typeof value.x === 'number' &&
  typeof value.y === 'number' &&
  typeof value.w === 'number' &&
  typeof value.h === 'number'

const isTerminalGhosttyCreateSurfaceOptions = (
  value: unknown
): value is TerminalGhosttyCreateSurfaceOptions =>
  isRecord(value) &&
  (!('cwd' in value) || value.cwd === undefined || typeof value.cwd === 'string') &&
  (!('shell' in value) || value.shell === undefined || typeof value.shell === 'string') &&
  (!('scaleFactor' in value) ||
    value.scaleFactor === undefined ||
    typeof value.scaleFactor === 'number') &&
  (!('fontSize' in value) || value.fontSize === undefined || typeof value.fontSize === 'number')

const isTerminalGhosttyCreateSurfacePayload = (
  value: unknown
): value is TerminalGhosttyCreateSurfacePayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  isTerminalGhosttyRect(value.rect) &&
  (!('opts' in value) ||
    value.opts === undefined ||
    isTerminalGhosttyCreateSurfaceOptions(value.opts))

const isTerminalGhosttySetFramePayload = (
  value: unknown
): value is TerminalGhosttySetFramePayload =>
  isRecord(value) && typeof value.terminalId === 'string' && isTerminalGhosttyRect(value.rect)

const isTerminalGhosttySetSizePayload = (value: unknown): value is TerminalGhosttySetSizePayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  typeof value.width === 'number' &&
  typeof value.height === 'number'

const isTerminalGhosttyKeyEvent = (value: unknown): value is TerminalGhosttyKeyEvent =>
  isRecord(value) &&
  typeof value.action === 'number' &&
  typeof value.keycode === 'number' &&
  typeof value.mods === 'number' &&
  (!('consumedMods' in value) ||
    value.consumedMods === undefined ||
    typeof value.consumedMods === 'number') &&
  (!('text' in value) || value.text === undefined || typeof value.text === 'string') &&
  (!('unshiftedCodepoint' in value) ||
    value.unshiftedCodepoint === undefined ||
    typeof value.unshiftedCodepoint === 'number') &&
  (!('composing' in value) || value.composing === undefined || typeof value.composing === 'boolean')

const isTerminalGhosttyKeyEventPayload = (
  value: unknown
): value is TerminalGhosttyKeyEventPayload =>
  isRecord(value) && typeof value.terminalId === 'string' && isTerminalGhosttyKeyEvent(value.event)

const isTerminalGhosttyMouseButtonPayload = (
  value: unknown
): value is TerminalGhosttyMouseButtonPayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  typeof value.state === 'number' &&
  typeof value.button === 'number' &&
  typeof value.mods === 'number'

const isTerminalGhosttyMousePosPayload = (
  value: unknown
): value is TerminalGhosttyMousePosPayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  typeof value.x === 'number' &&
  typeof value.y === 'number' &&
  typeof value.mods === 'number'

const isTerminalGhosttyMouseScrollPayload = (
  value: unknown
): value is TerminalGhosttyMouseScrollPayload =>
  isRecord(value) &&
  typeof value.terminalId === 'string' &&
  typeof value.dx === 'number' &&
  typeof value.dy === 'number' &&
  typeof value.mods === 'number'

const isTerminalGhosttySetFocusPayload = (
  value: unknown
): value is TerminalGhosttySetFocusPayload =>
  isRecord(value) && typeof value.terminalId === 'string' && typeof value.focused === 'boolean'

const isTerminalGhosttyPasteTextPayload = (
  value: unknown
): value is TerminalGhosttyPasteTextPayload =>
  isRecord(value) && typeof value.terminalId === 'string' && typeof value.text === 'string'

const isTerminalGhosttyDestroySurfacePayload = (
  value: unknown
): value is TerminalGhosttyDestroySurfacePayload =>
  isRecord(value) && typeof value.terminalId === 'string'

const isOpenCodeConnectPayload = (value: unknown): value is OpenCodeConnectPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.hiveSessionId === 'string'

const isOpenCodeReconnectPayload = (value: unknown): value is OpenCodeReconnectPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string' &&
  typeof value.hiveSessionId === 'string'

const isOpenCodePromptPayload = (value: unknown): value is OpenCodePromptPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string' &&
  isOpenCodePromptMessage(value.messageOrParts) &&
  (value.model === undefined || isOpenCodePromptModel(value.model)) &&
  (value.options === undefined || isOpenCodePromptOptions(value.options))

const isOpenCodePromptMessage = (value: unknown): value is OpenCodePromptMessage =>
  typeof value === 'string' || (Array.isArray(value) && value.every(isOpenCodePromptPart))

const isOpenCodePromptPart = (value: unknown): value is OpenCodePromptPart =>
  isRecord(value) &&
  ((value.type === 'text' && typeof value.text === 'string') ||
    (value.type === 'file' &&
      typeof value.mime === 'string' &&
      typeof value.url === 'string' &&
      (value.filename === undefined || typeof value.filename === 'string')))

const isOpenCodePromptModel = (value: unknown): value is OpenCodePromptModel =>
  isRecord(value) &&
  typeof value.providerID === 'string' &&
  typeof value.modelID === 'string' &&
  (value.variant === undefined || typeof value.variant === 'string')

const isOpenCodePromptOptions = (value: unknown): value is OpenCodePromptOptions =>
  isRecord(value) && (value.codexFastMode === undefined || typeof value.codexFastMode === 'boolean')

const isOpenCodeAbortPayload = (value: unknown): value is OpenCodeAbortPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeSteerPayload = (value: unknown): value is OpenCodeSteerPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string' &&
  typeof value.message === 'string'

const isOpenCodeDisconnectPayload = (value: unknown): value is OpenCodeDisconnectPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeGetMessagesPayload = (value: unknown): value is OpenCodeGetMessagesPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeRefreshFromThreadPayload = (
  value: unknown
): value is OpenCodeRefreshFromThreadPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeAgentSdk = (value: unknown): value is OpenCodeAgentSdk =>
  value === 'opencode' ||
  value === 'claude-code' ||
  value === 'claude-code-cli' ||
  value === 'codex' ||
  value === 'terminal'

const isOpenCodeListModelsPayload = (value: unknown): value is OpenCodeListModelsPayload =>
  isRecord(value) && (value.agentSdk === undefined || isOpenCodeAgentSdk(value.agentSdk))

const isOpenCodeSetModelInput = (value: unknown): value is OpenCodeSetModelInput =>
  isRecord(value) &&
  typeof value.providerID === 'string' &&
  typeof value.modelID === 'string' &&
  (value.variant === undefined || typeof value.variant === 'string') &&
  (value.agentSdk === undefined || isOpenCodeAgentSdk(value.agentSdk))

const isOpenCodeSetModelPayload = (value: unknown): value is OpenCodeSetModelPayload =>
  isRecord(value) && (value.model === null || isOpenCodeSetModelInput(value.model))

const isOpenCodeModelInfoPayload = (value: unknown): value is OpenCodeModelInfoPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.modelId === 'string' &&
  (value.agentSdk === undefined || isOpenCodeAgentSdk(value.agentSdk))

const isOpenCodeQuestionReplyPayload = (value: unknown): value is OpenCodeQuestionReplyPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  Array.isArray(value.answers) &&
  value.answers.every(
    (answerGroup) =>
      Array.isArray(answerGroup) && answerGroup.every((answer) => typeof answer === 'string')
  ) &&
  (value.worktreePath === undefined || typeof value.worktreePath === 'string')

const isOpenCodeQuestionRejectPayload = (value: unknown): value is OpenCodeQuestionRejectPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  (value.worktreePath === undefined || typeof value.worktreePath === 'string')

const isOpenCodePlanApprovePayload = (value: unknown): value is OpenCodePlanApprovePayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.hiveSessionId === 'string' &&
  (value.requestId === undefined || typeof value.requestId === 'string')

const isOpenCodePlanRejectPayload = (value: unknown): value is OpenCodePlanRejectPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.hiveSessionId === 'string' &&
  typeof value.feedback === 'string' &&
  (value.requestId === undefined || typeof value.requestId === 'string')

const isOpenCodePermissionDecision = (value: unknown): value is OpenCodePermissionDecision =>
  value === 'once' || value === 'always' || value === 'reject'

const isOpenCodePermissionReplyPayload = (
  value: unknown
): value is OpenCodePermissionReplyPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  isOpenCodePermissionDecision(value.reply) &&
  (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
  (value.message === undefined || typeof value.message === 'string')

const isOpenCodePermissionListPayload = (value: unknown): value is OpenCodePermissionListPayload =>
  isRecord(value) && (value.worktreePath === undefined || typeof value.worktreePath === 'string')

const isOpenCodeCommandApprovalRemember = (
  value: unknown
): value is OpenCodeCommandApprovalReplyPayload['remember'] =>
  value === 'allow' || value === 'block'

const isOpenCodeCommandApprovalReplyPayload = (
  value: unknown
): value is OpenCodeCommandApprovalReplyPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  typeof value.approved === 'boolean' &&
  (value.remember === undefined || isOpenCodeCommandApprovalRemember(value.remember)) &&
  (value.pattern === undefined || typeof value.pattern === 'string') &&
  (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
  (value.patterns === undefined ||
    (Array.isArray(value.patterns) &&
      value.patterns.every((pattern) => typeof pattern === 'string')))

const isOpenCodeSessionInfoPayload = (value: unknown): value is OpenCodeSessionInfoPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeUndoPayload = (value: unknown): value is OpenCodeUndoPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeRedoPayload = (value: unknown): value is OpenCodeRedoPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string'

const isOpenCodeCommandPayload = (value: unknown): value is OpenCodeCommandPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string' &&
  typeof value.command === 'string' &&
  typeof value.args === 'string' &&
  (value.model === undefined || isOpenCodePromptModel(value.model)) &&
  (value.options === undefined || isOpenCodePromptOptions(value.options))

const isOpenCodeCommandsPayload = (value: unknown): value is OpenCodeCommandsPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  (value.sessionId === undefined || typeof value.sessionId === 'string')

const isOpenCodeRenameSessionPayload = (value: unknown): value is OpenCodeRenameSessionPayload =>
  isRecord(value) &&
  typeof value.opencodeSessionId === 'string' &&
  typeof value.title === 'string' &&
  (value.worktreePath === undefined || typeof value.worktreePath === 'string')

const isOpenCodeCapabilitiesPayload = (value: unknown): value is OpenCodeCapabilitiesPayload =>
  isRecord(value) && (value.sessionId === undefined || typeof value.sessionId === 'string')

const isOpenCodeForkPayload = (value: unknown): value is OpenCodeForkPayload =>
  isRecord(value) &&
  typeof value.worktreePath === 'string' &&
  typeof value.opencodeSessionId === 'string' &&
  (value.messageId === undefined || typeof value.messageId === 'string')

const isTelegramClaudeCliSessionPayload = (
  value: unknown
): value is TelegramClaudeCliSessionPayload =>
  isRecord(value) && typeof value.sessionId === 'string'

const isTelegramClaudeCliQuestionReplyPayload = (
  value: unknown
): value is TelegramClaudeCliQuestionReplyPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  Array.isArray(value.answers) &&
  value.answers.every(
    (answerGroup) =>
      Array.isArray(answerGroup) && answerGroup.every((answer) => typeof answer === 'string')
  )

const isTelegramClaudeCliQuestionRejectPayload = (
  value: unknown
): value is TelegramClaudeCliQuestionRejectPayload =>
  isRecord(value) && typeof value.requestId === 'string'

const isTelegramClaudeCliPlanReplyPayload = (
  value: unknown
): value is TelegramClaudeCliPlanReplyPayload =>
  isRecord(value) &&
  typeof value.requestId === 'string' &&
  typeof value.approve === 'boolean' &&
  (value.feedback === undefined || typeof value.feedback === 'string')

const isTerminalClaudeCliPlanAutoApprovePayload = (
  value: unknown
): value is TerminalClaudeCliPlanAutoApprovePayload =>
  isRecord(value) && typeof value.sessionId === 'string' && typeof value.enabled === 'boolean'
