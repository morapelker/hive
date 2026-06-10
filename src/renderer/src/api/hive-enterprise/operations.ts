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
        recordQuestions
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
      recordQuestions
    }
  }
`

export const RecordPromptIdleDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordPromptIdle($input: PromptIdleInput!) {
    recordPromptIdle(input: $input) {
      recorded
      storePrompts
      recordQuestions
    }
  }
`

export const RecordQuestionsAnsweredDocument = /* GraphQL */ `
  mutation HiveEnterpriseRecordQuestionsAnswered($input: QuestionAnsweredInput!) {
    recordQuestionsAnswered(input: $input) {
      recorded
      storePrompts
      recordQuestions
    }
  }
`
