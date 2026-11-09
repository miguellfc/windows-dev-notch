/**
 * Channel names exposed to the renderer, grouped by namespace.
 * Kept free of runtime dependencies so the sandboxed preload stays tiny.
 */
export const channels = {
  app: {
    getInfo: 'app:get-info',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
} as const

type ChannelGroups = typeof channels
export type ChannelName = {
  [Group in keyof ChannelGroups]: ChannelGroups[Group][keyof ChannelGroups[Group]]
}[keyof ChannelGroups]
