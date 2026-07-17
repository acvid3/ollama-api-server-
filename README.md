# Ollama API Server

A lightweight HTTP proxy that routes requests to local Ollama models.

Supports:
- Text generation (`type: "text"`)
- Function calling routing (`type: "function_calling"`)
- Video generation — planned but not implemented

## Quick Start

```bash
node api.mjs
```

Server starts on `http://0.0.0.0:3457`.

Requires Ollama running locally with the configured models pulled.

## API

### POST /api/ask

```json
{
  "type": "text",
  "system_prompt": "...",
  "user_message": "...",
  "session_id": "optional"
}
```

**Types:**

| Type | Behavior |
|---|---|
| `text` | Sends prompt to LLM, returns text response |
| `function_calling` | Routes to a registered function or returns `null` |
| `video` | Not implemented yet |

### Functions

```
POST   /api/function          — register { name, description, parameters? }
GET    /api/function          — list all
DELETE /api/function/:name    — delete
```

When no function matches, the API returns available endpoints in the response.

## Configuration

Set via environment variables or `.env` file:

| Variable | Default | Notes |
|---|---|---|
| `API_PORT` | `3457` | |
| `OLLAMA_URL` | `http://localhost:11434` | |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Fallback model |
| `OLLAMA_MODEL_TEXT` | `qwen2.5:14b` | Used for `type: "text"` |
| `OLLAMA_MODEL_FUNCTION` | `qwen2.5:14b` | Used for `type: "function_calling"` |
| `OLLAMA_MODEL_VIDEO` | `qwen2.5:14b` | Not yet used |
