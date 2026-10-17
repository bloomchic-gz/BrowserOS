import { usePaperclipConnection } from '@/modules/chat/paperclip-connection.hooks'

export function PaperclipConnectionBar({
  conversationId,
}: {
  conversationId: string
}) {
  const { data, error, control } = usePaperclipConnection(conversationId, true)
  if (!data) return null
  const running =
    data.run &&
    ['running', 'queued', 'scheduled_retry'].includes(data.run.status)
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-border border-b px-3 py-2 text-xs"
      role="status"
    >
      <a
        href={data.taskUrl}
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        Paperclip Task
      </a>
      <span>
        {data.status} · {data.readOnly ? 'Read only' : 'Browser control'} · Team
        access
      </span>
      <button
        type="button"
        className="rounded border px-2 py-1"
        disabled={control.isPending}
        onClick={() => control.mutate(data.enabled ? 'pause' : 'resume')}
      >
        {data.enabled ? 'Pause remote control' : 'Resume remote control'}
      </button>
      {running && (
        <button
          type="button"
          className="rounded border px-2 py-1"
          disabled={control.isPending}
          onClick={() => control.mutate('stop')}
        >
          Stop task
        </button>
      )}
      {(error || control.error || data.error) && (
        <span className="text-destructive">
          {control.error?.message ?? error?.message ?? data.error}
        </span>
      )}
    </div>
  )
}
