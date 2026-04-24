#!/usr/bin/env python3
"""Submit an L4 TRT build as a Volc ML task.

The task script lives on shared vepfs at:
  /high_perf_store3/l3_data/wuwenda/lidar_agent_builds/bin/trt_build_l4_task.sh
Entrypoint exports env vars (build params + path config) and calls that script.

Model presets (--model lite|large) provide default branch, convert script,
and L4 path config. All can be overridden via CLI flags.

Outputs (stdout, one per line):
  task_id=<id>
  yaml_path=<archived yaml>
  out_dir=<shared-storage dir>
  engine_path=<expected .plf>
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import re
import shlex
import subprocess
import sys

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
WORKSPACE_ROOT = REPO_ROOT.parent
TEMPLATE = SCRIPT_DIR / "volc_trt_l4_template.yaml"
ARCHIVE_DIR = WORKSPACE_ROOT / "submitted_jobs_yamls"
DEFAULT_OUT_ROOT = "/high_perf_store3/l3_data/wuwenda/lidar_agent_builds/L4"
REMOTE_TASK_SCRIPT = "/high_perf_store3/l3_data/wuwenda/lidar_agent_builds/bin/trt_build_l4_task.sh"

L4_PLUGINS_DIR = "/high_perf_store3/l3_data/wuwenda/l3_deep/data/data/plugins"

MODEL_PRESETS = {
    "large": {
        "branch": "feat_merge",
        "convert_script": "deploy/convert_onnx_det/convert_onnx_online_vrf_L4.py",
        "plugin_path": f"{L4_PLUGINS_DIR}/libl3det_plugins_v3_3090.so",
        "load_inputs_dir": L4_PLUGINS_DIR,
        "export_output": f"{L4_PLUGINS_DIR}/output.json",
        "path_replace_old": "",
        "path_replace_new": "",
    },
    "lite": {
        "branch": "dev_lit",
        "convert_script": "deploy/convert_onnx_det/convert_onnx_s1_c128_4b_s2_64_b1_vfe_vrf_L4.py",
        "plugin_path": f"{L4_PLUGINS_DIR}/libl3det_plugins_v3_3090.so",
        "load_inputs_dir": L4_PLUGINS_DIR,
        "export_output": f"{L4_PLUGINS_DIR}/output.json",
        "path_replace_old": "/high_perf_store/l3_deep/wuwenda",
        "path_replace_new": "/high_perf_store3/l3_data/wuwenda/l3_deep",
    },
}


def sanitize(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")
    return s or "build"


def derive_stem(checkpoint: str, name: str) -> str:
    p = pathlib.Path(checkpoint)
    parent = sanitize(p.parent.name)
    m = re.match(r"epoch_(\d+)\.pth$", p.name)
    if m:
        return f"{parent}_ep{m.group(1)}"
    return f"{parent}_{sanitize(p.stem)}"


def build_entrypoint(env: dict[str, str]) -> str:
    exports = " ".join(f"export {k}={shlex.quote(v)};" for k, v in env.items())
    return f"{exports} bash {REMOTE_TASK_SCRIPT}"


def render_yaml(task_name: str, entrypoint: str) -> str:
    tmpl = TEMPLATE.read_text()
    out_lines = []
    for line in tmpl.splitlines():
        if line.startswith("TaskName:"):
            out_lines.append(f'TaskName: "{task_name}"')
        elif line.startswith("Entrypoint:"):
            out_lines.append(f"Entrypoint: {json.dumps(entrypoint)}")
        else:
            out_lines.append(line)
    return "\n".join(out_lines) + "\n"


def submit(yaml_path: pathlib.Path) -> str:
    proc = subprocess.run(
        ["volc", "ml_task", "submit", "--conf", str(yaml_path)],
        capture_output=True, text=True,
    )
    combined = proc.stdout + "\n" + proc.stderr
    if proc.returncode != 0:
        raise RuntimeError(f"volc submit failed (rc={proc.returncode})\n{combined}")
    m = re.search(r"(t-\d{14}-[a-z0-9]+)", combined)
    if not m:
        raise RuntimeError(f"could not parse task_id from submit output:\n{combined}")
    return m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=["lite", "large"])
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--name", required=True, help="build name (shared-storage subdir)")
    # Overrides (default from model preset)
    ap.add_argument("--branch")
    ap.add_argument("--convert-script")
    ap.add_argument("--plugin-path")
    ap.add_argument("--trtexec-bin", default="/TensorRT-10.8.0.43/bin/trtexec")
    ap.add_argument("--load-inputs-dir")
    ap.add_argument("--export-output")
    ap.add_argument("--out-root", default=DEFAULT_OUT_ROOT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    preset = MODEL_PRESETS[args.model]
    branch = args.branch or preset["branch"]
    convert_script = args.convert_script or preset["convert_script"]
    plugin_path = args.plugin_path or preset["plugin_path"]
    load_inputs_dir = args.load_inputs_dir or preset["load_inputs_dir"]
    export_output = args.export_output or preset["export_output"]
    path_replace_old = preset.get("path_replace_old", "")
    path_replace_new = preset.get("path_replace_new", "")

    name = sanitize(args.name)
    stem = derive_stem(args.checkpoint, name)
    ts = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    task_name = f"trt_l4_{name}_{ts}"

    env = {
        "BUILD_NAME": name,
        "CKPT": args.checkpoint,
        "STEM": stem,
        "OUT_ROOT": args.out_root,
        "BRANCH": branch,
        "CONVERT_SCRIPT": convert_script,
        "PLUGIN_PATH": plugin_path,
        "TRTEXEC_BIN": args.trtexec_bin,
        "LOAD_INPUTS_DIR": load_inputs_dir,
        "EXPORT_OUTPUT": export_output,
        "PATH_REPLACE_OLD": path_replace_old,
        "PATH_REPLACE_NEW": path_replace_new,
    }

    entrypoint = build_entrypoint(env)
    yaml_text = render_yaml(task_name, entrypoint)

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    yaml_path = ARCHIVE_DIR / f"{ts}_trt_l4_{name}.yaml"
    yaml_path.write_text(yaml_text)

    expected_engine = f"{args.out_root}/{name}/{stem}.plf"

    if args.dry_run:
        print(f"yaml_path={yaml_path}")
        print(f"expected_engine={expected_engine}")
        print(f"branch={branch}")
        print(f"convert_script={convert_script}")
        print(f"plugin_path={plugin_path}")
        print("task_id=DRY_RUN")
        return 0

    task_id = submit(yaml_path)
    print(f"task_id={task_id}")
    print(f"yaml_path={yaml_path}")
    print(f"out_dir={args.out_root}/{name}")
    print(f"engine_path={expected_engine}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
