"""Inspect final image layers without printing their contents or uploading artifacts."""
import json
import os
import sys
import tarfile
from pathlib import PurePosixPath

canary = os.environ["CI_CANARY"].encode()


def require(condition, description):
    if not condition:
        raise SystemExit(description)


def has_canary(stream):
    tail = b""
    while chunk := stream.read(256 * 1024):
        data = tail + chunk
        if canary in data:
            return True
        tail = data[-(len(canary) - 1):]
    return False


with tarfile.open(sys.argv[1]) as archive:
    manifest = json.load(archive.extractfile("manifest.json"))
    require(len(manifest) == 2, "Expected Web and API image entries")
    for image in manifest:
        config = archive.extractfile(image["Config"]).read()
        require(canary not in config, "Canary found in image configuration or history")
        require(json.loads(config)["architecture"] == "amd64", "Expected AMD64 image")
        for layer in image["Layers"]:
            with tarfile.open(fileobj=archive.extractfile(layer), mode="r|*") as files:
                for entry in files:
                    name = entry.name.removeprefix("./").lstrip("/")
                    parts = PurePosixPath(name).parts
                    require(not any("reader-ci-canary" in part for part in parts),
                            "Unexpected CI canary path in image layers")
                    if entry.isfile():
                        require(not has_canary(files.extractfile(entry)), "Canary found in image layers")
                    app_path = name.startswith(("app/", "ci/", "usr/share/nginx/html/", "etc/nginx/conf.d/", "run/secrets/"))
                    if not app_path or "node_modules" in parts:
                        continue
                    require(not any(part.startswith((".env", ".git")) or part == "secrets" or part.endswith((".key", ".pem"))
                                    for part in parts), "Unexpected sensitive path in application image layers")
                    require(not name.startswith(("ci/", "app/src/", "app/deploy/", "app/test/")),
                            "Unexpected application or CI source directory in image layers")

print("Image architecture, build history and application layers verified")
