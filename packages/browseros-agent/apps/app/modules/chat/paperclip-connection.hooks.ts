import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { resolveAgentServerUrl } from '@/modules/browseros/agent-server-url.helpers'

export interface PaperclipConnection {
  enabled: boolean
  status: string
  error?: string
  taskUrl?: string
  readOnly: boolean
  run?: { id: string; status: string } | null
  messages: UIMessage[]
}
export function usePaperclipConnection(
  conversationId: string,
  enabled: boolean,
) {
  const client = useQueryClient()
  const queryKey = ['paperclip-connection', conversationId]
  const query = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<PaperclipConnection | null> => {
      const base = await resolveAgentServerUrl()
      const response = await fetch(
        `${base}/paperclip/${encodeURIComponent(conversationId)}`,
      )
      if (!response.ok) throw new Error('Cannot read browser connection')
      return response.json()
    },
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
  })
  const control = useMutation({
    mutationFn: async (action: 'pause' | 'resume' | 'stop') => {
      const base = await resolveAgentServerUrl()
      const response = await fetch(
        `${base}/paperclip/${encodeURIComponent(conversationId)}/${action}`,
        { method: 'POST' },
      )
      if (!response.ok) throw new Error('Unable to change browser connection')
    },
    onSuccess: () => client.invalidateQueries({ queryKey }),
  })
  return { ...query, control }
}
