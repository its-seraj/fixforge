# FixForge

**AI-powered ticket resolver CLI** — Detect bugs, create Jira issues, fix code in a sandbox, and ship PRs automatically.

---

## Installation

```bash
npm install -g .
```

> Requires **Node.js ≥ 18**

---

## Quick Start

### 1. Setup (one-time)

```bash
fixforge setup
```

An interactive wizard will:
- Collect and validate Jira, GitHub, and AI provider credentials (Gemini and/or TrueFoundry)
- Store tokens encrypted at `~/.fixforge/config.json`
- Optionally start the webhook daemon

### 2. Start the webhook server

The server runs as a **background daemon by default**.

```bash
fixforge webhook --port 4242
# equivalent to:
fixforge webhook start --port 4242

# run in the foreground with live console logs
fixforge webhook --foreground

# stop the background daemon
fixforge webhook --stop
# or: fixforge webhook stop
```

### 3. Send an error event to FixForge

```bash
curl -X POST http://localhost:4242/webhook/error \
  -H "Content-Type: application/json" \
  -H "x-fixforge-secret: <your-webhook-secret>" \
  -d '{
    "message": "TypeError: Cannot read properties of undefined (reading 'userId')",
    "stack": "at getUserProfile (src/api/user.js:42)\n    at async handler (src/routes/profile.js:18)",
    "context": { "endpoint": "/api/profile", "userId": null },
    "severity": "High"
  }'
```

FixForge will automatically:
1. Classify the error with the configured AI provider
2. Create a Jira bug
3. Fetch related code from GitHub
4. Run root cause analysis
5. Generate a patch
6. Apply & test in a sandbox
7. Draft a customer reply
8. ⏸ Await your approval (via Jira comment: `fixforge:approve`), depending on approval mode
9. Push a PR and update Jira

FixForge also runs autonomously in the background once the webhook server is up:
- Polls Jira for new "To Do" tickets and stuck "In Progress" tickets and attempts to resolve them
- Polls for merged PRs to update the corresponding Jira issue
- Scans local listening ports/log output for errors and can auto-raise them (see `fixforge scan`, `fixforge watch`, `fixforge run`)

### 4. Monitor with the dashboard

```bash
fixforge dashboard
```

### 5. Manually resolve a Jira issue

```bash
fixforge resolve BUG-42
fixforge resolve BUG-42 --dry-run   # analyse only, don't push changes
```

### 6. Check status

```bash
fixforge status
```

### 7. Other commands

```bash
fixforge scan [--all]     # scan listening ports to identify running web services
fixforge watch [path]     # watch log files in real-time, auto-raise errors to the webhook
fixforge run <command>    # run an app command and auto-intercept crashes to the webhook
```

---

## Webhook API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhook/error` | Receive a runtime error payload |
| POST | `/webhook/github` | GitHub push / pull_request events |
| POST | `/webhook/resolve` | Manually trigger resolution (`{ jiraKey }`) |
| GET | `/api/metrics` | JSON metrics summary |
| GET | `/api/tickets` | JSON list of tracked tickets |
| GET | `/api/services` | Background port scanner status & discovered services |
| GET | `/health` | Health check |

### Authenticating requests

If `webhookSecret` is not configured, the webhook endpoints accept **any** request unauthenticated — set it before exposing the server beyond localhost. When a secret is configured, any of the following are accepted:

- `x-fixforge-secret: <secret>` — secret sent directly
- `x-api-key: <secret>` — secret sent directly
- `Authorization: Bearer <secret>` — secret sent directly
- `x-fixforge-signature: sha256=<HMAC_SHA256(body, webhookSecret)>` — HMAC over the JSON body (GitHub-style)
- `x-hub-signature-256: sha256=<HMAC_SHA256(body, webhookSecret)>` — same, for native GitHub webhook delivery

---

## Approval Modes

| Mode | Behaviour |
|------|-----------|
| `always` | Posts a Jira comment and waits up to 3 minutes for a `fixforge:approve` / `fixforge:reject <reason>` reply; if the window elapses with no reply, it **proceeds autonomously** |
| `auto-low` | Auto-approves Low **and** Medium severity; other severities go through the `always` flow above |
| `autonomous` | No approval gate — fully automated (this is also the fallback if `approvalMode` is unset) |

---

## Configuration

Config is stored at `~/.fixforge/config.json` (sensitive values AES-256-CBC encrypted using a key at `~/.fixforge/.key`).

| Key | Description |
|-----|-------------|
| `jiraUrl` | Jira base URL |
| `jiraEmail` | Jira account email |
| `jiraToken` | Jira API token (encrypted) |
| `jiraProject` | Jira project key |
| `githubToken` | GitHub PAT (encrypted) |
| `githubRepo` | Default repo (`owner/repo`) |
| `githubBaseBranch` | Base branch for PRs |
| `aiProvider` | AI provider to use: `gemini` or `truefoundry` |
| `geminiApiKey` | Gemini API key (encrypted) |
| `geminiModel` | Gemini model (falls back through a built-in list of models if unset/unavailable) |
| `truefoundryApiKey` | TrueFoundry AI Gateway API key (encrypted) |
| `truefoundryBaseUrl` | TrueFoundry AI Gateway base URL |
| `truefoundryModel` | TrueFoundry model identifier |
| `openaiApiKey` | OpenAI API key (encrypted), used as an additional provider option |
| `webhookPort` | Webhook server port |
| `webhookSecret` | Shared secret for webhook auth (encrypted) |
| `approvalMode` | `always` / `auto-low` / `autonomous` |

---



---

## Architecture

```
Your Application
       │ runtime error
       ▼
┌──────────────────────┐
│  Bug Detection Agent │  ← AI provider (Gemini / TrueFoundry) classifies error
└──────────┬───────────┘
           │ creates
           ▼
      Jira Bug
           │
           ▼
┌──────────────────────┐
│  Bug Resolver Agent  │
└──────────┬───────────┘
     ┌─────┼─────┐
     ▼     ▼     ▼
  GitHub Sandbox Logs
     │     │
     └──┬──┘ reproduce
        ▼
   Root Cause (AI)
        ▼
   Generate Patch (AI)
        ▼
   Run Tests
        ▼
   Draft Customer Reply
        ▼
   ⏸ Approval gate (mode-dependent, see Approval Modes)
        ▼
   Push PR + Update Jira
```

In parallel, an `AgentOrchestrator` runs autonomous background loops (once the webhook server starts) that poll Jira for new/stuck tickets and poll GitHub for merged PRs, feeding into the same resolver pipeline above.

---

## License

MIT
