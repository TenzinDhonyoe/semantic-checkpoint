"""
Example callback server that receives status updates from the WebAgent API.

This is a simple FastAPI server that can be used to test the callback functionality.
In production, you would replace this with your own endpoint (e.g., in Next.js).

Run this server on port 8081:
    uvicorn example_callback_server:app --port 8081

Then start the main API server on port 8080:
    uvicorn api_server:app --port 8080

Send a task with callback_url pointing to this server:
    curl -X POST http://localhost:8080/start \
        -H "Content-Type: application/json" \
        -d '{
            "start_url": "https://example.com",
            "goal_text": "Click the More Information link",
            "callback_url": "http://localhost:8081/status"
        }'
"""

from datetime import datetime
from typing import Optional

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(
    title="Example Callback Server",
    description="Receives status updates from WebAgent API",
    version="1.0.0",
)

# Store received updates for inspection
received_updates: list[dict] = []


class StatusUpdate(BaseModel):
    """Status update received from WebAgent API."""
    task_id: str
    status: str
    step: int
    total_steps: int
    action: Optional[str] = None
    reasoning: Optional[str] = None
    screenshot_base64: Optional[str] = None
    error: Optional[str] = None
    timestamp: Optional[str] = None


@app.post("/status")
async def receive_status(update: StatusUpdate):
    """
    Receive a status update from the WebAgent API.
    
    This endpoint is called by the agent after each step.
    """
    # Log the update
    print(f"\n{'='*60}")
    print(f"[{datetime.now().isoformat()}] Status Update Received")
    print(f"{'='*60}")
    print(f"Task ID:     {update.task_id}")
    print(f"Status:      {update.status}")
    print(f"Step:        {update.step}/{update.total_steps}")
    
    if update.action:
        print(f"Action:      {update.action[:100]}..." if len(update.action) > 100 else f"Action:      {update.action}")
    
    if update.reasoning:
        print(f"Reasoning:   {update.reasoning[:100]}..." if len(update.reasoning) > 100 else f"Reasoning:   {update.reasoning}")
    
    if update.screenshot_base64:
        print(f"Screenshot:  [Base64 data, {len(update.screenshot_base64)} chars]")
    
    if update.error:
        print(f"ERROR:       {update.error}")
    
    print(f"{'='*60}\n")
    
    # Store for later inspection
    received_updates.append(update.model_dump())
    
    return {"received": True, "task_id": update.task_id, "step": update.step}


@app.get("/updates")
async def list_updates():
    """List all received status updates."""
    return {
        "count": len(received_updates),
        "updates": received_updates,
    }


@app.get("/updates/{task_id}")
async def get_task_updates(task_id: str):
    """Get all updates for a specific task."""
    task_updates = [u for u in received_updates if u["task_id"] == task_id]
    return {
        "task_id": task_id,
        "count": len(task_updates),
        "updates": task_updates,
    }


@app.delete("/updates")
async def clear_updates():
    """Clear all stored updates."""
    global received_updates
    count = len(received_updates)
    received_updates = []
    return {"cleared": count}


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*60)
    print("Example Callback Server")
    print("="*60)
    print("This server receives status updates from the WebAgent API.")
    print("POST /status - Receives status updates")
    print("GET /updates - Lists all received updates")
    print("="*60 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8081)
