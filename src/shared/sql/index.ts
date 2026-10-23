// Shared SQL toolkit (renderer + server): lexer, statement splitter, safety classifier, auto-limit
// rewrite, quoting, filter → WHERE and secret masking. Pure TS, no dependencies.

export {
  isSqlTrivia,
  isSqlWord,
  lexSql,
  type SqlLexError,
  type SqlLexOptions,
  type SqlLexResult,
  type SqlToken,
  type SqlTokenType
} from './lexer'
export {
  splitSqlStatements,
  splitSqlStatementsWithTerminators,
  statementAtOffset,
  type SqlStatementSpan,
  type SqlStatementSpanWithTerminator
} from './splitter'
export {
  analyzeSqlStatement,
  classifySqlStatement,
  unquoteSqlIdentifier,
  type SqlClassification,
  type SqlClassifyOptions,
  type SqlStatementAnalysis
} from './classify'
export { applyAutoLimit, hasUserLimit } from './limit'
export {
  qualifiedSqlName,
  quoteSqlIdentifier,
  quoteSqlLiteral,
  quoteSqlString,
  type SqlQuoteOptions
} from './quote'
export {
  buildSqlWhere,
  buildSqlWhereClause,
  splitFilterList,
  type SqlWhereOptions
} from './filters'
export { maskSqlSecrets } from './mask'
