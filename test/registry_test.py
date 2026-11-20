"""Offline tests: publication guards must fail closed without touching Docker or GHCR."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('registry', Path(__file__).resolve().parents[1] / 'deploy/publish/registry.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(os.chdir, self.previous)
        self.local = {'Architecture': 'amd64', 'Os': 'linux', 'Id': 'sha256:' + 'a' * 64, 'Size': 100}
        self.progress = r.Progress()
        self.remote = ('sha256:' + 'b' * 64, {'config': {'digest': self.local['Id']}, 'layers': [{'size': 25}]})
        self.env = patch.dict(os.environ, SOURCE_SHA=r.SHA, GHCR_TOKEN='synthetic-token', GHCR_USER='test-user')
        self.env.start()
        self.addCleanup(self.env.stop)

    def execute(self, visibility='private', existing=False, platform='amd64', conflict=False, fail_second=False):
        self.local['Architecture'] = platform
        def manifests(name, ref, token, missing=False):
            if missing:
                if conflict:
                    return ('sha256:' + 'c' * 64, {'config': {'digest': 'different'}})
                return self.remote if existing else None
            if fail_second and name.endswith('-api'):
                raise RuntimeError('Synthetic registry failure')
            return self.remote
        details = None if visibility is None else json.dumps({'visibility': visibility}).encode()
        with patch.object(r, 'run', side_effect=lambda *a, **k: r.SHA if a[0] == 'git' else json.dumps([self.local])), \
             patch.object(r, 'read', return_value=b'{"token":"synthetic-bearer"}'), \
             patch.object(r, 'package', return_value=details), \
             patch.object(r, 'manifest', side_effect=manifests), \
             patch.object(r.subprocess, 'run') as commands:
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    r.main(self.progress)
            finally:
                self.commands = commands.call_args_list

    def test_public_package_stops_before_any_write(self):
        with self.assertRaises(RuntimeError):
            self.execute(visibility='public')
        self.assertEqual(self.commands, [])

    def test_conflicting_tag_stops_before_any_write(self):
        with self.assertRaises(r.PublishError) as caught:
            self.execute(conflict=True)
        self.assertEqual(self.commands, [])
        self.assertIn('phase=preflight-sha-manifest', self.progress.failure(caught.exception))
        self.assertIn('reason=existing-sha-conflict', self.progress.failure(caught.exception))
        self.assertEqual(set(self.progress.upload.values()), {'not-attempted'})

    def test_existing_tag_with_unknown_package_visibility_stops(self):
        with self.assertRaisesRegex(RuntimeError, 'visibility could not be verified'):
            self.execute(visibility=None, existing=True)
        self.assertEqual(self.commands, [])

    def test_authenticated_redirect_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'Unexpected registry/API redirect'):
            r.RejectRedirects().redirect_request(None, None, 302, '', {}, 'https://example.invalid')

    def test_wrong_platform_stops_before_any_write(self):
        with self.assertRaises(RuntimeError):
            self.execute(platform='arm64')
        self.assertEqual(self.commands, [])

    def test_success_writes_both_digest_locks_and_uses_stdin(self):
        self.execute()
        data = json.loads(Path('release.json').read_text())
        self.assertEqual(set(data['images']), {'web', 'api'})
        self.assertIn('@sha256:', Path('release.lock.yaml').read_text())
        uploads = [c.args[0][2] for c in self.commands if c.args[0][1] == 'push']
        self.assertEqual(uploads, [f'ghcr.io/hendysen01/{name}:{r.SHA}' for name in
                                  ('english-context-reader-web-private', 'english-context-reader-api')])
        login = self.commands[0]
        self.assertIn('--password-stdin', login.args[0])
        self.assertNotIn('synthetic-token', ' '.join(login.args[0]))
        self.assertEqual(login.kwargs['input'], 'synthetic-token')

    def test_identical_existing_images_are_not_pushed(self):
        self.execute(existing=True)
        self.assertFalse(any(c.args[0][1] == 'push' for c in self.commands))

    def test_partial_failure_does_not_emit_release_lock(self):
        with self.assertRaises(RuntimeError) as caught:
            self.execute(fail_second=True)
        self.assertFalse(Path('release.lock.yaml').exists())
        self.assertFalse(Path('release.json').exists())
        log = self.progress.failure(caught.exception)
        self.assertIn('phase=read-sha-manifest package=english-context-reader-api', log)
        self.assertIn('english-context-reader-web-private=push-verified', log)
        self.assertIn('english-context-reader-api=push-acknowledged', log)
        self.assertNotIn('Synthetic registry failure', log)

    def test_http_failures_log_status_without_response_contents_or_credentials(self):
        for status, reason in [(401, 'authentication-rejected'), (403, 'access-forbidden'),
                               (404, 'not-found-or-inaccessible'), (429, 'rate-limited')]:
            with self.subTest(status=status):
                failure = r.urllib.error.HTTPError('https://example.invalid', status, 'response-secret', {}, None)
                with patch.object(r.opener, 'open', side_effect=failure):
                    with self.assertRaises(r.PublishError) as caught:
                        r.read('https://example.invalid', {'Authorization': 'Bearer header-secret'})
                log = self.progress.failure(caught.exception)
                self.assertIn(f'reason={reason} http={status}', log)
                for secret in ['response-secret', 'header-secret', 'example.invalid']:
                    self.assertNotIn(secret, log)

    def test_digest_header_mismatch_has_safe_category(self):
        response = Mock()
        response.read.return_value = b'sensitive body'
        response.headers = {'Docker-Content-Digest': 'untrusted value'}
        with patch.object(r.opener, 'open') as open_request:
            open_request.return_value.__enter__.return_value = response
            with self.assertRaises(r.PublishError) as caught:
                r.read('https://example.invalid', {})
        log = self.progress.failure(caught.exception)
        self.assertIn('reason=response-digest-mismatch', log)
        self.assertNotIn('sensitive body', log)
        self.assertNotIn('untrusted value', log)

    def test_cli_does_not_print_subprocess_exception_or_output(self):
        error = r.subprocess.CalledProcessError(1, ['sensitive argv'], stderr='sensitive stderr')
        with patch.object(r, 'main', side_effect=error), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(r.cli(), 1)
        self.assertIn('reason=process-failed exit=1', stderr.getvalue())
        self.assertNotIn('sensitive', stderr.getvalue())

    def test_wrong_source_stops_before_authentication(self):
        with patch.object(r, 'run', return_value='wrong'), patch.object(r, 'read') as network:
            with self.assertRaises(RuntimeError):
                r.main()
            network.assert_not_called()

    def test_manifest_digest_is_calculated_from_registry_bytes(self):
        raw = b'{"config":{"digest":"test"},"layers":[]}'
        with patch.object(r, 'read', return_value=raw):
            digest, _ = r.manifest('test', r.SHA, 'synthetic-bearer')
        self.assertEqual(digest, 'sha256:' + r.hashlib.sha256(raw).hexdigest())
