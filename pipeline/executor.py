import argparse
import json
import sys
from pathlib import Path
from typing import Any

import yaml

from bridge_protocol import (
    read_request,
    send_pipeline_completed,
    send_pipeline_failed,
    send_stage_completed,
    send_stage_failed,
    send_stage_started,
)


def load_dag(yaml_path: str) -> dict[str, Any]:
    with open(yaml_path) as f:
        return yaml.safe_load(f)


def resolve_variable(value: str, context: dict[str, Any]) -> str:
    if not isinstance(value, str):
        return value
    result = value
    for key, val in context.items():
        result = result.replace(f"${{{key}}}", str(val))
    return result


def resolve_inputs(inputs: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    return {k: resolve_variable(v, context) for k, v in inputs.items()}


def topological_sort(stages: list[dict]) -> list[dict]:
    id_to_stage = {s["id"]: s for s in stages}
    visited: set[str] = set()
    order: list[dict] = []

    def visit(stage_id: str) -> None:
        if stage_id in visited:
            return
        visited.add(stage_id)
        for dep in id_to_stage[stage_id].get("depends_on", []):
            visit(dep)
        order.append(id_to_stage[stage_id])

    for s in stages:
        visit(s["id"])
    return order


STAGE_REGISTRY: dict[str, type] = {}


def register_stage(stage_type: str, cls: type) -> None:
    STAGE_REGISTRY[stage_type] = cls


from stages.config_validate import ConfigValidateStage
from stages.volc_submit import VolcSubmitStage
from stages.volc_monitor import VolcMonitorStage
from stages.ssh_fetch import SSHFetchStage
from stages.result_collect import ResultCollectStage
from stages.db_store import DbStoreStage
from stages.run_scripts import RunScriptsStage
from stages.data_validate import DataValidateStage
from stages.notify import NotifyStage

register_stage("config_validate", ConfigValidateStage)
register_stage("volc_submit", VolcSubmitStage)
register_stage("volc_monitor", VolcMonitorStage)
register_stage("ssh_fetch", SSHFetchStage)
register_stage("result_collect", ResultCollectStage)
register_stage("db_store", DbStoreStage)
register_stage("run_scripts", RunScriptsStage)
register_stage("data_validate", DataValidateStage)
register_stage("notify", NotifyStage)
register_stage("check_data_source", ConfigValidateStage)


def run_pipeline(dag: dict, params: dict[str, Any]) -> None:
    context = dict(params)
    stages = topological_sort(dag["stages"])

    for stage_def in stages:
        stage_id = stage_def["id"]
        stage_type = stage_def["type"]
        raw_inputs = stage_def.get("inputs", {})
        resolved = resolve_inputs(raw_inputs, context)

        send_stage_started(stage_id)

        cls = STAGE_REGISTRY.get(stage_type)
        if cls is None:
            send_stage_failed(stage_id, f"Unknown stage type: {stage_type}")
            if stage_def.get("fail_fast", False):
                send_pipeline_failed(dag["name"], f"Stage {stage_id} failed")
                return
            continue

        try:
            stage = cls(stage_id, resolved)
            outputs = stage.run()
            for out_key, out_val in outputs.items():
                context[f"{stage_id}.output.{out_key}"] = out_val
            send_stage_completed(stage_id, outputs)
        except Exception as e:
            send_stage_failed(stage_id, str(e))
            if stage_def.get("fail_fast", True):
                send_pipeline_failed(dag["name"], f"Stage {stage_id}: {e}")
                return

    send_pipeline_completed(dag["name"])


def main_bridge_mode() -> None:
    """Run in bridge mode: read JSON requests from stdin."""
    while True:
        request = read_request()
        if request.get("type") == "run_pipeline":
            dag = load_dag(request["dag_path"])
            run_pipeline(dag, request.get("params", {}))
        elif request.get("type") == "ping":
            sys.stdout.write(json.dumps({"type": "pong"}) + "\n")
            sys.stdout.flush()


def main_cli_mode(dag_path: str, params_path: str | None) -> None:
    """Run from CLI directly."""
    dag = load_dag(dag_path)
    params = {}
    if params_path:
        with open(params_path) as f:
            params = json.load(f)
    run_pipeline(dag, params)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", action="store_true", help="Run in bridge mode (JSON stdin/stdout)")
    parser.add_argument("--dag", help="DAG YAML path")
    parser.add_argument("--params", help="Params JSON path")
    args = parser.parse_args()

    if args.bridge:
        main_bridge_mode()
    elif args.dag:
        main_cli_mode(args.dag, args.params)
    else:
        parser.print_help()
