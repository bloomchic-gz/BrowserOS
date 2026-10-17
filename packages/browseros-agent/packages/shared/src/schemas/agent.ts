import { z } from 'zod'

export const AcpAgentTypeSchema = z.enum([
  'claude',
  'codex',
  'custom',
  'paperclip',
])

/**
 * Config for a user-defined ("custom") ACP agent. Only meaningful when the
 * agent's type is 'custom'; the built-in claude/codex agents leave this null.
 * `command` is the full launch command line (args included); it is shell-split
 * into argv at launch and probe time.
 */
export const CustomAcpAgentConfigSchema = z
  .object({
    command: z.string().trim().min(1),
    env: z.record(z.string(), z.string()).optional(),
    fullAccessModes: z.array(z.string().trim().min(1)).optional(),
    reasoningEffortKey: z.string().trim().min(1).optional(),
    systemPromptAppend: z.string().trim().min(1).optional(),
    icon: z.string().trim().min(1).max(64).optional(),
  })
  .strict()

export const PaperclipAgentConfigSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value)
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/' &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        )
      }, 'Use an HTTPS origin, or HTTP on localhost'),
    token: z.string().min(1),
    remoteAgentId: z.string().uuid(),
    clientId: z.string().uuid(),
    oauthClientId: z.string().optional(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
  })
  .strict()
export type PaperclipAgentConfig = z.infer<typeof PaperclipAgentConfigSchema>
export const PaperclipAgentTargetSchema = z.object({
  type: z.literal('paperclip'),
  agentId: z.string().uuid(),
})

export const BrowserOsAgentTargetSchema: z.ZodObject<{
  type: z.ZodLiteral<'browseros'>
  providerId: z.ZodString
}> = z.object({
  type: z.literal('browseros'),
  providerId: z.string().min(1),
})

export const ClaudeAgentTargetSchema: z.ZodObject<{
  type: z.ZodLiteral<'claude'>
  agentId: z.ZodString
}> = z.object({
  type: z.literal('claude'),
  agentId: z.string().uuid(),
})

export const CodexAgentTargetSchema: z.ZodObject<{
  type: z.ZodLiteral<'codex'>
  agentId: z.ZodString
}> = z.object({
  type: z.literal('codex'),
  agentId: z.string().uuid(),
})

export const CustomAgentTargetSchema: z.ZodObject<{
  type: z.ZodLiteral<'custom'>
  agentId: z.ZodString
}> = z.object({
  type: z.literal('custom'),
  agentId: z.string().uuid(),
})

export const AgentTargetSchema = z.discriminatedUnion('type', [
  BrowserOsAgentTargetSchema,
  ClaudeAgentTargetSchema,
  CodexAgentTargetSchema,
  CustomAgentTargetSchema,
  PaperclipAgentTargetSchema,
])

export const AcpAgentTargetSchema = z.discriminatedUnion('type', [
  ClaudeAgentTargetSchema,
  CodexAgentTargetSchema,
  CustomAgentTargetSchema,
  PaperclipAgentTargetSchema,
])

export type AcpAgentType = z.infer<typeof AcpAgentTypeSchema>
export type CustomAcpAgentConfig = z.infer<typeof CustomAcpAgentConfigSchema>
export type AgentTarget = z.infer<typeof AgentTargetSchema>
export type AcpAgentTarget = z.infer<typeof AcpAgentTargetSchema>
