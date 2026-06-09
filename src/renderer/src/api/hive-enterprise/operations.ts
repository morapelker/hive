export const MeDocument = /* GraphQL */ `
  query HiveEnterpriseMe {
    me {
      id
      email
      role
      organization {
        id
        name
        storePrompts
      }
    }
  }
`

export const RecordPromptStartDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordPromptStart($input: PromptStartInput!) {
    recordPromptStart(input: $input) {
      recorded
      promptId
      storePrompts
    }
  }
`

export const RecordPromptIdleDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordPromptIdle($input: PromptIdleInput!) {
    recordPromptIdle(input: $input) {
      recorded
      storePrompts
    }
  }
`
