// The structure editor reports how many changes it has staged to the workspace store
// (setStagedEditCount) under its own key next to the table tab's id: TableDataView reports its row
// edits under the tab id itself, and the two counts must never overwrite each other. Readers of a
// tab's staged count (pendingEditCount, the close-tab question, the tab strip's staged marker) add
// this key's count to the tab id's.
export const structureStagedKey = (tabId: string): string => `${tabId}::structure`
