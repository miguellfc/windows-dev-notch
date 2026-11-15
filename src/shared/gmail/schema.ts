import { z } from 'zod'

export const GMAIL_RECENT_LIMIT = 5
/** Unread counts are capped here; the UI shows 100 as "99+". */
export const GMAIL_UNREAD_CAP = 100
/** A mail body shown in the notch is cut to this many characters (`truncated: true`). */
export const GMAIL_BODY_MAX = 50_000
/** At most this many links of a mail are kept (and can be opened by index). */
export const GMAIL_LINKS_MAX = 50
/** Link text is cut to this many characters. */
export const GMAIL_LINK_TEXT_MAX = 200
/** Longer link URLs are left out of a mail's links (they stay plain text in the body). */
export const GMAIL_URL_MAX = 2048
/** Sender name, sender address and subject of an opened mail are cut to this many characters. */
export const GMAIL_HEADER_MAX = 1000

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
  /** Why the session is `expired`: `scope` when it lacks the full-mail permission. */
  reason: z.literal('scope').nullable(),
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

/** Only `http`/`https` URLs are ever offered as links (no `javascript:`, `data:`, `mailto:`...). */
export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url.trim())

export const gmailLinkSchema = z.strictObject({
  text: z.string().max(GMAIL_LINK_TEXT_MAX),
  url: z.string().max(GMAIL_URL_MAX).refine(isWebUrl, 'Only http/https links'),
})
export type GmailLink = z.infer<typeof gmailLinkSchema>

/** A mail opened in the notch, as plain text. */
export const gmailMessageDetailSchema = z.strictObject({
  id: z.string(),
  threadId: z.string(),
  /** Display name of the sender. */
  from: z.string().max(GMAIL_HEADER_MAX),
  fromAddress: z.string().max(GMAIL_HEADER_MAX),
  subject: z.string().max(GMAIL_HEADER_MAX),
  /** ISO time. */
  date: z.string(),
  unread: z.boolean(),
  body: z.string().max(GMAIL_BODY_MAX),
  truncated: z.boolean(),
  links: z.array(gmailLinkSchema).max(GMAIL_LINKS_MAX),
  attachments: z.int().min(0),
})
export type GmailMessageDetail = z.infer<typeof gmailMessageDetailSchema>

/** Event main -> notch for new unread mail; no sender or subject when the user hides them. */
export const gmailNewMailSchema = z.strictObject({
  count: z.int().min(1),
  id: z.string().min(1).max(64),
  from: z.string().optional(),
  subject: z.string().optional(),
})
export type GmailNewMail = z.infer<typeof gmailNewMailSchema>

/** Gmail ids are short hex strings; the bound keeps an open request small. */
export const gmailOpenInputSchema = z.strictObject({ id: z.string().min(1).max(64).optional() })
export type GmailOpenInput = z.infer<typeof gmailOpenInputSchema>

const gmailIdSchema = z.string().min(1).max(64)

/** `gmail:message`, `gmail:mark-read` and `gmail:delete`. */
export const gmailIdInputSchema = z.strictObject({ id: gmailIdSchema })
export type GmailIdInput = z.infer<typeof gmailIdInputSchema>

/** `gmail:open-link`: the renderer names a link by its index, never by URL. */
export const gmailOpenLinkInputSchema = z.strictObject({ id: gmailIdSchema, index: z.int().min(0).max(GMAIL_LINKS_MAX - 1) })
export type GmailOpenLinkInput = z.infer<typeof gmailOpenLinkInputSchema>

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

const headerSchema = z.object({ name: z.string(), value: z.string() })

/** One MIME part of a `format=full` message; `parts` nest for multipart types. */
export interface MessagePayload {
  mimeType: string
  filename?: string | undefined
  headers: { name: string; value: string }[]
  body: { data?: string | undefined; size: number }
  parts?: MessagePayload[] | undefined
}

const messagePartSchema: z.ZodType<MessagePayload> = z.lazy(() =>
  z.object({
    mimeType: z.string(),
    filename: z.string().optional(),
    headers: z.array(headerSchema).default([]),
    body: z.object({ data: z.string().optional(), size: z.number() }),
    parts: z.array(messagePartSchema).optional(),
  }),
)

export const messageFullSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string(),
  payload: messagePartSchema,
})

export const profileSchema = z.object({ emailAddress: z.string() })

export const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
})
