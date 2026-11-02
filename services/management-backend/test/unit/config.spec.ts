import { loadConfig } from '../../src/config/config.js';
import { readSecretFile } from '../../src/config/secret-files.js';
import { SafeLogger } from '../../src/common/safe-logger.js';
import { configFixture, countLeaks } from '../support/config.js';

describe('bounded management configuration', () => {
  const fixtures: ReturnType<typeof configFixture>[] = [];
  const fixture = () => {
    const f = configFixture();
    fixtures.push(f);
    return f;
  };
  afterEach(() => {
    fixtures.splice(0).forEach((f) => f.cleanup());
  });

  it('loads only runtime inputs and exposes immutable bounded defaults', () => {
    const f = fixture();
    const config = loadConfig({
      ...f.env,
      MANAGEMENT_MIGRATION_DATABASE_URL_FILE: 'must-not-read',
    });
    expect(config.PORT).toBe(3000);
    expect(config.MANAGEMENT_REQUEST_RATE_PER_SECOND).toBe(20);
    expect(config.MANAGEMENT_REQUEST_BURST).toBe(40);
    expect(config.MANAGEMENT_DB_POOL_MAX).toBe(10);
    expect(config.MANAGEMENT_DB_POOL_TIMEOUT_MS).toBe(1000);
    expect(config.MANAGEMENT_NONCE_MAX_ENTRIES).toBe(20000);
    expect(config.MANAGEMENT_LOG_LEVEL).toBe('INFO');
    expect(config.MANAGEMENT_AGENT_INGEST_BASE_URL).toBe(
      'http://127.0.0.1:8000',
    );
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.adminTrust.lab)).toBe(true);
    expect('MANAGEMENT_MIGRATION_DATABASE_URL_FILE' in config).toBe(false);
  });
  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['PORT', '1.1'],
    ['MANAGEMENT_REQUEST_RATE_PER_SECOND', 'Infinity'],
    ['MANAGEMENT_REQUEST_RATE_PER_SECOND', '0'],
    ['MANAGEMENT_REQUEST_RATE_PER_SECOND', '1001'],
    ['MANAGEMENT_REQUEST_BURST', '10001'],
    ['MANAGEMENT_DB_POOL_MAX', '65'],
    ['MANAGEMENT_DB_POOL_TIMEOUT_MS', '1001'],
    ['MANAGEMENT_NONCE_MAX_ENTRIES', '20001'],
    ['MANAGEMENT_LOG_LEVEL', 'DEBUG'],
    ['MANAGEMENT_GRAFANA_CONTEXT', ''],
    ['MANAGEMENT_AGENT_INGEST_BASE_URL', 'http://u:p@127.0.0.1:8000'],
    ['MANAGEMENT_AGENT_INGEST_BASE_URL', 'http://127.0.0.1:8000/?secret=bad'],
  ])('rejects invalid %s without value disclosure', (name, value) => {
    const f = fixture();
    expect(() => loadConfig({ ...f.env, [name]: value })).toThrow(
      'Invalid management configuration.',
    );
  });
  it('accepts exact upper bounds and explicit fractional token refill rate', () => {
    const f = fixture();
    const config = loadConfig({
      ...f.env,
      PORT: '65535',
      MANAGEMENT_REQUEST_RATE_PER_SECOND: '0.5',
      MANAGEMENT_REQUEST_BURST: '10000',
      MANAGEMENT_DB_POOL_MAX: '64',
      MANAGEMENT_NONCE_MAX_ENTRIES: '1',
    });
    expect(config.PORT).toBe(65535);
    expect(config.MANAGEMENT_REQUEST_RATE_PER_SECOND).toBe(0.5);
  });
  it.each([
    'http://example.com',
    'http://management:3000',
    'http://169.254.1.2',
    'http://0.0.0.0',
    'http://[::]',
    'http://[::ffff:127.0.0.1]',
    'http://224.0.0.1',
    'http://172.32.0.1',
    'http://127.0.0.1:8000/remote-write',
    'https://example.com/path',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1/?x=1',
    'http://127.0.0.1/#x',
  ])('rejects unsafe or non-origin sender URL %#', (url) => {
    const f = fixture();
    expect(() =>
      loadConfig({ ...f.env, MANAGEMENT_AGENT_INGEST_BASE_URL: url }),
    ).toThrow('Invalid management configuration.');
  });
  it.each([
    ['http://localhost:8000/', 'http://localhost:8000'],
    ['http://127.42.1.2/', 'http://127.42.1.2'],
    ['http://10.1.2.3:8000', 'http://10.1.2.3:8000'],
    ['http://172.16.0.1', 'http://172.16.0.1'],
    ['http://172.31.255.255', 'http://172.31.255.255'],
    ['http://192.168.1.1', 'http://192.168.1.1'],
    ['http://[::1]:8000/', 'http://[::1]:8000'],
    ['http://[fc00::1]', 'http://[fc00::1]'],
    ['http://[fdff::1]', 'http://[fdff::1]'],
    ['https://example.com/', 'https://example.com'],
  ])('accepts explicit lab origin or HTTPS %#', (url, expected) => {
    const f = fixture();
    expect(
      loadConfig({ ...f.env, MANAGEMENT_AGENT_INGEST_BASE_URL: url })
        .MANAGEMENT_AGENT_INGEST_BASE_URL,
    ).toBe(expected);
  });
  it('sanitizes missing secret file IO errors without paths or cause objects', () => {
    const f = fixture();
    let captured = '';
    try {
      readSecretFile(`${f.directory}/URL_SENTINEL-missing`);
    } catch (error) {
      captured = String(error);
    }
    expect(captured).toBe('Error: Invalid management configuration.');
    expect(countLeaks(captured, [f.directory, 'URL_SENTINEL'])).toBe(0);
  });
  it.each([
    '{',
    '{"lab":1,"lab":2}',
    '{/* comment */"lab":{}}',
    '{"lab":{},}',
    '{"__proto__":{}}',
  ])('rejects malformed trust JSON without echo', (raw) => {
    const f = fixture();
    expect(() =>
      loadConfig({ ...f.env, MANAGEMENT_ADMIN_TRUST_FILE: f.file('bad', raw) }),
    ).toThrow('Invalid management configuration.');
  });
  it('rejects private material, unknown fields and oversized trust files', () => {
    const f = fixture();
    for (const text of [
      JSON.stringify({
        lab: { ...f.trust.lab, public_key_pem: f.privateSentinel },
      }),
      JSON.stringify({ lab: { ...f.trust.lab, password: f.privateSentinel } }),
      ' '.repeat(65537),
    ]) {
      let captured = '';
      try {
        loadConfig({
          ...f.env,
          MANAGEMENT_ADMIN_TRUST_FILE: f.file('invalid', text),
        });
      } catch (error) {
        captured = String(error);
      }
      expect(captured).toBe('Error: Invalid management configuration.');
      expect(
        countLeaks(captured, [f.privateSentinel, f.databaseSentinel]),
      ).toBe(0);
    }
  });
  it('uses an allowlist logger, never serializes arbitrary exception or secret fields', () => {
    const f = fixture();
    const lines: string[] = [];
    const logger = new SafeLogger((line) => lines.push(line));
    const fields = {
      code: 'invalid_request' as const,
      request_id: '123e4567-e89b-42d3-a456-426614174000',
      password: f.privateSentinel,
      error: new Error(f.databaseSentinel),
      url: f.databaseSentinel,
    };
    logger.event('request_failed', fields);
    expect(JSON.parse(lines.join('')).code).toBe('invalid_request');
    expect(
      countLeaks(lines.join(''), [f.privateSentinel, f.databaseSentinel]),
    ).toBe(0);
  });
});
