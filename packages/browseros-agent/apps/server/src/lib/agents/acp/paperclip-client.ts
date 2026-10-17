import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { z } from 'zod'
import { BROWSEROS_TOOL_LEASE_HEADER } from '../../browser-tool-lease'

import { DbAcpAgentStore } from '../storage/acp-agent-store'
import type { AcpAgentStreamInput } from './acp-agent-runtime'

type Json = Record<string, unknown>
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
export type SentMessage = {
  requestId: string
  body: string
  settings?: { modelId: string | null; reasoningEffort: string | null }
  oldRun?: string
  commentIds: string[]
}
export type Binding = {
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

export async function callLocalBrowser(
  serverPort: number,
  input: Pick<AcpAgentStreamInput, 'readOnly' | 'browserToolLeaseToken'>,
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

export async function loadBinding(
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
  let saves: Promise<void> = Promise.resolve()
  const save = (binding: Binding) => {
    const content = JSON.stringify(binding)
    const next = saves.then(async () => {
      const tmp = `${filename}.${randomUUID()}.tmp`
      await writeFile(tmp, content, { mode: 0o600 })
      await rename(tmp, filename)
    })
    saves = next.catch(() => undefined)
    return next
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
