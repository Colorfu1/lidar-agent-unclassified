#!/usr/bin/env python3
"""Sync Volc ML Platform task status to JSON stdout.

Ported from job-manager skill's volc_jobs_status_pretty.sh core logic.
Two-step approach:
  Step 1: List active tasks (Queue,Staging,Running,Killing)
  Step 2: For each unique job name, discover same-name jobs in terminal states

Outputs a JSON array of task objects to stdout.

Usage:
  python3 volc_task_sync.py                    # active tasks only
  python3 volc_task_sync.py --include-terminal  # also discover Success/Failed
  python3 volc_task_sync.py --task-id t-xxx     # single task details
  python3 volc_task_sync.py --name job-name     # filter by name
  python3 volc_task_sync.py --limit 100         # max tasks in step 1
"""

import argparse
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

NORMAL_QUEUE = "q-20241104174420-vt829"
PIPELINE_QUEUE = "q-20250327162123-lwvqb"


def parse_volc_json(raw: str) -> list[dict]:
    idx = raw.find("[")
    if idx < 0:
        return []
    try:
        return json.loads(raw[idx:])
    except json.JSONDecodeError:
        return []


def fetch_task_by_id(task_id: str) -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["volc", "ml_task", "get", "--id", task_id, "--output", "json"],
            capture_output=True, text=True, timeout=30,
        )
        data = parse_volc_json(result.stdout)
        if not data:
            return {"task_id": task_id, "status": "FetchError", "error": result.stderr[:200]}
        return normalize_task(data[0])
    except Exception as e:
        return {"task_id": task_id, "status": "FetchError", "error": str(e)[:200]}


def normalize_task(t: dict, discovered: bool = False) -> dict[str, Any]:
    specs = t.get("TaskRoleSpecs", [])
    workers = sum(s.get("RoleReplicas", 0) for s in specs if s.get("RoleName") == "worker")
    if not workers:
        workers = sum(s.get("RoleReplicas", 0) for s in specs)

    queue_id = t.get("ResourceQueueId", "")
    if queue_id == NORMAL_QUEUE:
        queue_label = "normal"
    elif queue_id == PIPELINE_QUEUE:
        queue_label = "pipeline"
    else:
        queue_label = queue_id[:20] if queue_id else ""

    status = t.get("Status", "Unknown")
    if discovered:
        status += "*"

    return {
        "task_id": t.get("JobId", ""),
        "name": t.get("JobName", ""),
        "status": status,
        "workers": workers,
        "queue": queue_id,
        "queue_label": queue_label,
        "creator": t.get("Creator", ""),
        "start": t.get("Start", ""),
        "end": t.get("End"),
        "elapsed": t.get("Elapsed"),
        "error": "",
    }


def list_tasks(statuses: str, limit: int, name_filter: str = "") -> list[dict]:
    cmd = ["volc", "ml_task", "list", "--output", "json", "--limit", str(limit), "-s", statuses]
    if name_filter:
        cmd.extend(["-n", name_filter])
    cmd.extend(["--format", "JobId,JobName,Status,Start,End,Creator,ResourceQueueId,TaskRoleSpecs"])
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return parse_volc_json(result.stdout + result.stderr)
    except Exception:
        return []


def discover_same_name(job_name: str, known_ids: set[str]) -> list[dict]:
    raw_tasks = list_tasks("Queue,Staging,Running,Success", 20, name_filter=job_name)
    results = []
    for t in raw_tasks:
        jid = t.get("JobId", "")
        if not jid or jid in known_ids:
            continue
        results.append(normalize_task(t, discovered=True))
        known_ids.add(jid)
    return results


def main():
    parser = argparse.ArgumentParser(description="Sync Volc ML task status")
    parser.add_argument("--task-id", help="Fetch a single task by ID")
    parser.add_argument("--name", help="Filter by task name")
    parser.add_argument("--limit", type=int, default=50, help="Max tasks to fetch in step 1")
    parser.add_argument("--include-terminal", action="store_true", help="Also discover terminal-state same-name jobs")
    parser.add_argument("--statuses", default="Queue,Staging,Running,Killing", help="Status filter for step 1")
    args = parser.parse_args()

    # Single task lookup
    if args.task_id:
        task = fetch_task_by_id(args.task_id)
        json.dump([task], sys.stdout, ensure_ascii=False)
        return

    # Step 1: list active tasks
    raw_tasks = list_tasks(args.statuses, args.limit, name_filter=args.name or "")
    tasks = [normalize_task(t) for t in raw_tasks]
    known_ids = {t["task_id"] for t in tasks}

    # Step 2: discover same-name jobs in parallel
    if args.include_terminal:
        unique_names = list({t["name"] for t in tasks if t["name"]})
        if unique_names:
            with ThreadPoolExecutor(max_workers=8) as pool:
                futures = {pool.submit(discover_same_name, name, known_ids): name for name in unique_names}
                for f in as_completed(futures):
                    tasks.extend(f.result())

    # Sort: active first, then by start time descending
    status_order = {"Running": 0, "Queue": 1, "Staging": 2, "Killing": 3, "Success": 4, "Failed": 5, "Killed": 6}
    tasks.sort(key=lambda t: (
        status_order.get(t["status"].rstrip("*"), 99),
        -(t.get("elapsed") or 0),
    ))

    json.dump(tasks, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
