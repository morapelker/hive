import type { Resolvers } from '../../__generated__/resolvers-types'

export const systemMutationResolvers: Resolvers = {
  Mutation: {
    systemKillSwitch: async (_parent, _args, ctx) => {
      ctx.db.deleteSetting('headless_api_key_hash')
      return true
    },
    systemRegisterPushToken: async (_parent, { token, platform }, ctx) => {
      ctx.db.setSetting('headless_push_token', token)
      ctx.db.setSetting('headless_push_platform', platform)
      return true
    }
  }
}
