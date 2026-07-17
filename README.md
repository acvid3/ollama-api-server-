# Ollama API Server

A proxy server that routes requests to Ollama models with support for text generation, function calling, and video generation.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env` and configure your models
3. Start: `npm start` or `systemctl start ollama-api.service`

## API Endpoints

### POST /api/ask

Generate a response from an Ollama model.

**Request:**
```json
{
  "type": "text",
  "system_prompt": "You are a helpful assistant.",
  "user_message": "What is the capital of France?",
  "session_id": "optional-session-id"
}
```

**Types:**

| Type | Description | Model |
|---|---|---|
| `text` | Standard text generation | `qwen2.5:14b` |
| `function_calling` | Route to a registered function | `qwen2.5:14b` |
| `video` | Video generation (WIP) | `tbd` |

### POST /api/function

Register a new function for function calling.

```json
{
  "name": "my_function",
  "description": "What this function does",
  "parameters": {
    "param1": { "type": "string" }
  }
}
```

### GET /api/function

List all registered functions.

### DELETE /api/function/:name

Delete a registered function.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `3457` | Server port |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Default model |
| `OLLAMA_MODEL_TEXT` | `qwen2.5:14b` | Model for text type |
| `OLLAMA_MODEL_FUNCTION` | `qwen2.5:14b` | Model for function_calling |
| `OLLAMA_MODEL_VIDEO` | `qwen2.5:14b` | Model for video type |

## Systemd Service

```bash
systemctl start ollama-api.service
systemctl enable ollama-api.service
```
# ollama-api-server-
