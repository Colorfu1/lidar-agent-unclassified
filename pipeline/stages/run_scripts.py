import subprocess
from typing import Any

from stages.base import Stage


class RunScriptsStage(Stage):
    def run(self) -> dict[str, Any]:
        scripts = self.inputs.get("scripts", [])
        config = self.inputs.get("config", "")
        results = []
        for script in scripts:
            cmd = ["python3", script]
            if config:
                cmd.extend(["--config", config])
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
            if result.returncode != 0:
                raise RuntimeError(f"Script {script} failed: {result.stderr}")
            results.append({"script": script, "stdout": result.stdout[-500:]})
        return {"script_results": results}
