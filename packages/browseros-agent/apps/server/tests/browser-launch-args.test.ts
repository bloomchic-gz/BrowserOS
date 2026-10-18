/**
 * @license
 * Copyright 2025 BrowserOS
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killBrowser, spawnBrowser } from './__helpers__/browser'

/** Runs the real spawn path and returns argv captured by a fake browser binary. */
async function captureBrowserArgs(
  headless: boolean,
  delayedStartup = false,
): Promise<string[]> {
  const tempDir = mkdtempSync(join(tmpdir(), 'browseros-launch-args-'))
  const argsPath = join(tempDir, 'args.txt')
  const binaryPath = join(tempDir, 'browseros-fake')
  await Bun.write(
    binaryPath,
    [
      '#!/bin/sh',
      ...(delayedStartup ? ['sleep 1'] : []),
      'args_file="$BROWSEROS_TEST_ARGS_FILE.tmp"',
      ': > "$args_file"',
      'for arg in "$@"; do',
      '  printf "%s\\n" "$arg" >> "$args_file"',
      'done',
      'mv "$args_file" "$BROWSEROS_TEST_ARGS_FILE"',
      'sleep 60',
    ].join('\n'),
  )
  chmodSync(binaryPath, 0o755)

  const cdpServer = createServer((_request, response) => {
    // Readiness must come from the child, not merely the fixture HTTP listener.
    if (!existsSync(argsPath)) {
      response.writeHead(503).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"Browser":"BrowserOS"}')
  })
  await new Promise<void>((resolve) => cdpServer.listen(0, resolve))
  const address = cdpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to allocate CDP test port')
  }

  const originalArgsFile = process.env.BROWSEROS_TEST_ARGS_FILE
  process.env.BROWSEROS_TEST_ARGS_FILE = argsPath
  try {
    await spawnBrowser({
      cdpPort: address.port,
      serverPort: address.port + 1,
      extensionPort: address.port + 2,
      binaryPath,
      userDataDir: mkdtempSync(join(tmpdir(), 'browseros-test-')),
      headless,
      extraArgs: [],
    })

    return readFileSync(argsPath, 'utf8').split('\n')
  } finally {
    if (originalArgsFile === undefined) {
      delete process.env.BROWSEROS_TEST_ARGS_FILE
    } else {
      process.env.BROWSEROS_TEST_ARGS_FILE = originalArgsFile
    }
    await killBrowser()
    await new Promise<void>((resolve, reject) => {
      cdpServer.close((error) => (error ? reject(error) : resolve()))
    })
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('spawnBrowser', () => {
  afterEach(async () => {
    await killBrowser()
  })

  it('uses the dev dock icon without a headless flag in headed mode', async () => {
    const args = await captureBrowserArgs(false, true)

    expect(args).toContain('--browseros-dock-icon=dev')
    expect(args).not.toContain('--headless=new')
  })

  it('adds the Chromium headless flag in headless mode', async () => {
    const args = await captureBrowserArgs(true)

    expect(args).toContain('--headless=new')
  })
})
