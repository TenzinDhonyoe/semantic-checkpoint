# WebAgent API Service

A FastAPI-based service that exposes the web agent as an API. Start agent tasks via POST requests and receive status updates through webhooks.

## Architecture

```
User/Next.js  →  POST /start  →  FastAPI (8080)  →  Start Agent
                                      ↓
                                 Agent runs...
                                      ↓
              ←  POST /status  ←  Agent Step  →  POST /status  →  Callback API (8081)
                                      ↓
                               (repeat until done)
                                      ↓
              ←  POST /status (completed)  ←  Agent Done
```

## Quick Start

### 1. Install Dependencies

```bash
# Activate venv
source venv/bin/activate

# Install API dependencies
pip install -r requirements.txt
```

### 2. Start the API Server

```bash
# Start on port 8080
uvicorn api_server:app --host 0.0.0.0 --port 8080
```

### 3. (Optional) Start the Example Callback Server

```bash
# In another terminal, start the callback receiver on port 8081
uvicorn example_callback_server:app --port 8081
```

### 4. Start an Agent Task

```bash
curl -X POST http://localhost:8080/start \
  -H "Content-Type: application/json" \
  -d '{
    "start_url": "https://youtube.com",
    "goal_text": "Find a cat video and jump to the 00:45 mark",
    "goal_images": [],
    "callback_url": "http://localhost:8081/status",
    "headless": true,
    "max_steps": 50
  }'
```

## API Endpoints

### POST `/start`

Start a new web agent task.

**Request Body:**
```json
{
  "start_url": "https://example.com",
  "goal_text": "Description of what the agent should do",
  "goal_images": [],
  "callback_url": "http://your-server.com/webhook",
  "headless": true,
  "max_steps": 100
}
```

**Response (202 Accepted):**
```json
{
  "task_id": "uuid-string",
  "status": "accepted",
  "message": "Task started. Status updates will be sent to the callback URL."
}
```

### GET `/status/{task_id}`

Get current status of a task.

### GET `/tasks`

List all tasks and their status.

### DELETE `/tasks/{task_id}`

Request cancellation of a running task.

### GET `/health`

Health check endpoint.

## Callback Payload

The agent will POST to your `callback_url` after each step:

```json
{
  "task_id": "uuid-string",
  "status": "running",
  "step": 5,
  "total_steps": 100,
  "action": "click('submit-button')",
  "reasoning": "I need to click the submit button to proceed...",
  "screenshot_base64": "base64-encoded-png...",
  "error": null,
  "timestamp": "2026-01-10T14:30:00.000Z"
}
```

**Status values:**
- `running` - Task is in progress
- `completed` - Task finished successfully
- `failed` - Task encountered an error
- `cancelled` - Task was cancelled

## Using with Next.js

Create an API route to receive callbacks:

```typescript
// app/api/agent-callback/route.ts
export async function POST(request: Request) {
  const update = await request.json();
  
  console.log(`Step ${update.step}: ${update.action}`);
  
  // Store in database, emit via WebSocket, etc.
  // await db.updates.create({ data: update });
  // await pusher.trigger('agent-updates', 'step', update);
  
  return Response.json({ received: true });
}
```

Then start a task pointing to your callback:

```typescript
const response = await fetch('http://localhost:8080/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    start_url: 'https://youtube.com',
    goal_text: 'Find a cat video',
    callback_url: 'http://localhost:3000/api/agent-callback',
    max_steps: 50,
  }),
});

const { task_id } = await response.json();
console.log(`Started task: ${task_id}`);
```

## Environment Variables

Make sure these are set:
- `ANTHROPIC_API_KEY` - For the Claude agent
- `OPENROUTER_API_KEY` - If using OpenRouter

## Development

```bash
# Run API server with auto-reload
uvicorn api_server:app --reload --port 8080

# Run callback server for testing
uvicorn example_callback_server:app --port 8081
```
