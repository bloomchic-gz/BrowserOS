import { z } from 'zod'
import type { BrowserToolLease } from '../../../api/services/mcp/browser-mcp-module'
import { BROWSEROS_TOOL_LEASE_HEADER } from '../../browser-tool-lease'
import type {
  BrowserToolAccess,
  BrowserToolRequest,
  BrowserToolResponse,
  PaperclipScope,
} from './paperclip-runtime-ports'

export type BrowserToolLeaseFactory = (
  scope: PaperclipScope,
  runId: string,
  signal: AbortSignal,
) => BrowserToolLease

/** Keeps local lease tokens and MCP transport details outside the connection core. */
export class LocalMcpBrowserToolAccess implements BrowserToolAccess {
  constructor(
    private readonly serverPort: number,
    private readonly createToolLease: BrowserToolLeaseFactory,
  ) {}

  acquire(scope: PaperclipScope, runId: string, signal: AbortSignal) {
    const lease = this.createToolLease(scope, runId, signal)
    if (!lease) throw new Error('Persistent browser tools are not configured.')
    return {
      call: (request: BrowserToolRequest) =>
        callLocalBrowser(
          this.serverPort,
          { readOnly: scope.readOnly, browserToolLeaseToken: lease.token },
          request,
          signal,
        ),
      release: () => lease.revoke(),
    }
  }
}

const ResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string(), code: z.number() }).optional(),
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
})

async function callLocalBrowser(
  serverPort: number,
  input: { readOnly: boolean; browserToolLeaseToken: string },
  request: BrowserToolRequest,
  signal: AbortSignal,
): Promise<BrowserToolResponse> {
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
