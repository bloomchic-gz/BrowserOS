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
