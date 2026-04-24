#!/usr/bin/env python3
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path


DEFAULT_METADATA = {
    "platform": "ipc3090",
    "format": "plf",
    "precision": "fp32",
    "runtime": "trt108",
    "os": "GNU/Linux",
    "machine": "x86_64",
    "device": "gpu",
}


def compute_md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def resolve_source_dir(input_path: Path) -> Path:
    if input_path.is_file():
        if input_path.suffix.lower() != ".plf":
            raise ValueError(f"Expected a .plf file, got: {input_path}")
        return input_path.parent
    if input_path.is_dir():
        return input_path
    raise FileNotFoundError(f"Path not found: {input_path}")


def resolve_plf(source_dir: Path, explicit_plf: str | None, input_path: Path) -> Path:
    if input_path.is_file():
        return input_path

    if explicit_plf:
        plf_path = source_dir / explicit_plf
        if not plf_path.is_file():
            raise FileNotFoundError(f"Specified .plf not found: {plf_path}")
        return plf_path

    plf_files = sorted(source_dir.glob("*.plf"))
    if not plf_files:
        raise FileNotFoundError(f"No .plf file found in: {source_dir}")
    if len(plf_files) > 1:
        names = ", ".join(p.name for p in plf_files)
        raise ValueError(
            f"Multiple .plf files found in {source_dir}. Use --plf to choose one: {names}"
        )
    return plf_files[0]


def load_metadata(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"metadata.json must contain a JSON object: {path}")
    return data


def build_metadata(
    plf_path: Path,
    md5_value: str,
    source_dir: Path,
    args: argparse.Namespace,
) -> tuple[dict, str]:
    metadata_path = source_dir / "metadata.json"
    if metadata_path.is_file():
        data = load_metadata(metadata_path)
        data["md5"] = md5_value
        return data, "templated-from-source"

    if not args.name or not args.version:
        raise ValueError(
            "No source metadata.json found. Provide both --name and --version to generate metadata."
        )

    model_name = args.name
    model_version = args.version

    data = dict(DEFAULT_METADATA)
    data.update(
        {
            "name": model_name,
            "version": model_version,
            "md5": md5_value,
        }
    )

    if args.platform:
        data["platform"] = args.platform
    if args.precision:
        data["precision"] = args.precision
    if args.runtime:
        data["runtime"] = args.runtime
    if args.device:
        data["device"] = args.device

    return data, "generated"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prepare a traceable cloudml_upload package next to a source model."
    )
    parser.add_argument("path", help="Source model directory or .plf file path")
    parser.add_argument("--plf", help="Choose a specific .plf file when the directory contains multiple")
    parser.add_argument("--output-subdir", default="cloudml_upload", help="Upload subdirectory name")
    parser.add_argument("--name", help="Model name when metadata must be generated")
    parser.add_argument("--version", help="Model version when metadata must be generated")
    parser.add_argument("--platform", help="Platform override for generated metadata")
    parser.add_argument("--precision", help="Precision override for generated metadata")
    parser.add_argument("--runtime", help="Runtime override for generated metadata")
    parser.add_argument("--device", help="Device override for generated metadata")
    parser.add_argument("--force", action="store_true", help="Replace an existing output subdirectory")
    args = parser.parse_args()

    input_path = Path(args.path).expanduser().resolve()
    source_dir = resolve_source_dir(input_path)
    plf_path = resolve_plf(source_dir, args.plf, input_path)
    output_dir = source_dir / args.output_subdir

    if output_dir.exists():
        if not args.force:
            raise FileExistsError(
                f"Output directory already exists: {output_dir}. Use --force to replace it."
            )
        shutil.rmtree(output_dir)

    output_dir.mkdir(parents=True, exist_ok=False)

    md5_value = compute_md5(plf_path)
    metadata, metadata_mode = build_metadata(plf_path, md5_value, source_dir, args)

    shutil.copy2(plf_path, output_dir / "model.plf")
    with (output_dir / "metadata.json").open("w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=4)
        handle.write("\n")

    print(f"source_dir={source_dir}")
    print(f"source_plf={plf_path}")
    print(f"output_dir={output_dir}")
    print(f"metadata_mode={metadata_mode}")
    print(f"md5={md5_value}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
