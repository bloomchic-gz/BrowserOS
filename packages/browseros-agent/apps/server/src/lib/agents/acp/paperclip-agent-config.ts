import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { z } from 'zod'
import { type AcpAgentStore, DbAcpAgentStore } from '../storage/acp-agent-store'
import type { AgentConfigProvider } from './paperclip-runtime-ports'

const TokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
})

/** One provider instance shares OAuth refreshes across routes and workers. */
export class DbAgentConfigProvider implements AgentConfigProvider {
  private readonly refreshes = new Map<string, Promise<PaperclipAgentConfig>>()

  constructor(
    private readonly store: () => Pick<AcpAgentStore, 'get' | 'update'> = () =>
      new DbAcpAgentStore(),
  ) {}

  get(id: string) {
    return this.store().get(id)
  }

  async fresh(
    agentId: string,
    fallback: PaperclipAgentConfig,
  ): Promise<PaperclipAgentConfig> {
    if (!fallback.refreshToken || !fallback.oauthClientId) return fallback
    const pending = this.refreshes.get(agentId)
    if (pending) return pending
    const refresh = (async () => {
      const store = this.store()
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
    this.refreshes.set(agentId, refresh)
    try {
      return await refresh
    } finally {
      this.refreshes.delete(agentId)
    }
  }
}

export const paperclipAgentConfigs = new DbAgentConfigProvider()

export const freshPaperclipConfig = (
  agentId: string,
  fallback: PaperclipAgentConfig,
) => paperclipAgentConfigs.fresh(agentId, fallback)
