import { randomUUID } from 'node:crypto'
import { createUIMessageStream } from 'ai'
import type { AcpAgentStreamInput } from './acp-agent-runtime'
import type { PaperclipConnectionRuntime } from './paperclip-connection-runtime'

/** AI SDK input/output mapping; the persistent connection outlives this view. */
export function createPaperclipStream(
  runtime: Pick<PaperclipConnectionRuntime, 'beginTurn' | 'state'>,
  input: AcpAgentStreamInput,
) {
  const latest = input.messages.findLast((message) => message.role === 'user')
  const turn = runtime.beginTurn({
    agent: input.agent,
    conversationId: input.conversationId,
    readOnly: input.readOnly,
    browserContext: input.browserContext,
    abortSignal: input.abortSignal,
    message: latest && {
      id: latest.id,
      body: latest.parts
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n'),
      hasAttachments: latest.parts.some((part) => part.type === 'file'),
    },
  })
  return createUIMessageStream({
    originalMessages: input.messages,
    onFinish: async () =>
      input.onFinish?.({
        messages:
          runtime.state(input.conversationId)?.messages ?? input.messages,
        isAborted: turn.signal.aborted,
      }),
    onError: (error) =>
      error instanceof Error ? error.message : 'Paperclip execution failed',
    execute: async ({ writer }) => {
      let textId = ''
      await turn.execute((event) => {
        if (event.type === 'start') {
          textId = randomUUID()
          writer.write({
            type: 'start',
            messageId: `paperclip-observer-${textId}`,
          })
          writer.write({ type: 'text-start', id: textId })
        } else if (event.type === 'text') {
          writer.write({ type: 'text-delta', id: textId, delta: event.text })
        } else {
          writer.write({ type: 'text-end', id: textId })
          writer.write({ type: 'finish' })
        }
      })
    },
  })
}
