"""Publish only audited local images, verify GHCR privacy/digests, then produce release locks."""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
import urllib.parse

SHA = "73bb384ee031452cd2a7a2f1a16cbee74aa0ec97"
OWNER = "hendysen01"
NAMES = ["english-context-reader-web", "english-context-reader-api"]


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Registry and GitHub API requests carry authorization headers.
        raise RuntimeError(f"Unexpected registry/API redirect (HTTP {code})")


opener = urllib.request.build_opener(RejectRedirects())


def run(*args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=180, **kwargs).strip()


def read(url, headers, missing=False):
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
            body = response.read()
            digest = response.headers.get("Docker-Content-Digest")
            if digest is not None and digest != "sha256:" + hashlib.sha256(body).hexdigest():
                raise RuntimeError("Registry response digest mismatch")
            return body
    except urllib.error.HTTPError as error:
        if missing and error.code == 404:
            return None
        raise RuntimeError(f"Registry/API request rejected (HTTP {error.code})") from None


def manifest(name, ref, token, missing=False):
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    }
    raw = read(f"https://ghcr.io/v2/{OWNER}/{name}/manifests/{ref}", headers, missing)
    if raw is None:
        return None
    data = json.loads(raw)
    if "config" not in data or "layers" not in data:
        raise RuntimeError("Expected a single-platform image manifest")
    return "sha256:" + hashlib.sha256(raw).hexdigest(), data


def package(name, token, missing=False):
    return read(f"https://api.github.com/users/{OWNER}/packages/container/{name}", {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }, missing)


def require_private(name, token, missing=False):
    details = package(name, token, missing)
    if details is not None and json.loads(details)["visibility"] != "private":
        raise RuntimeError("Package must be private")
    return details is not None


def main():
    if run("git", "rev-parse", "HEAD") != SHA or os.environ.get("SOURCE_SHA") != SHA:
        raise RuntimeError("Source SHA differs from reviewed source")
    token = os.environ["GHCR_TOKEN"]
    user = os.environ["GHCR_USER"]
    auth = base64.b64encode(f"{user}:{token}".encode()).decode()
    records = []
    # Preflight both targets before performing the first registry write.
    for name in NAMES:
        image = f"ghcr.io/{OWNER}/{name}:{SHA}"
        local = json.loads(run("docker", "image", "inspect", image))[0]
        if local["Architecture"] != "amd64" or local["Os"] != "linux":
            raise RuntimeError("Unexpected image platform")
        known_package = require_private(name, token, missing=True)
        query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{OWNER}/{name}:pull,push"})
        bearer = json.loads(read("https://ghcr.io/token?" + query, {"Authorization": "Basic " + auth}))["token"]
        existing = manifest(name, SHA, bearer, missing=True)
        if existing and not known_package:
            raise RuntimeError("Existing tag found but package visibility could not be verified")
        if existing and existing[1]["config"]["digest"] != local["Id"]:
            raise RuntimeError("Existing SHA tag differs; refusing overwrite")
        records.append((name, image, local, bearer, known_package, existing))

    release = {"source_sha": SHA, "publisher_sha": os.environ.get("GITHUB_SHA"),
               "workflow_run_id": os.environ.get("GITHUB_RUN_ID"), "platform": "linux/amd64", "images": {}}
    with tempfile.TemporaryDirectory(prefix="reader-registry-") as directory:
        env = {**os.environ, "DOCKER_CONFIG": directory}
        # Token reaches Docker through stdin, never argv or a shell command.
        subprocess.run(["docker", "login", "ghcr.io", "-u", user, "--password-stdin"],
                       input=token, text=True, env=env, check=True, capture_output=True, timeout=30)
        for name, image, local, bearer, known_package, existing in records:
            current = manifest(name, SHA, bearer, missing=True)
            require_private(name, token, missing=not (known_package or current))
            if existing and not current:
                raise RuntimeError("Previously observed SHA tag disappeared; refusing to recreate it")
            if current and current[1]["config"]["digest"] != local["Id"]:
                raise RuntimeError("SHA tag changed concurrently; refusing overwrite")
            if not current:
                subprocess.run(["docker", "push", image], env=env, check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
            result = manifest(name, SHA, bearer)
            digest, remote = result
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest) or remote["config"]["digest"] != local["Id"]:
                raise RuntimeError("Published image digest verification failed")
            pinned = manifest(name, digest, bearer)
            if pinned != result:
                raise RuntimeError("Published digest verification failed")
            require_private(name, token)
            service = "web" if name.endswith("-web") else "api"
            release["images"][service] = {
                "image": f"ghcr.io/{OWNER}/{name}@{digest}",
                "digest": digest, "local_size_bytes": local["Size"],
                "compressed_layer_bytes": sum(layer["size"] for layer in remote["layers"]),
                "visibility": "private",
            }
    # Emit success artifacts only after both images have passed registry readback.
    pathlib.Path("release.json").write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    lock = "services:\n"
    for service, value in release["images"].items():
        lock += f'  {service}:\n    image: "{value["image"]}"\n    platform: linux/amd64\n'
        print(f'{service}: {value["digest"]} private linux/amd64')
    pathlib.Path("release.lock.yaml").write_text(lock, encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid subprocess output, credentials and response bodies in failure logs.
        print(f"Publication failed: {type(error).__name__}. Review permissions and existing tags.")
        raise SystemExit(1)
