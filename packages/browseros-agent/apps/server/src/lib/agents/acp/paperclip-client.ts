import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { z } from 'zod'

export const CommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  authorAgentId: z.string().nullish(),
  derivedAuthorAgentId: z.string().nullish(),
  authorUserId: z.string().nullish(),
  clientRequestId: z.string().nullish(),
  createdByRunId: z.string().nullish(),
  derivedCreatedByRunId: z.string().nullish(),
  deletedAt: z.string().nullish(),
})
export const MessagesSchema = z.object({
  comments: z.array(CommentSchema),
  next: z.string().nullable(),
})
export const SnapshotSchema = z.object({
  comments: z.array(CommentSchema),
  liveRuns: z.array(z.unknown()),
  run: z
    .object({
      id: z.string(),
      status: z.string(),
      resultJson: z.object({ summary: z.string().nullish() }).nullish(),
    })
    .nullable(),
  taskUrl: z.string().optional(),
  output: z.object({ offset: z.number(), text: z.string() }).nullish(),
})
export const PollSchema = z.object({
  calls: z.array(
    z.object({
      id: z.string(),
      runId: z.string(),
      request: z.object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
})
export async function paperclipRequest(
  config: PaperclipAgentConfig,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(
    `${new URL(config.url).origin}/api/browseros${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
        : AbortSignal.timeout(35_000),
    },
  )
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Reconnect your Paperclip account.'
        : `Paperclip request failed (${response.status}). Check the linked task before retrying.`,
    )
  const result: unknown = await response.json()
  const outcome = z
    .object({
      outcome: z.enum(['rejected', 'unknown']),
      message: z.string().optional(),
    })
    .safeParse(result)
  if (outcome.success)
    throw new Error(
      outcome.data.outcome === 'rejected'
        ? `Paperclip rejected this message. ${outcome.data.message ?? 'Check the linked task.'}`
        : 'Paperclip could not confirm this message. Check the linked task before sending another message.',
    )
  return result
}
