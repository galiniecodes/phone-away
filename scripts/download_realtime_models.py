#!/usr/bin/env python3
"""Restore pinned assets for the browser-local YOLO26 + MediaPipe detector.

    python3 scripts/download_realtime_models.py --verify
    python3 scripts/download_realtime_models.py

Runtime/model assets are already bundled. --verify works completely offline.
If the generated ONNX model is missing, provide --export-python pointing at a
Python 3.12 virtual environment with realtime-export-requirements.txt installed.
No camera access, training, API key, or global Python installation is needed.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
LOCK = Path(__file__).with_name("realtime-assets.json")
ALLOWED_HOSTS = {"cdn.jsdelivr.net", "storage.googleapis.com", "raw.githubusercontent.com", "github.com"}


def matches(path, asset):
    return (path.is_file() and path.stat().st_size == asset["bytes"]
            and hashlib.sha256(path.read_bytes()).hexdigest() == asset["sha256"])


def validate(asset, remote=True):
    relative = Path(asset["path"])
    if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "public":
        raise ValueError("Invalid asset path")
    if len(asset["sha256"]) != 64 or asset["bytes"] < 1:
        raise ValueError("Invalid asset checksum")
    if remote:
        url = urllib.parse.urlsplit(asset["url"])
        if url.scheme != "https" or url.hostname not in ALLOWED_HOSTS:
            raise ValueError("Unexpected asset source")


def download(asset, destination=None):
    destination = destination or ROOT / asset["path"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".download")
    request = urllib.request.Request(asset["url"], headers={"User-Agent": "PhoneAway-local-model-setup/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, partial.open("wb") as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                output.write(chunk)
        if not matches(partial, asset):
            raise ValueError("Downloaded asset does not match its pinned checksum")
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)
    return str(destination.relative_to(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", action="store_true", help="Verify the bundle offline")
    parser.add_argument("--export-python", type=Path, help="Build-only Python environment for restoring the generated ONNX model")
    args = parser.parse_args()
    lock = json.loads(LOCK.read_text())
    for asset in lock["assets"]:
        validate(asset)
    for asset in lock["generated"]:
        validate(asset, remote=False)
        validate({**asset["source"], "path": asset["path"]})
    assets = lock["assets"] + lock["generated"]
    missing = [asset for asset in assets if not matches(ROOT / asset["path"], asset)]
    if args.verify:
        for asset in missing:
            print("MISSING OR CHANGED:", asset["path"], file=sys.stderr)
        if missing:
            return 1
    else:
        remote = [asset for asset in missing if "url" in asset]
        errors = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(download, asset): asset for asset in remote}
            for future in as_completed(futures):
                try:
                    print("Verified", future.result(), flush=True)
                except Exception as error:
                    errors.append(futures[future]["path"])
                    print("FAILED:", futures[future]["path"], str(error), file=sys.stderr)
        if errors:
            return 1
        for asset in lock["generated"]:
            if matches(ROOT / asset["path"], asset):
                continue
            if args.export_python is None:
                print("The generated YOLO model needs to be restored. Create a Python 3.12 virtual environment under work/, install scripts/realtime-export-requirements.txt, then rerun with --export-python PATH/TO/VENV/bin/python.", file=sys.stderr)
                return 1
            export_python = args.export_python.resolve()
            work = ROOT / "work"
            work.mkdir(exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="model-restore-", dir=work) as temporary:
                checkpoint = Path(temporary) / "yolo26n.pt"
                download(asset["source"], checkpoint)
                subprocess.run([str(export_python), str(ROOT / "scripts/export_realtime_model.py"),
                                "--checkpoint", str(checkpoint), "--output", str(ROOT / asset["path"])], check=True)
            if not matches(ROOT / asset["path"], asset):
                raise ValueError("Restored model does not match its checksum")
    print(f"All {len(assets)} real-time vision assets verified ({sum(asset['bytes'] for asset in assets) / 1_000_000:.1f} MB).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print("Real-time model setup failed:", error, file=sys.stderr)
        sys.exit(1)
