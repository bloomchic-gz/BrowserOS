import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { z } from 'zod'
import { MessageSyncStateSchema } from './paperclip-message-sync'

type Json = Record<string, unknown>
export type SentMessage = {
  requestId: string
  body: string
  settings?: { modelId: string | null; reasoningEffort: string | null }
  oldRun?: string
  commentIds: string[]
}
export type Binding = {
  version: 1
  identity: string
  request: Json
  messageSync?: z.infer<typeof MessageSyncStateSchema>
  taskId?: string
  messages?: Record<string, SentMessage>
}

const bindingSchema = z
  .object({
    version: z.literal(1).default(1),
    identity: z.string().min(1),
    request: z.record(z.string(), z.unknown()),
    taskId: z.string().min(1).optional(),
    // Derived cache can be rebuilt without replacing the durable Task identity.
    messageSync: MessageSyncStateSchema.optional().catch(undefined),
    messages: z
      .record(
        z.string(),
        z
          .object({
            requestId: z.string().min(1),
            body: z.string(),
            oldRun: z.string().optional(),
            commentIds: z.array(z.string()),
            settings: z
              .object({
                modelId: z.string().nullable(),
                reasoningEffort: z.string().nullable(),
              })
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

// Keep runtime-owned transcript/state fields intact during schema upgrades.
export function parseBinding(value: unknown): Binding {
  const parsed = bindingSchema.safeParse(value)
  if (!parsed.success)
    throw new Error(
      'Unsupported or damaged Paperclip binding. Preserve this file and restore a compatible version; do not create a replacement Task.',
    )
  return parsed.data
}

export async function loadBinding(
  stateDir: string,
  key: string,
  input: { conversationId: string },
  config: Pick<PaperclipAgentConfig, 'url' | 'clientId' | 'remoteAgentId'>,
  title: string,
) {
  const identity = `${new URL(config.url).origin}:${config.clientId}:${config.remoteAgentId}`
  const filename = join(
    stateDir,
    `${createHash('sha256').update(key).digest('hex')}.json`,
  )
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  let saves: Promise<void> = Promise.resolve()
  const save = (binding: Binding) => {
    const content = JSON.stringify(parseBinding(binding))
    const next = saves.then(async () => {
      const tmp = `${filename}.${randomUUID()}.tmp`
      await writeFile(tmp, content, { mode: 0o600 })
      await rename(tmp, filename)
    })
    saves = next.catch(() => undefined)
    return next
  }
  let binding: Binding
  let legacy = false
  try {
    const raw = JSON.parse(await readFile(filename, 'utf8'))
    legacy = raw?.version === undefined
    binding = parseBinding(raw)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    binding = {
      version: 1,
      identity,
      request: {
        requestId: randomUUID(),
        conversationId: input.conversationId,
        clientId: config.clientId,
        agentId: config.remoteAgentId,
        title: (
          title.match(/<USER_QUERY>\s*([\s\S]*?)<\/USER_QUERY>/)?.[1] ?? title
        )
          .trim()
          .slice(0, 200),
      },
    }
    await save(binding)
  }
  if (binding.identity !== identity)
    throw new Error(
      'This conversation belongs to another Paperclip connection. Start a new conversation.',
    )

  if (legacy) await save(binding)
  return { binding, save }
}
