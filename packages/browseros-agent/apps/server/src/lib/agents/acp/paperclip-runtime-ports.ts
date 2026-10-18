import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import type { BrowserContext } from '@browseros/shared/schemas/browser-context'

/** The connection core only consumes these fields, never provider DB rows. */
export interface PaperclipAgent {
  id: string
  type: string
  paperclipConfig?: PaperclipAgentConfig
  modelId?: string
  reasoningEffort?: string
}

export interface AgentConfigProvider {
  get(id: string): Promise<PaperclipAgent | null>
  fresh(
    id: string,
    fallback: PaperclipAgentConfig,
  ): Promise<PaperclipAgentConfig>
}

export interface PaperclipScope {
  conversationId: string
  readOnly: boolean
  browserContext?: BrowserContext
}

/** The UI adapter extracts only the latest local user message. */
export interface PaperclipTurnInput extends PaperclipScope {
  agent: PaperclipAgent
  message?: { id: string; body: string; hasAttachments: boolean }
  abortSignal?: AbortSignal
}

export type PaperclipTurnEvent =
  | { type: 'start' }
  | { type: 'text'; text: string }
  | { type: 'finish' }

export interface BrowserToolRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface BrowserToolResponse {
  jsonrpc?: string
  id?: string | number | null
  result?: unknown
  error?: { message: string; code: number }
}

/** Call-scoped local authority. The core releases it after result delivery settles. */
export interface BrowserToolAccess {
  acquire(
    scope: PaperclipScope,
    runId: string,
    signal: AbortSignal,
  ): {
    call(request: BrowserToolRequest): Promise<BrowserToolResponse>
    release(): void
  }
}
