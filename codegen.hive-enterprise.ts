import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  schema: '/Users/mor/.hive/connections/9fe455b3/hive-enterprise/src/graphql/schema.graphql',
  documents: ['src/renderer/src/api/hive-enterprise/operations.ts'],
  generates: {
    'src/renderer/src/api/hive-enterprise/generated.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        typesPrefix: 'Gql',
        enumsAsTypes: true,
        preResolveTypes: false
      }
    }
  }
}

export default config
