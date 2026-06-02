export type MenuActionChannel = `menu:${string}`

export const isMenuActionChannel = (channel: string): channel is MenuActionChannel =>
  channel.startsWith('menu:')
