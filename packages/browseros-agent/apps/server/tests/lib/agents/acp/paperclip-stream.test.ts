import { describe, expect, it } from 'bun:test'
import type { AcpAgentStreamInput } from '../../../../src/lib/agents/acp/acp-agent-runtime'
import type { PaperclipTurnInput } from '../../../../src/lib/agents/acp/paperclip-runtime-ports'
import { createPaperclipStream } from '../../../../src/lib/agents/acp/paperclip-stream'

const input: AcpAgentStreamInput = {
  agent: {
    id: 'agent',
    type: 'paperclip',
    name: 'Remote',
    createdAt: 0,
    updatedAt: 0,
  },
  conversationId: 'conversation',
  readOnly: true,
  browserToolLeaseToken: 'private-lease',
  messages: [
    { id: 'old', role: 'user', parts: [{ type: 'text', text: 'old message' }] },
    {
      id: 'latest',
      role: 'user',
      parts: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    },
    {
      id: 'remote',
      role: 'assistant',
      parts: [{ type: 'text', text: 'synced answer' }],
    },
  ],
}

describe('Paperclip foreground stream adapter', () => {
  it('submits only the latest user message and maps events with consistent stream IDs', async () => {
    let submitted: PaperclipTurnInput | undefined
    const finished: unknown[] = []
    const messages = [
      {
        id: 'durable-answer',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'stored result' }],
      },
    ]
    const chunks = []
    const stream = createPaperclipStream(
      {
        beginTurn: (value) => {
          submitted = value
          return {
            signal: new AbortController().signal,
            execute: async (emit) => {
              emit({ type: 'start' })
              emit({ type: 'text', text: 'partial' })
              emit({ type: 'text', text: ' result' })
              emit({ type: 'finish' })
            },
          }
        },
        state: () => ({
          enabled: true,
          status: 'online',
          taskId: 'task',
          readOnly: true,
          error: undefined,
          taskUrl: undefined,
          run: undefined,
          messages,
        }),
      },
      {
        ...input,
        onFinish: (result) => {
          finished.push(result)
        },
      },
    )
    for await (const chunk of stream) chunks.push(chunk)
    expect(submitted?.message).toEqual({
      id: 'latest',
      body: 'first\nsecond',
      hasAttachments: false,
    })
    expect(submitted).not.toHaveProperty('browserToolLeaseToken')
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ])
    const start = chunks.find((chunk) => chunk.type === 'text-start')
    for (const chunk of chunks)
      if ('id' in chunk) expect(chunk.id).toBe(start?.id)
    expect(finished).toEqual([{ messages, isAborted: false }])
  })

  it('preserves attachments for core rejection and surfaces errors without a false finish', async () => {
    let submitted: PaperclipTurnInput | undefined
    const finished: unknown[] = []
    const controller = new AbortController()
    const chunks = []
    for await (const chunk of createPaperclipStream(
      {
        beginTurn: (value) => {
          submitted = value
          return {
            signal: controller.signal,
            execute: async () => {
              controller.abort()
              throw new Error('connection failed')
            },
          }
        },
        state: () => null,
      },
      {
        ...input,
        messages: [
          {
            id: 'file',
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'text/plain',
                url: 'https://example.com/file',
              },
            ],
          },
        ],
        onFinish: (result) => {
          finished.push(result)
        },
      },
    ))
      chunks.push(chunk)
    expect(submitted?.message?.hasAttachments).toBe(true)
    expect(chunks).toEqual([{ type: 'error', errorText: 'connection failed' }])
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ isAborted: true })
  })
})
