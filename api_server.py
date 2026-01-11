"""
FastAPI server for WebAgent API.

Exposes:
1. POST /start - Start agent tasks
2. Frontend API endpoints for capsules and runs (reads from MongoDB)
"""

import asyncio
import re
import uuid
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from agent_runner import run_agent_task, TaskConfig
    AGENT_AVAILABLE = True
except Exception as e:
    AGENT_AVAILABLE = False
    run_agent_task = None
    TaskConfig = None
    print(f"Warning: agent_runner not available: {e}")

# MongoDB integration
try:
    import db as mongodb
    MONGODB_AVAILABLE = mongodb.test_connection()
except Exception as e:
    MONGODB_AVAILABLE = False
    mongodb = None
    print(f"Warning: MongoDB not available: {e}")

app = FastAPI(
    title="WebAgent API",
    description="API to start and monitor web automation agents",
    version="1.0.0",
)

# Allow CORS for Next.js and other frontends
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory task tracking (backup to MongoDB)
tasks: dict[str, dict] = {}
workflows: dict[str, dict] = {}
idempotency_cache: dict[str, dict] = {}


# ============ Request/Response Models ============

class StartTaskRequest(BaseModel):
    """Request body for starting a new agent task."""
    start_url: str
    goal_text: str
    goal_images: list[str] = []
    callback_url: str = ""  # Optional callback URL
    capsule_id: Optional[str] = None  # Optional parent capsule
    capsule_title: Optional[str] = None  # Title for new capsule
    headless: bool = True
    max_steps: int = 100


class StartTaskResponse(BaseModel):
    """Response after starting a task."""
    task_id: str
    capsule_id: str
    status: str
    message: str


class TaskStatusResponse(BaseModel):
    """Response for task status queries."""
    task_id: str
    status: str
    step: Optional[int] = None
    total_steps: Optional[int] = None
    started_at: Optional[str] = None
    error: Optional[str] = None


class ResolveRequest(BaseModel):
    """Request body for resolving human intervention."""
    step_id: str
    action: str  # "approve_continue", "provide_input", "edit_constraint", "abort"
    payload: Optional[dict] = None


class WorkflowSource(BaseModel):
    key: str
    type: str
    mode: str
    connector: Optional[dict] = None
    snapshot: Optional[dict] = None
    security: Optional[dict] = None


class WorkflowCreateRequest(BaseModel):
    title: str
    description: str
    deliverable: str
    workflow_md: str
    sources: list[WorkflowSource] = []


class WorkflowCreateResponse(BaseModel):
    workflow_id: str
    version: int
    status: str
    validation: dict


# ============ Agent Control Endpoints ============

@app.post("/start", response_model=StartTaskResponse, status_code=202)
async def start_task(request: StartTaskRequest, background_tasks: BackgroundTasks):
    """
    Start a new web agent task.
    
    The agent will run in the background and:
    1. Save progress to MongoDB for frontend
    2. POST status updates to callback_url (if provided)
    
    Returns immediately with task_id and capsule_id.
    """
    if not AGENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="Agent runner not available")
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    
    # Create or use existing capsule
    if request.capsule_id and MONGODB_AVAILABLE:
        capsule_id = request.capsule_id
        # Verify capsule exists
        capsule = mongodb.get_capsule(capsule_id)
        if not capsule:
            raise HTTPException(status_code=404, detail=f"Capsule {capsule_id} not found")
    else:
        capsule_id = f"capsule_{uuid.uuid4().hex[:12]}"
        if MONGODB_AVAILABLE:
            mongodb.create_capsule(
                capsule_id=capsule_id,
                title=request.capsule_title or request.goal_text[:50],
                summary=request.goal_text,
            )
    
    # Store task info in memory
    tasks[run_id] = {
        "status": "starting",
        "step": 0,
        "total_steps": request.max_steps,
        "started_at": datetime.utcnow().isoformat(),
        "capsule_id": capsule_id,
        "error": None,
    }
    
    # Create task config
    config = TaskConfig(
        task_id=run_id,
        capsule_id=capsule_id,
        start_url=request.start_url,
        goal_text=request.goal_text,
        goal_images=request.goal_images,
        callback_url=request.callback_url,
        headless=request.headless,
        max_steps=request.max_steps,
    )
    
    # Run agent in background
    background_tasks.add_task(run_agent_task, config, tasks)
    
    return StartTaskResponse(
        task_id=run_id,
        capsule_id=capsule_id,
        status="accepted",
        message="Task started. Monitor progress via /api/runs/{run_id} or callback URL.",
    )


@app.get("/status/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    """Get the current status of a task (from memory)."""
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task = tasks[task_id]
    return TaskStatusResponse(
        task_id=task_id,
        status=task["status"],
        step=task.get("step"),
        total_steps=task.get("total_steps"),
        started_at=task.get("started_at"),
        error=task.get("error"),
    )


@app.get("/tasks")
async def list_tasks():
    """List all tasks and their current status (from memory)."""
    return {
        "tasks": [
            {
                "task_id": task_id,
                "status": task["status"],
                "step": task.get("step"),
                "started_at": task.get("started_at"),
                "capsule_id": task.get("capsule_id"),
            }
            for task_id, task in tasks.items()
        ]
    }


@app.delete("/tasks/{task_id}")
async def cancel_task(task_id: str):
    """Cancel a running task (best effort - marks it for cancellation)."""
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    tasks[task_id]["status"] = "cancelling"
    return {"message": f"Task {task_id} marked for cancellation"}


# ============ Workflow Endpoints ============

def parse_workflow_markdown(workflow_md: str) -> tuple[list[dict], list[str]]:
    step_heading = re.compile(r"^## Step\s+(\d+):\s+(.+?)\s+\(id:\s*([^)]+)\)\s*$")
    source_token = re.compile(r"\[\[source:([^\]]+)\]\]")
    lines = workflow_md.splitlines()

    step_indexes = []
    for idx, line in enumerate(lines):
        match = step_heading.match(line.strip())
        if match:
            step_indexes.append((idx, match.group(1), match.group(2), match.group(3)))

    parsed_steps = []
    referenced_sources: list[str] = []

    for i, (line_idx, order, title, step_id) in enumerate(step_indexes):
        start = line_idx + 1
        end = step_indexes[i + 1][0] if i + 1 < len(step_indexes) else len(lines)
        section = "\n".join(lines[start:end])
        source_keys = source_token.findall(section)
        referenced_sources.extend(source_keys)
        parsed_steps.append(
            {
                "step_id": step_id.strip(),
                "title": title.strip(),
                "order": int(order),
                "source_keys": source_keys,
            }
        )

    return parsed_steps, list(dict.fromkeys(referenced_sources))


def store_workflow(doc: dict) -> str:
    if MONGODB_AVAILABLE and hasattr(mongodb, "create_workflow"):
        try:
            result = mongodb.create_workflow(doc)
            if isinstance(result, dict):
                return result.get("workflow_id") or result.get("_id") or doc["workflow_id"]
            if isinstance(result, str):
                return result
        except Exception as exc:
            print(f"Warning: MongoDB create_workflow failed: {exc}")

    workflows[doc["workflow_id"]] = doc
    return doc["workflow_id"]


@app.post("/workflows", response_model=WorkflowCreateResponse, status_code=201)
async def create_workflow(request: WorkflowCreateRequest, http_request: Request):
    idempotency_key = http_request.headers.get("Idempotency-Key")
    if idempotency_key and idempotency_key in idempotency_cache:
        return idempotency_cache[idempotency_key]

    parsed_steps, referenced_source_keys = parse_workflow_markdown(request.workflow_md)
    provided_source_keys = [source.key for source in request.sources]
    missing_sources = [key for key in referenced_source_keys if key not in provided_source_keys]

    status = "invalid" if missing_sources else "ready"
    validation = {
        "parsed_steps": parsed_steps,
        "referenced_source_keys": referenced_source_keys,
        "missing_sources": missing_sources,
        "warnings": [],
        "errors": [
            {
                "code": "MISSING_SOURCE",
                "message": f"Workflow references [[source:{key}]] but no source with key={key} was provided."
            }
            for key in missing_sources
        ],
    }

    workflow_id = f"wf_{uuid.uuid4().hex[:12]}"
    workflow_doc = {
        "workflow_id": workflow_id,
        "title": request.title,
        "description": request.description,
        "deliverable": request.deliverable,
        "workflow_md": request.workflow_md,
        "sources": [source.model_dump() for source in request.sources],
        "version": 1,
        "status": status,
        "validation": validation,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
    }

    workflow_id = store_workflow(workflow_doc)

    response_payload = WorkflowCreateResponse(
        workflow_id=workflow_id,
        version=1,
        status=status,
        validation=validation,
    )

    if idempotency_key:
        idempotency_cache[idempotency_key] = response_payload

    return response_payload


# ============ Frontend API Endpoints (MongoDB) ============

@app.get("/api/capsules")
async def api_list_capsules(page: int = 1, pageSize: int = 20):
    """List all capsules (paginated) - for frontend."""
    if not MONGODB_AVAILABLE:
        raise HTTPException(status_code=503, detail="MongoDB not available")
    
    return mongodb.list_capsules(page=page, page_size=pageSize)


@app.get("/api/capsules/{capsule_id}")
async def api_get_capsule(capsule_id: str):
    """Get capsule by ID - for frontend."""
    if not MONGODB_AVAILABLE:
        raise HTTPException(status_code=503, detail="MongoDB not available")
    
    capsule = mongodb.get_capsule(capsule_id)
    if not capsule:
        raise HTTPException(status_code=404, detail="Capsule not found")
    
    return capsule


@app.get("/api/capsules/{capsule_id}/runs")
async def api_get_capsule_runs(capsule_id: str):
    """Get all runs for a capsule - for frontend."""
    if not MONGODB_AVAILABLE:
        raise HTTPException(status_code=503, detail="MongoDB not available")
    
    runs = mongodb.get_runs_for_capsule(capsule_id)
    return {"runs": runs}


@app.get("/api/runs/{run_id}")
async def api_get_run(run_id: str):
    """Get run by ID (includes steps + eventLog) - for frontend."""
    if not MONGODB_AVAILABLE:
        raise HTTPException(status_code=503, detail="MongoDB not available")
    
    run = mongodb.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    return run


@app.post("/api/runs/{run_id}/resolve")
async def api_resolve_human_action(run_id: str, request: ResolveRequest):
    """Submit human action for intervention - for frontend."""
    if not MONGODB_AVAILABLE:
        raise HTTPException(status_code=503, detail="MongoDB not available")
    
    run = mongodb.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    
    # Record the human resolution
    mongodb.resolve_human_action(
        run_id=run_id,
        step_id=request.step_id,
        action=request.action,
        payload=request.payload,
    )
    
    return {"status": "resolved", "run_id": run_id, "step_id": request.step_id}


# ============ Utility Endpoints ============

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "mongodb": "connected" if MONGODB_AVAILABLE else "disconnected",
    }


@app.get("/api/health")
async def api_health():
    """API health check with MongoDB status."""
    mongo_status = "disconnected"
    if MONGODB_AVAILABLE:
        try:
            mongodb.test_connection()
            mongo_status = "connected"
        except:
            mongo_status = "error"
    
    return {
        "status": "healthy",
        "mongodb": mongo_status,
        "timestamp": datetime.utcnow().isoformat(),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
