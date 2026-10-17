import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBinding } from '../../../../src/lib/agents/acp/paperclip-binding'
import { FileBindingStore } from '../../../../src/lib/agents/acp/paperclip-binding-store'

const config = {
  url: 'https://paperclip.test',
  clientId: 'client',
  remoteAgentId: 'agent',
}
const input = { conversationId: 'conversation' }
const key = 'agent:conversation'
const filename = `${createHash('sha256').update(key).digest('hex')}.json`
const legacy = {
  identity: 'https://paperclip.test:client:agent',
  request: { requestId: 'old-create', conversationId: 'conversation' },
  taskId: 'old-task',
  enabled: false,
  deleted: false,
  transcript: [{ id: 'message', parts: [{ type: 'text', text: 'keep' }] }],
  messages: {
    message: { requestId: 'old-send', body: 'keep', commentIds: ['comment'] },
  },
}
describe('Paperclip binding storage compatibility', () => {
  it('upgrades legacy data atomically without changing task, request identities or paused state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browseros-binding-'))
    try {
      await writeFile(join(dir, filename), JSON.stringify(legacy))
      const loaded = await loadBinding(
        dir,
        key,
        input,
        config,
        'ignored new title',
      )
      expect(loaded.binding).toEqual({ ...legacy, version: 1 })
      expect(JSON.parse(await readFile(join(dir, filename), 'utf8'))).toEqual({
        ...legacy,
        version: 1,
      })
      expect(
        (await loadBinding(dir, key, input, config, 'again')).binding,
      ).toEqual(loaded.binding)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('lists only readable bindings and preserves invalid files for recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browseros-binding-'))
    try {
      const store = new FileBindingStore(dir)
      const opened = await store.open(key, input, config, 'first')
      opened.binding.taskId = 'kept-task'
      await opened.save(opened.binding)
      await writeFile(
        join(dir, 'future.json'),
        JSON.stringify({ ...legacy, version: 99 }),
      )
      await writeFile(join(dir, 'corrupt.json'), '{broken')
      await writeFile(join(dir, 'interrupted.tmp'), '{partial')
      const bindings = []
      for await (const binding of store.list()) bindings.push(binding)
      expect(bindings).toEqual([opened.binding])
      expect(await readFile(join(dir, 'corrupt.json'), 'utf8')).toBe('{broken')
      expect(
        (await store.open(key, input, config, 'again')).binding.taskId,
      ).toBe('kept-task')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('never replaces future, damaged or retargeted data with a new task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'browseros-binding-'))
    try {
      for (const raw of [
        JSON.stringify({ ...legacy, version: 2 }),
        '{broken',
        JSON.stringify({ ...legacy, identity: 'other' }),
      ]) {
        await writeFile(join(dir, filename), raw)
        await expect(
          loadBinding(dir, key, input, config, 'new'),
        ).rejects.toThrow()
        expect(await readFile(join(dir, filename), 'utf8')).toBe(raw)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
