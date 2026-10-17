import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod/v3'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import type { AcpAgent } from '@/modules/agents/acp-agent-types'
import {
  useCreateAcpAgent,
  useUpdateAcpAgent,
} from '@/modules/agents/agents.hooks'
import { useAgentServerUrl } from '@/modules/browseros/agent-server-url.hooks'

interface PaperclipAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (agentId: string) => void
  agent?: AcpAgent | null
}

const QUERY_KEYS = {
  device: 'paperclip-device',
  connection: 'paperclip-connection',
}
const schema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(80),
  remoteAgentId: z.string(),
  modelId: z.string(),
  reasoningEffort: z.string(),
})
type Device = {
  client_id: string
  device_code: string
  user_code: string
  verification_uri_complete: string
  expires_in: number
}
type Tokens = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
}
type Connection = {
  company: { name: string }
  agents: Array<{
    id: string
    name: string
    adapterType: string
    defaults?: { modelId: string; reasoningEffort: string | null }
    capabilities?: { customModel?: boolean; modelSelection?: boolean }
    customModelReasoningEfforts?: string[]
    reasoningEfforts?: string[]
    models?: Array<{ id: string; label: string; reasoningEfforts: string[] }>
  }>
  unavailableAgents?: Array<{ id: string; name: string; reason: string }>
}

export function PaperclipAgentDialog({
  open,
  onOpenChange,
  onSaved,
  agent: existingAgent,
}: PaperclipAgentDialogProps) {
  const { baseUrl } = useAgentServerUrl()
  const create = useCreateAcpAgent()
  const update = useUpdateAcpAgent()
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      url: existingAgent?.paperclipConfig?.url ?? '',
      name: existingAgent?.name ?? 'Paperclip',
      remoteAgentId: existingAgent?.paperclipConfig?.remoteAgentId ?? '',
      modelId: existingAgent?.modelId ?? '',
      reasoningEffort: existingAgent?.reasoningEffort ?? '',
    },
  })
  const [device, setDevice] = useState<
    (Device & { url: string; expiresAt: number }) | null
  >(null)
  const request = async <T,>(path: string, body: unknown): Promise<T> => {
    if (!baseUrl) throw new Error('BrowserOS server is not ready')
    const response = await fetch(`${baseUrl}/agents/paperclip/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok)
      throw new Error(
        'Unable to connect. Check the Paperclip URL and Public MCP setting.',
      )
    return response.json()
  }
  const connect = useMutation({
    mutationFn: async () => {
      const url = form.getValues('url')
      const result = await request<Device>('connect', { url })
      setDevice({
        ...result,
        url,
        expiresAt: Date.now() + result.expires_in * 1000,
      })
    },
  })
  const tokens = useQuery({
    queryKey: [QUERY_KEYS.device, device?.device_code],
    queryFn: () =>
      request<Tokens>('token', {
        url: device?.url,
        clientId: device?.client_id,
        deviceCode: device?.device_code,
      }),
    enabled: open && Boolean(device),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.access_token ||
      query.state.error ||
      (device && Date.now() >= device.expiresAt)
        ? false
        : query.state.data?.error === 'slow_down'
          ? 10_000
          : 5000,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const connection = useQuery({
    queryKey: [
      QUERY_KEYS.connection,
      baseUrl,
      existingAgent?.id,
      device?.client_id,
    ],
    queryFn: async (): Promise<Connection> => {
      if (tokens.data?.access_token)
        return request<Connection>('connection', {
          url: device?.url,
          token: tokens.data.access_token,
        })
      const response = await fetch(
        `${baseUrl}/agents/${existingAgent?.id}/paperclip-connection`,
      )
      if (!response.ok)
        throw new Error(
          'Unable to load Paperclip models. Reconnect your account if authorization expired.',
        )
      return response.json()
    },
    enabled:
      open &&
      Boolean(baseUrl) &&
      (Boolean(tokens.data?.access_token) || Boolean(existingAgent && !device)),
    retry: false,
    gcTime: 0,
  })
  const remote = connection.data?.agents.find(
    (a) => a.id === form.watch('remoteAgentId'),
  )
  const modelId = form.watch('modelId')
  const efforts =
    (modelId
      ? (remote?.models?.find((m) => m.id === modelId)?.reasoningEfforts ??
        remote?.customModelReasoningEfforts)
      : remote?.reasoningEfforts) ?? []
  const save = form.handleSubmit(async (values) => {
    if (!values.remoteAgentId || !remote) return
    const settings = {
      modelId: values.modelId || null,
      reasoningEffort: values.reasoningEffort || null,
    }
    if (existingAgent && !device) {
      await update.mutateAsync({
        agentId: existingAgent.id,
        patch: { name: values.name, ...settings },
      })
      onOpenChange(false)
      onSaved?.(existingAgent.id)
      return
    }
    if (!device || !tokens.data?.access_token) return
    const value = {
      name: values.name,
      type: 'paperclip' as const,
      modelId: values.modelId || undefined,
      reasoningEffort: values.reasoningEffort || undefined,
      paperclipConfig: {
        url: device.url,
        token: tokens.data.access_token,
        remoteAgentId: values.remoteAgentId,
        clientId:
          existingAgent?.paperclipConfig?.clientId ?? crypto.randomUUID(),
        oauthClientId: device.client_id,
        refreshToken: tokens.data.refresh_token,
        expiresAt:
          tokens.dataUpdatedAt + (tokens.data.expires_in ?? 900) * 1000,
      },
    }
    const agent = existingAgent
      ? await update.mutateAsync({
          agentId: existingAgent.id,
          patch: {
            name: value.name,
            paperclipConfig: value.paperclipConfig,
            ...settings,
          },
        })
      : await create.mutateAsync(value)
    onOpenChange(false)
    onSaved?.(agent.id)
  })
  const error =
    connect.error ??
    tokens.error ??
    connection.error ??
    create.error ??
    update.error
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {existingAgent ? 'Edit Paperclip agent' : 'Connect Paperclip'}
          </DialogTitle>
          <DialogDescription>
            Run an agent in Paperclip and let it use this browser. Each
            conversation creates a task; follow-up messages continue that task.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={save} className="space-y-4">
            <FormField
              control={form.control}
              name="url"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Paperclip URL</FormLabel>
                  <FormControl>
                    <Input
                      disabled={Boolean(existingAgent && !device)}
                      placeholder="https://paperclip.example.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              onClick={async () => {
                if (await form.trigger('url')) connect.mutate()
              }}
              disabled={connect.isPending}
            >
              {existingAgent ? 'Reconnect account' : 'Connect account'}
            </Button>
            {device && !tokens.data?.access_token ? (
              <p className="text-sm">
                Authorize BrowserOS in{' '}
                <a
                  className="underline"
                  href={device.verification_uri_complete}
                  target="_blank"
                  rel="noreferrer"
                >
                  Paperclip
                </a>{' '}
                using code <strong>{device.user_code}</strong>.
              </p>
            ) : null}
            {connection.data ? (
              <>
                <p>Connected to {connection.data.company.name}</p>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Name</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="remoteAgentId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Remote agent</FormLabel>
                      <FormControl>
                        <select
                          className="w-full rounded border bg-background p-2"
                          {...field}
                          disabled={Boolean(existingAgent && !device)}
                          onChange={(event) => {
                            field.onChange(event)
                            form.setValue('modelId', '')
                            form.setValue('reasoningEffort', '')
                          }}
                        >
                          <option value="">Choose an agent</option>
                          {connection.data?.agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {connection.data.unavailableAgents?.length ? (
                  <details className="text-muted-foreground text-sm">
                    <summary>Other agents and connection requirements</summary>
                    <ul>
                      {connection.data.unavailableAgents.map((agent) => (
                        <li key={agent.id}>
                          {agent.name}: {agent.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <FormField
                  control={form.control}
                  name="modelId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model</FormLabel>
                      <FormControl>
                        <select
                          className="w-full rounded border bg-background p-2"
                          {...field}
                          disabled={
                            !remote ||
                            remote.capabilities?.modelSelection === false
                          }
                          onChange={(event) => {
                            field.onChange(event)
                            form.setValue('reasoningEffort', '')
                          }}
                        >
                          <option value="">
                            Agent default
                            {remote?.defaults?.modelId
                              ? ` (${remote.defaults.modelId})`
                              : ''}
                          </option>
                          {field.value &&
                          !remote?.models?.some((m) => m.id === field.value) ? (
                            <option value={field.value}>{field.value}</option>
                          ) : null}
                          {remote?.models?.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.label}
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {remote?.capabilities?.customModel ? (
                  <FormField
                    control={form.control}
                    name="modelId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Model ID (optional)</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="Leave blank for agent default"
                            onChange={(event) => {
                              field.onChange(event)
                              form.setValue('reasoningEffort', '')
                            }}
                          />
                        </FormControl>
                        <p className="text-muted-foreground text-sm">
                          Use a model supported by the remote agent when it is
                          not in the list.
                        </p>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : null}
                <FormField
                  control={form.control}
                  name="reasoningEffort"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reasoning effort</FormLabel>
                      <FormControl>
                        <select
                          className="w-full rounded border bg-background p-2"
                          {...field}
                          disabled={!efforts.length}
                        >
                          <option value="">Agent default</option>
                          {field.value && !efforts.includes(field.value) ? (
                            <option value={field.value} disabled>
                              {field.value} (unsupported)
                            </option>
                          ) : null}
                          {efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-muted-foreground text-sm">
                  Applies to the next message in your BrowserOS tasks. The
                  remote agent's defaults stay unchanged.
                </p>
              </>
            ) : null}
            {error ? (
              <p className="text-destructive text-sm">{error.message}</p>
            ) : null}
            {tokens.data?.error &&
            !['authorization_pending', 'slow_down'].includes(
              tokens.data.error,
            ) ? (
              <p>Authorization expired or was denied. Connect again.</p>
            ) : null}
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  !connection.data ||
                  !remote ||
                  create.isPending ||
                  update.isPending ||
                  Boolean(device && !tokens.data?.access_token)
                }
              >
                {existingAgent ? 'Save changes' : 'Add Paperclip agent'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
