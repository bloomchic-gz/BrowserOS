import { afterEach, describe, expect, it } from 'bun:test'
import { LocalMcpBrowserToolAccess } from '../../../../src/lib/agents/acp/paperclip-browser-tool-access'
import type { BrowserToolRequest } from '../../../../src/lib/agents/acp/paperclip-runtime-ports'
import { BROWSEROS_TOOL_LEASE_HEADER } from '../../../../src/lib/browser-tool-lease'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const request: BrowserToolRequest = {
  jsonrpc: '2.0',
  id: 42,
  method: 'tools/call',
  params: { name: 'tabs', arguments: { action: 'list' } },
}
const scope = { conversationId: 'conversation', readOnly: true }

function fixture(handler: (r: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler })
  cleanup.push(() => server.stop(true))
  const leases: unknown[] = []
  let revoked = 0
  const access = new LocalMcpBrowserToolAccess(
    server.port ?? 0,
    (value, runId, signal) => {
      leases.push({ scope: value, runId, signal })
      return {
        token: 'private-local-token',
        revoke() {
          revoked++
        },
        updateBrowserContext() {},
      }
    },
  )
  return { access, leases, revoked: () => revoked }
}

describe('Local MCP BrowserToolAccess adapter', () => {
  it('pins scope/run/cancellation, hides the token and preserves read-only transport and JSON result', async () => {
    const received: unknown[] = []
    const result = {
      jsonrpc: '2.0',
      id: 42,
      result: { content: [{ type: 'text', text: 'tabs' }] },
    }
    const f = fixture(async (r) => {
      received.push({
        method: r.method,
        path: new URL(r.url).pathname + new URL(r.url).search,
        token: r.headers.get(BROWSEROS_TOOL_LEASE_HEADER),
        accept: r.headers.get('accept'),
        body: await r.json(),
      })
      return Response.json(result)
    })
    const controller = new AbortController()
    const scoped = {
      ...scope,
      browserContext: { windowId: 3, activeTab: { id: 7 } },
    }
    const grant = f.access.acquire(scoped, 'run', controller.signal)
    expect(f.leases).toEqual([
      { scope: scoped, runId: 'run', signal: controller.signal },
    ])
    expect(grant).not.toHaveProperty('token')
    expect(await grant.call(request)).toEqual(result)
    expect(received).toEqual([
      {
        method: 'POST',
        path: '/mcp?read_only=1',
        token: 'private-local-token',
        accept: 'application/json, text/event-stream',
        body: request,
      },
    ])
    expect(f.revoked()).toBe(0)
    grant.release()
    expect(f.revoked()).toBe(1)
  })

  it('uses the matching SSE response and keeps writable requests on the normal MCP endpoint', async () => {
    const f = fixture((r) => {
      expect(new URL(r.url).search).toBe('')
      return new Response(
        'data: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\ndata: {"id":1,"result":"other"}\r\n\r\ndata: {"jsonrpc":"2.0","id":42,"error":{"code":-32602,"message":"invalid tool"}}\r\n\r\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const grant = f.access.acquire(
      { ...scope, readOnly: false },
      'run',
      new AbortController().signal,
    )
    expect(await grant.call(request)).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32602, message: 'invalid tool' },
    })
    grant.release()
  })

  it.each([
    'http-error',
    'invalid-json',
    'missing-sse-response',
    'redirect',
  ] as const)(
    'converts %s to the existing RPC error without replaying a tool',
    async (mode) => {
      let calls = 0
      const f = fixture(() => {
        calls++
        if (mode === 'http-error') return new Response('', { status: 503 })
        if (mode === 'invalid-json') return new Response('not JSON')
        if (mode === 'redirect')
          return new Response('', {
            status: 302,
            headers: { location: 'http://127.0.0.1:1/mcp' },
          })
        return new Response('data: {"id":99,"result":{}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      })
      const grant = f.access.acquire(scope, 'run', new AbortController().signal)
      const result = await grant.call(request)
      expect(result).toMatchObject({
        jsonrpc: '2.0',
        id: 42,
        error: { code: -32000 },
      })
      expect(result.error?.message).toBeTruthy()
      expect(calls).toBe(1)
      grant.release()
      expect(f.revoked()).toBe(1)
    },
  )

  it('aborts an in-flight HTTP call with the supplied run signal and retains the response ID', async () => {
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<Response>()
    const f = fixture(() => {
      started.resolve()
      return finish.promise
    })
    cleanup.push(() => finish.resolve(Response.json({})))
    const controller = new AbortController()
    const grant = f.access.acquire(scope, 'run', controller.signal)
    const pending = grant.call(request)
    await started.promise
    controller.abort()
    expect(await pending).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32000 },
    })
    grant.release()
    expect(f.revoked()).toBe(1)
  })
})
