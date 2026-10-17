import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PaperclipAgentConfig } from '@browseros/shared/schemas/agent'
import { type Binding, loadBinding, parseBinding } from './paperclip-binding'

/** Storage boundary: identity validation and atomic v1 files stay in this adapter. */
export interface BindingStore {
  list(): AsyncIterable<Binding>
  open(
    key: string,
    input: { conversationId: string },
    config: Pick<PaperclipAgentConfig, 'url' | 'clientId' | 'remoteAgentId'>,
    title: string,
  ): Promise<{ binding: Binding; save: (binding: Binding) => Promise<void> }>
}

export class FileBindingStore implements BindingStore {
  constructor(private readonly directory: string) {}

  async *list() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith('.json')) continue
      try {
        yield parseBinding(
          JSON.parse(await readFile(join(this.directory, name), 'utf8')),
        )
      } catch {
        // Preserve unsupported/damaged files and never grant browser authority.
      }
    }
  }

  open(...args: Parameters<BindingStore['open']>) {
    return loadBinding(this.directory, ...args)
  }
}
