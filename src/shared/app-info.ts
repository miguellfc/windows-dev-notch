import { z } from 'zod'

export const appInfoSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
})

export type AppInfo = z.infer<typeof appInfoSchema>
