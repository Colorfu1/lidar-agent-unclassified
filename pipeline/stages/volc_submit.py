import json
import subprocess
from typing import Any

from stages.base import Stage


class VolcSubmitStage(Stage):
    def run(self) -> dict[str, Any]:
        yaml_path = self.inputs["yaml_path"]
        cmd = ["volc", "ml_task", "submit", "--conf", yaml_path, "--output-format", "json"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if result.returncode != 0:
            raise RuntimeError(f"volc submit failed: {result.stderr}")
        output = json.loads(result.stdout)
        task_id = output.get("Id") or output.get("TaskId") or output.get("id")
        if not task_id:
            raise RuntimeError(f"No task_id in submit output: {result.stdout}")
        return {"task_id": str(task_id)}
