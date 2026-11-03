"""Offline syntax and mocked systemd startup regressions; never starts a service."""
from contextlib import ExitStack
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


BUNDLE = Path(__file__).resolve().parents[1]


def load_lifecycle():
    spec = importlib.util.spec_from_file_location('infrapulse_startup_lifecycle',
                                                 BUNDLE / 'linux/lifecycle.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        if seconds < 0:
            raise AssertionError('negative sleep')
        self.now += seconds


def snapshot(**changes):
    values = {'MainPID': '42', 'InvocationID': 'a' * 32, 'NRestarts': '0',
              'ActiveState': 'active', 'SubState': 'running'}
    values.update(changes)
    return ''.join(f'{key}={value}\n' for key, value in values.items()).encode()


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() == 0,
                     'Requires an isolated Linux root runner')
class ConfigSyntax(unittest.TestCase):
    def setUp(self):
        self.lifecycle = load_lifecycle()
        self.assertTrue(callable(getattr(self.lifecycle, 'validate_config_syntax', None)),
                        'missing preactivation syntax gate')
        self.temporary = tempfile.TemporaryDirectory(prefix='infrapulse-startup-')
        self.addCleanup(self.temporary.cleanup)
        self.stage = Path(self.temporary.name)
        (self.stage / 'conf.d').mkdir(mode=0o700)
        self.paths = [self.stage / 'telegraf.conf', self.stage / 'conf.d/inputs.conf',
                      self.stage / 'conf.d/output.conf']
        for path in self.paths:
            path.write_bytes(b'[agent]\ninterval = "10s"\n')
            path.chmod(0o600)

    def test_unsupported_python_still_reaches_finite_version_guard(self):
        # tomllib exists only on3.11+. Loading the CLI must not traceback first.
        with patch.dict(sys.modules, {'tomllib': None}):
            lifecycle = load_lifecycle()
            with patch.object(lifecycle, 'arguments', return_value=None), \
                    patch.object(lifecycle.sys, 'version_info', (3, 10)):
                with self.assertRaises(lifecycle.Refusal) as caught:
                    lifecycle.main()
        self.assertEqual(str(caught.exception), 'Python 3.11 or newer is required.')

    def test_valid_files_are_parsed_separately_without_a_process(self):
        # Repeated [agent] tables across files are valid, not concatenated TOML.
        with patch.object(self.lifecycle.subprocess, 'run') as run:
            self.lifecycle.validate_config_syntax(self.stage)
        run.assert_not_called()

    def test_malformed_toml_in_each_file_is_private(self):
        for path in self.paths:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(b'authorization = "PRIVATE-CONFIG-SENTINEL\n')
                with self.assertRaises(self.lifecycle.Refusal) as caught:
                    self.lifecycle.validate_config_syntax(self.stage)
                self.assertNotIn('PRIVATE-CONFIG-SENTINEL', str(caught.exception))
                self.assertNotIn(str(path), str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)
                path.write_bytes(original)

    def test_exact_size_limit_is_accepted(self):
        self.paths[0].write_bytes(b'#' + b'x' * (256 * 1024 - 1))
        self.lifecycle.validate_config_syntax(self.stage)

    def test_oversize_is_refused_before_open(self):
        self.paths[0].write_bytes(b'#' + b'x' * (256 * 1024))
        with patch.object(Path, 'open', side_effect=AssertionError('oversize read')):
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.validate_config_syntax(self.stage)

    def test_invalid_utf8_is_private(self):
        self.paths[1].write_bytes(b'key = "PRIVATE-CONFIG-SENTINEL\xff"')
        with self.assertRaises(self.lifecycle.Refusal) as caught:
            self.lifecycle.validate_config_syntax(self.stage)
        self.assertNotIn('PRIVATE-CONFIG-SENTINEL', str(caught.exception))

    def test_symlink_or_writable_config_is_refused(self):
        path = self.paths[1]
        path.chmod(0o622)
        with self.assertRaises(self.lifecycle.Refusal):
            self.lifecycle.validate_config_syntax(self.stage)
        path.chmod(0o600)
        target = self.stage / 'target'
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaises(self.lifecycle.Refusal):
            self.lifecycle.validate_config_syntax(self.stage)

    def test_growing_file_read_is_bounded(self):
        from io import BytesIO
        class GrowingFile(BytesIO):
            read_sizes = []
            def read(self, size=-1):
                self.read_sizes.append(size)
                return super().read(size)
        stream = GrowingFile(b'#' + b'x' * (256 * 1024 + 100))
        with patch.object(Path, 'open', return_value=stream):
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.validate_config_syntax(self.stage)
        # A replacement stream larger than the inspected file remains bounded.
        self.assertEqual(stream.read_sizes, [256 * 1024 + 1])


@unittest.skipUnless(sys.platform.startswith('linux'), 'Linux lifecycle imports')
class ServiceLiveness(unittest.TestCase):
    def setUp(self):
        self.lifecycle = load_lifecycle()
        self.assertTrue(callable(getattr(self.lifecycle, 'service_snapshot', None)),
                        'missing bounded systemd snapshot')
        self.assertTrue(callable(getattr(self.lifecycle, 'require_stable_service', None)),
                        'missing sampled startup liveness gate')

    def test_named_snapshot_parses_identity_and_caps_command(self):
        with patch.object(self.lifecycle.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 0, snapshot())) as run:
            self.assertEqual(self.lifecycle.service_snapshot(0.25), (42, 'a' * 32, 0))
        args, kwargs = run.call_args
        self.assertEqual(args[0][0:2], ['systemctl', 'show'])
        self.assertIn(self.lifecycle.UNIT_NAME, args[0])
        for name in ('MainPID', 'InvocationID', 'NRestarts', 'ActiveState', 'SubState'):
            self.assertIn('--property=' + name, args[0])
        self.assertEqual(kwargs['timeout'], 0.25)
        self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)

    def test_bad_or_inactive_snapshots_are_refused_without_raw_output(self):
        bad = [b'', snapshot(MainPID='0'), snapshot(MainPID='-1'),
               snapshot(InvocationID=''), snapshot(NRestarts='-1'),
               snapshot(ActiveState='inactive'), snapshot(SubState='auto-restart'),
               snapshot() + b'MainPID=43\n', snapshot() + b'Unknown=PRIVATE\n',
               snapshot().replace(b'NRestarts=0\n', b''), b'x' * 4097,
               b'PRIVATE-SYSTEMD-SENTINEL\xff']
        for output in bad:
            with self.subTest(output=output[:40]):
                with patch.object(self.lifecycle.subprocess, 'run', return_value=
                                  subprocess.CompletedProcess([], 0, output)):
                    with self.assertRaises(self.lifecycle.Refusal) as caught:
                        self.lifecycle.service_snapshot(0.25)
                self.assertNotIn('PRIVATE', str(caught.exception))

    def test_query_failures_and_timeouts_are_private(self):
        for failure in (OSError('PRIVATE-SYSTEMD-SENTINEL'),
                        subprocess.TimeoutExpired('PRIVATE-SYSTEMD-SENTINEL', 0.25)):
            with self.subTest(failure=type(failure).__name__):
                with patch.object(self.lifecycle.subprocess, 'run', side_effect=failure):
                    with self.assertRaises(self.lifecycle.Refusal) as caught:
                        self.lifecycle.service_snapshot(0.25)
                self.assertNotIn('PRIVATE-SYSTEMD-SENTINEL', str(caught.exception))
                self.assertTrue(caught.exception.__suppress_context__)
        with patch.object(self.lifecycle.subprocess, 'run', return_value=
                          subprocess.CompletedProcess([], 1, snapshot())):
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.service_snapshot(0.25)

    def observe(self, outputs):
        clock = Clock()
        times = []
        def query(arguments, **kwargs):
            self.assertGreater(kwargs['timeout'], 0)
            self.assertLessEqual(kwargs['timeout'], 0.5)
            self.assertLessEqual(kwargs['timeout'], 3.0 - clock.now)
            times.append(clock.now)
            clock.now += 0.01
            output = outputs[min(len(times) - 1, len(outputs) - 1)]
            return subprocess.CompletedProcess(arguments, 0, output)
        with patch.object(self.lifecycle.time, 'monotonic', clock.monotonic), \
                patch.object(self.lifecycle.time, 'sleep', clock.sleep), \
                patch.object(self.lifecycle.subprocess, 'run', side_effect=query):
            self.lifecycle.require_stable_service()
        return clock, times

    def test_stable_process_is_observed_for_two_seconds_not_just_once(self):
        clock, times = self.observe([snapshot()])
        self.assertGreaterEqual(times[-1], times[0] + 0.01 + 2.0)
        self.assertGreater(len(times), 2)
        self.assertLessEqual(clock.now, 3.0)

    def test_pid_invocation_restart_or_state_change_refuses_activation(self):
        for change in ({'MainPID': '43'}, {'InvocationID': 'b' * 32},
                       {'NRestarts': '1'}, {'ActiveState': 'failed'},
                       {'SubState': 'dead'}):
            with self.subTest(change=change):
                with self.assertRaises(self.lifecycle.Refusal):
                    self.observe([snapshot(), snapshot(**change)])

    def test_slow_snapshot_cannot_turn_deadline_expiry_into_success(self):
        clock = Clock()
        def slow_query(arguments, **kwargs):
            clock.now += 3.1
            return subprocess.CompletedProcess(arguments, 0, snapshot())
        with patch.object(self.lifecycle.time, 'monotonic', clock.monotonic), \
                patch.object(self.lifecycle.time, 'sleep', clock.sleep), \
                patch.object(self.lifecycle.subprocess, 'run', side_effect=slow_query):
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.require_stable_service()


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() == 0,
                     'Requires an isolated Linux root runner')
class ActivationGates(unittest.TestCase):
    """Run the real filesystem transaction, mocking only external operations."""
    def setUp(self):
        self.lifecycle = load_lifecycle()
        self.temporary = tempfile.TemporaryDirectory(prefix='infrapulse-activation-')
        self.addCleanup(self.temporary.cleanup)
        base = Path(self.temporary.name)
        self.root = base / 'root'
        self.root.mkdir(mode=0o700)
        self.releases = self.root / 'releases'
        self.releases.mkdir(mode=0o700)
        self.previous = self.releases / ('r-20000101000000-' + 'a' * 16)
        self.previous.mkdir(mode=0o700)
        (self.previous / '.release-owner').write_text(self.lifecycle.RELEASE_OWNER)
        self.current = self.root / 'current'
        self.current.symlink_to('releases/' + self.previous.name)
        self.unit = base / 'fixture.service'
        self.unit.write_bytes(b'canonical unchanged unit')
        self.binary = base / 'binary'
        self.binary.write_bytes(b'fixture never executed')
        self.key = base / 'key'
        self.key.write_bytes(b'fixture not a credential')
        self.key.chmod(0o600)
        self.bad_config = False
        self.calls = []
        self.reports = []
        self.reporting_observations = []
        self.observed_pointers = []
        self.stability_failures = []
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        replacements = dict(ROOT=self.root, RELEASES=self.releases, CURRENT=self.current,
                            UNIT=self.unit, UNIT_NAME=self.unit.name)
        for name, value in replacements.items():
            self.stack.enter_context(patch.object(self.lifecycle, name, value))
        for name, result in [('inspect_root', self.previous), ('inspect_unit', True),
                             ('unit_template', b'canonical unchanged unit'),
                             ('read_metadata', {}), ('ensure_account', 0),
                             ('inspect_logs', None), ('create_logs', None),
                             ('copy_sources', None), ('retire_previous', None), ('event', None)]:
            self.stack.enter_context(patch.object(self.lifecycle, name, return_value=result))
        self.stack.enter_context(patch.object(self.lifecycle.pwd, 'getpwnam',
                                             return_value=SimpleNamespace(pw_uid=0)))
        self.stack.enter_context(patch.object(self.lifecycle, 'run', side_effect=self.prepare))
        self.stack.enter_context(patch.object(self.lifecycle, 'systemctl', side_effect=self.systemctl))
        self.stack.enter_context(patch.object(self.lifecycle, 'report', side_effect=self.report))
        self.stack.enter_context(patch.object(self.lifecycle, 'require_stable_service',
                                             side_effect=self.observe))
        self.options = SimpleNamespace(management_url='https://management.example',
                                       gateway_origin='https://gateway.example',
                                       telegraf_binary=str(self.binary),
                                       telegraf_sha256=hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                                       key_file=str(self.key), management_ca=None, gateway_ca=None)

    def prepare(self, arguments, **kwargs):
        destination = Path(arguments[arguments.index('--destination') + 1])
        for name, content in [('telegraf.conf', '[agent]\ninterval="10s"\n'),
                              ('inputs.conf', '[[inputs.cpu]]\n'),
                              ('output.conf', '[[outputs.http]]\n'),
                              ('api-key', 'fixture not a credential'), ('state.json', '{}')]:
            (destination / name).write_text(content)
            (destination / name).chmod(0o600)
        if self.bad_config:
            (destination / 'output.conf').write_text('token="PRIVATE-CONFIG-SENTINEL\n')
        return True

    def systemctl(self, *arguments, **kwargs):
        self.calls.append(arguments[0])
        return True

    def report(self, release, result):
        self.reports.append(result)
        self.reporting_observations.append(len(self.observed_pointers))
        return True

    def observe(self):
        self.observed_pointers.append(self.lifecycle.current_release())
        if self.stability_failures:
            failure = self.stability_failures.pop(0)
            if failure:
                raise self.lifecycle.Refusal('fixture startup failure')

    def test_bad_syntax_never_switches_pointer_or_touches_service(self):
        self.bad_config = True
        with self.assertRaises(self.lifecycle.Refusal) as caught:
            self.lifecycle.install(self.options)
        self.assertNotIn('PRIVATE-CONFIG-SENTINEL', str(caught.exception))
        self.assertEqual(self.lifecycle.current_release(), self.previous)
        self.assertEqual(self.unit.read_bytes(), b'canonical unchanged unit')
        self.assertNotIn('restart', self.calls)
        self.assertNotIn('daemon-reload', self.calls)
        self.assertEqual(self.reports, [])
        self.assertEqual(list(self.releases.iterdir()), [self.previous])
        self.assertFalse((self.root / '.transaction').exists())

    def test_valid_activation_requires_observation_before_applied_report(self):
        self.lifecycle.install(self.options)
        new_release = self.lifecycle.current_release()
        self.assertNotEqual(new_release, self.previous)
        self.assertEqual(self.observed_pointers, [new_release])
        self.assertEqual(self.reports, ['applied'])
        self.assertEqual(self.reporting_observations, [1])
        self.assertFalse((self.root / '.transaction').exists())

    def test_failed_liveness_restores_and_observes_previous_process(self):
        self.stability_failures = [True, False]
        with self.assertRaises(self.lifecycle.Refusal):
            self.lifecycle.install(self.options)
        self.assertEqual(self.lifecycle.current_release(), self.previous)
        self.assertEqual(len(self.observed_pointers), 2)
        self.assertNotEqual(self.observed_pointers[0], self.previous)
        self.assertEqual(self.observed_pointers[1], self.previous)
        self.assertEqual(self.reports, ['failed'])
        self.assertFalse((self.root / '.transaction').exists())

    def test_unstable_rollback_retains_recovery_transaction(self):
        self.stability_failures = [True, True]
        with self.assertRaises(self.lifecycle.Refusal):
            self.lifecycle.install(self.options)
        self.assertEqual(self.lifecycle.current_release(), self.previous)
        self.assertTrue((self.root / '.transaction').exists())
        self.assertEqual(self.reports, ['failed'])


if __name__ == '__main__':
    unittest.main()
