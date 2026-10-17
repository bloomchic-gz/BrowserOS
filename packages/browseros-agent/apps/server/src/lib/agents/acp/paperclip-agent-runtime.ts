import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { createUIMessageStream, type UIMessageChunk } from 'ai'
import { z } from 'zod'
import { BROWSEROS_TOOL_LEASE_HEADER } from '../../browser-tool-lease'
import { DbAcpAgentStore } from '../storage/acp-agent-store'
import type { AcpAgentStreamInput } from './acp-agent-runtime'

type Json = Record<string, unknown>
const SnapshotSchema = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      authorAgentId: z.string().nullish(),
      body: z.string(),
    }),
  ),
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
const PollSchema = z.object({
  calls: z.array(
    z.object({
      id: z.string(),
      request: z.object({
        jsonrpc: z.literal('2.0'),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
})
const ResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.number() }).optional(),
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
})
const TokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
})
type SentMessage = {
  requestId: string
  body: string
  settings?: { modelId: string | null; reasoningEffort: string | null }
  oldRun?: string
  commentIds: string[]
}
type Binding = {
  identity: string
  request: Json
  taskId?: string
  messages?: Record<string, SentMessage>
}
const refreshes = new Map<string, Promise<PaperclipAgentConfig>>()

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

export async function freshPaperclipConfig(
  agentId: string,
  fallback: PaperclipAgentConfig,
): Promise<PaperclipAgentConfig> {
  if (!fallback.refreshToken || !fallback.oauthClientId) return fallback
  const pending = refreshes.get(agentId)
  if (pending) return pending
  const refresh = (async () => {
    const store = new DbAcpAgentStore()
    const config = (await store.get(agentId))?.paperclipConfig ?? fallback
    if (
      config.expiresAt === undefined ||
      config.expiresAt > Date.now() + 60_000
    )
      return config
    const response = await fetch(
      `${new URL(config.url).origin}/mcp/oauth/token`,
      {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: config.oauthClientId,
          refresh_token: config.refreshToken,
          resource: `${new URL(config.url).origin}/mcp/paperclip`,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    )
    if (!response.ok) throw new Error('Reconnect your Paperclip account.')
    const tokens = TokensSchema.parse(await response.json())
    const next = {
      ...config,
      token: String(tokens.access_token),
      refreshToken: String(tokens.refresh_token),
      expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
    }
    await store.update(agentId, { paperclipConfig: next })
    return next
  })()
  refreshes.set(agentId, refresh)
  try {
    return await refresh
  } finally {
    refreshes.delete(agentId)
  }
}

async function callLocalBrowser(
  serverPort: number,
  input: AcpAgentStreamInput,
  request: z.infer<typeof PollSchema>['calls'][number]['request'],
  signal: AbortSignal,
) {
  let result: z.infer<typeof ResponseSchema>
  try {
    const response = await fetch(
      `http://127.0.0.1:${serverPort}/mcp${input.readOnly ? '?read_only=1' : ''}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          [BROWSEROS_TOOL_LEASE_HEADER]: input.browserToolLeaseToken,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
        redirect: 'error',
      },
    )
    if (!response.ok)
      throw new Error(`Local browser returned ${response.status}`)
    const raw = await response.text()
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => ResponseSchema.parse(JSON.parse(line.slice(5))))
      const found = events.find((event) => event.id === request.id)
      if (!found) throw new Error('Browser MCP response missing')
      result = found
    } else result = ResponseSchema.parse(JSON.parse(raw))
  } catch (error) {
    result = {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : 'Browser unavailable',
      },
    }
  }
  return result
}

async function loadBinding(
  stateDir: string,
  key: string,
  input: AcpAgentStreamInput,
  config: PaperclipAgentConfig,
  title: string,
) {
  const identity = `${new URL(config.url).origin}:${config.clientId}:${config.remoteAgentId}`
  const filename = join(
    stateDir,
    `${createHash('sha256').update(key).digest('hex')}.json`,
  )
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const save = async (binding: Binding) => {
    const tmp = `${filename}.${randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(binding), { mode: 0o600 })
    await rename(tmp, filename)
  }
  let binding: Binding
  try {
    binding = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    binding = {
      identity,
      request: {
        requestId: randomUUID(),
        conversationId: input.conversationId,
        clientId: config.clientId,
        agentId: config.remoteAgentId,
        title: (
          title.match(/<USER_QUERY>\s*([\s\S]*?)<\/USER_QUERY>/)?.[1] ?? title
        )
          .trim()
          .slice(0, 200),
      },
    }
    await save(binding)
  }
  if (binding.identity !== identity)
    throw new Error(
      'This conversation belongs to another Paperclip connection. Start a new conversation.',
    )

  return { binding, save }
}

export class PaperclipAgentRuntime {
  private active = new Map<string, AbortController>()
  constructor(
    private serverPort: number,
    private stateDir: string,
  ) {}

  close(agentId: string, conversationId?: string) {
    let count = 0
    for (const [key, controller] of this.active) {
      if (
        conversationId
          ? key === `${agentId}:${conversationId}`
          : key.startsWith(`${agentId}:`)
      ) {
        controller.abort()
        count++
      }
    }
    return count
  }

  stream(input: AcpAgentStreamInput): ReadableStream<UIMessageChunk> {
    const controller = new AbortController()
    const key = `${input.agent.id}:${input.conversationId}`
    this.active.set(key, controller)
    const signal = input.abortSignal
      ? AbortSignal.any([controller.signal, input.abortSignal])
      : controller.signal
    return createUIMessageStream({
      originalMessages: input.messages,
      onFinish: async ({ messages, isAborted }) =>
        input.onFinish?.({ messages, isAborted: isAborted || signal.aborted }),
      onError: (error) => {
        this.active.delete(key)
        return error instanceof Error
          ? error.message
          : 'Paperclip execution failed.'
      },
      execute: async ({ writer }) => {
        let taskId: string | undefined, leaseId: string | undefined
        let config = input.agent.paperclipConfig
        if (!config) throw new Error('Paperclip connection is not configured.')
        const polling = new AbortController()
        let pollJob: Promise<void> | undefined
        let pollError: unknown
        const api = async (
          path: string,
          body?: unknown,
          requestSignal: AbortSignal = signal,
        ) => {
          if (!config)
            throw new Error('Paperclip connection is not configured.')
          config = await freshPaperclipConfig(input.agent.id, config)
          return paperclipRequest(config, path, body, requestSignal)
        }
        let outputId: string | undefined
        const closeOutput = () => {
          if (outputId) writer.write({ type: 'text-end', id: outputId })
          outputId = undefined
        }
        const streamOutput = (delta: string) => {
          if (!outputId) {
            outputId = randomUUID()
            writer.write({ type: 'text-start', id: outputId })
          }
          writer.write({ type: 'text-delta', id: outputId, delta })
        }
        const text = (value: string) => {
          closeOutput()
          const id = randomUUID()
          writer.write({ type: 'text-start', id })
          writer.write({ type: 'text-delta', id, delta: value })
          writer.write({ type: 'text-end', id })
        }
        writer.write({ type: 'start', messageId: randomUUID() })
        try {
          const latest = input.messages.findLast((m) => m.role === 'user')
          const first = input.messages.find((m) => m.role === 'user')
          const content = (message: typeof latest) =>
            message?.parts
              .flatMap((p) => (p.type === 'text' ? [p.text] : []))
              .join('\n') ?? ''
          const body = content(latest)
          if (latest?.parts.some((part) => part.type === 'file'))
            throw new Error(
              'Paperclip conversations currently accept text. Add files directly to the linked Paperclip task.',
            )
          if (!body.trim() || !latest)
            throw new Error('A text message is required.')
          const { binding, save } = await loadBinding(
            this.stateDir,
            key,
            input,
            config,
            content(first) || body,
          )
          if (!binding.taskId) {
            const opened = z
              .object({ task: z.object({ id: z.string().uuid() }) })
              .parse(await api('/open', binding.request))
            binding.taskId = String(opened.task.id)
            await save(binding)
          }
          taskId = binding.taskId
          const baseline = SnapshotSchema.parse(
            await api(`/tasks/${taskId}/snapshot`),
          )
          if (baseline.taskUrl)
            text(`[Paperclip task](${baseline.taskUrl})\n\n`)
          binding.messages ??= {}
          let sent = binding.messages[latest.id]
          if (!sent) {
            sent = {
              requestId: randomUUID(),
              body,
              settings: {
                modelId: input.agent.modelId ?? null,
                reasoningEffort: input.agent.reasoningEffort ?? null,
              },
              oldRun: baseline.run?.id,
              commentIds: baseline.comments.map((c) => c.id),
            }
            binding.messages[latest.id] = sent
            await save(binding)
          }
          const seenComments = new Set(sent.commentIds)
          const oldRun = sent.oldRun
          const attached = z.object({ leaseId: z.string().uuid() }).parse(
            await api(`/tasks/${taskId}/attach`, {
              clientId: config.clientId,
            }),
          )
          leaseId = String(attached.leaseId)
          const pollSignal = AbortSignal.any([signal, polling.signal])
          pollJob = (async () => {
            while (!pollSignal.aborted) {
              const { calls } = PollSchema.parse(
                await api(`/leases/${leaseId}/poll`, {}, pollSignal),
              )
              for (const call of calls) {
                pollSignal.throwIfAborted()
                const request = call.request
                const tool = request.method === 'tools/call'
                if (tool)
                  writer.write({
                    type: 'tool-input-available',
                    toolCallId: call.id,
                    toolName: String(request.params?.name ?? ''),
                    input: request.params?.arguments ?? {},
                    dynamic: true,
                  })
                if (tool) closeOutput()
                const result = await callLocalBrowser(
                  this.serverPort,
                  input,
                  request,
                  pollSignal,
                )
                if (tool) {
                  if (result.error)
                    writer.write({
                      type: 'tool-output-error',
                      toolCallId: call.id,
                      errorText: String(result.error.message),
                      dynamic: true,
                    })
                  else
                    writer.write({
                      type: 'tool-output-available',
                      toolCallId: call.id,
                      output: result.result,
                      dynamic: true,
                    })
                }
                await api(
                  `/leases/${leaseId}/respond`,
                  { callId: call.id, response: result },
                  pollSignal,
                )
              }
            }
          })().catch((error) => {
            if (!pollSignal.aborted) pollError = error
          })
          await api(`/tasks/${taskId}/send`, {
            requestId: sent.requestId,
            body: sent.body,
            ...(sent.settings ? { settings: sent.settings } : {}),
          })
          let delivered = false
          let logRunId: string | undefined
          let logOffset = 0
          const deadline = Date.now() + 30 * 60_000
          while (Date.now() < deadline) {
            signal.throwIfAborted()
            if (pollError) throw pollError
            const snapshot = SnapshotSchema.parse(
              await api(`/tasks/${taskId}/snapshot?logOffset=${logOffset}`),
            )
            if (snapshot.run?.id !== logRunId) {
              logRunId = snapshot.run?.id
              logOffset = 0
            } else if (snapshot.run?.id !== oldRun && snapshot.output) {
              logOffset = snapshot.output.offset
              if (snapshot.output.text) {
                streamOutput(snapshot.output.text)
                delivered = true
              }
            }
            for (const comment of [...snapshot.comments].reverse()) {
              if (seenComments.has(comment.id)) continue
              seenComments.add(comment.id)
              if (comment.authorAgentId && comment.body) {
                text(String(comment.body))
                delivered = true
              }
            }
            const run = snapshot.run
            if (
              run &&
              run.id !== oldRun &&
              !['queued', 'running', 'scheduled_retry'].includes(run.status) &&
              !snapshot.liveRuns.length
            ) {
              if (run.status !== 'succeeded')
                throw new Error(
                  `Paperclip run ${run.status}. Open task ${taskId} for details.`,
                )
              if (!delivered)
                text(
                  String(
                    run.resultJson?.summary ?? `Task completed: ${taskId}`,
                  ),
                )
              closeOutput()
              writer.write({ type: 'finish' })
              return
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(done, 1000)
              function done() {
                clearTimeout(timer)
                signal.removeEventListener('abort', done)
                resolve()
              }
              signal.addEventListener('abort', done, { once: true })
            })
          }
          throw new Error(
            `Paperclip task is still pending: ${taskId}. Check its approval or scheduling state.`,
          )
        } finally {
          closeOutput()
          polling.abort()
          await pollJob
          if (signal.aborted && taskId)
            await api(
              `/tasks/${taskId}/stop`,
              {},
              AbortSignal.timeout(10_000),
            ).catch(() => {})
          if (leaseId)
            await api(
              `/leases/${leaseId}/detach`,
              {},
              AbortSignal.timeout(10_000),
            ).catch(() => {})
          this.active.delete(key)
        }
      },
    })
  }
}
