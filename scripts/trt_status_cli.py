#!/usr/bin/env python3
"""Atomic status-file writer for TRT builds.

The status JSON is the only structured channel between the bash builder and the
Node monitor. Full stdout / stderr is intentionally streamed to the sibling
`.log` file and NEVER echoed into this JSON — agent readers must not be forced
to load large error payloads.

Subcommands:
  init        --model --name --checkpoint --engine-dir
  step        <step_id> <status> [--detail TEXT]
  keys        --json '{"missing_keys":[...],"unexpected_keys":[...]}'
  confirm     <true|false>
  terminal    <completed|failed> [--reason TEXT]

Env: STATUS_FILE must be set to the target JSON path.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

STEPS_MANIFEST = Path(__file__).resolve().parent.parent / "pipeline" / "trt_steps.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_path() -> Path:
    p = os.environ.get("STATUS_FILE")
    if not p:
        print("STATUS_FILE env not set", file=sys.stderr)
        sys.exit(2)
    return Path(p)


def _atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def cmd_init(args: argparse.Namespace) -> None:
    manifest = json.loads(STEPS_MANIFEST.read_text(encoding="utf-8"))
    steps = [{"id": s["id"], "name": s["name"], "status": "pending"} for s in manifest["steps"]]
    payload = {
        "model": args.model,
        "name": args.name,
        "checkpoint": args.checkpoint,
        "engine_dir": args.engine_dir,
        "steps": steps,
        "user_confirm_upload": False,
        "missing_keys": [],
        "unexpected_keys": [],
        "terminal": None,
        "reason": None,
        "started_at": _now(),
        "updated_at": _now(),
    }
    _atomic_write(_status_path(), payload)


def cmd_step(args: argparse.Namespace) -> None:
    path = _status_path()
    payload = _read(path)
    if payload is None:
        return
    for step in payload.get("steps", []):
        if step.get("id") == args.step_id:
            step["status"] = args.status
            if args.detail:
                step["detail"] = args.detail
            break
    payload["updated_at"] = _now()
    _atomic_write(path, payload)


def cmd_keys(args: argparse.Namespace) -> None:
    path = _status_path()
    payload = _read(path)
    if payload is None:
        return
    try:
        keys = json.loads(args.json) if args.json else {}
    except json.JSONDecodeError:
        keys = {}
    payload["missing_keys"] = list(keys.get("missing_keys") or [])
    payload["unexpected_keys"] = list(keys.get("unexpected_keys") or [])
    payload["updated_at"] = _now()
    _atomic_write(path, payload)


def cmd_confirm(args: argparse.Namespace) -> None:
    path = _status_path()
    payload = _read(path)
    if payload is None:
        return
    payload["user_confirm_upload"] = args.value.lower() in {"1", "true", "yes", "y"}
    payload["updated_at"] = _now()
    _atomic_write(path, payload)


def cmd_terminal(args: argparse.Namespace) -> None:
    path = _status_path()
    payload = _read(path)
    if payload is None:
        return
    payload["terminal"] = args.state
    if args.reason:
        payload["reason"] = args.reason
    payload["updated_at"] = _now()
    _atomic_write(path, payload)


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("init")
    pi.add_argument("--model", required=True)
    pi.add_argument("--name", required=True)
    pi.add_argument("--checkpoint", default="")
    pi.add_argument("--engine-dir", required=True, dest="engine_dir")
    pi.set_defaults(func=cmd_init)

    ps = sub.add_parser("step")
    ps.add_argument("step_id")
    ps.add_argument("status")
    ps.add_argument("--detail", default="")
    ps.set_defaults(func=cmd_step)

    pk = sub.add_parser("keys")
    pk.add_argument("--json", required=True)
    pk.set_defaults(func=cmd_keys)

    pc = sub.add_parser("confirm")
    pc.add_argument("value")
    pc.set_defaults(func=cmd_confirm)

    pt = sub.add_parser("terminal")
    pt.add_argument("state", choices=["completed", "failed"])
    pt.add_argument("--reason", default="")
    pt.set_defaults(func=cmd_terminal)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
