import type { CodegenConfig } from '@graphql-codegen/cli'

// Path to the hive-enterprise GraphQL SDL this app talks to. Override with the
// HIVE_ENTERPRISE_SCHEMA env var when the checkout lives somewhere else.
const schema =
  process.env.HIVE_ENTERPRISE_SCHEMA ??
  '/Users/mor/Documents/dev/hive-enterprise/src/graphql/schema.graphql'

const config: CodegenConfig = {
  schema,
  documents: ['src/renderer/src/api/hive-enterprise/operations.ts'],
  generates: {
    'src/renderer/src/api/hive-enterprise/generated.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        typesPrefix: 'Gql',
        enumsAsTypes: true,
        preResolveTypes: false,
        scalars: {
          InteractId: 'string'
        }
      }
    }
  }
}

export default config
