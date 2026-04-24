import json
import subprocess
import time
from typing import Any

from stages.base import Stage

TERMINAL_STATES = {"Success", "Failed", "Cancelled", "Exception", "Stopped"}


class VolcMonitorStage(Stage):
    def run(self) -> dict[str, Any]:
        task_id = self.inputs["task_id"]
        poll_interval = int(self.inputs.get("poll_interval", 300))

        while True:
            cmd = ["volc", "ml_task", "get", "--id", task_id, "--output-format", "json"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                raise RuntimeError(f"volc get failed: {result.stderr}")
            output = json.loads(result.stdout)
            state = output.get("State") or output.get("Status", "Unknown")

            if state in TERMINAL_STATES:
                if state != "Success":
                    raise RuntimeError(f"Job {task_id} ended with state: {state}")
                return {"task_id": task_id, "final_state": state}

            time.sleep(poll_interval)
