"""Publish only audited local images, verify GHCR privacy/digests, then produce release locks."""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import urllib.parse

SHA = "73bb384ee031452cd2a7a2f1a16cbee74aa0ec97"
OWNER = "hendysen01"
TARGETS = {"web": "english-context-reader-web-private", "api": "english-context-reader-api"}


class PublishError(RuntimeError):
    """Only locally defined error codes and numeric statuses may reach CI logs."""

    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code = code
        self.status = status


class Progress:
    def __init__(self):
        self.phase = "source-sha-check"
        self.package = None
        self.upload = dict.fromkeys(TARGETS.values(), "not-attempted")

    def failure(self, error):
        if isinstance(error, PublishError):
            reason = error.code
            status = f" http={error.status}" if error.status is not None else ""
        else:
            status = ""
            if isinstance(error, subprocess.TimeoutExpired):
                reason = "process-timeout"
            elif isinstance(error, subprocess.CalledProcessError):
                reason = f"process-failed exit={error.returncode}"
            elif isinstance(error, (ValueError, KeyError, TypeError, IndexError)):
                reason = "invalid-or-missing-data"
            elif isinstance(error, (urllib.error.URLError, TimeoutError)):
                reason = "network-error-or-timeout"
            elif isinstance(error, OSError):
                reason = "local-io-error"
            else:
                reason = "unexpected-error"
        uploads = " ".join(f"{name}={state}" for name, state in self.upload.items())
        return (f"Publication failed: phase={self.phase} package={self.package or '-'} "
                f"reason={reason}{status}\nUpload status: {uploads}")


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        # Registry and GitHub API requests carry authorization headers.
        raise PublishError("redirect-refused", "Unexpected registry/API redirect", code)


opener = urllib.request.build_opener(RejectRedirects())


def run(*args):
    return subprocess.check_output(args, text=True, timeout=180, stderr=subprocess.DEVNULL).strip()


def read(url, headers, missing=False):
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
            body = response.read()
            digest = response.headers.get("Docker-Content-Digest")
            if digest is not None and digest != "sha256:" + hashlib.sha256(body).hexdigest():
                raise PublishError("response-digest-mismatch", "Registry response digest mismatch")
            return body
    except urllib.error.HTTPError as error:
        with error:
            if missing and error.code == 404:
                return None
            reasons = {401: "authentication-rejected", 403: "access-forbidden", 404: "not-found-or-inaccessible",
                       429: "rate-limited"}
            raise PublishError(reasons.get(error.code, "http-error"), "Registry/API request rejected", error.code) from None


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
        raise PublishError("unexpected-manifest-format", "Expected a single-platform image manifest")
    return "sha256:" + hashlib.sha256(raw).hexdigest(), data


def package(name, token):
    return read(f"https://api.github.com/users/{OWNER}/packages/container/{name}", {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })


def require_private(name, token):
    details = package(name, token)
    if details is None:
        raise PublishError("package-visibility-unverified", "Package visibility could not be verified")
    if json.loads(details)["visibility"] != "private":
        raise PublishError("package-not-private", "Package must be private")


def main(progress=None):
    progress = progress or Progress()
    if run("git", "rev-parse", "HEAD") != SHA or os.environ.get("SOURCE_SHA") != SHA:
        raise PublishError("source-sha-mismatch", "Source SHA differs from reviewed source")
    progress.phase = "load-registry-credentials"
    token = os.environ["GHCR_TOKEN"]
    user = os.environ["GHCR_USER"]
    auth = base64.b64encode(f"{user}:{token}".encode()).decode()
    records = []
    # Preflight both targets before performing the first registry write.
    for service, name in TARGETS.items():
        progress.package = name
        progress.phase = "inspect-local-image"
        image = f"ghcr.io/{OWNER}/{name}:{SHA}"
        local_image = f"ecs-audited-{service}:{SHA}"
        local = json.loads(run("docker", "image", "inspect", local_image))[0]
        if local["Architecture"] != "amd64" or local["Os"] != "linux":
            raise PublishError("platform-mismatch", "Unexpected image platform")
        progress.phase = "preflight-package-visibility"
        require_private(name, token)
        query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{OWNER}/{name}:pull,push"})
        progress.phase = "ghcr-token-exchange"
        bearer = json.loads(read("https://ghcr.io/token?" + query, {"Authorization": "Basic " + auth}))["token"]
        progress.phase = "preflight-sha-manifest"
        existing = manifest(name, SHA, bearer, missing=True)
        if existing and existing[1]["config"]["digest"] != local["Id"]:
            raise PublishError("existing-sha-conflict", "Existing SHA tag differs; refusing overwrite")
        records.append((service, name, image, local, bearer, existing))

    release = {"source_sha": SHA, "publisher_sha": os.environ.get("GITHUB_SHA"),
               "workflow_run_id": os.environ.get("GITHUB_RUN_ID"), "platform": "linux/amd64", "images": {}}
    progress.phase = "docker-login"
    progress.package = None
    with tempfile.TemporaryDirectory(prefix="reader-registry-") as directory:
        env = {**os.environ, "DOCKER_CONFIG": directory}
        # Token reaches Docker through stdin, never argv or a shell command.
        subprocess.run(["docker", "login", "ghcr.io", "-u", user, "--password-stdin"],
                       input=token, text=True, env=env, check=True, capture_output=True, timeout=30)
        for service, name, image, local, bearer, existing in records:
            progress.package = name
            progress.phase = "pre-push-sha-manifest"
            current = manifest(name, SHA, bearer, missing=True)
            progress.phase = "pre-push-package-visibility"
            require_private(name, token)
            if existing and not current:
                raise PublishError("observed-tag-disappeared", "Previously observed SHA tag disappeared")
            if current and current[1]["config"]["digest"] != local["Id"]:
                raise PublishError("concurrent-sha-conflict", "SHA tag changed concurrently; refusing overwrite")
            if not current:
                progress.phase = "tag-audited-image"
                subprocess.run(["docker", "tag", local["Id"], image], env=env, check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                progress.phase = "docker-push"
                progress.upload[name] = "attempted-outcome-unknown"
                subprocess.run(["docker", "push", image], env=env, check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
                progress.upload[name] = "push-acknowledged"
            else:
                progress.upload[name] = "existing-tag-reused"
            progress.phase = "read-sha-manifest"
            result = manifest(name, SHA, bearer)
            digest, remote = result
            if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest) or remote["config"]["digest"] != local["Id"]:
                raise PublishError("sha-manifest-mismatch", "Published image digest verification failed")
            progress.phase = "read-pinned-manifest"
            pinned = manifest(name, digest, bearer)
            if pinned != result:
                raise PublishError("pinned-manifest-mismatch", "Published digest verification failed")
            progress.phase = "final-package-visibility"
            require_private(name, token)
            release["images"][service] = {
                "image": f"ghcr.io/{OWNER}/{name}@{digest}",
                "digest": digest, "local_size_bytes": local["Size"],
                "compressed_layer_bytes": sum(layer["size"] for layer in remote["layers"]),
                "visibility": "private",
            }
            if not current:
                progress.upload[name] = "push-verified"
    # Emit success artifacts only after both images have passed registry readback.
    progress.phase = "write-release-artifacts"
    progress.package = None
    pathlib.Path("release.json").write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    lock = "services:\n"
    for service, value in release["images"].items():
        lock += f'  {service}:\n    image: "{value["image"]}"\n    platform: linux/amd64\n'
        print(f'{service}: {value["digest"]} private linux/amd64')
    pathlib.Path("release.lock.yaml").write_text(lock, encoding="utf-8")


def cli():
    progress = Progress()
    try:
        main(progress)
    except Exception as error:
        print(progress.failure(error), file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(cli())
