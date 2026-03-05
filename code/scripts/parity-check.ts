#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(cmd: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf-8', env });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function parseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`invalid json:\n${s}`);
  }
}

function normalize(obj: any): any {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (!obj || typeof obj !== 'object') return obj;
  const out: any = {};
  const skip = new Set(['registry']);
  for (const [k, v] of Object.entries(obj)) {
    if (skip.has(k)) continue;
    out[k] = normalize(v);
  }
  return out;
}

function assertEqual(name: string, pyObj: any, tsObj: any): void {
  const a = JSON.stringify(normalize(pyObj));
  const b = JSON.stringify(normalize(tsObj));
  if (a !== b) {
    throw new Error(`mismatch on ${name}\nPY=${a}\nTS=${b}`);
  }
}

function main(): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = resolve(__filename, '..');
  const root = resolve(__dirname, '..');
  const py = join(root, 'legacy', 'swarm.py');
  const ts = join(root, 'src', 'swarm.ts');

  const home = mkdtempSync(join(tmpdir(), 'swarm-parity-'));
  const env = { ...process.env, HOME: home };

  const tests: Array<{ name: string; py: string[]; ts: string[]; compareJson?: boolean }> = [
    {
      name: 'list-empty',
      py: ['python3', py, 'list'],
      ts: ['node', '--loader', 'ts-node/esm', ts, 'list'],
      compareJson: true,
    },
    {
      name: 'status-empty',
      py: ['python3', py, 'status'],
      ts: ['node', '--loader', 'ts-node/esm', ts, 'status'],
      compareJson: true,
    },
    {
      name: 'check-empty',
      py: ['python3', py, 'check', '--changes-only'],
      ts: ['node', '--loader', 'ts-node/esm', ts, 'check', '--changes-only'],
      compareJson: true,
    },
  ];

  try {
    for (const t of tests) {
      const pyRes = run(t.py, env);
      const tsRes = run(t.ts, env);
      if (pyRes.code !== tsRes.code) {
        throw new Error(`exit code mismatch on ${t.name}: py=${pyRes.code} ts=${tsRes.code}\npyErr=${pyRes.err}\ntsErr=${tsRes.err}`);
      }
      if (t.compareJson) {
        assertEqual(t.name, parseJson(pyRes.out), parseJson(tsRes.out));
      }
    }
    console.log('parity-check: ok');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

main();
