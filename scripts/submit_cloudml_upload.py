#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


def compute_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_upload_dir(input_path: Path, output_subdir: str) -> Path:
    if input_path.is_file():
        if input_path.suffix.lower() != ".plf":
            raise ValueError(f"Expected a .plf file, got: {input_path}")
        return input_path.parent / output_subdir
    if input_path.is_dir():
        if (input_path / "model.plf").is_file() and (input_path / "metadata.json").is_file():
            return input_path
        return input_path / output_subdir
    raise FileNotFoundError(f"Path not found: {input_path}")


def load_metadata(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"metadata.json must contain a JSON object: {path}")
    return data


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"Missing {label}: {path}")


def print_evidence(model_plf: Path, metadata_path: Path, metadata: dict, actual_md5: str) -> None:
    metadata_md5 = metadata.get("md5", "")
    md5_match = actual_md5 == metadata_md5
    print("Pre-submit evidence:")
    print(f"  source_plf:     {model_plf}")
    print(f"  metadata_json:  {metadata_path}")
    print(f"  computed_md5:   {actual_md5}")
    print(f"  metadata_md5:   {metadata_md5}")
    print(f"  md5_match:      {'yes' if md5_match else 'no'}")
    if not md5_match:
        raise ValueError("metadata.json md5 does not match model.plf md5")


def print_attributes(metadata: dict, upload_dir: Path, app_label: str) -> None:
    print("Important upload attributes:")
    print(f"  name:        {metadata.get('name', '')}")
    print(f"  version:     {metadata.get('version', '')}")
    print(f"  platform:    {metadata.get('platform', '')}")
    print(f"  runtime:     {metadata.get('runtime', '')}")
    print(f"  precision:   {metadata.get('precision', '')}")
    print(f"  app_label:   {app_label}")
    print(f"  upload_dir:  {upload_dir}")


def build_upload_command(metadata: dict, upload_dir: Path, app_label: str) -> list[str]:
    name = metadata.get("name")
    version = metadata.get("version")
    if not name or not version:
        raise ValueError("metadata.json must contain non-empty 'name' and 'version'")
    return [
        "cloudml",
        "model-repo",
        "upload",
        str(name),
        str(version),
        str(upload_dir),
        "-al",
        app_label,
    ]


def build_describe_command(metadata: dict, app_label: str) -> list[str]:
    return [
        "cloudml",
        "model-repo",
        "describe",
        "-n",
        str(metadata["name"]),
        "-v",
        str(metadata["version"]),
        "-al",
        app_label,
    ]


def run_cloudml(command: list[str]) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env["DISPLAY"] = ""
    for key in (
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "all_proxy",
        "ALL_PROXY",
        "no_proxy",
        "NO_PROXY",
    ):
        env.pop(key, None)
    return subprocess.run(command, text=True, capture_output=True, env=env)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a cloudml_upload package, ask for confirmation, then upload."
    )
    parser.add_argument("path", help="Source model directory, .plf path, or cloudml_upload directory")
    parser.add_argument("--output-subdir", default="cloudml_upload", help="Upload subdirectory name")
    parser.add_argument("--app-label", default="ipc3090", help="CloudML app label")
    parser.add_argument("--yes", action="store_true", help="Skip interactive confirmation (for agent/automation use)")
    args = parser.parse_args()

    input_path = Path(args.path).expanduser().resolve()
    upload_dir = resolve_upload_dir(input_path, args.output_subdir)
    model_plf = upload_dir / "model.plf"
    metadata_path = upload_dir / "metadata.json"
    require_file(model_plf, "model.plf")
    require_file(metadata_path, "metadata.json")

    metadata = load_metadata(metadata_path)
    actual_md5 = compute_md5(model_plf)
    print_evidence(model_plf, metadata_path, metadata, actual_md5)
    print_attributes(metadata, upload_dir, args.app_label)

    upload_command = build_upload_command(metadata, upload_dir, args.app_label)
    print("Upload command:")
    print("  DISPLAY= " + shlex.join(upload_command))
    if not args.yes:
        confirm = input("Type 'yes' to run the real upload: ").strip()
        if confirm != "yes":
            print("Upload aborted by user.")
            return 0

    upload_result = run_cloudml(upload_command)
    if upload_result.stdout:
        print("Upload output:")
        print(upload_result.stdout.rstrip())
    if upload_result.stderr:
        print("Upload stderr:")
        print(upload_result.stderr.rstrip(), file=sys.stderr)
    if upload_result.returncode != 0:
        raise RuntimeError(f"Upload failed with exit code {upload_result.returncode}")

    describe_command = build_describe_command(metadata, args.app_label)
    describe_result = run_cloudml(describe_command)
    print("Post-submit evidence:")
    if describe_result.stdout:
        print(describe_result.stdout.rstrip())
    if describe_result.stderr:
        print(describe_result.stderr.rstrip(), file=sys.stderr)
    if describe_result.returncode != 0:
        raise RuntimeError(f"Post-submit describe failed with exit code {describe_result.returncode}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
