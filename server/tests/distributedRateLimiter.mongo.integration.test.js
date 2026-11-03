import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
let safeMongoTarget = false;
try {
  const url = new URL(configuredMongoUri);
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('?')[0]);
  safeMongoTarget = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && database.startsWith('astradj_test_');
} catch { /* The multi-process test requires a safe local test URI. */ }
const liveTest = safeMongoTarget ? test : test.skip;

const workerPath = fileURLToPath(new URL('./rateLimitWorker.js', import.meta.url));
const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
const windowsEnvironment = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  WINDIR: process.env.WINDIR,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  NODE_ENV: 'test',
};

function startWorker(mongoUri) {
  const child = spawn(process.execPath, [workerPath], {
    cwd: serverDirectory,
    env: { ...windowsEnvironment, MONGODB_URI: mongoUri },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === 'READY') { resolveReady(); continue; }
      if (!line) continue;
      const response = JSON.parse(line);
      const callbacks = pending.get(response.id);
      if (callbacks) {
        pending.delete(response.id);
        callbacks.resolve(response);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    const error = new Error(`Rate-limit worker failed: ${chunk.toString()}`);
    rejectReady(error);
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  });
  child.once('error', rejectReady);
  child.once('exit', (code) => {
    if (code !== 0) {
      const error = new Error(`Rate-limit worker exited with code ${code}`);
      rejectReady(error);
      for (const callbacks of pending.values()) callbacks.reject(error);
      pending.clear();
    }
  });
  return {
    child,
    ready,
    request(input) {
      const id = `request-${nextId++}`;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
      return promise;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end(`${JSON.stringify({ type: 'close' })}\n`);
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

liveTest('separate application processes share atomic user and Lounge limits and fixed-window expiry', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'ratelimit');
  const workers = [];
  let connected = false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    workers.push(startWorker(uri), startWorker(uri));
    await Promise.all(workers.map((worker) => worker.ready));
    const base = { scope: 'integration.chat', identity: ['user-a', 'room-a'], limit: 5, windowMs: 60_000, now: 120_000 };
    const boundary = await Promise.all(Array.from({ length: 20 }, (_, index) => workers[index % workers.length].request(base)));
    expect(boundary.filter(({ result }) => result?.allowed)).toHaveLength(5);
    expect(boundary.filter(({ result }) => result && !result.allowed)).toHaveLength(15);

    const separateUsers = await Promise.all([
      workers[0].request({ ...base, identity: ['user-b', 'room-a'], limit: 1 }),
      workers[1].request({ ...base, identity: ['user-a', 'room-b'], limit: 1 }),
    ]);
    expect(separateUsers.map(({ result }) => result.allowed)).toEqual([true, true]);

    const nextWindow = await workers[0].request({ ...base, now: 180_000 });
    expect(nextWindow.result).toMatchObject({ allowed: true, remaining: 4 });
    expect(nextWindow.result.resetAt).toBe(240_000);
  } finally {
    await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 60_000);
