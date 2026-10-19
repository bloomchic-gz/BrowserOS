import { z } from 'zod'
import { CommentSchema, MessagesSchema } from './paperclip-client'

const IncrementalCommentSchema = CommentSchema.extend({
  createdAt: z.iso.datetime({ offset: true }),
})
export const MessageSyncStateSchema = z.object({
  version: z.literal(1),
  cursor: z.string().min(1).max(2048),
  comments: z.array(IncrementalCommentSchema),
})
const ChangesSchema = z.object({
  version: z.literal(1),
  reset: z.boolean(),
  comments: z.array(IncrementalCommentSchema),
  removed: z.array(z.string()),
  cursor: z.string().min(1).max(2048),
  hasMore: z.boolean(),
})
type MessageSyncState = z.infer<typeof MessageSyncStateSchema>

// Date.parse retains only milliseconds; PostgreSQL ordering also uses the
// remaining microseconds. Offset normalization still belongs to Date.parse.
const subMillisecond = (timestamp: string) =>
  Number((timestamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6))

/** Stage a complete local view; callers commit it only after the sink succeeds. */
export async function readPaperclipMessages(
  request: (path: string) => Promise<unknown>,
  taskId: string,
  incremental: boolean,
  previous?: MessageSyncState,
): Promise<{
  comments: z.infer<typeof CommentSchema>[]
  messageSync?: MessageSyncState
}> {
  if (!incremental) {
    const comments: z.infer<typeof CommentSchema>[] = []
    let after: string | null = null
    do {
      const page = MessagesSchema.parse(
        await request(
          `/tasks/${taskId}/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`,
        ),
      )
      comments.push(...page.comments)
      after = page.next
    } while (after)
    return { comments }
  }
  const cache = new Map(previous?.comments.map((c) => [c.id, c]))
  let cursor = previous?.cursor
  for (let pages = 0; pages < 1000; pages++) {
    const page = ChangesSchema.parse(
      await request(
        `/tasks/${taskId}/message-changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    )
    if (!cursor && !page.reset)
      throw new Error('Paperclip did not provide an initial message snapshot.')
    if (page.reset) cache.clear()
    for (const id of page.removed) cache.delete(id)
    for (const comment of page.comments) {
      if (comment.deletedAt) cache.delete(comment.id)
      else cache.set(comment.id, comment)
    }
    if (page.hasMore && page.cursor === cursor)
      throw new Error('Paperclip message cursor did not advance.')
    cursor = page.cursor
    if (!page.hasMore) {
      const comments = [...cache.values()].sort(
        (a, b) =>
          Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
          subMillisecond(a.createdAt) - subMillisecond(b.createdAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      return { comments, messageSync: { version: 1, cursor, comments } }
    }
  }
  throw new Error('Paperclip message catch-up exceeded its page limit.')
}
