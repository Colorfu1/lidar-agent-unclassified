import json
import os
from typing import Any

from stages.base import Stage


class ResultCollectStage(Stage):
    def run(self) -> dict[str, Any]:
        results = {}
        for key, path in self.inputs.items():
            if not key.endswith("_path"):
                continue
            task_name = key.replace("_result_path", "").replace("_path", "")
            if not os.path.isfile(path):
                results[task_name] = {"error": f"File not found: {path}"}
                continue
            with open(path) as f:
                results[task_name] = json.load(f)
        return {"results": results}
