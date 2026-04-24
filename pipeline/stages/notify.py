from typing import Any

from bridge_protocol import send_response
from stages.base import Stage


class NotifyStage(Stage):
    def run(self) -> dict[str, Any]:
        message = self.inputs.get("message", "Pipeline stage completed")
        send_response("notification", {"message": message})
        return {"notified": True}
