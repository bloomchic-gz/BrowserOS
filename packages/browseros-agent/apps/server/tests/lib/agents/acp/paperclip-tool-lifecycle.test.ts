import { afterEach, describe, expect, it } from 'bun:test'
import { PaperclipConnectionRuntime } from '../../../../src/lib/agents/acp/paperclip-connection-runtime'
import type { BrowserToolResponse } from '../../../../src/lib/agents/acp/paperclip-runtime-ports'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check() && Date.now() < end) await Bun.sleep(10)
  expect(check()).toBe(true)
}

async function fixture(
  mode:
    | 'success'
    | 'pending'
    | 'throw'
    | 'reject-check'
    | 'reject-response'
    | 'hold-response',
) {
  const events: string[] = []
  const received: unknown[] = []
  const responseGate = Promise.withResolvers<void>()
  let sent = false
  let rejectCheck = mode === 'reject-check'
  let callSignal: AbortSignal | undefined
  const remote = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path.endsWith('/attach'))
        return Response.json({ leaseId: 'remote-lease' })
      if (path.endsWith('/poll')) {
        await Bun.sleep(15)
        const calls = sent
          ? []
          : [
              {
                id: 'call',
                runId: 'remote-run',
                request: {
                  jsonrpc: '2.0',
                  id: 7,
                  method: 'tools/call',
                  params: { name: 'tabs' },
                },
              },
            ]
        sent = true
        return Response.json({ calls })
      }
      if (path.endsWith('/check')) {
        events.push('check')
        return Response.json({}, { status: rejectCheck ? 403 : 200 })
      }
      if (path.endsWith('/respond')) {
        events.push('respond')
        received.push(await request.json())
        if (mode === 'hold-response') await responseGate.promise
        events.push('ack')
        return Response.json(
          {},
          { status: mode === 'reject-response' ? 503 : 200 },
        )
      }
      if (path.endsWith('/stop')) events.push('stop')
      if (path.endsWith('/detach')) events.push('detach')
      // Keep another run live so only the per-call watchdog can notice revocation.
      if (path.endsWith('/snapshot'))
        return Response.json({
          comments: [],
          liveRuns: [{ id: 'another-run' }],
          run: null,
        })
      if (path.endsWith('/messages'))
        return Response.json({ comments: [], next: null })
      return Response.json({})
    },
  })
  cleanup.push(() => remote.stop(true))
  const config = {
    url: remote.url.origin,
    token: 'test-token',
    clientId: 'client',
    remoteAgentId: 'agent',
  }
  const binding = {
    version: 1 as const,
    identity: `${remote.url.origin}:client:agent`,
    request: {},
    taskId: 'task',
    agentId: 'local',
    conversationId: 'conversation',
    enabled: true,
    readOnly: true,
  }
  const result = {
    jsonrpc: '2.0',
    id: 7,
    result: { content: [{ type: 'text', text: 'result' }] },
  }
  const runtime = new PaperclipConnectionRuntime({
    bindingStore: {
      async *list() {
        yield binding
      },
      open: async () => ({ binding, save: async () => {} }),
    },
    conversationSink: { replace: async () => {} },
    agentConfigs: {
      get: async () => ({
        id: 'local',
        type: 'paperclip',
        paperclipConfig: config,
      }),
      fresh: async (_id, value) => value,
    },
    browserTools: {
      acquire(scope, runId, signal) {
        events.push('acquire')
        expect(scope.conversationId).toBe('conversation')
        expect(scope.readOnly).toBe(true)
        expect(runId).toBe('remote-run')
        callSignal = signal
        return {
          call: async (request) => {
            events.push('call')
            expect(request.id).toBe(7)
            if (mode === 'throw') throw new Error('adapter failed')
            if (mode === 'pending')
              return new Promise<BrowserToolResponse>((resolve) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    events.push('abort')
                    resolve({
                      jsonrpc: '2.0',
                      id: 7,
                      error: { code: -32000, message: 'cancelled' },
                    })
                  },
                  { once: true },
                )
              })
            return result
          },
          release() {
            events.push('release')
          },
        }
      },
    },
  })
  cleanup.push(() => runtime.shutdown())
  cleanup.push(() => responseGate.resolve())
  await runtime.restore()
  return {
    runtime,
    events,
    received,
    result,
    signal: () => callSignal,
    revokeRemote: () => {
      rejectCheck = true
    },
    acknowledge: () => responseGate.resolve(),
  }
}

describe('BrowserToolAccess connection lifecycle', () => {
  it('checks remote authority before acquisition and retains local authority until result acknowledgement', async () => {
    const f = await fixture('hold-response')
    await until(() => f.events.includes('respond'))
    expect(f.events.slice(0, 4)).toEqual([
      'check',
      'acquire',
      'call',
      'respond',
    ])
    expect(f.events).not.toContain('release')
    expect(f.received).toEqual([{ callId: 'call', response: f.result }])
    f.acknowledge()
    await until(() => f.events.includes('release'))
    expect(f.events.indexOf('release')).toBeGreaterThan(f.events.indexOf('ack'))
    expect(f.signal()?.aborted).toBe(true)
  })

  it('does not acquire local authority for a rejected remote call', async () => {
    const f = await fixture('reject-check')
    await until(() => f.runtime.state('conversation')?.status === 'offline')
    expect(f.events).toEqual(['check'])
  })

  it.each(['throw', 'reject-response'] as const)(
    'releases local authority on %s without replay',
    async (mode) => {
      const f = await fixture(mode)
      await until(() => f.runtime.state('conversation')?.status === 'offline')
      expect(f.events.filter((event) => event === 'call')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'release')).toHaveLength(1)
      expect(f.signal()?.aborted).toBe(true)
      expect(f.received).toHaveLength(mode === 'throw' ? 0 : 1)
    },
  )

  it.each(['pause', 'stop', 'shutdown'] as const)(
    'aborts an in-flight tool and releases its authority on %s',
    async (action) => {
      const f = await fixture('pending')
      await until(() => f.events.includes('call'))
      if (action === 'shutdown') await f.runtime.shutdown()
      else await f.runtime.control('conversation', action)
      await until(() => f.events.includes('release'))
      expect(f.events.filter((event) => event === 'call')).toHaveLength(1)
      expect(f.events.filter((event) => event === 'release')).toHaveLength(1)
      expect(f.signal()?.aborted).toBe(true)
      if (action === 'stop') {
        expect(f.events).toContain('stop')
        expect(f.events).not.toContain('detach')
        expect(f.runtime.state('conversation')?.enabled).toBe(true)
        expect(f.received).toEqual([
          {
            callId: 'call',
            response: {
              jsonrpc: '2.0',
              id: 7,
              error: { code: -32000, message: 'cancelled' },
            },
          },
        ])
      } else {
        expect(f.events.indexOf('detach')).toBeGreaterThan(
          f.events.indexOf('release'),
        )
        expect(f.received).toHaveLength(0)
        if (action === 'pause')
          expect(f.runtime.state('conversation')?.status).toBe('paused')
      }
    },
  )

  it('aborts a remotely revoked call while another run remains live', async () => {
    const f = await fixture('pending')
    await until(() => f.events.includes('call'))
    f.revokeRemote()
    await until(() => f.events.includes('release'))
    expect(f.events).toContain('abort')
    expect(
      f.events.filter((event) => event === 'check').length,
    ).toBeGreaterThan(1)
    expect(f.events.filter((event) => event === 'release')).toHaveLength(1)
    expect(f.received).toHaveLength(1)
  })
})
