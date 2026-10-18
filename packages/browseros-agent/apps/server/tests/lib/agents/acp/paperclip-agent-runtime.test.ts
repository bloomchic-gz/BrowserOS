import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpAgentStreamInput } from '../../../../src/lib/agents/acp/acp-agent-runtime'
import { PaperclipAgentRuntime } from '../../../../src/lib/agents/acp/paperclip-agent-runtime'
import { FileBindingStore } from '../../../../src/lib/agents/acp/paperclip-binding-store'
import { PaperclipConnectionRuntime } from '../../../../src/lib/agents/acp/paperclip-connection-runtime'
import { DbConversationSink } from '../../../../src/lib/agents/acp/paperclip-conversation-sink'
import type { PaperclipTurnEvent } from '../../../../src/lib/agents/acp/paperclip-runtime-ports'
import { BROWSEROS_TOOL_LEASE_HEADER } from '../../../../src/lib/browser-tool-lease'

setDefaultTimeout(30000)
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop()
})
async function fixture(outcome?: 'rejected' | 'unknown') {
  const dir = await mkdtemp(join(tmpdir(), 'paperclip-runtime-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const tasks = new Map<string, { run: string | null; receipts: Set<string> }>()
  const comments: Array<{ id: string; body: string; authorAgentId?: string }> =
    []
  const sent: Array<{ requestId: string; body: string }> = []
  const tools: Array<{ url: string; lease: string | null }> = []
  let opens = 0,
    stops = 0,
    running = false,
    toolPending = true
  const mcp = Bun.serve({
    port: 0,
    fetch(request) {
      tools.push({
        url: request.url,
        lease: request.headers.get(BROWSEROS_TOOL_LEASE_HEADER),
      })
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'browser result' }] },
      })
    },
  })
  cleanup.push(() => mcp.stop(true))
  const remote = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get('authorization') !== 'Bearer fixture-token')
        return new Response('', { status: 401 })
      const url = new URL(request.url)
      const path = url.pathname.replace('/api/browseros', '')
      if (path === '/open') {
        opens++
        const id = crypto.randomUUID()
        tasks.set(id, { run: null, receipts: new Set() })
        return Response.json({ task: { id } })
      }
      if (path.endsWith('/attach'))
        return Response.json({ leaseId: crypto.randomUUID() })
      if (path.endsWith('/poll')) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        const calls = toolPending
          ? [
              {
                id: crypto.randomUUID(),
                runId: 'remote-run',
                request: {
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'tools/call',
                  params: { name: 'tabs', arguments: { action: 'list' } },
                },
              },
            ]
          : []
        toolPending = false
        return Response.json({ calls })
      }
      if (
        path.endsWith('/respond') ||
        path.endsWith('/detach') ||
        path.endsWith('/check')
      )
        return Response.json({ ok: true })
      const task = tasks.get(path.split('/')[2])
      if (!task) return new Response('', { status: 404 })
      if (path.endsWith('/send')) {
        if (outcome)
          return Response.json({ outcome, message: 'Task state conflict' })
        const message = (await request.json()) as {
          requestId: string
          body: string
        }
        sent.push(message)
        if (!task.receipts.has(message.requestId)) {
          task.run = crypto.randomUUID()
          task.receipts.add(message.requestId)
        }
        return Response.json({ ok: true })
      }
      if (path.endsWith('/stop')) {
        stops++
        running = false
        return Response.json({ ok: true })
      }
      if (path.endsWith('/messages'))
        return Response.json({ comments, next: null })
      if (path.endsWith('/snapshot'))
        return Response.json({
          comments: [],
          liveRuns: running ? [{}] : [],
          run: task.run
            ? {
                id: task.run,
                status: running ? 'running' : 'succeeded',
                resultJson: { summary: 'complete' },
              }
            : null,
        })
      return new Response('', { status: 404 })
    },
  })
  cleanup.push(() => remote.stop(true))
  const input: AcpAgentStreamInput = {
    agent: {
      id: crypto.randomUUID(),
      name: 'Remote',
      type: 'paperclip',
      createdAt: 0,
      updatedAt: 0,
      paperclipConfig: {
        url: remote.url.origin,
        token: 'fixture-token',
        clientId: crypto.randomUUID(),
        remoteAgentId: crypto.randomUUID(),
      },
    },
    conversationId: crypto.randomUUID(),
    browserToolLeaseToken: 'local-lease',
    readOnly: true,
    messages: [
      {
        id: 'user-message-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Read the page' }],
      },
    ],
  }
  const saved: unknown[] = []
  let failures = 0
  const runtime = () => {
    const instance = new PaperclipAgentRuntime(mcp.port ?? 0, dir, {
      createToolLease: () => ({
        token: 'local-lease',
        revoke() {},
        updateBrowserContext() {},
      }),
      conversationSink: new DbConversationSink({
        save: async (value) => {
          if (failures > 0) {
            failures--
            throw new Error('disk unavailable')
          }
          saved.push(value)
          return { ...value, createdAt: 0, updatedAt: 0, lastMessagedAt: 0 }
        },
      }),
      getAgent: async () => input.agent,
    })
    cleanup.push(() => instance.shutdown())
    return instance
  }
  const read = async (instance: PaperclipAgentRuntime, value = input) => {
    const chunks = []
    for await (const chunk of instance.stream(value)) chunks.push(chunk)
    await instance.shutdown()
    return chunks
  }
  return {
    dir,
    mcpPort: mcp.port ?? 0,
    input,
    saved,
    failNextSave: () => {
      failures++
    },
    runtime,
    read,
    sent,
    tools,
    stats: () => ({ opens, stops }),
    runForever: () => {
      running = true
    },
    tasks,
    comments,
    async until(check: () => boolean) {
      const deadline = Date.now() + 8000
      while (!check() && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 30))
      expect(check()).toBe(true)
    },
  }
}

describe('Paperclip native conversation runtime', () => {
  it('runs the connection core through injected storage/config and domain events without a UI stream', async () => {
    const f = await fixture()
    const refreshed: string[] = []
    const snapshots: unknown[] = []
    const runtime = new PaperclipConnectionRuntime(f.mcpPort, {
      bindingStore: new FileBindingStore(f.dir),
      conversationSink: {
        replace: async (value) => {
          snapshots.push(value)
        },
      },
      agentConfigs: {
        get: async () => f.input.agent,
        fresh: async (id, config) => {
          refreshed.push(id)
          return config
        },
      },
      createToolLease: () => ({
        token: 'local-lease',
        revoke() {},
        updateBrowserContext() {},
      }),
    })
    cleanup.push(() => runtime.shutdown())
    const events: PaperclipTurnEvent[] = []
    const turn = runtime.beginTurn({
      agent: f.input.agent,
      conversationId: f.input.conversationId,
      readOnly: true,
      message: {
        id: 'core-message',
        body: 'Read the page',
        hasAttachments: false,
      },
    })
    await turn.execute((event) => {
      events.push(event)
    })
    expect(events[0]).toEqual({ type: 'start' })
    expect(events.at(-1)).toEqual({ type: 'finish' })
    expect(events).toContainEqual({ type: 'text', text: 'complete' })
    expect(f.sent).toHaveLength(1)
    expect(f.stats().opens).toBe(1)
    expect(refreshed.length).toBeGreaterThan(1)
    expect(refreshed.every((id) => id === f.input.agent.id)).toBe(true)
    f.comments.push({
      id: 'core-team',
      body: 'Team reply after observer finished',
    })
    await f.until(() => JSON.stringify(snapshots).includes('core-team'))
    expect(runtime.state(f.input.conversationId)?.status).toBe('online')
    expect(f.sent).toHaveLength(1)
  })

  it('keeps working after foreground completion, syncs team messages once, and restores paused connections', async () => {
    const f = await fixture()
    const runtime = f.runtime()
    for await (const _ of runtime.stream(f.input)) {
      /* Drain foreground only. */
    }
    expect(runtime.state(f.input.conversationId)?.status).toBe('online')
    f.comments.push({ id: 'team-comment', body: 'Continue from teammate' })
    await f.until(
      () =>
        runtime
          .state(f.input.conversationId)
          ?.messages.some((m) => m.id === 'paperclip-comment-team-comment') ??
        false,
    )
    await runtime.control(f.input.conversationId, 'pause')
    expect(runtime.state(f.input.conversationId)?.status).toBe('paused')
    f.comments[0].body = 'Edited by teammate'
    await f.until(() =>
      JSON.stringify(runtime.state(f.input.conversationId)?.messages).includes(
        'Edited by teammate',
      ),
    )
    await runtime.shutdown()
    const restored = f.runtime()
    await restored.restore()
    expect(restored.state(f.input.conversationId)?.enabled).toBe(false)
    await restored.control(f.input.conversationId, 'resume')
    await f.until(
      () => restored.state(f.input.conversationId)?.status === 'online',
    )
    expect(
      restored
        .state(f.input.conversationId)
        ?.messages.filter((m) => m.id === 'paperclip-comment-team-comment'),
    ).toHaveLength(1)
    expect(f.sent).toHaveLength(1)
    await restored.forget(f.input.conversationId)
    const deleted = f.runtime()
    await deleted.restore()
    expect(deleted.state(f.input.conversationId)).toBeNull()
  })
  it('retries a failed conversation write before acknowledging synchronized messages', async () => {
    const f = await fixture()
    const runtime = f.runtime()
    for await (const _ of runtime.stream(f.input)) {
    }
    f.failNextSave()
    f.comments.push({ id: 'disk-retry', body: 'Must reach durable history' })
    await f.until(() => JSON.stringify(f.saved).includes('disk-retry'))
    expect(
      runtime
        .state(f.input.conversationId)
        ?.messages.filter((m) => m.id === 'paperclip-comment-disk-retry'),
    ).toHaveLength(1)
    expect(f.sent).toHaveLength(1)
  })
  it('persists task and mutation identity across restart and repeated delivery', async () => {
    const f = await fixture()
    expect(
      (await f.read(f.runtime())).some((chunk) => chunk.type === 'finish'),
    ).toBe(true)
    await f.read(f.runtime())
    expect(f.stats().opens).toBe(1)
    expect(f.sent[1]).toEqual(f.sent[0])
    expect([...f.tasks.values()][0].receipts.size).toBe(1)
    f.input.messages.push({
      id: 'user-message-2',
      role: 'user',
      parts: [{ type: 'text', text: 'Continue' }],
    })
    await f.read(f.runtime())
    expect(f.stats().opens).toBe(1)
    expect([...f.tasks.values()][0].receipts.size).toBe(2)
    await f.read(f.runtime(), {
      ...f.input,
      conversationId: crypto.randomUUID(),
    })
    expect(f.stats().opens).toBe(2)
  })
  it('keeps the local lease and read-only boundary on reverse tool calls', async () => {
    const f = await fixture()
    f.runForever()
    const runtime = f.runtime()
    const result = f.read(runtime)
    while (f.tools.length === 0)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.tools[0].lease).toBe('local-lease')
    expect(new URL(f.tools[0].url).searchParams.get('read_only')).toBe('1')
    runtime.close(f.input.agent.id, f.input.conversationId)
    await result
    expect(f.stats().stops).toBe(1)
  })
  it('rejects retargeting a saved conversation to another connection', async () => {
    const f = await fixture()
    await f.read(f.runtime())
    const config = f.input.agent.paperclipConfig
    if (!config) throw new Error('Missing fixture config')
    f.input.agent.paperclipConfig = {
      ...config,
      remoteAgentId: crypto.randomUUID(),
    }
    const result = await f.read(f.runtime())
    expect(
      result.some(
        (chunk) =>
          chunk.type === 'error' &&
          chunk.errorText.includes('another Paperclip connection'),
      ),
    ).toBe(true)
    expect(f.stats().opens).toBe(1)
  })
  it('freezes settings on retries and applies edits to the next message on the same task', async () => {
    const f = await fixture()
    f.input.agent.modelId = 'gpt-6-astra'
    f.input.agent.reasoningEffort = 'high'
    await f.read(f.runtime())
    expect(f.sent[0]).toMatchObject({
      settings: { modelId: 'gpt-6-astra', reasoningEffort: 'high' },
    })
    f.input.agent.modelId = 'gpt-6-luna'
    f.input.agent.reasoningEffort = 'low'
    await f.read(f.runtime())
    expect(f.sent[1]).toEqual(f.sent[0])
    f.input.messages.push({
      id: 'new-settings',
      role: 'user',
      parts: [{ type: 'text', text: 'Continue with new settings' }],
    })
    await f.read(f.runtime())
    expect(f.sent[2]).toMatchObject({
      settings: { modelId: 'gpt-6-luna', reasoningEffort: 'low' },
    })
    expect(f.stats().opens).toBe(1)
    f.input.agent.modelId = undefined
    f.input.agent.reasoningEffort = undefined
    f.input.messages.push({
      id: 'default-settings',
      role: 'user',
      parts: [{ type: 'text', text: 'Use defaults' }],
    })
    await f.read(f.runtime())
    expect(f.sent[3]).toMatchObject({
      settings: { modelId: null, reasoningEffort: null },
    })
    f.input.messages.push({
      id: 'unchanged-settings',
      role: 'user',
      parts: [{ type: 'text', text: 'Keep remotely edited Task settings' }],
    })
    await f.read(f.runtime())
    expect(f.sent.at(-1)).not.toHaveProperty('settings')
  })
  it.each(['rejected', 'unknown'] as const)(
    'surfaces a %s receipt without waiting for a run',
    async (outcome) => {
      const f = await fixture(outcome)
      const chunks = await f.read(f.runtime())
      expect(
        chunks.some(
          (c) =>
            c.type === 'error' &&
            c.errorText.includes(
              outcome === 'rejected' ? 'rejected' : 'could not confirm',
            ),
        ),
      ).toBe(true)
      expect([...f.tasks.values()][0].run).toBeNull()
    },
  )
})
