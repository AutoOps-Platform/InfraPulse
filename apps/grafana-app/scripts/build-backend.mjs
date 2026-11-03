import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
const arch = process.argv[2] ?? 'amd64';
if (!['amd64', 'arm64'].includes(arch)) { throw new Error('Supported backend targets: linux amd64 or arm64'); }
mkdirSync(new URL('../dist', import.meta.url), { recursive: true });
const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', `dist/gpx_infrapulse_linux_${arch}`, './pkg'], {
  cwd, stdio: 'inherit', env: { ...process.env, GOOS: 'linux', GOARCH: arch, CGO_ENABLED: '0', GOTOOLCHAIN: 'local' },
});
if (result.error) { throw new Error('Go compiler unavailable; install the documented toolchain'); }
process.exit(result.status ?? 1);
