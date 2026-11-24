import { describe, expect, it } from 'vitest';
import {
  encodeSnappyBlock,
  encodeWriteRequestProtobuf,
} from '../../../integrations/aws/amp-remote-write.js';
import { isAllowedPublicIp, normalizeSslHost } from './services/tls-probe.service.js';
import { buildExternalSslSamples } from './services/ssl-targets.service.js';

describe('SSL monitoring helpers', () => {
  it('blocks private, loopback, link-local and invalid IPs against SSRF', () => {
    expect(isAllowedPublicIp('127.0.0.1')).toBe(false);
    expect(isAllowedPublicIp('169.254.169.254')).toBe(false);
    expect(isAllowedPublicIp('10.0.0.1')).toBe(false);
    expect(isAllowedPublicIp('172.16.5.2')).toBe(false);
    expect(isAllowedPublicIp('192.168.1.10')).toBe(false);
    expect(isAllowedPublicIp('::1')).toBe(false);
    expect(isAllowedPublicIp('fe80::1')).toBe(false);
    expect(isAllowedPublicIp('1.1.1.1')).toBe(true);
    expect(isAllowedPublicIp('140.82.112.4')).toBe(true);
  });

  it('normalizes valid public hostnames and rejects local or IP literals', () => {
    expect(normalizeSslHost('InfraPulse.HacMieu.COM.')).toBe('infrapulse.hacmieu.com');
    expect(normalizeSslHost('localhost')).toBeNull();
    expect(normalizeSslHost('127.0.0.1')).toBeNull();
    expect(normalizeSslHost('app.internal')).toBeNull();
  });

  it('encodes Prometheus remote write protobuf and Snappy literal blocks', () => {
    const now = 1_795_400_000_000;
    const samples = buildExternalSslSamples(
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: 'InfraPulse',
          host: 'infrapulse.hacmieu.com',
          port: 443,
          group_name: 'Production',
          enabled: true,
          subject_cn: '*.hacmieu.com',
          issuer_cn: 'WE1',
          serial_number: '1234',
          not_before: new Date('2026-10-01T00:00:00Z'),
          not_after: new Date('2027-01-01T00:00:00Z'),
          authorized: true,
          last_probed_at: new Date(now),
          last_error: null,
          created_at: new Date(now),
          updated_at: new Date(now),
        },
      ],
      0,
      now,
    );
    expect(samples).toHaveLength(3);
    const proto = encodeWriteRequestProtobuf(samples);
    expect(proto.length).toBeGreaterThan(100);
    const snappy = encodeSnappyBlock(proto);
    expect(snappy.length).toBeGreaterThan(proto.length);
  });
});
