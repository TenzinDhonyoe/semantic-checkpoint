import base64
import os
from pathlib import Path

from browsergym.core.task import AbstractBrowserTask
from browsergym.core.registration import register_task
from agentlab.agents.generic_agent import AGENT_CLAUDE_SONNET_35_VISION
from agentlab.experiments.loop import EnvArgs, ExpArgs


class MultimodalTask(AbstractBrowserTask):
    """Task that supports text + image goals."""
    
    @classmethod
    def get_task_id(cls):
        return "multimodal"
    
    def __init__(self, seed: int, start_url: str, goal_text: str, goal_images: list = None):
        """
        Args:
            seed: Random seed
            start_url: URL to navigate to
            goal_text: Text description of the task
            goal_images: List of image paths or base64 data URLs
        """
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
                # Already a data URL
                goal.append({"type": "image_url", "image_url": img})
            else:
                # Load from file path
                img_path = Path(img)
                with open(img_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                suffix = img_path.suffix.lower().replace(".", "")
                mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}
                mime = mime_map.get(suffix, "image/png")
                goal.append({"type": "image_url", "image_url": f"data:{mime};base64,{b64}"})
        
        return goal, {}  # Return list for multimodal goal
    
    def validate(self, page, chat_messages):
        for msg in chat_messages:
            if msg["role"] == "user" and msg["message"] == "exit":
                return 0, True, "", {}
        return 0, False, "", {}
    
    def teardown(self):
        pass


# Register the custom task
register_task("multimodal", MultimodalTask)


# ============ USAGE EXAMPLE ============

# Set your OpenRouter API key (get one at https://openrouter.ai)
# os.environ["OPENROUTER_API_KEY"] = "your-key-here"

# Example 1: Text-only task
# task_kwargs = {
#     "start_url": "https://example.com",
#     "goal_text": "Click the 'More Information' link",
#     "goal_images": [],
# }

# Example 2: Task with image(s)
# task_kwargs = {
#     "start_url": "https://example.com",
#     "goal_text": "Find and click the element shown in this screenshot",
#     "goal_images": ["/path/to/screenshot.png"],
# }

# Example 3: Multiple images
# task_kwargs = {
#     "start_url": "https://example.com",  
#     "goal_text": "Navigate from the state shown in image 1 to the state shown in image 2",
#     "goal_images": ["/path/to/before.png", "/path/to/after.png"],
# }


if __name__ == "__main__":
    # Configure your task here
    task_kwargs = {
        "start_url": "https://youtube.com",
        "goal_text": "Go to a youtube video which shows a cat and jump to the 00:45 minute mark.",
        "goal_images": [],  # Add image paths here, e.g. ["./screenshot.png"]
    }
    
    exp_args = ExpArgs(
        agent_args=AGENT_CLAUDE_SONNET_35_VISION,
        env_args=EnvArgs(
            task_name="multimodal",  # Use our custom task
            task_kwargs=task_kwargs,
            headless=False,
            max_steps=100,
        ),
    )
    
    exp_args.prepare(Path("./results"))
    exp_args.run()
