"""Linux root-only filesystem regressions; never installs or starts a service."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform.startswith('linux') and os.geteuid() == 0,
                     'Linux root-owned path checks require a disposable root runner')
class LinuxPrivateLogPaths(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('infrapulse_linux_lifecycle',
                                                     cls.bundle / 'linux/lifecycle.py')
        cls.lifecycle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.lifecycle)

    def test_log_ancestors_are_safe_on_standard_ubuntu(self):
        # Regression: /var/log is root:syslog 0775 on stock Ubuntu. The Agent
        # must use a private location without weakening the ancestor guard.
        self.lifecycle.ancestors(self.lifecycle.LOGS)

    def test_group_writable_directories_remain_forbidden(self):
        with tempfile.TemporaryDirectory(prefix='infrapulse-path-regression-') as name:
            directory = Path(name)
            directory.chmod(0o770)
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.directory(directory)

    def test_directory_symlinks_remain_forbidden(self):
        with tempfile.TemporaryDirectory(prefix='infrapulse-path-regression-') as name:
            parent = Path(name)
            (parent / 'target').mkdir(mode=0o700)
            (parent / 'link').symlink_to(parent / 'target', target_is_directory=True)
            with self.assertRaises(self.lifecycle.Refusal):
                self.lifecycle.directory(parent / 'link')

    def test_systemd_writable_path_matches_private_log_directory(self):
        unit = (self.bundle / 'linux/infrapulse-telegraf.service').read_text()
        self.assertIn('ReadWritePaths=' + str(self.lifecycle.LOGS) + '\n', unit)


if __name__ == '__main__':
    unittest.main()
