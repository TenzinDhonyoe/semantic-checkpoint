"""
Background agent runner with callback status updates and MongoDB persistence.

This module wraps the webagent functionality to run in a separate thread
(to avoid Playwright sync/async conflicts) and:
1. POST status updates to a callback endpoint
2. Save runs/steps/events to MongoDB for the frontend
"""

import asyncio
import base64
import logging
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional
from concurrent.futures import ThreadPoolExecutor

import httpx

from browsergym_browserless.core.task import AbstractBrowserTask
from browsergym_browserless.core.registration import register_task
from browsergym_browserless.experiments.loop import EnvArgs, ExpArgs, StepInfo

# MongoDB integration
try:
    import db as mongodb
    MONGODB_AVAILABLE = True
except Exception as e:
    MONGODB_AVAILABLE = False
    mongodb = None
    logging.warning(f"MongoDB not available: {e}")

# Try to import agentlab agent, fall back gracefully
try:
    from agentlab.agents.generic_agent import AGENT_CLAUDE_SONNET_35_VISION
    AGENT_AVAILABLE = True
except ImportError:
    AGENT_AVAILABLE = False
    AGENT_CLAUDE_SONNET_35_VISION = None

logger = logging.getLogger(__name__)

# Thread pool for running sync agent code
_executor = ThreadPoolExecutor(max_workers=4)


@dataclass
class TaskConfig:
    """Configuration for a web agent task."""
    task_id: str  # This becomes the runId
    capsule_id: str  # Parent capsule ID
    start_url: str
    goal_text: str
    goal_images: list[str]
    callback_url: str
    headless: bool = True
    max_steps: int = 100


@dataclass
class StatusUpdate:
    """Status update to send to callback URL."""
    task_id: str
    status: str  # "running", "completed", "failed"
    step: int
    total_steps: int
    action: Optional[str] = None
    reasoning: Optional[str] = None
    screenshot_base64: Optional[str] = None
    error: Optional[str] = None
    timestamp: str = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.utcnow().isoformat()
    
    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "step": self.step,
            "total_steps": self.total_steps,
            "action": self.action,
            "reasoning": self.reasoning,
            "screenshot_base64": self.screenshot_base64,
            "error": self.error,
            "timestamp": self.timestamp,
        }


def send_status_update_sync(callback_url: str, status: StatusUpdate) -> bool:
    """Send a status update to the callback URL (sync version for thread)."""
    if not callback_url:
        return True  # Skip if no callback URL
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                callback_url,
                json=status.to_dict(),
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            logger.info(f"Status update sent: step={status.step}, status={status.status}")
            return True
    except httpx.HTTPError as e:
        logger.error(f"Failed to send status update to {callback_url}: {e}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error sending status update: {e}")
        return False


class MultimodalTask(AbstractBrowserTask):
    """Task that supports text + image goals."""
    
    @classmethod
    def get_task_id(cls):
        return "multimodal_api"
    
    def __init__(self, seed: int, start_url: str, goal_text: str, goal_images: list = None):
        super().__init__(seed)
        self.start_url = start_url
        self.goal_text = goal_text
        self.goal_images = goal_images or []
    
    def setup(self, page):
        page.goto(self.start_url, timeout=10000)
        
        # Build multimodal goal_object (OpenAI format)
        goal = [{"type": "text", "text": self.goal_text}]
        
        for img in self.goal_images:
            if img.startswith("data:image"):
                goal.append({"type": "image_url", "image_url": img})
            else:
                img_path = Path(img)
                with open(img_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                suffix = img_path.suffix.lower().replace(".", "")
                mime_map = {
                    "png": "image/png",
                    "jpg": "image/jpeg",
                    "jpeg": "image/jpeg",
                    "gif": "image/gif",
                    "webp": "image/webp"
                }
                mime = mime_map.get(suffix, "image/png")
                goal.append({"type": "image_url", "image_url": f"data:{mime};base64,{b64}"})
        
        return goal, {}
    
    def validate(self, page, chat_messages):
        for msg in chat_messages:
            if msg["role"] == "user" and msg["message"] == "exit":
                return 0, True, "", {}
        return 0, False, "", {}
    
    def teardown(self):
        pass


# Register the task
register_task("multimodal_api", MultimodalTask)


def encode_screenshot_base64(screenshot) -> Optional[str]:
    """Encode a screenshot (numpy array) to base64 PNG string."""
    if screenshot is None:
        return None
    try:
        from PIL import Image
        import io
        img = Image.fromarray(screenshot)
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("utf-8")
    except Exception as e:
        logger.error(f"Failed to encode screenshot: {e}")
        return None


def generate_step_id(run_id: str, index: int) -> str:
    """Generate a step ID."""
    return f"step_{run_id}_{index:03d}"


async def run_agent_task(config: TaskConfig, tasks_registry: dict):
    """
    Run the web agent task and send status updates via callback.
    
    This is the main entry point for background task execution.
    Runs the sync Playwright code in a separate thread to avoid async conflicts.
    """
    run_id = config.task_id
    
    # Create run in MongoDB
    if MONGODB_AVAILABLE:
        try:
            mongodb.create_run(
                run_id=run_id,
                task_id=config.capsule_id,
                goal=config.goal_text,
                max_steps=config.max_steps,
            )
            logger.info(f"Created MongoDB run: {run_id}")
        except Exception as e:
            logger.error(f"Failed to create MongoDB run: {e}")
    
    if not AGENT_AVAILABLE:
        error_msg = "AgentLab not available. Please install agentlab package."
        logger.error(error_msg)
        tasks_registry[config.task_id]["status"] = "failed"
        tasks_registry[config.task_id]["error"] = error_msg
        
        # Update MongoDB
        if MONGODB_AVAILABLE:
            mongodb.update_run_status(run_id, "failed")
        
        send_status_update_sync(
            config.callback_url,
            StatusUpdate(
                task_id=config.task_id,
                status="failed",
                step=0,
                total_steps=config.max_steps,
                error=error_msg,
            )
        )
        return
    
    # Update task status
    tasks_registry[config.task_id]["status"] = "running"
    
    # Send initial status
    send_status_update_sync(
        config.callback_url,
        StatusUpdate(
            task_id=config.task_id,
            status="running",
            step=0,
            total_steps=config.max_steps,
            action="initializing",
        )
    )
    
    try:
        # Run the sync agent code in a separate thread to avoid Playwright async conflicts
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(
            _executor,
            run_agent_sync,
            config,
            tasks_registry
        )
        
    except Exception as e:
        error_msg = f"Agent task failed: {type(e).__name__}: {e}"
        stack_trace = traceback.format_exc()
        logger.error(f"{error_msg}\n{stack_trace}")
        
        tasks_registry[config.task_id]["status"] = "failed"
        tasks_registry[config.task_id]["error"] = error_msg
        
        # Update MongoDB
        if MONGODB_AVAILABLE:
            mongodb.update_run_status(run_id, "failed")
        
        send_status_update_sync(
            config.callback_url,
            StatusUpdate(
                task_id=config.task_id,
                status="failed",
                step=tasks_registry[config.task_id].get("step", 0),
                total_steps=config.max_steps,
                error=error_msg,
            )
        )


def run_agent_sync(config: TaskConfig, tasks_registry: dict):
    """
    Run the agent loop synchronously (in a thread).
    
    This function runs the BrowserGym/Playwright code which requires
    sync execution outside of the asyncio event loop.
    """
    run_id = config.task_id
    
    task_kwargs = {
        "start_url": config.start_url,
        "goal_text": config.goal_text,
        "goal_images": config.goal_images,
    }
    
    exp_args = ExpArgs(
        agent_args=AGENT_CLAUDE_SONNET_35_VISION,
        env_args=EnvArgs(
            task_name="multimodal_api",
            task_kwargs=task_kwargs,
            headless=config.headless,
            max_steps=config.max_steps,
        ),
    )
    
    # Prepare experiment directory
    results_dir = Path("./results")
    results_dir.mkdir(exist_ok=True)
    exp_args.prepare(results_dir)
    
    env = None
    current_step_id = None
    
    try:
        # Create agent and environment
        agent = exp_args.agent_args.make_agent()
        env = exp_args.env_args.make_env(
            action_mapping=agent.action_set.to_python_code,
            exp_dir=exp_args.exp_dir,
        )
        
        # Reset environment
        step_info = StepInfo(step=0)
        step_info.from_reset(
            env,
            seed=exp_args.env_args.task_seed,
            obs_preprocessor=agent.obs_preprocessor
        )
        
        current_step = 0
        
        # Add initial step to MongoDB
        if MONGODB_AVAILABLE:
            current_step_id = generate_step_id(run_id, current_step)
            mongodb.add_step(
                run_id=run_id,
                step_id=current_step_id,
                index=current_step,
                title=f"Navigate to {config.start_url}",
                tool="browser",
                input_summary=f"Open {config.start_url}",
            )
            mongodb.complete_step(
                run_id=run_id,
                step_id=current_step_id,
                output_summary="Page loaded successfully",
                status="success",
            )
            # Increment source count
            mongodb.update_capsule_stats(config.capsule_id, source_count=1)
        
        while not step_info.is_done:
            # Check for cancellation
            if tasks_registry[config.task_id].get("status") == "cancelling":
                logger.info(f"Task {config.task_id} cancelled")
                tasks_registry[config.task_id]["status"] = "cancelled"
                
                if MONGODB_AVAILABLE:
                    mongodb.update_run_status(run_id, "cancelled")
                
                send_status_update_sync(
                    config.callback_url,
                    StatusUpdate(
                        task_id=config.task_id,
                        status="cancelled",
                        step=current_step,
                        total_steps=config.max_steps,
                    )
                )
                return
            
            current_step += 1
            
            # Create step in MongoDB before getting action
            if MONGODB_AVAILABLE:
                current_step_id = generate_step_id(run_id, current_step)
                mongodb.add_step(
                    run_id=run_id,
                    step_id=current_step_id,
                    index=current_step,
                    title=f"Step {current_step}: Analyzing page",
                    tool="browser",
                    input_summary="Determining next action based on goal",
                )
            
            # Get action from agent
            action = step_info.from_action(agent)
            
            # Extract reasoning if available
            reasoning = step_info.agent_info.get("think", None)
            
            # Get screenshot for callback
            screenshot_b64 = None
            if step_info.obs and "screenshot" in step_info.obs:
                screenshot_b64 = encode_screenshot_base64(step_info.obs["screenshot"])
                # Update screenshot count
                if MONGODB_AVAILABLE:
                    mongodb.update_capsule_stats(config.capsule_id, screenshot_count=1)
            
            # Update registry
            tasks_registry[config.task_id]["step"] = current_step
            
            # Update step in MongoDB with action
            if MONGODB_AVAILABLE and current_step_id:
                # Extract action title from the action string
                action_title = action[:50] + "..." if action and len(action) > 50 else action
                mongodb.complete_step(
                    run_id=run_id,
                    step_id=current_step_id,
                    output_summary=action_title or "No action",
                    status="success",
                )
            
            # Send step status update
            send_status_update_sync(
                config.callback_url,
                StatusUpdate(
                    task_id=config.task_id,
                    status="running",
                    step=current_step,
                    total_steps=config.max_steps,
                    action=action,
                    reasoning=reasoning,
                    screenshot_base64=screenshot_b64,
                )
            )
            
            if action is None:
                step_info.truncated = True
                break
            
            # Save step info
            step_info.save_step_info(
                exp_args.exp_dir,
                save_screenshot=exp_args.save_screenshot,
                save_som=exp_args.save_som
            )
            
            # Execute action in environment
            step_info = StepInfo(step=current_step)
            step_info.from_step(env, action, obs_preprocessor=agent.obs_preprocessor)
        
        # Task completed successfully
        tasks_registry[config.task_id]["status"] = "completed"
        tasks_registry[config.task_id]["step"] = current_step
        
        # Update MongoDB
        if MONGODB_AVAILABLE:
            mongodb.update_run_status(run_id, "completed")
        
        # Send completion status
        final_screenshot_b64 = None
        if step_info.obs and "screenshot" in step_info.obs:
            final_screenshot_b64 = encode_screenshot_base64(step_info.obs["screenshot"])
        
        send_status_update_sync(
            config.callback_url,
            StatusUpdate(
                task_id=config.task_id,
                status="completed",
                step=current_step,
                total_steps=config.max_steps,
                screenshot_base64=final_screenshot_b64,
            )
        )
        
        # Save final step info
        step_info.save_step_info(
            exp_args.exp_dir,
            save_screenshot=exp_args.save_screenshot,
            save_som=exp_args.save_som
        )
        
    except Exception as e:
        error_msg = f"Agent error: {type(e).__name__}: {e}"
        stack_trace = traceback.format_exc()
        logger.error(f"{error_msg}\n{stack_trace}")
        
        tasks_registry[config.task_id]["status"] = "failed"
        tasks_registry[config.task_id]["error"] = error_msg
        
        # Update MongoDB
        if MONGODB_AVAILABLE:
            mongodb.update_run_status(run_id, "failed")
            if current_step_id:
                mongodb.fail_step(
                    run_id=run_id,
                    step_id=current_step_id,
                    error_type="unknown",
                    error_message=str(e),
                )
        
        send_status_update_sync(
            config.callback_url,
            StatusUpdate(
                task_id=config.task_id,
                status="failed",
                step=tasks_registry[config.task_id].get("step", 0),
                total_steps=config.max_steps,
                error=error_msg,
            )
        )
        raise
        
    finally:
        if env is not None:
            try:
                env.close()
            except Exception as e:
                logger.error(f"Error closing environment: {e}")


if __name__ == "__main__":
    # Test the runner directly (outside of FastAPI)
    import asyncio
    
    async def test():
        config = TaskConfig(
            task_id="run_test_123",
            capsule_id="capsule_test_001",
            start_url="https://example.com",
            goal_text="Click the 'More information' link",
            goal_images=[],
            callback_url="http://localhost:8081/status",
            headless=True,
            max_steps=10,
        )
        
        tasks = {config.task_id: {"status": "starting", "step": 0}}
        await run_agent_task(config, tasks)
        print(f"Final status: {tasks[config.task_id]}")
    
    asyncio.run(test())
