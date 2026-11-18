"""Offline tests: publication guards must fail closed without touching Docker or GHCR."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
                    r.main()
            finally:
                self.commands = commands.call_args_list

    def test_public_package_stops_before_any_write(self):
        with self.assertRaises(RuntimeError):
            self.execute(visibility='public')
        self.assertEqual(self.commands, [])

    def test_conflicting_tag_stops_before_any_write(self):
        with self.assertRaises(RuntimeError):
            self.execute(conflict=True)
        self.assertEqual(self.commands, [])

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
        self.assertEqual(sum(c.args[0][1] == 'push' for c in self.commands), 2)
        login = self.commands[0]
        self.assertIn('--password-stdin', login.args[0])
        self.assertNotIn('synthetic-token', ' '.join(login.args[0]))
        self.assertEqual(login.kwargs['input'], 'synthetic-token')

    def test_identical_existing_images_are_not_pushed(self):
        self.execute(existing=True)
        self.assertFalse(any(c.args[0][1] == 'push' for c in self.commands))

    def test_partial_failure_does_not_emit_release_lock(self):
        with self.assertRaises(RuntimeError):
            self.execute(fail_second=True)
        self.assertFalse(Path('release.lock.yaml').exists())
        self.assertFalse(Path('release.json').exists())

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
