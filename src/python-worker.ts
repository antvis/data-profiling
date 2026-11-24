import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { ProfileResult } from './types.js';

// Reuse initialized Python imports across requests using the same executable.
const workers = new Map<string, ReturnType<typeof createWorker>>();

function createWorker(python: string) {
  const child = spawn(python, [fileURLToPath(new URL('./worker.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve(value: ProfileResult[]): void; reject(error: unknown): void }>();
  let next = 0,
    output = '',
    errors = '',
    idle: NodeJS.Timeout | undefined;
  const references = (active: boolean) => {
    // Outstanding work keeps Node alive. An idle worker and its pipes do not.
    if (active) child.ref();
    else child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (active) (stream as Socket).ref();
      else (stream as Socket).unref();
    }
  };
  const fail = (error: unknown) => {
    clearTimeout(idle);
    for (const job of pending.values()) job.reject(error);
    pending.clear();
    // An exiting worker must never evict a replacement for the same executable.
    if (workers.get(python) === api) workers.delete(python);
    child.kill();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value) => {
    errors = (errors + value).slice(-65536);
  });
  child.on('error', fail);
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', fail);
  child.on('close', (code) => fail(new Error(`profiling worker exited (${code}): ${errors.trim()}`)));
  child.stdout.on('data', (value) => {
    // Buffer partial lines and match each response to the caller's request ID.
    output += value;
    let end: number;
    while ((end = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, end);
      output = output.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const job = pending.get(message.id);
        if (!job) throw new Error('Unexpected profiling worker response');
        pending.delete(message.id);
        if (message.error) job.reject(new Error(`profiling worker failed: ${message.error}`));
        else job.resolve(message.results);
      } catch (error) {
        fail(error);
        return;
      }
    }
    if (!pending.size) {
      references(false);
      idle = setTimeout(() => {
        if (workers.get(python) === api) workers.delete(python);
        // Closing stdin lets the worker exit its request loop cleanly.
        child.stdin.end();
      }, 30000);
      idle.unref();
    }
  });
  const api = {
    run(request: unknown): Promise<ProfileResult[]> {
      clearTimeout(idle);
      references(true);
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, request }) + '\n');
      });
    },
  };
  return api;
}

export function runPythonWorker(python: string, request: unknown): Promise<ProfileResult[]> {
  if (!workers.has(python)) workers.set(python, createWorker(python));
  return workers.get(python)!.run(request);
}
