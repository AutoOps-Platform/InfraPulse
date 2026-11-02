import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Evidence, scanChunks } from '../support/evidence.js';

// Breaks caught: split sentinel missed, truncated/missing capture claims complete,
// matching values echoed into diagnostics, or overlapping chunks counted twice.
describe('Task13 bounded count-only evidence scanner', () => {
  it('detects sentinels split across arbitrary chunk boundaries without exposing them', async () => {
    const result = await scanChunks(['private-token'], [{ location: 'node-stderr', chunks: ['safe pri', 'vate-', 'token tail'], complete: true }]);
    expect(result).toEqual({ complete: true, leak_count: 1, locations: ['node-stderr'] });
    expect(JSON.stringify(result).includes('private-token')).toBe(false);
  });
  it('counts separate occurrences but not overlap twice', async () => {
    expect(await scanChunks(['needle'], [{ location: 'audit', chunks: ['needle', 'xx', 'needle'], complete: true }]))
      .toEqual({ complete: true, leak_count: 2, locations: ['audit'] });
  });
  it('never calls empty or truncated evidence complete', async () => {
    expect((await scanChunks(['needle'], [])).complete).toBe(false);
    expect(await scanChunks(['needle'], [{ location: 'python', chunks: ['safe'], complete: false }]))
      .toEqual({ complete: false, leak_count: 0, locations: [] });
  });
  it('finds a clean capture without a fake positive or raw text result', async () => {
    expect(await scanChunks(['needle'], [{ location: 'http-errors', chunks: ['sanitized', ' safe'], complete: true }]))
      .toEqual({ complete: true, leak_count: 0, locations: [] });
  });
  it('fails closed when multiple registered capture files are missing without unhandled stream errors', async () => {
    const evidence = new Evidence();
    const missing = resolve(import.meta.dirname,'../../../../.superpowers/sdd/2026-10-31-management-backend',`task-13-never-created-${randomUUID()}`);
    evidence.register('missing-first',missing);
    evidence.register('missing-second',missing+'-second');
    expect(await evidence.scan(['needle'])).toEqual({complete:false,leak_count:0,locations:[]});
  });
  it('does not emit an unhandled later-file open error while consuming an earlier capture', () => {
    // The real Linux test image has no writable repository projection. Its
    // secret-free input stays in a uniquely guarded temporary container dir.
    const directory=process.env.TASK12_REPOSITORY_ROOT ? mkdtempSync(resolve(tmpdir(),'infrapulse-task13-evidence-')) : resolve(import.meta.dirname,'../../../../.superpowers/sdd/2026-10-31-management-backend');
    mkdirSync(directory,{recursive:true,mode:0o700});
    const prefix = resolve(directory,`task-13-stream-${randomUUID()}`);
    const first=prefix+'.private', result=prefix+'.result.json';
    writeFileSync(first,'safe'.repeat(512*1024),{flag:'wx',mode:0o600});
    const module = new URL('../support/evidence.ts',import.meta.url).href;
    const code = `import {Evidence} from ${JSON.stringify(module)};import {writeFileSync} from 'node:fs';let unhandled_errors=0;process.on('uncaughtException',()=>{unhandled_errors++;});const evidence=new Evidence();evidence.register('first',${JSON.stringify(first)});evidence.register('later-missing',${JSON.stringify(prefix+'-missing')});const scan=await evidence.scan(['needle']);await new Promise(done=>setTimeout(done,20));writeFileSync(${JSON.stringify(result)},JSON.stringify({...scan,unhandled_errors}));`;
    const fd=openSync(prefix+'.log','wx',0o600);
    let child: ReturnType<typeof spawnSync>;
    try {child=spawnSync(process.execPath,['--input-type=module','-e',code],{stdio:['ignore',fd,fd],timeout:3000,encoding:'utf8'});}finally{closeSync(fd);}
    writeFileSync(prefix+'.exit.json',JSON.stringify({native_exit:child.status,signal:child.signal,spawn_error:!!child.error}),{flag:'wx',mode:0o600});
    expect({native_exit:child.status,spawn_error:!!child.error}).toEqual({native_exit:0,spawn_error:false});
    const verdict=JSON.parse(readFileSync(result,'utf8'));
    expect(verdict).toEqual({complete:false,leak_count:0,locations:[],unhandled_errors:0});
    process.stdout.write(JSON.stringify({event:'task13_scan_child_receipt',native_exit:child.status,unhandled_errors:verdict.unhandled_errors})+'\n');
  });
  it('fails closed on a byte budget and invalid scan inputs', async () => {
    expect((await scanChunks(['needle'], [{ location: 'node', chunks: ['123456'], complete: true }], 5)).complete).toBe(false);
    await expect(scanChunks([''], [{ location: 'node', chunks: ['x'], complete: true }])).rejects.toThrow();
  });
});
