import { afterEach, describe, expect, it } from 'bun:test'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { DbAgentConfigProvider } from '../../../../src/lib/agents/acp/paperclip-agent-config'
import type { AcpAgentDefinition } from '../../../../src/lib/agents/agent-types'

const cleanup: Array<() => unknown> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function fixture() {
  let requests = 0
  let status = 200
  const bodies: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests++
      bodies.push(await request.json())
      return Response.json(
        {
          access_token: 'rotated-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        },
        { status },
      )
    },
  })
  cleanup.push(() => server.stop(true))
  const config: PaperclipAgentConfig = {
    url: server.url.origin,
    token: 'expired',
    clientId: 'browser',
    remoteAgentId: 'remote',
    oauthClientId: 'oauth-client',
    refreshToken: 'old-refresh',
    expiresAt: 1,
  }
  let agent: AcpAgentDefinition = {
    id: 'local',
    name: 'Remote',
    type: 'paperclip',
    createdAt: 0,
    updatedAt: 0,
    paperclipConfig: config,
  }
  let writes = 0
  let failSave = false
  const provider = new DbAgentConfigProvider(() => ({
    get: async () => agent,
    update: async (_id, update) => {
      writes++
      if (failSave) throw new Error('storage unavailable')
      agent = { ...agent, paperclipConfig: update.paperclipConfig }
      return agent
    },
  }))
  return {
    config,
    provider,
    bodies,
    stats: () => ({ requests, writes }),
    failHttp: () => {
      status = 401
    },
    recoverHttp: () => {
      status = 200
    },
    failSave: () => {
      failSave = true
    },
  }
}

describe('Paperclip AgentConfigProvider', () => {
  it('shares refresh across consumers, saves before returning, and reads the latest stored token', async () => {
    const f = fixture()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.provider.fresh('local', f.config)),
    )
    expect(f.stats()).toEqual({ requests: 1, writes: 1 })
    expect(results.every((result) => result.token === 'rotated-access')).toBe(
      true,
    )
    expect((await f.provider.get('local'))?.paperclipConfig).toEqual(results[0])
    expect(await f.provider.fresh('local', f.config)).toEqual(results[0])
    expect(f.stats()).toEqual({ requests: 1, writes: 1 })
    expect(f.bodies).toEqual([
      {
        grant_type: 'refresh_token',
        client_id: 'oauth-client',
        refresh_token: 'old-refresh',
        resource: `${f.config.url}/mcp/paperclip`,
      },
    ])
  })

  it('leaves static credentials independent of the database', async () => {
    const provider = new DbAgentConfigProvider(() => {
      throw new Error('must not access storage')
    })
    const config = {
      url: 'http://localhost',
      token: 'static',
      clientId: 'client',
      remoteAgentId: 'remote',
    }
    expect(await provider.fresh('local', config)).toBe(config)
  })

  it('clears a failed refresh so a later call can recover', async () => {
    const f = fixture()
    f.failHttp()
    await expect(f.provider.fresh('local', f.config)).rejects.toThrow(
      'Reconnect',
    )
    expect(f.stats().writes).toBe(0)
    f.recoverHttp()
    expect((await f.provider.fresh('local', f.config)).token).toBe(
      'rotated-access',
    )
    expect(f.stats()).toEqual({ requests: 2, writes: 1 })
  })

  it('propagates failed credential persistence rather than acknowledging the rotated token', async () => {
    const f = fixture()
    f.failSave()
    await expect(f.provider.fresh('local', f.config)).rejects.toThrow(
      'storage unavailable',
    )
    expect((await f.provider.get('local'))?.paperclipConfig?.token).toBe(
      'expired',
    )
  })
})
