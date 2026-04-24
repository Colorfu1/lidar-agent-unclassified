import os
from typing import Any

from stages.base import Stage


class ConfigValidateStage(Stage):
    def run(self) -> dict[str, Any]:
        config_path = self.inputs["config_path"]
        if not os.path.isfile(config_path):
            raise FileNotFoundError(f"Config not found: {config_path}")
        with open(config_path) as f:
            content = f.read()
        if "model" not in content:
            raise ValueError(f"Config {config_path} does not define a model")
        return {"config_path": config_path, "valid": True}
