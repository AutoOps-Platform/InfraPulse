"""Bounded renderer regressions; no server/process/service starts."""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/render-prometheus-tls.py'


class PrometheusTLSRenderer(unittest.TestCase):
    def run_renderer(self, server_name, output):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--server-name', server_name,
                               '--output', str(output)], capture_output=True, text=True, timeout=5)

    def test_https_scrape_preserves_self_monitoring_and_verifies_ca_hostname(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'prometheus.yml'
            result = self.run_renderer('gateway.vm2.infrapulse.lab', p)
            self.assertEqual(result.returncode, 0, result.stderr)
            cfg = json.loads(p.read_text())
            own, gateway = cfg['scrape_configs']
            self.assertEqual(own['static_configs'], [{'targets': ['prometheus:9090']}])
            self.assertEqual(gateway['job_name'], 'ingestion-gateway')
            self.assertEqual(gateway['scheme'], 'https')
            self.assertEqual(gateway['static_configs'], [{'targets': ['ingest:8000']}])
            self.assertEqual(gateway['tls_config'], {'ca_file': '/etc/prometheus/ingestion-ca.pem',
                                                    'server_name': 'gateway.vm2.infrapulse.lab'})
            self.assertNotIn('insecure_skip_verify', json.dumps(cfg))

    def test_rejects_hostname_or_yaml_injection_before_creating_output(self):
        with tempfile.TemporaryDirectory() as d:
            for i, name in enumerate(['', 'https://gateway:8443', 'a\nb: true', '../gateway',
                                       'a:8443', '-invalid.local', 'a..b', 'a/b', '${SECRET}']):
                with self.subTest(name=name):
                    p = Path(d) / str(i)
                    result = self.run_renderer(name, p)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(p.exists())

    @unittest.skipUnless(os.name == 'posix', 'container UID readability is a POSIX deployment boundary')
    def test_public_config_remains_readable_for_prometheus_uid_under_private_umask(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'public-config.yml'
            result = subprocess.run([sys.executable, '-I', str(SCRIPT), '--server-name',
                                     'gateway.example', '--output', str(p)], capture_output=True,
                                    text=True, timeout=5, preexec_fn=lambda: os.umask(0o077))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(p.stat().st_mode & 0o777, 0o644)

    def test_never_overwrites_existing_operator_configuration(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'existing.yml'
            p.write_text('operator_owned: preserve\n')
            self.assertNotEqual(self.run_renderer('gateway.example', p).returncode, 0)
            self.assertEqual(p.read_text(), 'operator_owned: preserve\n')


if __name__ == '__main__':
    unittest.main()
