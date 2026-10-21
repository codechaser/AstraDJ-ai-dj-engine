import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(root, 'server');
const testEnvPath = join(serverDir, '.env.test');
const backendPort = 4317;
const frontendPort = 4318;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const frontendOrigin = `http://127.0.0.1:${frontendPort}`;

function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function assertSafeTestMongoUri(value) {
  if (!value) throw new Error('server/.env.test must define MONGODB_TEST_URI');
  let uri;
  try { uri = new URL(value); }
  catch { throw new Error('MONGODB_TEST_URI must be a valid MongoDB URI'); }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)
    || !localHosts.has(uri.hostname)
    || !/test/i.test(decodeURIComponent(uri.pathname))) {
    throw new Error('Refusing E2E setup: MONGODB_TEST_URI must target a local database with “test” in its name');
  }
  return uri;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function startNode(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-12000); });
  child.recentOutput = () => output;
  return child;
}

async function waitForHealth(child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Backend exited before becoming healthy.\n${child.recentOutput()}`);
    try {
      const response = await fetch(`${backendOrigin}/health`, { signal: AbortSignal.timeout(1500) });
      const result = await response.json();
      if (response.ok && result.status === 'ok' && result.database === 'connected') return;
      lastError = new Error(`Backend health response was ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(300);
  }
  throw new Error(`Backend did not become healthy: ${lastError?.message ?? 'timeout'}\n${child.recentOutput()}`);
}

async function waitForFrontend(child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited before becoming ready.\n${child.recentOutput()}`);
    try {
      const response = await fetch(frontendOrigin, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`Frontend returned ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(300);
  }
  throw new Error(`Vite did not become ready: ${lastError?.message ?? 'timeout'}\n${child.recentOutput()}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

if (!existsSync(testEnvPath)) throw new Error('Missing server/.env.test; refusing to run E2E without a verified local test database');
const testEnv = parseEnvFile(testEnvPath);
const mongoUri = assertSafeTestMongoUri(testEnv.MONGODB_TEST_URI);
const databaseName = `astradj_e2e_${process.pid}_${Date.now()}`;
mongoUri.pathname = `/${databaseName}`;
const isolatedMongoUri = mongoUri.toString();
const runtimeEnv = {
  ...process.env,
  MONGODB_URI: isolatedMongoUri,
  JWT_ACCESS_SECRET: randomBytes(48).toString('base64url'),
  PORT: String(backendPort),
  NODE_ENV: 'test',
  CLIENT_ORIGIN: frontendOrigin,
  VITE_DEV_API_TARGET: backendOrigin,
  ASTRADJ_E2E_BASE_URL: frontendOrigin,
};

let backend;
let frontend;
let exitCode = 1;
let cleanupError;

try {
  run(process.execPath, [join(serverDir, 'src/seed/run.js')], { cwd: serverDir, env: runtimeEnv });
  backend = startNode([join(serverDir, 'src/index.js')], serverDir, runtimeEnv);
  frontend = startNode([join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], root, runtimeEnv);
  await waitForHealth(backend);
  await waitForFrontend(frontend);

  const catalogResponse = await fetch(`${frontendOrigin}/api/v1/tracks?q=Thoughtness`);
  if (!catalogResponse.ok) throw new Error(`Frontend API proxy returned ${catalogResponse.status} for the test catalog`);
  const catalog = await catalogResponse.json();
  const demoTrack = catalog.items?.find((track) => track.trackId === 't_cc0_thoughtness');
  if (!demoTrack || demoTrack.audioAssetUrl !== '/audio/thoughtness.ogg' || demoTrack.durationSeconds !== 46 || demoTrack.acoustic !== null) {
    throw new Error('Seeded catalog did not return the expected demo track metadata');
  }

  const playwrightCli = join(root, 'node_modules/@playwright/test/cli.js');
  run(process.execPath, [playwrightCli, 'test', '--config=playwright.audio-e2e.config.js'], { cwd: root, env: runtimeEnv });
  exitCode = 0;
} catch (error) {
  console.error(error.message);
} finally {
  await stop(frontend);
  await stop(backend);
  try {
    const mongoosePath = pathToFileURL(join(serverDir, 'node_modules/mongoose/index.js')).href;
    const { default: mongoose } = await import(mongoosePath);
    await mongoose.connect(isolatedMongoUri, { serverSelectionTimeoutMS: 5000 });
    const actualDatabase = mongoose.connection.db.databaseName;
    if (actualDatabase !== databaseName || !actualDatabase.startsWith('astradj_e2e_')) {
      throw new Error('Refusing cleanup: connected database did not match this E2E run');
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  } catch (error) {
    cleanupError = error;
    console.error(`E2E database cleanup failed for the isolated run: ${error.message}`);
  }
}

if (cleanupError) process.exitCode = 1;
else process.exitCode = exitCode;
