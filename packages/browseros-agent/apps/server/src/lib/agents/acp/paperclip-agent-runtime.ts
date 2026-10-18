import type { AcpAgentDefinition } from '../agent-types'
import type { AcpAgentStreamInput } from './acp-agent-runtime'
import { paperclipAgentConfigs } from './paperclip-agent-config'
import { type BindingStore, FileBindingStore } from './paperclip-binding-store'
import {
  type PaperclipConnectionDeps,
  PaperclipConnectionRuntime,
} from './paperclip-connection-runtime'
import type { ConversationSink } from './paperclip-conversation'
import { DbConversationSink } from './paperclip-conversation-sink'
import type { AgentConfigProvider } from './paperclip-runtime-ports'
import { createPaperclipStream } from './paperclip-stream'

export { freshPaperclipConfig } from './paperclip-agent-config'
export { paperclipRequest } from './paperclip-client'

export interface PaperclipRuntimeDeps {
  createToolLease: PaperclipConnectionDeps['createToolLease']
  bindingStore?: BindingStore
  conversationSink?: ConversationSink
  agentConfigs?: AgentConfigProvider
  getAgent?: (id: string) => Promise<AcpAgentDefinition | null>
}

/** Composition boundary; preserve the existing ACP/HTTP lifecycle entry points. */
export class PaperclipAgentRuntime extends PaperclipConnectionRuntime {
  constructor(
    serverPort: number,
    stateDir: string,
    deps?: PaperclipRuntimeDeps,
  ) {
    super(serverPort, {
      bindingStore: deps?.bindingStore ?? new FileBindingStore(stateDir),
      conversationSink: deps?.conversationSink ?? new DbConversationSink(),
      agentConfigs: deps?.agentConfigs ?? {
        get: deps?.getAgent ?? ((id) => paperclipAgentConfigs.get(id)),
        fresh: (id, config) => paperclipAgentConfigs.fresh(id, config),
      },
      createToolLease: (scope, runId, signal) => {
        if (!deps)
          throw new Error('Persistent browser tools are not configured.')
        return deps.createToolLease(scope, runId, signal)
      },
    })
  }

  stream(input: AcpAgentStreamInput) {
    return createPaperclipStream(this, input)
  }
}
