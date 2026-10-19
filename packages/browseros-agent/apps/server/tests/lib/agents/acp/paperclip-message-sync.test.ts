import { describe, expect, it } from 'bun:test'
import { parseBinding } from '../../../../src/lib/agents/acp/paperclip-binding'
import { readPaperclipMessages } from '../../../../src/lib/agents/acp/paperclip-message-sync'

const comment = (
  id: string,
  body = id,
  createdAt = '2026-10-19T00:00:00Z',
) => ({ id, body, createdAt })
const page = (
  cursor: string,
  comments: ReturnType<typeof comment>[] = [],
  extra = {},
) => ({
  version: 1,
  reset: false,
  comments,
  removed: [],
  cursor,
  hasMore: false,
  ...extra,
})

describe('Paperclip incremental message transport', () => {
  it('drops an unsupported derived cache while retaining Task and mutation identity', () => {
    const binding = parseBinding({
      version: 1,
      identity: 'same',
      request: { requestId: 'same' },
      taskId: 'task',
      messageSync: { version: 2, cursor: 'unknown', comments: [] },
    })
    expect(binding).toMatchObject({
      identity: 'same',
      taskId: 'task',
      request: { requestId: 'same' },
    })
    expect(binding.messageSync).toBeUndefined()
  })
  it('drains pages, sorts by creation order and merges edits/deletions without mutating saved state', async () => {
    const paths: string[] = []
    const pages = [
      page('first', [comment('b')], { reset: true, hasMore: true }),
      page('second', [comment('a', 'earlier', '2025-01-01T00:00:00Z')]),
    ]
    const initial = await readPaperclipMessages(
      async (path) => {
        paths.push(path)
        return pages.shift()
      },
      'task',
      true,
    )
    expect(paths).toEqual([
      '/tasks/task/message-changes',
      '/tasks/task/message-changes?cursor=first',
    ])
    expect(initial.comments.map((c) => c.id)).toEqual(['a', 'b'])
    const changed = await readPaperclipMessages(
      async () => page('third', [comment('b', 'edited')], { removed: ['a'] }),
      'task',
      true,
      initial.messageSync,
    )
    expect(changed.comments).toEqual([comment('b', 'edited')])
    expect(initial.comments.map((c) => c.id)).toEqual(['a', 'b'])
    const replay = await readPaperclipMessages(
      async () => page('third', [comment('b', 'edited')], { removed: ['a'] }),
      'task',
      true,
      changed.messageSync,
    )
    expect(replay).toEqual(changed)
  })
  it('retains database microseconds and handles equivalent timezone offsets when sorting', async () => {
    const result = await readPaperclipMessages(
      async () =>
        page(
          'precise',
          [
            comment('a', 'later', '2026-10-19T00:00:00.123200Z'),
            comment(
              'c',
              'same earlier instant',
              '2026-10-19T08:00:00.123100+08:00',
            ),
            comment('b', 'earlier', '2026-10-19T00:00:00.123100Z'),
          ],
          { reset: true },
        ),
      'task',
      true,
    )
    expect(result.comments.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })
  it('discards stale cache on a reset in the middle of catch-up', async () => {
    const pages = [
      page('a', [comment('old')], { reset: true, hasMore: true }),
      page('b', [comment('new')], { reset: true }),
    ]
    const result = await readPaperclipMessages(
      async () => pages.shift(),
      'task',
      true,
    )
    expect(result.comments).toEqual([comment('new')])
  })
  it('retries the last durable cursor after network failure without committing a partial page', async () => {
    const previous = {
      version: 1 as const,
      cursor: 'saved',
      comments: [comment('saved')],
    }
    let requests = 0
    await expect(
      readPaperclipMessages(
        async () => {
          if (requests++ === 0)
            return page('partial', [comment('new')], { hasMore: true })
          throw new Error('response lost')
        },
        'task',
        true,
        previous,
      ),
    ).rejects.toThrow('response lost')
    expect(previous).toEqual({
      version: 1,
      cursor: 'saved',
      comments: [comment('saved')],
    })
    const paths: string[] = []
    await readPaperclipMessages(
      async (path) => {
        paths.push(path)
        return page('complete', [comment('new')])
      },
      'task',
      true,
      previous,
    )
    expect(paths).toEqual(['/tasks/task/message-changes?cursor=saved'])
  })
  it('rejects an uninitialized or non-advancing stream and validates creation timestamps', async () => {
    await expect(
      readPaperclipMessages(async () => page('a'), 'task', true),
    ).rejects.toThrow('initial message snapshot')
    const previous = { version: 1 as const, cursor: 'a', comments: [] }
    await expect(
      readPaperclipMessages(
        async () => page('a', [], { hasMore: true }),
        'task',
        true,
        previous,
      ),
    ).rejects.toThrow('did not advance')
    await expect(
      readPaperclipMessages(
        async () => page('b', [comment('x', 'body', 'invalid')]),
        'task',
        true,
        previous,
      ),
    ).rejects.toThrow()
  })
  it('uses the original full projection for an older server and discards its obsolete incremental cursor', async () => {
    const paths: string[] = []
    const result = await readPaperclipMessages(
      async (path) => {
        paths.push(path)
        return paths.length === 1
          ? { comments: [comment('a')], next: 'a' }
          : { comments: [comment('b')], next: null }
      },
      'task',
      false,
      { version: 1, cursor: 'obsolete', comments: [comment('old')] },
    )
    expect(paths).toEqual([
      '/tasks/task/messages',
      '/tasks/task/messages?after=a',
    ])
    expect(result.comments.map((c) => c.id)).toEqual(['a', 'b'])
    expect(result.messageSync).toBeUndefined()
  })
})
