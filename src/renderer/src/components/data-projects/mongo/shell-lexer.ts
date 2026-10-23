// The forgiving mongosh tokenizer now lives in shared code (the secret masker on the server uses
// it too): see @shared/data-projects/mongo-shell/shell-lexer.
export {
  lexShell,
  stringTokenValue,
  type ShellToken,
  type ShellTokenType
} from '@shared/data-projects/mongo-shell/shell-lexer'
