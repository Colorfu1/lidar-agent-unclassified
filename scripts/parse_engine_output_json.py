#!/usr/bin/env python3
"""Parse trtexec --exportOutput JSON into a human-readable trt_result.txt.

Usage:
    python parse_engine_output_json.py <output.json> [--out-dir <dir>]

Reads the vrf_points_1673078x5.bin reference file to extract ring-0 points,
then appends seg_res / point_static columns from the trtexec output.
Result is saved as trt_result.txt in --out-dir (default: same dir as output.json).
"""
import argparse
import json
import os
import sys

import numpy as np

BIN_FILE = "/home/mi/data/data_pkl/plugins/10.8.0.43-flat/vrf_points_1673078x5.bin"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output_json", help="Path to trtexec --exportOutput JSON")
    ap.add_argument("--out-dir", help="Directory for trt_result.txt (default: same as output.json)")
    args = ap.parse_args()

    if not os.path.isfile(args.output_json):
        print(f"ERROR: {args.output_json} not found", file=sys.stderr)
        return 1

    if not os.path.isfile(BIN_FILE):
        print(f"ERROR: reference bin {BIN_FILE} not found", file=sys.stderr)
        return 1

    out_dir = args.out_dir or os.path.dirname(args.output_json) or "."
    os.makedirs(out_dir, exist_ok=True)
    result_path = os.path.join(out_dir, "trt_result.txt")

    with open(args.output_json) as f:
        data = json.load(f)

    bin_data = np.fromfile(BIN_FILE, dtype=np.float32).reshape(-1, 5)
    bin_data = bin_data[bin_data[:, 4] == 0]

    whole_data = [bin_data]
    for item in data:
        if item["name"] in ("seg_res", "point_static"):
            seg_res = np.array(item["values"][: len(bin_data)])
            whole_data.append(seg_res[:, np.newaxis])
            print(f"  {item['name']}: {len(item['values'])} values")

    whole_data = np.concatenate(whole_data, axis=-1)
    np.savetxt(result_path, whole_data)
    print(f"trt_result.txt: {result_path} ({whole_data.shape[0]} rows x {whole_data.shape[1]} cols)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
