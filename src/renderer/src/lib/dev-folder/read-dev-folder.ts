import { DEV_FOLDER_RPC, isDevFolderState } from '@shared/types/dev-folder'
import { getRendererRpcClient } from '@/api/rpc-client'

/**
 * The dev folder, for a dialog that wants a folder to start from: its path while it is a
 * directory on disk, null otherwise.
 *
 * Never rejects and never throws. The dialogs ask when they open, also where the answer is
 * not a dev folder at all: a window without a server has no RPC client, and a test double
 * answers whatever it answers. All of those read as "no folder to
 * start from", which leaves the dialog exactly as it is without this.
 *
 * A folder that is not on disk is not offered: the server refuses to create a project or
 * clone a repository into a folder that does not exist.
 */
export const readExistingDevFolder = async (): Promise<string | null> => {
  try {
    const state: unknown = await getRendererRpcClient().request<unknown>(DEV_FOLDER_RPC.get, {})
    if (!isDevFolderState(state) || state.exists !== true || state.path.length === 0) return null
    return state.path
  } catch {
    return null
  }
}
