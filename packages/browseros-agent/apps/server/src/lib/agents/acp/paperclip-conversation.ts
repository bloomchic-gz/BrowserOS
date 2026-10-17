import type { z } from 'zod'
import type { SentMessage } from './paperclip-binding'
import type { CommentSchema } from './paperclip-client'

/** Remote conversation data; independent of the UI SDK and database schema. */
export interface PaperclipMessage {
  id: string
  role: 'user' | 'assistant'
  parts: Array<{ type: 'text'; text: string }>
  metadata?: {
    paperclipCommentId: string
    authorUserId?: string | null
    authorAgentId?: string | null
  }
}
export type RunOutput = { offset: number; text: string; status: string }
export interface ConversationSink {
  replace(input: {
    conversationId: string
    agentId: string
    messages: PaperclipMessage[]
  }): Promise<void>
}

/** Reconcile a complete snapshot, including edits, deletions and run replacement. */
export function projectPaperclipMessages(
  comments: z.infer<typeof CommentSchema>[],
  sent: Record<string, SentMessage>,
  outputs: Record<string, RunOutput>,
): PaperclipMessage[] {
  const messages: PaperclipMessage[] = comments
    .filter((c) => !c.deletedAt)
    .map((c) => {
      const local = Object.entries(sent).find(
        ([, message]) => message.requestId === c.clientRequestId,
      )
      return {
        id: local?.[0] ?? `paperclip-comment-${c.id}`,
        role: c.authorAgentId || c.derivedAuthorAgentId ? 'assistant' : 'user',
        parts: [
          {
            type: 'text',
            text:
              c.body
                .match(/<USER_QUERY>\s*([\s\S]*?)<\/USER_QUERY>/)?.[1]
                ?.trim() ?? c.body,
          },
        ],
        metadata: {
          paperclipCommentId: c.id,
          authorUserId: c.authorUserId,
          authorAgentId: c.authorAgentId ?? c.derivedAuthorAgentId,
        },
      }
    })
  for (const [runId, output] of Object.entries(outputs)) {
    if (
      !output.text ||
      comments.some(
        (c) =>
          !c.deletedAt &&
          (c.createdByRunId === runId || c.derivedCreatedByRunId === runId) &&
          (c.authorAgentId || c.derivedAuthorAgentId),
      )
    )
      continue
    messages.push({
      id: `paperclip-run-${runId}`,
      role: 'assistant',
      parts: [{ type: 'text', text: output.text }],
    })
  }
  return messages
}
