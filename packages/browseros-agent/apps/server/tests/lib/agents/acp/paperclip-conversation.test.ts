import { describe, expect, it } from 'bun:test'
import { projectPaperclipMessages } from '../../../../src/lib/agents/acp/paperclip-conversation'
import { DbConversationSink } from '../../../../src/lib/agents/acp/paperclip-conversation-sink'

describe('Paperclip conversation boundary', () => {
  it('preserves local IDs, team authors, edits, deletions and final-run replacement', () => {
    const sent = {
      'local-message': {
        requestId: 'request',
        body: 'original',
        commentIds: [],
      },
    }
    const outputs = { run: { offset: 10, text: 'partial', status: 'running' } }
    const comments = [
      {
        id: 'mine',
        body: '<USER_QUERY> edited </USER_QUERY>',
        clientRequestId: 'request',
        authorUserId: 'owner',
      },
      { id: 'team', body: 'continue', authorUserId: 'teammate' },
      { id: 'deleted', body: 'removed', deletedAt: 'now' },
    ]
    const projected = projectPaperclipMessages(comments, sent, outputs)
    expect(projected.map((m) => m.id)).toEqual([
      'local-message',
      'paperclip-comment-team',
      'paperclip-run-run',
    ])
    expect(projected[0].parts).toEqual([{ type: 'text', text: 'edited' }])
    expect(projected[1].metadata?.authorUserId).toBe('teammate')
    const completed = projectPaperclipMessages(
      [
        ...comments,
        {
          id: 'answer',
          body: 'final',
          derivedAuthorAgentId: 'agent',
          derivedCreatedByRunId: 'run',
        },
      ],
      sent,
      outputs,
    )
    expect(completed.map((m) => m.id)).toEqual([
      'local-message',
      'paperclip-comment-team',
      'paperclip-comment-answer',
    ])
    expect(completed.at(-1)?.role).toBe('assistant')
    expect(projectPaperclipMessages(comments, sent, outputs)).toEqual(projected)
  })

  it('adapts remote snapshots to the existing conversation schema and propagates storage errors', async () => {
    const saved: unknown[] = []
    const sink = new DbConversationSink({
      save: async (value) => {
        saved.push(value)
        return { ...value, createdAt: 0, updatedAt: 0, lastMessagedAt: 0 }
      },
    })
    const messages = projectPaperclipMessages(
      [{ id: 'team', body: 'hello', authorUserId: 'team' }],
      {},
      {},
    )
    await sink.replace({
      conversationId: 'conversation',
      agentId: 'agent',
      messages,
    })
    expect(saved).toEqual([
      {
        id: 'conversation',
        agentId: 'agent',
        targetType: 'paperclip',
        messages,
      },
    ])
    const failed = new DbConversationSink({
      save: async () => {
        throw new Error('disk unavailable')
      },
    })
    await expect(
      failed.replace({
        conversationId: 'conversation',
        agentId: 'agent',
        messages,
      }),
    ).rejects.toThrow('disk unavailable')
  })
})
