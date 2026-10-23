// The Mongo workspace masks credentials before it writes drafts to localStorage with the same
// masker the server uses for query history and the assistant (one rule set everywhere): see
// @shared/data-projects/mongo-shell/mask.
export { maskMongoSecrets } from '@shared/data-projects/mongo-shell/mask'
