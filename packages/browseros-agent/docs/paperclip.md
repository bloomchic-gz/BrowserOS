# Paperclip agents

This source build adds a native **Paperclip** agent alongside local Codex, Claude and custom ACP agents. In Settings → AI & Agents, choose **Add Paperclip**, enter the server origin, authorize your account, and select a remote agent. OAuth device authorization and refresh are handled by the local BrowserOS server. To reconnect an existing account, choose **Edit → Reconnect account** in its configured-agent menu; the local connection ID is retained so saved conversations keep their Tasks.

The Paperclip server needs the companion `/api/browseros` integration, authenticated accounts, `PAPERCLIP_PUBLIC_URL`, and **Assistant connections (MCP)** enabled. Remote origins require HTTPS; localhost HTTP is supported for development. The current server integration supports legacy `codex_local` and `claude_local` adapters, with Codex ACP live-tested. It does not expose a generic ACP HTTP transport and does not yet support Paperclip's native Runner.

Every conversation creates its own Task on first send. Its Task ID and exact mutation arguments are saved atomically under the BrowserOS data directory's `agents/paperclip-sessions/` folder. Follow-up messages continue that Task. A stable UI message ID retains the same request receipt after retries. Switching a saved conversation to a different remote connection is rejected; start a new conversation instead.

The agent executes in Paperclip. BrowserOS maintains an outbound authenticated long poll while the turn is active. Browser calls arrive through that connection and execute against the local MCP endpoint using the conversation's internal tool lease, window context and read-only flag. Results and tool activity return to the agent and chat. BrowserOS never exposes an inbound public tool endpoint. Stop also cancels the corresponding Paperclip runs.

OAuth credentials are stored with the local server's agent configuration, omitted from public agent API responses, and refreshed using rotating refresh tokens. Browser calls are not automatically replayed after an ambiguous network outcome. Tasks survive reconnects; in-flight browser calls do not survive a server restart. The current Paperclip broker is process-local, so deployments need one API process or consistent connection routing. A browser must remain online while its tools are in use.

Text prompts are supported. Add attachments directly to the linked Task in Paperclip. Remote permissions, approvals, budgets and CLI credentials are configured in Paperclip. Local validation used an independent Paperclip process/database and the BrowserOS development browser; public cross-machine HTTPS and live Claude execution were not verified.

Focused checks:

```sh
bun run typecheck
bun test apps/server/tests/lib/agents/acp/paperclip-agent-runtime.test.ts apps/server/tests/api/routes/agents.test.ts apps/server/tests/api/services/mcp/browser-mcp-module.test.ts
```

Start a source development browser with `bun run dev:watch -- --new`. Its output reports the randomized browser CDP and local server ports; the installed production BrowserOS binary is not replaced by this source change.

## Model and reasoning effort

In **AI & Agents → Paperclip agent menu → Edit**, select **Model** and **Reasoning effort** and save. Editing these settings uses the existing connection without another OAuth approval. Model choices and model-specific effort choices come from Paperclip's adapter catalog. **Agent default** clears the corresponding task override. The configured agent row shows explicit selections.

Settings apply to the next new message, including follow-ups on the same Task. Paperclip updates the Task's adapter overrides and comment together using its normal task update API; it does not change the remote agent's global configuration. BrowserOS persists the settings with the message receipt, so retrying a message retains its original configuration even after defaults are edited. Rejected or unconfirmed receipts terminate the stream with an error rather than waiting for a run that may never start.
