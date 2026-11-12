import { z } from 'zod'

export const GMAIL_RECENT_LIMIT = 5
/** Unread counts are capped here; the UI shows 100 as "99+". */
export const GMAIL_UNREAD_CAP = 100

export const gmailStatusSchema = z.enum(['unconfigured', 'signed-out', 'signing-in', 'ok', 'offline', 'expired'])
export type GmailStatus = z.infer<typeof gmailStatusSchema>

export const gmailStateSchema = z.strictObject({
  status: gmailStatusSchema,
  /** Address of the connected account. */
  account: z.string().nullable(),
  unread: z.int().min(0).max(GMAIL_UNREAD_CAP).nullable(),
  /** ISO time of the last successful query. */
  updatedAt: z.string().nullable(),
  /** False when the session lives only in memory (no OS encryption) and will not survive a restart. */
  persistent: z.boolean(),
})
export type GmailState = z.infer<typeof gmailStateSchema>

export const gmailMessageSchema = z.strictObject({
  id: z.string(),
  threadId: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  date: z.string(),
  unread: z.boolean(),
})
export type GmailMessage = z.infer<typeof gmailMessageSchema>

/** Gmail ids are short hex strings; the bound keeps an open request small. */
export const gmailOpenInputSchema = z.strictObject({ id: z.string().min(1).max(64).optional() })
export type GmailOpenInput = z.infer<typeof gmailOpenInputSchema>

/** Credentials read from a client file; bounded like the settings fields they end up in. */
export const gmailClientFileSchema = z.strictObject({ clientId: z.string().min(1).max(256), clientSecret: z.string().min(1).max(256) })

const clientFileSchema = z.object({
  // Same 256 cap as the gmail settings: a longer value is not a client file (not an INTERNAL save error).
  installed: z.object({ client_id: z.string().min(1).max(256), client_secret: z.string().min(1).max(256) }),
})

/** Reads the credentials out of Google's "Desktop app" client JSON; any other shape gives `null`. */
export function parseClientFile(json: unknown): { clientId: string; clientSecret: string } | null {
  const parsed = clientFileSchema.safeParse(json)
  if (!parsed.success) return null
  return { clientId: parsed.data.installed.client_id, clientSecret: parsed.data.installed.client_secret }
}

// Gmail / OAuth responses: not strict, Google adds fields.
export const messageListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
})

export const messageMetadataSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  snippet: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string(),
  payload: z.object({ headers: z.array(z.object({ name: z.string(), value: z.string() })) }),
})

export const profileSchema = z.object({ emailAddress: z.string() })

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
})
