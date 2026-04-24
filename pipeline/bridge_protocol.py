import json
import sys
from typing import Any


def read_request() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        sys.exit(0)
    return json.loads(line)


def send_response(msg_type: str, data: dict[str, Any]) -> None:
    payload = {"type": msg_type, **data}
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def send_stage_started(stage_id: str) -> None:
    send_response("stage_started", {"stage_id": stage_id})


def send_stage_completed(stage_id: str, outputs: dict[str, Any]) -> None:
    send_response("stage_completed", {"stage_id": stage_id, "outputs": outputs})


def send_stage_failed(stage_id: str, error: str) -> None:
    send_response("stage_failed", {"stage_id": stage_id, "error": error})


def send_pipeline_completed(pipeline_id: str) -> None:
    send_response("pipeline_completed", {"pipeline_id": pipeline_id})


def send_pipeline_failed(pipeline_id: str, error: str) -> None:
    send_response("pipeline_failed", {"pipeline_id": pipeline_id, "error": error})
