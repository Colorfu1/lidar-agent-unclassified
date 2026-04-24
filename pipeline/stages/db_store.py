from typing import Any

from bridge_protocol import send_response
from stages.base import Stage


class DbStoreStage(Stage):
    def run(self) -> dict[str, Any]:
        experiment_id = self.inputs.get("experiment_id")
        send_response("store_results", {
            "experiment_id": experiment_id,
            "results": self.inputs.get("results", {}),
        })
        return {"stored": True}
