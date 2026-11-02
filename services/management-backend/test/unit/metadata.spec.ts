import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Server } from 'node:http';

@Injectable()
class Dependency {}
@Module({ providers: [Dependency], exports: [Dependency] })
class DependencyModule {}
@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}
@Module({ imports: [DependencyModule], providers: [Consumer] })
class ConsumerModule {}

describe('ESM decorator metadata contract', () => {
  it('imports main without starting a listener', async () => {
    const listen = vi
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(() => {
        throw new Error('Unexpected listener during import.');
      });
    try {
      await import('../../src/main.js');
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });
  it('sanitizes startup configuration failures without starting a listener', async () => {
    const { main } = await import('../../src/main.js');
    const originalExitCode = process.exitCode;
    const lines: string[] = [];
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => {
        lines.push(String(chunk));
        return true;
      });
    vi.stubEnv('MANAGEMENT_DATABASE_URL_FILE', 'missing-URL_SENTINEL');
    vi.stubEnv('MANAGEMENT_ADMIN_TRUST_FILE', 'missing-public-admin');
    vi.stubEnv('MANAGEMENT_SERVICE_TRUST_FILE', 'missing-public-service');
    vi.stubEnv('MANAGEMENT_GRAFANA_CONTEXT', 'fixture');
    try {
      await main();
      expect(process.exitCode).toBe(1);
      expect(lines.join('').includes('URL_SENTINEL')).toBe(false);
      expect(JSON.parse(lines.join('')).event).toBe('startup_failed');
    } finally {
      output.mockRestore();
      vi.unstubAllEnvs();
      process.exitCode = originalExitCode;
    }
  });
  it('retains runtime constructor types without explicit injection tokens', () => {
    expect(Reflect.getMetadata('design:paramtypes', Consumer)).toEqual([
      Dependency,
    ]);
  });
  it('injects an exported dependency across module boundaries', async () => {
    const module = await Test.createTestingModule({
      imports: [ConsumerModule],
    }).compile();
    try {
      expect(module.get(Consumer).dependency).toBe(module.get(Dependency));
    } finally {
      await module.close();
    }
  });
});
