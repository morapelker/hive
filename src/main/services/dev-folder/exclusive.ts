// One at a time: changing the dev folder, moving a project into it, and finishing a move that
// a quit interrupted all read and write the same folders and rows. Per process (the server
// child); a second app instance on the same database is stopped by the checks each step
// repeats inside its own transaction, not by this.

let chain: Promise<unknown> = Promise.resolve()

/** Run `task` after every task queued before it has settled. Rejects with what `task` rejects with. */
export const runDevFolderExclusive = <T>(task: () => Promise<T> | T): Promise<T> => {
  const run = chain.then(() => task())
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}
