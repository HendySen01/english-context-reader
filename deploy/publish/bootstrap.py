import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

REPO = 'HendySen01/english-context-reader'
ENVIRONMENT = 'ecs-ghcr-release'
TARGETS = {'bootstrap-web': 'english-context-reader-web-private',
           'bootstrap-api': 'english-context-reader-api'}
REST = 'https://api.github.com'
REGISTRY = 'https://ghcr.io'
MANIFEST_TYPES = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'


class Stop(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(url, headers):
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=20) as response:
            return response.status, response.headers, response.read(1024 * 1024)
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {}, error.read(16384)


def expect(status, expected):
    if status != expected:
        raise Stop(f'unexpected HTTP status {status}')


def digest_of(body):
    return 'sha256:' + hashlib.sha256(body).hexdigest()


def docker(*args, env, stdin=None):
    result = subprocess.run(['docker', *args], input=stdin, env=env, text=True,
                            capture_output=True, timeout=120, check=True)
    return result.stdout.strip()


def main():
    phase = 'approval'
    push_started = False
    try:
        sha = os.environ.get('GITHUB_SHA', '')
        target = TARGETS.get(os.environ.get('RELEASE_MODE'))
        if (os.environ.get('GITHUB_REPOSITORY') != REPO
            or os.environ.get('GITHUB_REF') != 'refs/heads/feat/ecs-deployment'
            or os.environ.get('GITHUB_EVENT_NAME') not in {'push', 'workflow_dispatch'}
            or not target):
            raise Stop('repository, branch, event or package is not allowed')
        if not re.fullmatch(r'[0-9a-f]{40}', sha) or os.environ.get('APPROVED_SHA') != sha:
            raise Stop('missing or mismatched approved SHA')
        run_id = os.environ.get('GITHUB_RUN_ID', '')
        attempt = os.environ.get('GITHUB_RUN_ATTEMPT', '')
        if not all(re.fullmatch(r'[1-9][0-9]*', value) for value in (run_id, attempt)):
            raise Stop('invalid run identity')
        token = os.environ['GHCR_TOKEN']
        actor = os.environ['GITHUB_ACTOR']
        tag = f'bootstrap-{run_id}-{attempt}'
        path = f'hendysen01/{target}'
        image = f'ghcr.io/{path}:{tag}'
        rest_headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28'}

        phase = 'environment protection'
        status, _, body = get(f'{REST}/repos/{REPO}/environments/{ENVIRONMENT}', rest_headers)
        expect(status, 200)
        env_config = json.loads(body)
        # An auto-created empty Environment or a repo-level fallback variable cannot authorize a push.
        rules = env_config.get('protection_rules', [])
        if (env_config.get('name') != ENVIRONMENT
            or not any(rule.get('type') == 'required_reviewers' and rule.get('reviewers') for rule in rules)):
            raise Stop('Environment must have required reviewers')

        package_url = f'{REST}/users/hendysen01/packages/container/{target}'
        registry_url = f'{REGISTRY}/v2/{path}'
        basic = base64.b64encode(f'{actor}:{token}'.encode()).decode()
        query = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': f'repository:{path}:pull,push'})

        def registry_headers():
            status, _, body = get(f'{REGISTRY}/token?{query}', {'Authorization': f'Basic {basic}'})
            expect(status, 200)
            bearer = json.loads(body)['token']
            if not isinstance(bearer, str) or not bearer:
                raise Stop('invalid Registry authorization response')
            return {'Authorization': f'Bearer {bearer}', 'Accept': MANIFEST_TYPES}

        with tempfile.TemporaryDirectory(prefix='ecs-package-bootstrap-') as scratch:
            root = Path(scratch)
            context = root / 'context'
            context.mkdir()
            config = root / 'docker-config'
            config.mkdir(mode=0o700)
            (context / 'Dockerfile').write_text('FROM scratch\nCOPY bootstrap.txt /bootstrap.txt\n', encoding='ascii')
            (context / 'bootstrap.txt').write_text('GHCR private package initialization only.\n', encoding='ascii')
            child_env = {key: value for key, value in os.environ.items() if key != 'GHCR_TOKEN'}
            child_env['DOCKER_CONFIG'] = str(config)

            phase = 'build and inspect placeholder'
            docker('build', '--network=none', '--platform=linux/amd64', '--tag', image, str(context), env=child_env)
            fmt = '{{.Os}} {{.Architecture}} {{.Id}}'
            info = docker('image', 'inspect', '--format', fmt, image, env=child_env)
            if not re.fullmatch(r'linux amd64 sha256:[0-9a-f]{64}', info):
                raise Stop('unexpected local image platform or ID')
            image_id = info.split()[-1]

            phase = 'target package preflight'
            status, _, _ = get(package_url, rest_headers)
            if status == 200:
                raise Stop('target already exists; verify its visibility and permissions before proceeding')
            expect(status, 404)
            headers = registry_headers()
            status, _, body = get(f'{registry_url}/tags/list', headers)
            expect(status, 404)
            errors = json.loads(body).get('errors') or []
            if [item.get('code') for item in errors] != ['NAME_UNKNOWN']:
                raise Stop('Registry did not explicitly report an unknown repository')

            phase = 'authenticate Docker'
            docker('login', 'ghcr.io', '-u', actor, '--password-stdin', env=child_env, stdin=token + '\n')
            phase = 'push placeholder'
            push_started = True
            docker('push', image, env=child_env)

            phase = 'verify package visibility'
            status, _, body = get(package_url, rest_headers)
            expect(status, 200)
            if json.loads(body).get('visibility') != 'private':
                raise Stop('package visibility is not private')

            phase = 'verify registry digest'
            headers = registry_headers()
            status, response_headers, body = get(f'{registry_url}/manifests/{tag}', headers)
            expect(status, 200)
            digest = digest_of(body)
            if response_headers.get('Docker-Content-Digest') != digest or json.loads(body)['config']['digest'] != image_id:
                raise Stop('Registry digest or image ID mismatch')
            status, _, pinned = get(f'{registry_url}/manifests/{digest}', headers)
            expect(status, 200)
            if body != pinned:
                raise Stop('pinned manifest mismatch')
        print(f'Private placeholder verified: {image} @ {digest}')
    except Exception as error:
        reason = str(error) if isinstance(error, Stop) else type(error).__name__
        print(f'Bootstrap stopped at {phase}: {reason}.')
        if push_started:
            print('A push was attempted. Check package state before retrying.')
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
