import { randomUUID } from 'node:crypto'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { z } from 'zod'
import type { Binding, SentMessage } from './paperclip-binding'
import type { BindingStore } from './paperclip-binding-store'
import {
  type CommentSchema,
  MessagesSchema,
  PollSchema,
  paperclipRequest,
  SnapshotSchema,
} from './paperclip-client'
import {
  type ConversationSink,
  type PaperclipMessage,
  projectPaperclipMessages,
  type RunOutput,
} from './paperclip-conversation'
import type {
  AgentConfigProvider,
  BrowserToolAccess,
  PaperclipTurnEvent,
  PaperclipTurnInput,
  PaperclipScope as Scope,
} from './paperclip-runtime-ports'

type PersistentBinding = Binding &
  Scope & {
    agentId: string
    enabled: boolean
    deleted?: boolean
    localSettings?: string
    transcript?: PaperclipMessage[]
    outputs?: Record<string, RunOutput>
  }
type Worker = {
  binding: PersistentBinding
  config: PaperclipAgentConfig
  save: (binding: Binding) => Promise<void>
  controller: AbortController
  call?: AbortController
  leaseId?: string
  status: string
  error?: string
  taskUrl?: string
  snapshot?: z.infer<typeof SnapshotSchema>
  job?: Promise<void>
  sync?: Promise<void>
  syncController?: AbortController
}
export interface PaperclipConnectionDeps {
  browserTools: BrowserToolAccess
  bindingStore: BindingStore
  conversationSink: ConversationSink
  agentConfigs: AgentConfigProvider
}
const pause = (signal: AbortSignal, ms = 1500) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
const activeStatuses = ['queued', 'running', 'scheduled_retry']

/** The desktop service owns the connection; chat streams are only observers. */
export class PaperclipConnectionRuntime {
  private restoration?: Promise<void>
  private workers = new Map<string, Worker>()
  private active = new Map<string, AbortController>()
  private readonly bindings: BindingStore
  private readonly conversations: ConversationSink
  constructor(private deps: PaperclipConnectionDeps) {
    this.bindings = deps.bindingStore
    this.conversations = deps.conversationSink
  }
  private getAgent(id: string) {
    return this.deps.agentConfigs.get(id)
  }
  restore() {
    this.restoration ??= this.restoreSaved()
    return this.restoration
  }
  private async restoreSaved() {
    for await (const saved of this.bindings.list()) {
      try {
        const binding = saved as PersistentBinding
        if (
          !binding.agentId ||
          !binding.taskId ||
          !binding.conversationId ||
          binding.deleted
        )
          continue
        const agent = await this.getAgent(binding.agentId)
        if (!agent?.paperclipConfig) continue
        const input = {
          agent,
          ...binding,
        }
        const loaded = await this.bindings.open(
          `${agent.id}:${binding.conversationId}`,
          input,
          agent.paperclipConfig,
          '',
        )
        const worker = this.register(
          binding,
          agent.paperclipConfig,
          loaded.save,
        )
        this.start(worker)
      } catch {
        /* A bad or retargeted binding never grants browser authority. */
      }
    }
  }
  private register(
    binding: PersistentBinding,
    config: PaperclipAgentConfig,
    save: Worker['save'],
  ) {
    const existing = this.workers.get(binding.conversationId)
    if (existing) return existing
    const worker: Worker = {
      binding,
      config,
      save,
      controller: new AbortController(),
      status: binding.enabled ? 'connecting' : 'paused',
    }
    this.workers.set(binding.conversationId, worker)
    return worker
  }
  private async api(
    worker: Worker,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    worker.config = await this.deps.agentConfigs.fresh(
      worker.binding.agentId,
      worker.config,
    )
    return paperclipRequest(worker.config, path, body, signal)
  }
  private start(worker: Worker) {
    this.startSync(worker)
    if (worker.job || !worker.binding.enabled) return
    worker.controller = new AbortController()
    const signal = worker.controller.signal
    worker.job = (async () => {
      while (!signal.aborted) {
        try {
          worker.status = 'connecting'
          const attached = z
            .object({ leaseId: z.string() })
            .parse(
              await this.api(
                worker,
                `/tasks/${worker.binding.taskId}/attach`,
                { clientId: worker.config.clientId },
                signal,
              ),
            )
          worker.leaseId = attached.leaseId
          worker.status = 'online'
          worker.error = undefined
          while (!signal.aborted) {
            const { calls } = PollSchema.parse(
              await this.api(
                worker,
                `/leases/${worker.leaseId}/poll`,
                {},
                signal,
              ),
            )
            for (const call of calls) {
              signal.throwIfAborted()
              await this.api(
                worker,
                `/leases/${worker.leaseId}/check`,
                { callId: call.id },
                signal,
              )
              const controller = new AbortController()
              worker.call = controller
              const callSignal = AbortSignal.any([signal, controller.signal])
              const tools = this.deps.browserTools.acquire(
                worker.binding,
                call.runId,
                callSignal,
              )
              // Revocation must also abort a long-running local tool, even if a
              // different run has already started on this Task.
              const watchdog = (async () => {
                while (!callSignal.aborted) {
                  await pause(callSignal, 1000)
                  if (callSignal.aborted) break
                  try {
                    await this.api(
                      worker,
                      `/leases/${worker.leaseId}/check`,
                      { callId: call.id },
                      callSignal,
                    )
                  } catch {
                    controller.abort()
                  }
                }
              })()
              try {
                const response = await tools.call(call.request)
                await this.api(
                  worker,
                  `/leases/${worker.leaseId}/respond`,
                  { callId: call.id, response },
                  signal,
                )
              } finally {
                tools.release()
                controller.abort()
                await watchdog
                worker.call = undefined
              }
            }
          }
        } catch (error) {
          if (!signal.aborted) {
            worker.status = 'offline'
            worker.error =
              error instanceof Error ? error.message : 'Connection failed'
            await pause(signal, 3000)
          }
        }
      }
    })().finally(() => {
      worker.job = undefined
    })
  }
  private startSync(worker: Worker) {
    if (worker.sync) return
    worker.syncController = new AbortController()
    const signal = worker.syncController.signal
    worker.sync = (async () => {
      while (!signal.aborted) {
        try {
          await this.sync(worker, signal)
        } catch (error) {
          if (!signal.aborted)
            worker.error =
              error instanceof Error ? error.message : 'Sync failed'
        }
        await pause(signal, 2000)
      }
    })().finally(() => {
      worker.sync = undefined
    })
  }
  // Full paginated reconciliation also reflects edited/deleted comments. Stable
  // IDs make restart/reconnect idempotent; no synchronized message is submitted.
  private async sync(worker: Worker, signal: AbortSignal) {
    const b = worker.binding
    const snapshot = SnapshotSchema.parse(
      await this.api(worker, `/tasks/${b.taskId}/snapshot`, undefined, signal),
    )
    worker.snapshot = snapshot
    worker.taskUrl = snapshot.taskUrl
    if (worker.call && !snapshot.liveRuns.length) worker.call.abort()
    const comments: z.infer<typeof CommentSchema>[] = []
    let after: string | null = null
    do {
      const page: {
        comments: z.infer<typeof CommentSchema>[]
        next: string | null
      } = MessagesSchema.parse(
        await this.api(
          worker,
          `/tasks/${b.taskId}/messages${after ? `?after=${after}` : ''}`,
          undefined,
          signal,
        ),
      )
      comments.push(...page.comments)
      after = page.next
    } while (after && !signal.aborted)
    b.outputs ??= {}
    if (snapshot.run) {
      const run = snapshot.run
      const output = b.outputs[run.id] ?? {
        offset: 0,
        text: '',
        status: run.status,
      }
      const log = SnapshotSchema.parse(
        await this.api(
          worker,
          `/tasks/${b.taskId}/snapshot?runId=${run.id}&logOffset=${output.offset}`,
          undefined,
          signal,
        ),
      )
      if (log.output) {
        output.offset = log.output.offset
        output.text += log.output.text
      }
      output.status = run.status
      if (!activeStatuses.includes(run.status) && !output.text)
        output.text = run.resultJson?.summary ?? `Paperclip run ${run.status}.`
      b.outputs[run.id] = output
    }
    const messages = projectPaperclipMessages(
      comments,
      b.messages ?? {},
      b.outputs,
    )
    if (JSON.stringify(messages) !== JSON.stringify(b.transcript)) {
      // A failed sink write must be retried on the next reconciliation. Only
      // acknowledge the snapshot after durable conversation storage succeeds.
      await this.conversations.replace({
        conversationId: b.conversationId,
        messages,
        agentId: b.agentId,
      })
      b.transcript = messages
    }
    await worker.save(b)
  }
  state(conversationId: string) {
    const w = this.workers.get(conversationId)
    if (!w) return null
    return {
      enabled: w.binding.enabled,
      status: w.status,
      error: w.error,
      taskId: w.binding.taskId,
      taskUrl: w.taskUrl,
      readOnly: w.binding.readOnly,
      run: w.snapshot?.run,
      messages: w.binding.transcript ?? [],
    }
  }
  async control(conversationId: string, action: 'pause' | 'resume' | 'stop') {
    const w = this.workers.get(conversationId)
    if (!w) throw new Error('Unknown Paperclip conversation')
    if (action === 'stop') {
      w.call?.abort()
      await this.api(w, `/tasks/${w.binding.taskId}/stop`, {})
    } else if (action === 'pause') {
      w.binding.enabled = false
      w.controller.abort()
      w.call?.abort()
      await w.job
      if (w.leaseId)
        await this.api(w, `/leases/${w.leaseId}/detach`, {}).catch(
          () => undefined,
        )
      w.leaseId = undefined
      w.status = 'paused'
      await w.save(w.binding)
    } else {
      const agent = await this.getAgent(w.binding.agentId)
      const config = agent?.paperclipConfig
      if (
        !config ||
        w.binding.identity !==
          `${new URL(config.url).origin}:${config.clientId}:${config.remoteAgentId}`
      )
        throw new Error('Connection changed. Start a new conversation.')
      w.config = config
      w.binding.enabled = true
      await w.save(w.binding)
      this.start(w)
    }
    return this.state(conversationId)
  }
  async forget(conversationId: string) {
    const w = this.workers.get(conversationId)
    if (!w) return
    await this.control(conversationId, 'pause')
    w.syncController?.abort()
    await w.sync
    w.binding.deleted = true
    await w.save(w.binding)
    this.workers.delete(conversationId)
  }
  async shutdown() {
    for (const w of this.workers.values()) {
      w.controller.abort()
      w.syncController?.abort()
      w.call?.abort()
    }
    for (const w of this.workers.values()) {
      await Promise.all([w.job, w.sync])
      if (w.leaseId)
        await this.api(w, `/leases/${w.leaseId}/detach`, {}).catch(
          () => undefined,
        )
    }
  }
  async refreshAgent(agentId: string) {
    const agent = await this.getAgent(agentId)
    if (agent?.type !== 'paperclip' || !agent.paperclipConfig) return false
    const config = agent.paperclipConfig
    const identity = `${new URL(config.url).origin}:${config.clientId}:${config.remoteAgentId}`
    for (const w of this.workers.values())
      if (w.binding.agentId === agentId) {
        if (w.binding.identity === identity) w.config = config
        else {
          await this.control(w.binding.conversationId, 'pause')
          w.syncController?.abort()
          await w.sync
        }
      }
    return true
  }
  close(agentId: string, conversationId?: string) {
    let count = 0
    for (const [key, controller] of this.active)
      if (
        key.startsWith(`${agentId}:`) &&
        (!conversationId || key === `${agentId}:${conversationId}`)
      ) {
        controller.abort()
        count++
      }
    // Config deletion/update revokes all task connections. Merely closing a
    // view must not call this; explicit conversation deletion uses forget().
    if (!conversationId)
      for (const w of this.workers.values())
        if (w.binding.agentId === agentId) {
          w.controller.abort()
          w.syncController?.abort()
          void this.control(w.binding.conversationId, 'pause').catch(
            () => undefined,
          )
          count++
        }
    return count
  }
  private async prepareMessage(input: PaperclipTurnInput, signal: AbortSignal) {
    await this.restore()
    signal.throwIfAborted()
    const key = `${input.agent.id}:${input.conversationId}`
    const config = input.agent.paperclipConfig
    if (!config) throw new Error('Paperclip connection is not configured.')
    const latest = input.message
    if (!latest || latest.hasAttachments)
      throw new Error(
        'A text message is required. Add attachments in Paperclip.',
      )
    const body = latest.body
    const loaded = await this.bindings.open(key, input, config, body)
    const existing = this.workers.get(input.conversationId)
    if (existing && existing.binding.agentId !== input.agent.id)
      throw new Error(
        'This conversation belongs to another agent. Start a new conversation.',
      )
    if ((loaded.binding as PersistentBinding).deleted)
      throw new Error(
        'This conversation was deleted. Start a new conversation.',
      )
    const binding: PersistentBinding =
      existing?.binding ??
      Object.assign(loaded.binding, {
        agentId: input.agent.id,
        conversationId: input.conversationId,
        enabled: true,
        readOnly: input.readOnly,
        browserContext: input.browserContext,
      })
    if (!binding.taskId) {
      const opened = z
        .object({ task: z.object({ id: z.string() }) })
        .parse(
          await paperclipRequest(
            await this.deps.agentConfigs.fresh(input.agent.id, config),
            '/open',
            binding.request,
            signal,
          ),
        )
      binding.taskId = opened.task.id
      await loaded.save(binding)
    }
    const worker = this.register(binding, config, loaded.save)
    if (!worker.binding.enabled)
      throw new Error(
        'Remote browser control is paused. Resume the connection before sending.',
      )
    // Restrictions can only change explicitly from this local conversation.
    binding.readOnly = input.readOnly
    binding.browserContext = input.browserContext
    this.start(worker)
    const deadline = Date.now() + 30_000
    while (worker.status !== 'online' && Date.now() < deadline) {
      signal.throwIfAborted()
      await pause(signal, 100)
    }
    if (worker.status !== 'online')
      throw new Error(worker.error ?? 'Browser connection unavailable')
    const baseline = SnapshotSchema.parse(
      await this.api(
        worker,
        `/tasks/${binding.taskId}/snapshot`,
        undefined,
        signal,
      ),
    )
    binding.messages ??= {}
    let sent = binding.messages[latest.id]
    if (!sent) {
      const settings = {
        modelId: input.agent.modelId ?? null,
        reasoningEffort: input.agent.reasoningEffort ?? null,
      }
      const fingerprint = JSON.stringify(settings)
      sent = {
        requestId: randomUUID(),
        body,
        oldRun: baseline.run?.id,
        commentIds: baseline.comments.map((c) => c.id),
        ...(binding.localSettings !== fingerprint ? { settings } : {}),
      }
      binding.messages[latest.id] = sent
      await worker.save(binding)
    }
    await this.api(
      worker,
      `/tasks/${binding.taskId}/send`,
      {
        requestId: sent.requestId,
        body: sent.body,
        ...(sent.settings ? { settings: sent.settings } : {}),
      },
      signal,
    )
    if (sent.settings) {
      binding.localSettings = JSON.stringify(sent.settings)
      await worker.save(binding)
    }
    return { worker, sent, baseline }
  }
  private async observe(
    worker: Worker,
    sent: SentMessage,
    baseline: z.infer<typeof SnapshotSchema>,
    signal: AbortSignal,
    write: (event: PaperclipTurnEvent) => void,
  ) {
    const binding = worker.binding
    write({ type: 'start' })
    write({ type: 'text', text: `[Paperclip task](${baseline.taskUrl})\n\n` })
    let displayed = ''
    const until = Date.now() + 30 * 60_000
    while (Date.now() < until) {
      signal.throwIfAborted()
      const snapshot = worker.snapshot
      const run = snapshot?.run
      if (run && run.id !== sent.oldRun) {
        const output = binding.outputs?.[run.id]?.text ?? ''
        if (output.startsWith(displayed) && output.length > displayed.length) {
          write({
            type: 'text',
            text: output.slice(displayed.length),
          })
          displayed = output
        }
        if (
          !activeStatuses.includes(run.status) &&
          !snapshot?.liveRuns.length &&
          binding.outputs?.[run.id]?.status === run.status
        ) {
          if (!displayed)
            write({
              type: 'text',
              text: run.resultJson?.summary ?? `Paperclip run ${run.status}.`,
            })
          write({ type: 'finish' })
          return
        }
      }
      await pause(signal, 500)
    }
    throw new Error(
      'Task remains pending. Check scheduling or approvals in Paperclip.',
    )
  }
  beginTurn(input: PaperclipTurnInput) {
    const controller = new AbortController()
    const key = `${input.agent.id}:${input.conversationId}`
    this.active.set(key, controller)
    const signal = input.abortSignal
      ? AbortSignal.any([controller.signal, input.abortSignal])
      : controller.signal
    return {
      signal,
      execute: async (write: (event: PaperclipTurnEvent) => void) => {
        let worker: Worker | undefined
        try {
          const prepared = await this.prepareMessage(input, signal)
          worker = prepared.worker
          await this.observe(
            worker,
            prepared.sent,
            prepared.baseline,
            signal,
            write,
          )
        } finally {
          if (
            signal.aborted &&
            (worker ?? this.workers.get(input.conversationId))
          )
            await this.control(input.conversationId, 'stop').catch(
              () => undefined,
            )
          this.active.delete(key)
        }
      },
    }
  }
}
