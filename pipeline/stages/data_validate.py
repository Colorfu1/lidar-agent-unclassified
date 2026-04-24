import os
from typing import Any

from stages.base import Stage


class DataValidateStage(Stage):
    def run(self) -> dict[str, Any]:
        output_path = self.inputs["output_path"]
        if not os.path.isdir(output_path):
            raise FileNotFoundError(f"Output directory not found: {output_path}")
        files = os.listdir(output_path)
        pkl_files = [f for f in files if f.endswith(".pkl")]
        if not pkl_files:
            raise ValueError(f"No .pkl files found in {output_path}")
        return {"total_files": len(files), "pkl_files": len(pkl_files)}
