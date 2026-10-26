#!/usr/bin/env python3
"""Export the official pretrained checkpoint; this never trains a model.

This build-only script needs the packages in realtime-export-requirements.txt.
The application itself only needs the bundled ONNX file, not Python ML packages.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    lock = json.loads((ROOT / "scripts/realtime-assets.json").read_text())
    recipe = lock["generated"][0]
    for package, expected in recipe["export_packages"].items():
        actual = importlib.metadata.version(package)
        if actual != expected:
            raise RuntimeError(f"Export needs {package}=={expected}; found {actual}")
    checkpoint = args.checkpoint.resolve()
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if digest != recipe["source"]["sha256"]:
        raise RuntimeError("Checkpoint checksum does not match the official pinned weights")

    with tempfile.TemporaryDirectory(prefix="phone-away-export-", dir=checkpoint.parent) as temporary:
        config = Path(temporary) / "config"
        config.mkdir()
        os.environ["YOLO_CONFIG_DIR"] = str(config)
        os.environ["MPLCONFIGDIR"] = str(config)
        os.environ["YOLO_AUTOINSTALL"] = "false"
        import onnx
        from ultralytics import YOLO

        # Export beside a temporary copy so the supplied checkpoint is untouched.
        build_checkpoint = Path(temporary) / "yolo26n.pt"
        build_checkpoint.write_bytes(checkpoint.read_bytes())
        model = YOLO(str(build_checkpoint))
        exported = model.export(**recipe["export_options"])
        graph = onnx.load(exported)
        # The exporter adds a timestamp. Remove it so identical pinned builds have
        # the same checksum; the source URL and build versions live in the lock.
        metadata = {entry.key: entry.value for entry in graph.metadata_props}
        metadata.pop("date", None)
        metadata.pop("docs", None)
        onnx.helper.set_model_props(graph, metadata)
        onnx.checker.check_model(graph)
        inputs = [(item.name, [dim.dim_value for dim in item.type.tensor_type.shape.dim]) for item in graph.graph.input]
        outputs = [(item.name, [dim.dim_value for dim in item.type.tensor_type.shape.dim]) for item in graph.graph.output]
        if inputs != [("images", [1, 3, 640, 640])] or outputs != [("output0", [1, 300, 6])]:
            raise RuntimeError(f"Unexpected exported model signature: {inputs}, {outputs}")
        encoded = graph.SerializeToString()
        if hashlib.sha256(encoded).hexdigest() != recipe["sha256"]:
            raise RuntimeError("Export differs from the pinned model. Keep the bundled model or use the recorded export versions.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(encoded)
        print(f"Verified export: {args.output} ({len(encoded):,} bytes)")


if __name__ == "__main__":
    main()
