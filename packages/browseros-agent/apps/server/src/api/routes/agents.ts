/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  AcpAgentTypeSchema,
  CustomAcpAgentConfigSchema,
  PaperclipAgentConfigSchema,
} from '@browseros/shared/schemas/agent'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AcpAgentDefinition } from '../../lib/agents/agent-types'
import {
  type AcpAgentStore,
  DbAcpAgentStore,
} from '../../lib/agents/storage/acp-agent-store'
import { logger } from '../../lib/logger'
import type { Env } from '../types'

const PaperclipUrlSchema = PaperclipAgentConfigSchema.pick({ url: true })
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'
async function oauthRequest(url: string, path: string, body: unknown) {
  const response = await fetch(`${new URL(url).origin}/mcp/oauth/${path}`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const result = (await response.json()) as Record<string, unknown>
  if (
    !response.ok &&
    result.error !== 'authorization_pending' &&
    result.error !== 'slow_down'
  )
    throw new Error(
      'Paperclip authorization failed. Check the URL and Public MCP setting.',
    )
  return result
}

function createPaperclipConnectionRoutes(): Hono<Env> {
  return new Hono<Env>()
    .post('/connect', zValidator('json', PaperclipUrlSchema), async (c) => {
      const { url } = c.req.valid('json')
      const client = await oauthRequest(url, 'register', {
        client_name: 'BrowserOS',
        redirect_uris: [],
        grant_types: [deviceGrant, 'refresh_token'],
        token_endpoint_auth_method: 'none',
      })
      const device = await oauthRequest(url, 'device_authorization', {
        client_id: client.client_id,
        resource: `${new URL(url).origin}/mcp/paperclip`,
        scope: 'paperclip:read paperclip:write offline_access',
      })
      return c.json({ ...device, client_id: client.client_id })
    })
    .post(
      '/token',
      zValidator(
        'json',
        PaperclipUrlSchema.extend({
          clientId: z.string().min(1),
          deviceCode: z.string().min(1),
        }),
      ),
      async (c) => {
        const { url, clientId, deviceCode } = c.req.valid('json')
        return c.json(
          await oauthRequest(url, 'token', {
            grant_type: deviceGrant,
            client_id: clientId,
            device_code: deviceCode,
            resource: `${new URL(url).origin}/mcp/paperclip`,
          }),
        )
      },
    )
    .post(
      '/connection',
      zValidator(
        'json',
        PaperclipUrlSchema.extend({ token: z.string().min(1) }),
      ),
      async (c) => {
        const { url, token } = c.req.valid('json')
        const response = await fetch(
          `${new URL(url).origin}/api/browseros/connection`,
          {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'error',
            signal: AbortSignal.timeout(15_000),
          },
        )
        if (!response.ok)
          return c.json({ error: 'Paperclip connection failed' }, 400)
        return c.json(await response.json())
      },
    )
}

const AgentIdParamsSchema = z.object({ agentId: z.string().uuid() })

const CreateAcpAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: AcpAgentTypeSchema,
    modelId: z.string().trim().min(1).optional(),
    reasoningEffort: z.string().trim().min(1).optional(),
    workingDirectory: z.string().trim().min(1).optional(),
    customConfig: CustomAcpAgentConfigSchema.optional(),
    paperclipConfig: PaperclipAgentConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.type === 'paperclip') !== Boolean(value.paperclipConfig))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'paperclipConfig is required only for Paperclip agents',
        path: ['paperclipConfig'],
      })
    if (value.type === 'custom' && !value.customConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customConfig is required for custom agents',
        path: ['customConfig'],
      })
    }
    if (value.type !== 'custom' && value.customConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'customConfig is only allowed for custom agents',
        path: ['customConfig'],
      })
    }
  })

const UpdateAcpAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    modelId: z.string().trim().min(1).nullable().optional(),
    reasoningEffort: z.string().trim().min(1).nullable().optional(),
    workingDirectory: z.string().trim().min(1).nullable().optional(),
    customConfig: CustomAcpAgentConfigSchema.optional(),
    paperclipConfig: PaperclipAgentConfigSchema.optional(),
  })
  .strict()

type AgentRouteStore = Pick<
  AcpAgentStore,
  'list' | 'get' | 'create' | 'update' | 'delete'
>

function publicAgent(agent: AcpAgentDefinition) {
  const { paperclipConfig, ...rest } = agent
  return {
    ...rest,
    ...(paperclipConfig
      ? {
          paperclipConfig: {
            url: paperclipConfig.url,
            remoteAgentId: paperclipConfig.remoteAgentId,
            clientId: paperclipConfig.clientId,
          },
        }
      : {}),
  }
}

export function createAgentRoutes(
  options: {
    store?: AgentRouteStore
    onDelete?: (agentId: string) => Promise<unknown>
    onUpdate?: (agentId: string) => Promise<unknown>
  } = {},
) {
  const store = options.store ?? new DbAcpAgentStore()

  return new Hono<Env>()
    .route('/paperclip', createPaperclipConnectionRoutes())
    .get('/', async (c) =>
      c.json({ agents: (await store.list()).map(publicAgent) }),
    )
    .post('/', zValidator('json', CreateAcpAgentSchema), async (c) =>
      c.json(
        { agent: publicAgent(await store.create(c.req.valid('json'))) },
        201,
      ),
    )
    .get('/:agentId', zValidator('param', AgentIdParamsSchema), async (c) => {
      const agent = await store.get(c.req.valid('param').agentId)
      if (!agent) return c.json({ error: 'Unknown agent' }, 404)
      return c.json({ agent: publicAgent(agent) })
    })
    .put(
      '/:agentId',
      zValidator('param', AgentIdParamsSchema),
      zValidator('json', UpdateAcpAgentSchema),
      async (c) => {
        const { agentId } = c.req.valid('param')
        const patch = c.req.valid('json')
        const existing = await store.get(agentId)
        if (!existing) return c.json({ error: 'Unknown agent' }, 404)
        if (patch.paperclipConfig && existing.type !== 'paperclip')
          return c.json({ error: 'Not a Paperclip agent' }, 400)
        if (patch.customConfig && existing.type !== 'custom') {
          return c.json(
            { error: 'customConfig is only allowed for custom agents' },
            400,
          )
        }
        const agent = await store.update(agentId, patch)
        if (!agent) return c.json({ error: 'Unknown agent' }, 404)
        // Drop any running sessions so the next turn re-spawns with the new
        // command/config (a no-op when nothing is running).
        await options.onUpdate?.(agentId).catch((error) => {
          logger.warn('Failed to refresh updated ACP agent sessions', {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return c.json({ agent: publicAgent(agent) })
      },
    )
    .delete(
      '/:agentId',
      zValidator('param', AgentIdParamsSchema),
      async (c) => {
        const { agentId } = c.req.valid('param')
        const deleted = await store.delete(agentId)
        if (!deleted) return c.json({ error: 'Unknown agent' }, 404)
        await options.onDelete?.(agentId).catch((error) => {
          logger.warn('Failed to close deleted ACP agent sessions', {
            agentId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return c.json({ success: true })
      },
    )
}
