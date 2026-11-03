import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { io as createClient } from 'socket.io-client';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from '../tests/mongoTestDatabase.js';
import { User } from '../src/models/User.js';
import { Track } from '../src/models/Track.js';
import { DJLounge } from '../src/models/DJLounge.js';
import { QueueEvent } from '../src/models/QueueEvent.js';
import { ChatMessage } from '../src/models/ChatMessage.js';
import { RateLimitCounter } from '../src/models/RateLimitCounter.js';
import { RefreshToken } from '../src/models/RefreshToken.js';
import { chromium } from '../../node_modules/playwright/index.mjs';

const sourceMongoUri = process.env.MONGODB_TEST_URI;
const roomsCount = integerSetting('BENCH_ROOMS', 3, 2, 6);
const clientsPerRoom = integerSetting('BENCH_CLIENTS_PER_ROOM', 50, 2, 50);
const mutationRatePerRoomHz = integerSetting('BENCH_MUTATIONS_PER_SECOND', 1, 1, 10);
const durationSeconds = integerSetting('BENCH_DURATION_SECONDS', 30, 5, 120);
const segueSamplesRequested = integerSetting('BENCH_SEGUE_SAMPLES', 20, 1, 100);
const browserClientsRequested = integerSetting('BENCH_BROWSER_CLIENTS_PER_ROOM', Math.min(50, clientsPerRoom), 0, clientsPerRoom);
const acknowledgementTimeoutMs = integerSetting('BENCH_ACK_TIMEOUT_MS', 30000, 5000, 120000);
const mutationSamplesPerRoom = durationSeconds * mutationRatePerRoomHz;
const rootDir = fileURLToPath(new URL('../', import.meta.url));
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const vitePath = fileURLToPath(new URL('../../node_modules/vite/bin/vite.js', import.meta.url));
const browserRoomIndex = 0;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const jwtSecret = crypto.randomBytes(48).toString('hex');
const runId = crypto.randomUUID();
const reportPath = process.env.BENCH_REPORT_PATH
  ? path.resolve(process.env.BENCH_REPORT_PATH)
  : path.resolve(rootDir, '..', 'docs', `performance-benchmark-multi-room-${new Date().toISOString().slice(0, 10)}.json`);

function integerSetting(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function assertSafeMongoUri(value) {
  if (!value) throw new Error('MONGODB_TEST_URI is required; run through npm run benchmark:multi-room');
  const uri = new URL(value);
  const database = decodeURIComponent(uri.pathname.replace(/^\//, '').split('?')[0]);
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)
    || !['127.0.0.1', 'localhost', '::1'].includes(uri.hostname)
    || !database.startsWith('astradj_test_')) {
    throw new Error('Refusing to run: MONGODB_TEST_URI must target loopback and an astradj_test_* database');
  }
}

function percentile(samples, fraction) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(fraction * sorted.length) - 1].toFixed(3));
}

function summarize(samples) {
  if (!samples.length) return { samples: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  return {
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function randomInviteCode() {
  const bytes = crypto.randomBytes(4);
  return `SP-${[...bytes].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function makeToken(userId) {
  return jwt.sign({}, jwtSecret, {
    subject: String(userId), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 3600, algorithm: 'HS256',
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sanitized(text, mongoUri) {
  return text.replaceAll(mongoUri, '[isolated Mongo URI]').replaceAll(jwtSecret, '[benchmark JWT secret]');
}

async function startApiProcess(port, mongoUri, frontendOrigin) {
  const child = spawn(process.execPath, [apiPath], {
    cwd: rootDir,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      NODE_ENV: 'test',
      PORT: String(port),
      MONGODB_URI: mongoUri,
      JWT_ACCESS_SECRET: jwtSecret,
      JWT_ACCESS_TTL_SECONDS: '3600',
      JWT_REFRESH_TTL_DAYS: '7',
      AI_DJ_OUTRO_WINDOW_SECONDS: '12',
      ASTRA_LOUNGE_ACCEPTANCE_TRACE: 'true',
      CLIENT_ORIGIN: frontendOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.pendingDiagnosticsRequests = new Map();
  child.on('message', (message) => {
    if (message?.type !== 'acceptance-diagnostics-snapshot') return;
    child.pendingDiagnosticsRequests.get(message.requestId)?.(message.report);
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = `${output}${chunk}`.slice(-5000); });
  }

  const origin = `http://127.0.0.1:${port}`;
  const started = performance.now();
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited during startup (port ${port}, exit ${child.exitCode}, signal ${child.signalCode}): ${sanitized(output, mongoUri)}`);
    }
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, origin, port, startupMs: Number((performance.now() - started).toFixed(3)) };
    } catch { }
    await delay(100);
  }
  const exitCode = child.exitCode;
  const signalCode = child.signalCode;
  child.kill();
  throw new Error(`API process did not become healthy within 60 seconds (port ${port}, exit ${exitCode}, signal ${signalCode}): ${sanitized(output, mongoUri)}`);
}

async function startFrontendProcess(port, targetOrigin) {
  const child = spawn(process.execPath, [vitePath, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: frontendRoot,
    env: { ...process.env, VITE_DEV_API_TARGET: targetOrigin },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = `${output}${chunk}`.slice(-8000); });
  }
  child.recentOutput = () => output;
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Vite exited during startup (port ${port}, exit ${child.exitCode}): ${output}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return { child, origin, port, recentOutput: () => output };
    } catch { }
    await delay(100);
  }
  child.kill();
  throw new Error(`Vite did not become ready within 30 seconds (port ${port}): ${output}`);
}

async function stopApiProcess(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  const child = processInfo.child;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(8000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function requestAcceptanceDiagnostics(processInfo) {
  const child = processInfo?.child;
  if (!child?.connected) return Promise.resolve(null);
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.pendingDiagnosticsRequests.delete(requestId);
      resolve(null);
    }, 5000);
    child.pendingDiagnosticsRequests.set(requestId, (report) => {
      clearTimeout(timer);
      child.pendingDiagnosticsRequests.delete(requestId);
      resolve(report);
    });
    child.send({ type: 'acceptance-diagnostics-snapshot', requestId }, (error) => {
      if (!error) return;
      clearTimeout(timer);
      child.pendingDiagnosticsRequests.delete(requestId);
      resolve({ error: error.message });
    });
  });
}

function connectClient(entry, processes, allClients = null) {
  const processInfo = processes[entry.instance];
  const socket = createClient(processInfo.origin, {
    transports: ['websocket'], reconnection: false, forceNew: true, timeout: 10000,
    auth: { token: entry.token },
    localAddress: entry.localAddress,
  });
  entry.socket = socket;
  allClients?.push(socket);
  socket.on('lounge.queue.update', (message) => recordQueueUpdate(entry, message));
  socket.on('lounge.chat.message', (message) => recordChatMessage(entry, message));
  socket.on('lounge.session.ended', (message) => recordEndedEvent(entry, message));
  return socket;
}

function addAcceptanceReceipt(entry, record, trace) {
  const waiter = trace?.traceId && entry.pendingTraces.get(trace.traceId);
  if (!waiter) return;
  if (waiter.received.has(entry.key)) {
    waiter.duplicates += 1;
    return;
  }
  waiter.received.set(entry.key, record);
}

function recordQueueUpdate(entry, message) {
  if (message?.loungeId !== entry.loungeId) {
    entry.foreignLoungeEvents += 1;
    return;
  }
  const queueIds = (message.payload.queue ?? []).map((track) => track.trackId);
  entry.appliedQueueIds = new Set(queueIds);
  setImmediate(() => { entry.renderedQueueIds = new Set(queueIds); });
  const trace = message.payload?.acceptanceTrace;
  const waiter = trace?.traceId && entry.pendingTraces.get(trace.traceId);
  if (!waiter) return;
  if (waiter.received.has(entry.key)) {
    waiter.duplicates += 1;
    return;
  }
  const receiveMonoMs = performance.now();
  const record = {
    clientKey: entry.key,
    clientKind: 'socket',
    receiveMonoMs,
    applyMonoMs: performance.now(),
    revision: message.payload?.revision,
    stateHash: message.payload?.stateHash,
    queueIds,
  };
  addAcceptanceReceipt(entry, record, trace);
  if (trace) {
    entry.socket.emit('lounge.queue.acceptance.received', {
      traceId: trace.traceId,
      eventId: trace.eventId,
      committedRevision: trace.committedRevision,
    }, (receiptAck) => { record.receiptAck = receiptAck; });
  }
  setImmediate(() => {
    entry.renderedQueueIds = new Set(queueIds);
    record.renderMonoMs = performance.now();
    waiter.rendered.set(entry.key, record);
    if (waiter.rendered.size === waiter.expectedClients) waiter.complete();
  });
}

function recordBrowserQueueReceipt(entry, payload) {
  const waiter = payload.traceId && entry.pendingTraces.get(payload.traceId);
  if (!waiter) return;
  if (waiter.received.has(entry.key)) {
    waiter.duplicates += 1;
    return;
  }
  waiter.received.set(entry.key, {
    clientKey: entry.key,
    clientKind: 'browser',
    receiveMonoMs: payload.clientReceivedAtMonoMs,
    revision: payload.broadcastRevision,
    broadcastRevision: payload.broadcastRevision,
    stateHash: payload.broadcastStateHash,
    queueIds: payload.expectedTrackIds ?? [],
    eventId: payload.eventId,
    committedRevision: payload.committedRevision,
  });
}

function recordBrowserQueueReceiptAck(entry, payload) {
  const record = entry.pendingTraces.get(payload.traceId)?.received.get(entry.key);
  if (record) record.receiptAck = payload.receiptAck;
}

function recordBrowserQueueStateApplied(entry, payload) {
  const record = entry.pendingTraces.get(payload.traceId)?.received.get(entry.key);
  if (!record) return;
  record.applyMonoMs = payload.clientStateAppliedAtMonoMs;
  record.applyLatencyMs = payload.clientStateAppliedAtMonoMs - record.receiveMonoMs;
  entry.appliedQueueIds = new Set(record.queueIds);
}

function recordBrowserQueueRender(entry, payload) {
  const waiter = entry.pendingTraces.get(payload.traceId);
  const record = waiter?.received.get(entry.key);
  if (!waiter || !record) return;
  const queueIds = payload.renderedTrackIds ?? [];
  record.renderMonoMs = payload.browserRenderedAtMonoMs;
  record.renderLatencyMs = payload.browserRenderedAtMonoMs - record.receiveMonoMs;
  record.applyMonoMs = payload.clientStateAppliedAtMonoMs;
  record.applyLatencyMs = payload.clientStateAppliedAtMonoMs - record.receiveMonoMs;
  record.queueIds = queueIds;
  record.domMatches = payload.domMatches === true;
  record.renderedRevision = payload.renderedRevision;
  record.renderedStateHash = payload.renderedStateHash;
  record.skippedRevision = payload.renderedRevision !== record.broadcastRevision;
  record.renderAck = payload.renderAck;
  record.harnessRenderAckReceivedMonoMs = performance.now();
  entry.renderedQueueIds = new Set(queueIds);
  waiter.rendered.set(entry.key, record);
  if (waiter.rendered.size === waiter.expectedClients) waiter.complete();
}

function recordChatMessage(entry, message) {
  if (message?.loungeId !== entry.loungeId) {
    entry.foreignLoungeEvents += 1;
    return;
  }
  const body = message.payload?.body;
  if (typeof body !== 'string') return;
  const records = entry.pendingChat.get(body);
  if (!records) return;
  records.push({ messageId: message.payload.messageId, receivedAt: performance.now() });
}

function recordEndedEvent(entry, message) {
  if (message?.loungeId !== entry.loungeId) {
    entry.foreignLoungeEvents += 1;
    return;
  }
  entry.endedEvents.push(message);
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 15000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(new Error(`Socket connection failed: ${error.message}`)); });
  });
}

function socketCommand(socket, event, payload = {}, timeoutMs = acknowledgementTimeoutMs) {
  const startedMonoMs = performance.now();
  const result = { response: null, roundTripMs: null, timedOut: false, lateResponse: null };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      result.roundTripMs = Number((performance.now() - startedMonoMs).toFixed(3));
      result.timedOut = true;
      resolve(result);
    }, timeoutMs);
    socket.emit(event, payload, (response) => {
      if (result.timedOut) {
        result.lateResponse = response;
        return;
      }
      clearTimeout(timer);
      result.response = response;
      result.roundTripMs = Number((performance.now() - startedMonoMs).toFixed(3));
      resolve(result);
    });
  });
}

function installTraceWaiter(room, traceId) {
  const waiter = {
    expectedClients: room.clients.length,
    received: new Map(),
    rendered: new Map(),
    duplicates: 0,
    complete: null,
    promise: null,
  };
  waiter.promise = new Promise((resolve) => { waiter.complete = () => resolve(); });
  for (const client of room.clients) client.pendingTraces.set(traceId, waiter);
  return waiter;
}

async function executeQueueMutation(room, trackId, mutationIndex) {
  const traceId = crypto.randomUUID();
  const waiter = installTraceWaiter(room, traceId);
  const source = room.writers[mutationIndex % room.writers.length];
  const [commandResult] = await Promise.all([
    socketCommand(source.socket, 'lounge.queue.add', { trackId, acceptanceTraceId: traceId }),
    Promise.race([waiter.promise, delay(acknowledgementTimeoutMs)]),
  ]);
  const { response, roundTripMs, timedOut } = commandResult;
  for (const client of room.clients) client.pendingTraces.delete(traceId);
  const records = [...waiter.received.values()];
  const finalResponse = response ?? commandResult.lateResponse;
  const ackTrace = finalResponse?.acceptanceTrace;
  const browserRecords = records.filter((record) => record.clientKind === 'browser');
  const renderedBrowserRecords = browserRecords.filter((record) => Number.isFinite(record.renderMonoMs));
  const applyLatencies = records.map((record) => Number.isFinite(record.applyLatencyMs)
    ? record.applyLatencyMs : record.applyMonoMs - record.receiveMonoMs);
  const simulatedRenderLatencies = records.filter((record) => Number.isFinite(record.renderMonoMs))
    .map((record) => record.renderMonoMs - record.receiveMonoMs);
  const recordByKey = new Map(records.map((record) => [record.clientKey, record]));
  const divergence = records.filter((record) => !record.queueIds.includes(trackId)
    || (record.clientKind === 'browser' && !record.domMatches)).length;
  const receiptAcksComplete = records.length === room.clients.length
    && records.every((record) => Number.isFinite(record.receiptAck?.serverReceiptElapsedMs));
  const browserSubsetRendersComplete = browserRecords.length === browserRoomClients(room).length
    && browserRecords.length > 0
    && waiter.duplicates === 0
    && divergence === 0
    && browserRecords.every((record) => record.skippedRevision !== true)
    && browserRecords.every((record) => record.domMatches === true
      && record.renderAck?.ok === true
      && record.renderAck?.stateHashValid === true
      && Number.isFinite(record.renderAck?.serverReceiptToRenderAckUpperBoundMs));
  const browserRendersComplete = browserRoomClients(room).length === room.clients.length
    && browserSubsetRendersComplete;
  const receiptElapsed = records.map((record) => record.receiptAck?.serverReceiptElapsedMs).filter(Number.isFinite);
  const renderAckUpperBounds = browserRecords.map((record) => record.renderAck?.serverReceiptToRenderAckUpperBoundMs).filter(Number.isFinite);
  return {
    traceId,
    loungeId: room.loungeId,
    trackId,
    attempted: true,
    accepted: finalResponse?.ok === true,
    rejected: finalResponse?.ok === false,
    timedOut,
    late: Boolean(commandResult.lateResponse),
    errorCode: finalResponse?.error?.code ?? (timedOut && !commandResult.lateResponse ? 'ACK_TIMEOUT' : null),
    ackRoundTripMs: roundTripMs,
    serverProcessingMs: ackTrace?.serverProcessingMs ?? null,
    serverTrace: ackTrace ?? null,
    serverReceiptToLastClientDeliveryAckUpperBoundMs: receiptAcksComplete ? Math.max(...receiptElapsed) : null,
    serverReceiptToLastBrowserRenderAckUpperBoundMs: browserSubsetRendersComplete ? Math.max(...renderAckUpperBounds) : null,
    serverReceiptToAllClientRenderAckUpperBoundMs: browserRendersComplete ? Math.max(...renderAckUpperBounds) : null,
    clientStateApplicationMs: summarize(applyLatencies.filter(Number.isFinite)),
    simulatedRenderCallbackMs: summarize(simulatedRenderLatencies),
    browserStateApplicationMs: summarize(browserRecords.map((record) => record.applyLatencyMs).filter(Number.isFinite)),
    browserDomRenderAfterReceiptMs: summarize(renderedBrowserRecords.map((record) => record.renderLatencyMs).filter(Number.isFinite)),
    queueDriftComplete: browserRendersComplete,
    browserSubsetRenderComplete: browserSubsetRendersComplete,
    browserDomRenderSpreadMs: null,
    browserDomMatches: renderedBrowserRecords.filter((record) => record.domMatches).length,
    browserDomMismatches: renderedBrowserRecords.filter((record) => !record.domMatches).length,
    renderedClientCount: renderedBrowserRecords.length,
    missingDomRenderings: browserRoomClients(room).length - renderedBrowserRecords.length,
    clientReceipts: records.length,
    expectedClientReceipts: room.clients.length,
    missingClientReceipts: room.clients.length - records.length,
    duplicateClientEvents: waiter.duplicates,
    queueStateDivergence: divergence,
    skippedRevisionClients: browserRecords.filter((record) => record.skippedRevision).length,
    invalidRenderAcknowledgements: browserRecords.filter((record) => record.renderAck?.ok !== true
      || record.renderAck?.stateHashValid !== true).length,
    incomplete: !browserRendersComplete || records.length !== room.clients.length
      || waiter.duplicates > 0 || divergence > 0,
    allEventRecords: records,
    clientRecordByKey: Object.fromEntries([...recordByKey.entries()]),
  };
}

function browserRoomClients(room) {
  return room.clients.filter((client) => client.kind === 'browser');
}

async function executeBrowserQueueMutation(room, trackId, mutationIndex) {
  const traceId = crypto.randomUUID();
  const waiter = installTraceWaiter(room, traceId);
  const browserWriters = room.writers.filter((writer) => writer.kind === 'browser');
  if (!browserWriters.length) throw new Error('Browser queue workload requires at least one browser Host or Co-DJ writer');
  const source = browserWriters[mutationIndex % browserWriters.length];
  const commandWaiter = { timedOut: false, lateResponse: null };
  const ackPromise = new Promise((resolve) => source.pendingCommandAcks.set(traceId, (ack) => {
    if (commandWaiter.timedOut) {
      commandWaiter.lateResponse = ack;
      return;
    }
    resolve(ack);
  }));
  const started = performance.now();
  try {
    await source.page.evaluate((id) => { window.__ASTRA_QUEUE_ACCEPTANCE_TRACE_ID__ = id; }, traceId);
    await source.page.getByRole('combobox', { name: 'Choose a catalog track to add' }).selectOption(trackId);
    await source.page.getByRole('button', { name: 'Add to queue' }).evaluate((button) => button.click());
    const response = await Promise.race([ackPromise, delay(acknowledgementTimeoutMs).then(() => null)]);
    const roundTripMs = response ? Number((performance.now() - started).toFixed(3)) : null;
    await source.page.evaluate(() => { delete window.__ASTRA_QUEUE_ACCEPTANCE_TRACE_ID__; });
    const timedOut = !response;
    commandWaiter.timedOut = timedOut;
    await Promise.race([waiter.promise, delay(acknowledgementTimeoutMs)]);
    const records = [...waiter.received.values()];
    const browserRecords = records.filter((record) => record.clientKind === 'browser');
    const renderedBrowserRecords = browserRecords.filter((record) => Number.isFinite(record.renderMonoMs));
    const finalResponse = response ?? commandWaiter.lateResponse;
    const ackTrace = finalResponse?.acceptanceTrace;
    const recordByKey = new Map(records.map((record) => [record.clientKey, record]));
    const browserSubsetRendersComplete = browserRecords.length === browserRoomClients(room).length
      && browserRecords.length > 0
      && waiter.duplicates === 0
      && browserRecords.every((record) => record.domMatches === true
        && record.renderAck?.ok === true
        && record.renderAck?.stateHashValid === true
        && record.skippedRevision !== true
        && Number.isFinite(record.renderAck?.serverReceiptToRenderAckUpperBoundMs));
    const browserRendersComplete = browserRoomClients(room).length === room.clients.length
      && browserSubsetRendersComplete;
    const renderAckUpperBounds = browserRecords.map((record) => record.renderAck?.serverReceiptToRenderAckUpperBoundMs).filter(Number.isFinite);
    return {
      traceId,
      loungeId: room.loungeId,
      trackId,
      attempted: true,
      accepted: finalResponse?.ok === true,
      rejected: finalResponse?.ok === false,
      timedOut,
      late: Boolean(commandWaiter.lateResponse),
      errorCode: finalResponse?.error?.code ?? (timedOut && !commandWaiter.lateResponse ? 'ACK_TIMEOUT' : null),
      ackRoundTripMs: roundTripMs,
      serverProcessingMs: ackTrace?.serverProcessingMs ?? null,
      serverTrace: ackTrace ?? null,
      serverReceiptToLastClientDeliveryAckUpperBoundMs: records.length === room.clients.length
        && records.every((record) => Number.isFinite(record.receiptAck?.serverReceiptElapsedMs))
        ? Math.max(...records.map((record) => record.receiptAck.serverReceiptElapsedMs)) : null,
      serverReceiptToLastBrowserRenderAckUpperBoundMs: browserSubsetRendersComplete
        ? Math.max(...renderAckUpperBounds) : null,
      serverReceiptToAllClientRenderAckUpperBoundMs: browserRendersComplete
        ? Math.max(...renderAckUpperBounds) : null,
      clientStateApplicationMs: summarize(browserRecords.map((record) => record.applyLatencyMs).filter(Number.isFinite)),
      simulatedRenderCallbackMs: summarize([]),
      browserStateApplicationMs: summarize(browserRecords.map((record) => record.applyLatencyMs).filter(Number.isFinite)),
      browserDomRenderAfterReceiptMs: summarize(renderedBrowserRecords.map((record) => record.renderLatencyMs).filter(Number.isFinite)),
      browserDomRenderSpreadMs: null,
      browserDomMatches: renderedBrowserRecords.filter((record) => record.domMatches).length,
      browserDomMismatches: renderedBrowserRecords.filter((record) => !record.domMatches).length,
      queueDriftComplete: browserRendersComplete,
      browserSubsetRenderComplete: browserSubsetRendersComplete,
      renderedClientCount: renderedBrowserRecords.length,
      missingDomRenderings: browserRoomClients(room).length - renderedBrowserRecords.length,
      clientReceipts: records.length,
      expectedClientReceipts: room.clients.length,
      missingClientReceipts: room.clients.length - records.length,
      duplicateClientEvents: waiter.duplicates,
      queueStateDivergence: records.filter((record) => !record.queueIds.includes(trackId)
        || (record.clientKind === 'browser' && !record.domMatches)).length,
      skippedRevisionClients: browserRecords.filter((record) => record.skippedRevision).length,
      invalidRenderAcknowledgements: browserRecords.filter((record) => record.renderAck?.ok !== true
        || record.renderAck?.stateHashValid !== true).length,
      incomplete: !browserRendersComplete || records.length !== room.clients.length || waiter.duplicates > 0
        || records.some((record) => !record.queueIds.includes(trackId)
          || (record.clientKind === 'browser' && !record.domMatches)),
      allEventRecords: records,
      clientRecordByKey: Object.fromEntries([...recordByKey.entries()]),
    };
  } finally {
    source.pendingCommandAcks.delete(traceId);
    source.pendingTraces.delete(traceId);
  }
}

async function runQueueMutations(rooms) {
  const allMeasurements = [];
  const start = performance.now();
  await Promise.all(rooms.map(async (room) => {
    const roomStart = performance.now();
    const operations = [];
    for (let index = 0; index < mutationSamplesPerRoom; index += 1) {
      const target = roomStart + (index * 1000 / mutationRatePerRoomHz);
      await delay(target - performance.now());
      const roomIndex = rooms.indexOf(room);
      const trackId = `t_mr_${String(roomIndex * mutationSamplesPerRoom + index).padStart(6, '0')}`;
      operations.push(room.browserMeasured
        ? executeBrowserQueueMutation(room, trackId, index)
        : executeQueueMutation(room, trackId, index));
    }
    allMeasurements.push(...await Promise.all(operations));
  }));
  return {
    workloadElapsedMs: Number((performance.now() - start).toFixed(3)),
    measurements: allMeasurements,
  };
}

function metricReport(measurements, key) {
  return summarize(measurements.map((entry) => entry[key]).filter(Number.isFinite));
}

function roomSummary(room, measurements) {
  const rows = measurements.filter((entry) => entry.loungeId === room.loungeId);
  return {
    loungeId: room.loungeId,
    clients: room.clients.length,
    clientConnectionsByProcess: room.processes.map((processInfo) => ({
      port: processInfo.port,
      connections: room.clients.filter((client) => client.kind === 'browser'
        ? room.processes.indexOf(processInfo) === browserRoomIndex
        : client.instance === room.processes.indexOf(processInfo)).length,
    })),
    queueMutations: rows.length,
    queueStateSyncDrift: room.browserMeasured ? metricReport(rows, 'serverReceiptToLastBrowserRenderAckUpperBoundMs') : null,
    browserDomRenderSpread: room.browserMeasured ? metricReport(rows, 'browserDomRenderSpreadMs') : null,
    serverProcessing: metricReport(rows, 'serverProcessingMs'),
    serverReceiptToLastClientDelivery: metricReport(rows, 'serverReceiptToLastClientDeliveryAckUpperBoundMs'),
    clientStateApplication: mergeSummaries(rows.flatMap((row) => row.allEventRecords.map((record) =>
      Number.isFinite(record.applyLatencyMs) ? record.applyLatencyMs : record.applyMonoMs - record.receiveMonoMs))),
    simulatedRenderCallback: mergeSummaries(rows.flatMap((row) => row.allEventRecords.filter((record) => Number.isFinite(record.renderMonoMs)).map((record) => record.renderMonoMs - record.receiveMonoMs))),
    browserStateApplication: mergeSummaries(rows.flatMap((row) => row.allEventRecords.map((record) => record.applyLatencyMs).filter(Number.isFinite))),
    browserDomRenderAfterReceipt: mergeSummaries(rows.flatMap((row) => row.allEventRecords.map((record) => record.renderLatencyMs).filter(Number.isFinite))),
    browserDomMismatchCount: rows.reduce((sum, entry) => sum + (entry.browserDomMismatches ?? 0), 0),
    missingBrowserDomRenderings: rows.reduce((sum, entry) => sum + (entry.missingDomRenderings ?? 0), 0),
    missingClientReceipts: rows.reduce((sum, entry) => sum + entry.missingClientReceipts, 0),
    duplicateClientEvents: rows.reduce((sum, entry) => sum + entry.duplicateClientEvents, 0),
    queueStateDivergence: rows.reduce((sum, entry) => sum + entry.queueStateDivergence, 0),
    skippedRevisionClients: rows.reduce((sum, entry) => sum + entry.skippedRevisionClients, 0),
    invalidRenderAcknowledgements: rows.reduce((sum, entry) => sum + entry.invalidRenderAcknowledgements, 0),
    attemptedMutations: rows.length,
    acceptedMutations: rows.filter((entry) => entry.accepted).length,
    rejectedMutations: rows.filter((entry) => entry.rejected).length,
    lateMutations: rows.filter((entry) => entry.late).length,
    completedBrowserRenders: rows.filter((entry) => entry.queueDriftComplete).length,
    completedBrowserSubsetRenders: rows.filter((entry) => entry.browserSubsetRenderComplete).length,
    incompleteMutations: rows.filter((entry) => entry.incomplete).length,
  };
}

function mergeSummaries(values) {
  return summarize(values.filter(Number.isFinite));
}

async function runChatAndReconnect(rooms, allSockets) {
  const results = [];
  for (const room of rooms) {
    if (room.browserMeasured) {
      results.push({ loungeId: room.loungeId, status: 'SKIPPED_BROWSER_QUEUE_COHORT', reason: 'Chat/reconnect coverage runs through the Socket.IO cohorts in the other concurrent rooms.' });
      continue;
    }
    if (room.listeners.length < 3) {
      results.push({ loungeId: room.loungeId, status: 'SKIPPED_INSUFFICIENT_LISTENERS', reason: 'Chat/reconnect acceptance needs three listener clients in addition to the Host and Co-DJ.' });
      continue;
    }
    const body = `multi-room acceptance ${runId} ${room.loungeId}`;
    for (const client of room.clients) client.pendingChat.set(body, []);
    const started = performance.now();
    const sent = await socketCommand(room.listeners[0].socket, 'lounge.chat.message', {
      body, clientMessageId: crypto.randomUUID(),
    });
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline && room.clients.some((client) => client.pendingChat.get(body).length === 0)) await delay(10);
    const counts = room.clients.map((client) => client.pendingChat.get(body).length);
    for (const client of room.clients) client.pendingChat.delete(body);
    const disconnected = room.listeners[1];
    const disconnectedSignal = new Promise((resolve) => disconnected.socket.once('disconnect', resolve));
    disconnected.socket.disconnect();
    await disconnectedSignal;
    const missedBody = `reconnect recovery ${runId} ${room.loungeId}`;
    const missedSender = room.listeners[2];
    for (const client of room.clients) client.pendingChat.set(missedBody, []);
    const missedSend = await socketCommand(missedSender.socket, 'lounge.chat.message', {
      body: missedBody, clientMessageId: crypto.randomUUID(),
    });
    await delay(150);
    const reconnectSocket = connectClient(disconnected, room.processes, allSockets);
    await waitForConnect(reconnectSocket);
    const joined = await socketCommand(reconnectSocket, 'lounge.join', { inviteCode: room.inviteCode });
    const history = await socketCommand(reconnectSocket, 'lounge.chat.history', { limit: 100 });
    disconnected.socket = reconnectSocket;
    const recoveredBody = history.response?.messages?.some((message) => message.body === missedBody) ?? false;
    const queueTrackIds = [
      ...(joined.response?.state?.nowPlaying?.trackId ? [joined.response.state.nowPlaying.trackId] : []),
      ...(joined.response?.state?.nextUp ?? []).map((track) => track.trackId),
    ];
    disconnected.appliedQueueIds = new Set(queueTrackIds);
    disconnected.renderedQueueIds = new Set(queueTrackIds);
    results.push({
      loungeId: room.loungeId,
      initialChatAckOk: sent.response?.ok === true,
      initialChatAckRoundTripMs: sent.roundTripMs,
      initialChatDeliveryLatencyMs: Number((performance.now() - started).toFixed(3)),
      chatRecipientsExpected: room.clients.length,
      chatRecipientsObservedExactlyOnce: counts.filter((count) => count === 1).length,
      chatDuplicateRecipientEvents: counts.filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0),
      chatMissingRecipients: counts.filter((count) => count === 0).length,
      disconnectedClientChatHistoryRecovered: missedSend.response?.ok === true && recoveredBody,
      reconnectJoinSucceeded: joined.response?.ok === true,
      reconnectQueueSnapshotTracks: queueTrackIds.length,
      reconnectForeignLoungeEvents: disconnected.foreignLoungeEvents,
      queueStateAfterReconnect: queueTrackIds,
    });
    for (const client of room.clients) client.pendingChat.delete(missedBody);
  }
  return results;
}

async function runSegueSamples(rooms, samples) {
  const measurements = [];
  const socketRooms = rooms.filter((room) => !room.browserMeasured);
  if (!socketRooms.length) return measurements;
  for (let index = 0; index < samples; index += 1) {
    if (index === 15) await RateLimitCounter.deleteMany({});
    const room = socketRooms[index % socketRooms.length];
    const current = await DJLounge.findOne({ loungeId: room.loungeId }).select('currentTrackId').lean();
    const remoteClients = room.clients.filter((client) => client.instance !== room.host.instance);
    const announcementWaiters = remoteClients.map((client) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.socket.off('lounge.ai.dj_announcement', handler);
        resolve(null);
      }, 10000);
      const handler = (message) => {
        if (message?.loungeId !== room.loungeId) return;
        clearTimeout(timer);
        client.socket.off('lounge.ai.dj_announcement', handler);
        resolve({ message, at: performance.now() });
      };
      client.socket.on('lounge.ai.dj_announcement', handler);
    }));
    const startedAt = performance.now();
    const trigger = await socketCommand(room.host.socket, 'lounge.ai.segue.trigger', { currentTs: 170 });
    const announcement = await Promise.all(announcementWaiters);
    const received = announcement.filter(Boolean);
    if (!trigger.response?.ok || !trigger.response.decision?.selectedTrackId) {
      measurements.push({ loungeId: room.loungeId, ok: false, errorCode: trigger.response?.error?.code ?? 'NO_DECISION' });
      continue;
    }
    const currentTrackId = current.currentTrackId;
    const completed = await socketCommand(room.host.socket, 'lounge.playback.ended', { trackId: currentTrackId });
    measurements.push({
      loungeId: room.loungeId,
      ok: completed.response?.ok === true && received.length === remoteClients.length,
      errorCode: completed.response?.error?.code ?? (received.length !== remoteClients.length ? 'ANNOUNCEMENT_RECIPIENT_MISMATCH' : null),
      triggerAckRoundTripMs: trigger.roundTripMs,
      triggerToLastRemoteAnnouncementMs: received.length
        ? Number((Math.max(...received.map((item) => item.at)) - startedAt).toFixed(3)) : null,
      announcementRecipientsExpected: remoteClients.length,
      announcementRecipientsObserved: received.length,
      playbackCompletionSucceeded: completed.response?.ok === true,
      note: 'Socket/service boundary with synthetic currentTs; no audio clock or browser render measurement.',
    });
  }
  return measurements;
}

async function verifyRoomIsolation(rooms, measurements) {
  const queueRows = [];
  let expectedAdds = 0;
  let missingEvents = 0;
  let duplicateEvents = 0;
  let missingState = 0;
  let divergenceCount = 0;
  for (const room of rooms) {
    let roomDivergence = 0;
    const trackIds = measurements.filter((row) => row.loungeId === room.loungeId && row.accepted).map((row) => row.trackId);
    expectedAdds += trackIds.length;
    const rows = await QueueEvent.find({ loungeId: room.loungeId, type: 'track.added', 'payload.acceptanceTrace.traceId': { $in: measurements.filter((row) => row.loungeId === room.loungeId).map((row) => row.traceId) } })
      .select('seq payload.trackId payload.acceptanceTrace').lean();
    const byTrace = new Map(rows.map((row) => [row.payload.acceptanceTrace?.traceId, row]));
    missingEvents += trackIds.filter((trackId) => !rows.some((row) => row.payload.trackId === trackId)).length;
    duplicateEvents += rows.length - byTrace.size;
    const lounge = await DJLounge.findOne({ loungeId: room.loungeId }).select('coordination.state.items coordination.state.currentTrackId coordination.outbox').lean();
    const persistedIds = new Set((lounge?.coordination?.state?.items ?? []).map((item) => item.trackId));
    if (lounge?.coordination?.state?.currentTrackId) persistedIds.add(lounge.coordination.state.currentTrackId);
    missingState += trackIds.filter((trackId) => !persistedIds.has(trackId)).length;
    for (const client of room.clients) {
      if (client.renderedQueueIds.size !== persistedIds.size || [...persistedIds].some((trackId) => !client.renderedQueueIds.has(trackId))) {
        divergenceCount += 1;
        roomDivergence += 1;
      }
    }
    queueRows.push({
      loungeId: room.loungeId,
      acknowledgedAdds: trackIds.length,
      persistedAddEvents: rows.length,
      uniqueCorrelationIds: byTrace.size,
      persistedQueueTracks: persistedIds.size,
      outboxBacklog: lounge?.coordination?.outbox?.length ?? null,
      allMembersRenderedPersistedSnapshot: roomDivergence === 0,
    });
  }
  return {
    acknowledgedAdds: expectedAdds,
    missingDurableEvents: missingEvents,
    duplicateDurableEvents: duplicateEvents,
    successfulAddsMissingFromPersistedQueue: missingState,
    clientQueueSnapshotDivergences: divergenceCount,
    roomDetails: queueRows,
  };
}

async function runLifecycle(rooms) {
  const results = await Promise.all(rooms.map(async (room) => {
    if (room.browserMeasured) {
      return { loungeId: room.loungeId, status: 'SKIPPED_BROWSER_QUEUE_COHORT', reason: 'Host lifecycle coverage runs through the Socket.IO cohorts in the other concurrent rooms.' };
    }
    const listeners = room.clients.map((client) => new Promise((resolve) => {
      const timer = setTimeout(() => {
        client.socket.off('lounge.session.ended', handler);
        resolve(false);
      }, 10000);
      const handler = (message) => {
        if (message?.loungeId !== room.loungeId) return;
        clearTimeout(timer);
        client.socket.off('lounge.session.ended', handler);
        resolve(true);
      };
      client.socket.on('lounge.session.ended', handler);
    }));
    const ended = await socketCommand(room.host.socket, 'lounge.session.end', {});
    const delivered = await Promise.all(listeners);
    const persisted = await DJLounge.findOne({ loungeId: room.loungeId }).select('status endedAt').lean();
    return {
      loungeId: room.loungeId,
      hostEndAcknowledged: ended.response?.ok === true,
      hostEndErrorCode: ended.response?.error?.code ?? null,
      persistedEnded: persisted?.status === 'ended' && Boolean(persisted.endedAt),
      endEventRecipientsExpected: room.clients.length,
      endEventRecipientsObserved: delivered.filter(Boolean).length,
      missingEndNotifications: delivered.filter((value) => !value).length,
      endAckRoundTripMs: ended.roundTripMs,
    };
  }));
  return results;
}

async function createFixtures(processes) {
  const rooms = [];
  const now = new Date();
  const userRows = [];
  const refreshTokenRows = [];
  const trackRows = [];
  const loungeRows = [];
  for (let roomIndex = 0; roomIndex < roomsCount; roomIndex += 1) {
    const loungeId = `lg_${crypto.randomBytes(8).toString('hex')}`;
    const inviteCode = randomInviteCode();
    const users = Array.from({ length: clientsPerRoom }, (_, index) => ({
      id: new mongoose.Types.ObjectId(),
      role: index === 0 ? 'Host' : index <= 5 ? 'Co-DJ' : 'Listener',
      displayName: `Room ${roomIndex + 1} User ${index + 1}`,
    }));
    const currentTrackId = `t_mr_current_${roomIndex}`;
    const firstSegueTrackId = `t_mr_initial_${roomIndex}`;
    const host = { userId: String(users[0].id), role: users[0].role, instance: 0 };
    const writer = { userId: String(users[1].id), role: users[1].role, instance: 1 };
    userRows.push(...users.map((user) => ({
      _id: user.id,
      email: `multirun-${runId}-${user.id}@example.invalid`,
      displayName: user.displayName,
      passwordHash: 'isolated-performance-fixture-only',
      role: user.role,
    })));
    const refreshTokens = users.map((user) => crypto.randomBytes(48).toString('base64url'));
    refreshTokenRows.push(...users.map((user, index) => ({
      userId: user.id,
      tokenHash: crypto.createHash('sha256').update(refreshTokens[index]).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })));
    const makeTrack = (trackId, title) => ({
      trackId, title, artist: 'Multi-room acceptance fixture', durationSeconds: 180,
      acoustic: { bpm: 120, camelotKey: '8A', energy: 0.55, valence: 0.55 },
      timeline: [{ ts: 15, type: 'trivia', text: 'Synthetic fact for the isolated acceptance run.' }],
    });
    trackRows.push(makeTrack(currentTrackId, `Room ${roomIndex + 1} current`));
    trackRows.push(makeTrack(firstSegueTrackId, `Room ${roomIndex + 1} first segue`));
    for (let index = 0; index < mutationSamplesPerRoom; index += 1) {
      trackRows.push(makeTrack(`t_mr_${String(roomIndex * mutationSamplesPerRoom + index).padStart(6, '0')}`, `Room ${roomIndex + 1} queue add ${index + 1}`));
    }
    const segueCount = Math.ceil(segueSamplesRequested / roomsCount) + 1;
    const segueTrackIds = Array.from({ length: segueCount }, (_, index) =>
      `t_mr_seg_${String(roomIndex * segueCount + index).padStart(4, '0')}`);
    for (let index = 0; index < segueCount; index += 1) {
      trackRows.push(makeTrack(segueTrackIds[index], `Room ${roomIndex + 1} segue candidate ${index + 1}`));
    }
    loungeRows.push({
      loungeId,
      inviteCode,
      hostUserId: users[0].id,
      vibeProfile: `Local multi-room acceptance room ${roomIndex + 1}`,
      queue: [currentTrackId, firstSegueTrackId, ...segueTrackIds],
      currentTrackId,
      status: 'live',
      participantIds: users.map((user) => user.id),
      createdAt: now,
      startedAt: now,
      analyticsTrackingVersion: 1,
      sessionEventSeq: 0,
      settings: { maxParticipants: clientsPerRoom, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
    });
    const room = {
      loungeId, inviteCode, clients: [], byKey: new Map(), host: null, writer: null, writers: [], listeners: [],
      processes, foreignEvents: 0,
    };
    for (const [ordinal, user] of users.entries()) {
      const instance = ordinal === 0 ? 0 : ordinal === 1 ? 1 : ordinal % 2;
      const entry = {
        key: `${loungeId}:${user.id}`,
        loungeId,
        localAddress: `127.0.0.${roomIndex + 1}`,
        userId: String(user.id),
        role: user.role,
        instance,
        token: makeToken(user.id),
        browserRefreshToken: refreshTokens[ordinal],
        socket: null,
        pendingTraces: new Map(),
        pendingChat: new Map(),
        endedEvents: [],
        foreignLoungeEvents: 0,
        appliedQueueIds: new Set(),
        renderedQueueIds: new Set([currentTrackId, firstSegueTrackId]),
      };
      room.clients.push(entry);
      room.byKey.set(entry.key, entry);
      if (ordinal === 0) room.host = entry;
      if (['Host', 'Co-DJ'].includes(user.role)) {
        room.writers.push(entry);
        if (ordinal === 1) room.writer = entry;
      } else room.listeners.push(entry);
    }
    rooms.push(room);
  }
  await Promise.all([User.init(), RefreshToken.init(), Track.init(), DJLounge.init(), QueueEvent.init(), ChatMessage.init()]);
  await User.create(userRows);
  await RefreshToken.create(refreshTokenRows);
  await Track.create(trackRows);
  await DJLounge.create(loungeRows);
  return rooms;
}

async function connectBrowserClient(entry, room, browser, frontend) {
  const frontendOrigin = frontend.origin;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  entry.browserContext = context;
  entry.page = await context.newPage();
  entry.kind = 'browser';
  entry.pendingCommandAcks = new Map();
  await context.addCookies([{
    name: 'astradj_refresh',
    value: entry.browserRefreshToken,
    domain: new URL(frontendOrigin).hostname,
    path: '/api/v1/auth',
    httpOnly: true,
    sameSite: 'Strict',
  }]);
  await entry.page.exposeFunction('__astraQueueEventReceived', (payload) => recordBrowserQueueReceipt(entry, payload));
  await entry.page.exposeFunction('__astraQueueReceiptAck', (payload) => recordBrowserQueueReceiptAck(entry, payload));
  await entry.page.exposeFunction('__astraQueueStateApplied', (payload) => recordBrowserQueueStateApplied(entry, payload));
  await entry.page.exposeFunction('__astraQueueRender', (payload) => recordBrowserQueueRender(entry, payload));
  await entry.page.exposeFunction('__astraQueueCommandAck', ({ traceId, ack }) => {
    entry.pendingCommandAcks.get(traceId)?.(ack);
  });
  await entry.page.addInitScript(() => {
    window.__ASTRA_LONG_TASKS__ = [];
    if ('PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        window.__ASTRA_LONG_TASKS__.push(...list.getEntries().map((entry) => ({
          startTimeMs: entry.startTime,
          durationMs: entry.duration,
        })));
      });
      observer.observe({ type: 'longtask', buffered: true });
    }
    window.__ASTRA_QUEUE_EVENT_RECEIVED__ = (payload) => window.__astraQueueEventReceived(payload);
    window.__ASTRA_QUEUE_RECEIPT_ACK__ = (payload) => window.__astraQueueReceiptAck(payload);
    window.__ASTRA_QUEUE_STATE_APPLIED__ = (payload) => window.__astraQueueStateApplied(payload);
    window.__ASTRA_QUEUE_RENDER__ = (payload) => window.__astraQueueRender(payload);
    window.__ASTRA_QUEUE_COMMAND_ACK__ = (payload) => window.__astraQueueCommandAck(payload);
  });
  entry.page.on('console', (message) => { if (message.type() === 'error') entry.browserError = message.text(); });
  entry.page.on('pageerror', (error) => { entry.browserError = error.message; });
  entry.apiResponses = [];
  entry.apiRequests = [];
  entry.page.on('request', (request) => {
    if (/\/api\/v1\/auth\/(refresh|me)$/.test(request.url())) entry.apiRequests.push(request.url());
  });
  entry.page.on('requestfailed', (request) => {
    if (/\/api\/v1\/auth\/(refresh|me)$/.test(request.url())) entry.browserError = `${request.url()} ${request.failure()?.errorText}`;
  });
  entry.page.on('response', async (response) => {
    if (/\/api\/v1\/auth\/(refresh|me)$/.test(response.url())) {
      const record = { url: response.url(), status: response.status(), body: '' };
      entry.apiResponses.push(record);
      record.body = (await response.text().catch(() => '')).slice(0, 500);
    }
  });
  try {
    await entry.page.goto(`${frontendOrigin}/queue`, { waitUntil: 'commit', timeout: 60000 });
  } catch (error) {
    throw new Error(`${error.message}\nVite output:\n${frontend.recentOutput?.() ?? ''}`);
  }
  try {
    await entry.page.getByRole('textbox', { name: 'Lounge invite code' }).waitFor({ state: 'visible', timeout: 30000 });
    await entry.page.getByRole('textbox', { name: 'Lounge invite code' }).fill(room.inviteCode);
    await entry.page.getByRole('button', { name: /^(Join Lounge|Reconnect)$/ }).click();
  } catch (error) {
    const body = await entry.page.locator('body').innerText().catch(() => '[no body text]');
    const cookies = await context.cookies(`${frontendOrigin}/api/v1/auth/refresh`);
    throw new Error(`${error.message}\nBrowser page error: ${entry.browserError ?? 'none'}\nAuth requests: ${JSON.stringify(entry.apiRequests)}\nAuth responses: ${JSON.stringify(entry.apiResponses)}\nRefresh cookie present: ${cookies.some((cookie) => cookie.name === 'astradj_refresh')}\nBody: ${body}\nVite output:\n${frontend.recentOutput?.() ?? ''}`);
  }
  await entry.page.locator('.lounge-add').waitFor({ state: 'visible', timeout: 30000 });
  const initialQueueIds = await entry.page.locator('.queue-page').evaluate((page) => [
    page.querySelector('.queue-current')?.getAttribute('data-track-id'),
    ...[...page.querySelectorAll('.queue-item')].map((item) => item.getAttribute('data-track-id')),
  ].filter(Boolean));
  entry.appliedQueueIds = new Set(initialQueueIds);
  entry.renderedQueueIds = new Set(initialQueueIds);
  entry.browserVisibilityState = await entry.page.evaluate(() => document.visibilityState);
}

async function connectAndJoin(rooms, clients, browser, frontend) {
  for (const [roomIndex, room] of rooms.entries()) {
    if (roomIndex === browserRoomIndex && browserClientsRequested > 0) {
      room.browserMeasured = true;
      const browserEntries = room.clients.slice(0, browserClientsRequested);
      for (const entry of browserEntries) {
        await connectBrowserClient(entry, room, browser, frontend);
      }
      for (const entry of room.clients) {
        if (entry.kind !== 'browser') entry.instance = browserRoomIndex;
      }
    }
    const entries = room.clients.filter((entry) => entry.kind !== 'browser');
    for (const entry of entries) entry.room = room;
    for (const entry of entries) {
      const socket = connectClient(entry, room.processes);
      clients.push(socket);
    }
    await Promise.all(entries.map(async (entry) => {
      await waitForConnect(entry.socket);
      const result = await socketCommand(entry.socket, 'lounge.join', { inviteCode: room.inviteCode });
      if (!result.response?.ok) throw new Error(`Join failed for ${entry.key}: ${result.response?.error?.code ?? 'UNKNOWN_ERROR'}`);
      const initial = [
        ...(result.response.state?.nowPlaying?.trackId ? [result.response.state.nowPlaying.trackId] : []),
        ...(result.response.state?.nextUp ?? []).map((track) => track.trackId),
      ];
      entry.appliedQueueIds = new Set(initial);
      entry.renderedQueueIds = new Set(initial);
    }));
  }
}

async function main() {
  assertSafeMongoUri(sourceMongoUri);
  const { uri: mongoUri, databaseName } = createIsolatedMongoTestDatabase(sourceMongoUri, 'multiroombench');
  const startedAt = new Date();
  const startedMono = performance.now();
  let connected = false;
  let processes = [];
  let clients = [];
  let frontend;
  let browser;
  let report;
  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    const build = await mongoose.connection.db.admin().command({ buildInfo: 1 });
    const [apiPortA, apiPortB, frontendPort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
    const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
    processes.push(await startApiProcess(apiPortA, mongoUri, frontendOrigin));
    processes.push(await startApiProcess(apiPortB, mongoUri, frontendOrigin));
    frontend = await startFrontendProcess(frontendPort, processes[0].origin);
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const rooms = await createFixtures(processes);
    await connectAndJoin(rooms, clients, browser, frontend);
    const workload = await runQueueMutations(rooms);
    const reconciliation = await verifyRoomIsolation(rooms, workload.measurements);
    const chatAndReconnect = await runChatAndReconnect(rooms, clients);
    const segue = await runSegueSamples(rooms, segueSamplesRequested);
    const lifecycle = await runLifecycle(rooms);
    const processDiagnostics = await Promise.all(processes.map(requestAcceptanceDiagnostics));
    const browserDiagnostics = await Promise.all(browserRoomClients(rooms[browserRoomIndex]).map(async (entry) => ({
      clientKey: entry.key,
      visibilityState: entry.browserVisibilityState,
      browserError: entry.browserError ?? null,
      rendering: await entry.page.evaluate(() => ({
        longTasks: window.__ASTRA_LONG_TASKS__ ?? [],
        memory: performance.memory ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
        } : null,
      })),
    })));
    const queueMetrics = workload.measurements;
    const browserQueueMetrics = queueMetrics.filter((row) => row.loungeId === rooms[browserRoomIndex].loungeId);
    const browserDomMissing = browserQueueMetrics.reduce((sum, row) => sum + row.missingDomRenderings, 0);
    const browserDomMismatches = browserQueueMetrics.reduce((sum, row) => sum + row.browserDomMismatches, 0);
    const browserReceiptMissing = browserQueueMetrics.reduce((sum, row) => sum + row.missingClientReceipts, 0);
    const browserSync = metricReport(browserQueueMetrics, 'serverReceiptToAllClientRenderAckUpperBoundMs');
    const browserSubsetSync = metricReport(browserQueueMetrics, 'serverReceiptToLastBrowserRenderAckUpperBoundMs');
    const browserAccepted = browserQueueMetrics.filter((row) => row.accepted).length;
    const browserCompleted = browserQueueMetrics.filter((row) => row.queueDriftComplete).length;
    const browserSubsetCompleted = browserQueueMetrics.filter((row) => row.browserSubsetRenderComplete).length;
    const fullQueueTargetMetrics = {
      queueStateSyncDrift: browserSync,
      browserDomRenderSpread: metricReport(browserQueueMetrics, 'browserDomRenderSpreadMs'),
      serverProcessing: metricReport(queueMetrics, 'serverProcessingMs'),
      serverReceiptToLastClientDelivery: metricReport(queueMetrics, 'serverReceiptToLastClientDeliveryAckUpperBoundMs'),
      serverReceiptToLastBrowserRenderAckUpperBound: browserSubsetSync,
      serverReceiptToAllClientRenderAckUpperBound: browserSync,
      ackRoundTrip: metricReport(queueMetrics, 'ackRoundTripMs'),
      clientStateApplication: mergeSummaries(queueMetrics.flatMap((row) => row.allEventRecords.map((record) =>
        Number.isFinite(record.applyLatencyMs) ? record.applyLatencyMs : record.applyMonoMs - record.receiveMonoMs))),
      simulatedRenderCallback: mergeSummaries(queueMetrics.flatMap((row) => row.allEventRecords.filter((record) => Number.isFinite(record.renderMonoMs)).map((record) => record.renderMonoMs - record.receiveMonoMs))),
      browserStateApplication: mergeSummaries(browserQueueMetrics.flatMap((row) => row.allEventRecords.map((record) => record.applyLatencyMs).filter(Number.isFinite))),
      browserDomRenderAfterReceipt: mergeSummaries(browserQueueMetrics.flatMap((row) => row.allEventRecords.map((record) => record.renderLatencyMs).filter(Number.isFinite))),
      browserMutationsRequested: mutationSamplesPerRoom,
      browserMutationsAccepted: browserAccepted,
      browserMutationsRejected: browserQueueMetrics.filter((row) => row.rejected).length,
      browserMutationsTimedOut: browserQueueMetrics.filter((row) => row.timedOut).length,
      browserMutationsLate: browserQueueMetrics.filter((row) => row.late).length,
      browserMutationsCompleted: browserCompleted,
      browserMutationsIncomplete: browserQueueMetrics.length - browserCompleted,
      browserSubsetMutationsRendered: browserSubsetCompleted,
      browserExpectedClientRenders: browserQueueMetrics.reduce((sum, row) => sum + browserRoomClients(rooms[browserRoomIndex]).length, 0),
      browserMissingClientReceipts: browserReceiptMissing,
      browserMissingDomRenders: browserDomMissing,
      browserDomMismatches,
      expectedRecipientEvents: queueMetrics.reduce((sum, row) => sum + row.expectedClientReceipts, 0),
      receivedRecipientEvents: queueMetrics.reduce((sum, row) => sum + row.clientReceipts, 0),
      missingRecipientEvents: queueMetrics.reduce((sum, row) => sum + row.missingClientReceipts, 0),
      duplicateRecipientEvents: queueMetrics.reduce((sum, row) => sum + row.duplicateClientEvents, 0),
      queueStateDivergence: queueMetrics.reduce((sum, row) => sum + row.queueStateDivergence, 0),
      skippedRevisionClients: queueMetrics.reduce((sum, row) => sum + row.skippedRevisionClients, 0),
      invalidRenderAcknowledgements: queueMetrics.reduce((sum, row) => sum + row.invalidRenderAcknowledgements, 0),
      serverProcessingFailures: queueMetrics.filter((row) => !row.accepted).length,
    };
    const segueDecision = summarize(segue.map((sample) => sample.triggerToLastRemoteAnnouncementMs).filter(Number.isFinite));
    const acceptanceEvaluation = {
      queueSyncDrift: {
        targetP95Ms: 100,
        measuredP95Ms: fullQueueTargetMetrics.queueStateSyncDrift.p95Ms,
        attemptedSamples: browserQueueMetrics.length,
        acceptedSamples: browserAccepted,
        completedSamples: browserCompleted,
        incompleteSamples: browserQueueMetrics.length - browserCompleted,
        status: clientsPerRoom !== 50 || browserRoomClients(rooms[browserRoomIndex]).length !== 50
          ? 'NOT_RUN_AT_TARGET_CAPACITY'
          : browserQueueMetrics.length !== mutationSamplesPerRoom
          || browserAccepted !== mutationSamplesPerRoom
          || browserCompleted !== mutationSamplesPerRoom
          || browserReceiptMissing > 0
          || browserDomMissing > 0 || browserDomMismatches > 0
          ? 'FAIL_INCOMPLETE_OR_DIVERGENT_BROWSER_RENDER'
          : fullQueueTargetMetrics.queueStateSyncDrift.p95Ms !== null && fullQueueTargetMetrics.queueStateSyncDrift.p95Ms < 100
            ? 'PASS_LOCAL_BROWSER_ONLY' : 'FAIL_LOCAL_BROWSER',
        boundary: 'Upper bound from queue command receipt to the server receiving the last valid browser render acknowledgement. Each acknowledgement follows React state application and two requestAnimationFrame callbacks and contains the rendered DOM revision, canonical track IDs, and SHA-256 state hash. Includes acknowledgement return latency; this is conservative, not the exact client render instant.',
      },
      webSocketFanout: {
        targetP95Ms: 500,
        measuredP95Ms: fullQueueTargetMetrics.serverReceiptToLastClientDelivery.p95Ms,
        attemptedSamples: browserQueueMetrics.length,
        acceptedSamples: browserAccepted,
        completedSamples: browserQueueMetrics.filter((row) => Number.isFinite(row.serverReceiptToLastClientDeliveryAckUpperBoundMs)).length,
        status: fullQueueTargetMetrics.serverReceiptToLastClientDelivery.samples !== browserAccepted
          ? 'UNVERIFIED_INCOMPLETE_RECEIPT_ACKS'
          : fullQueueTargetMetrics.serverReceiptToLastClientDelivery.p95Ms !== null && fullQueueTargetMetrics.serverReceiptToLastClientDelivery.p95Ms < 500
            ? 'PASS_LOCAL_ONLY' : 'FAIL_LOCAL',
        boundary: 'Upper bound from server command receipt to the last of all participant Socket.IO receipt acknowledgements observed by that same API process monotonic clock. Includes acknowledgement return latency. Cross-process events without a comparable origin clock are excluded and counted as incomplete.',
      },
      roomCapacity: {
        targetClientsPerRoom: 50,
        measuredClientsPerRoom: clientsPerRoom,
        status: clientsPerRoom === 50 ? 'EXERCISED_LOCAL_ONLY' : 'NOT_RUN_AT_TARGET_CAPACITY',
      },
      concurrentRooms: {
        measuredRoomCount: rooms.length,
        status: rooms.length >= 3 ? 'EXERCISED_LOCAL_ONLY' : 'LIMITED_LOCAL_EXERCISE',
      },
      aiDjSegue: {
        targetP95Ms: 3000,
        measuredSocketServiceProxyP95Ms: segueDecision.p95Ms,
        status: 'UNVERIFIED_TRUE_OUTRO_TO_RENDER_BOUNDARY',
      },
      deploymentRepresentative: false,
    };
    report = {
      benchmark: 'AstraDJ local multi-room Lounge acceptance and performance',
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      durationMs: Number((performance.now() - startedMono).toFixed(3)),
      database: {
        topology: topology.setName ? 'replicaSet' : topology.msg === 'isdbgrid' ? 'mongos' : 'standalone',
        version: build.version,
        hostScope: 'loopback only',
        isolatedDatabase: databaseName,
        isolatedDatabaseDroppedAfterReport: true,
      },
      runtime: {
        node: process.version,
        browserEngine: 'Chromium via installed Chrome channel',
        browserVersion: browser.version(),
        browserPageVisibilityStates: Object.fromEntries([...new Set(browserRoomClients(rooms[browserRoomIndex]).map((client) => client.browserVisibilityState))]
          .map((state) => [state, browserRoomClients(rooms[browserRoomIndex]).filter((client) => client.browserVisibilityState === state).length])),
        frontendMode: 'Vite development server; real production bundles and deployment infrastructure are not used.',
        platform: `${process.platform}-${process.arch}`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: os.cpus().length,
        apiProcessCount: processes.length,
        apiProcessStartupMs: processes.map((processInfo) => processInfo.startupMs),
        roomCount: rooms.length,
        clientsPerRoom,
        browserClientsRequestedPerRoom: browserClientsRequested,
        acknowledgementTimeoutMs,
        totalSocketConnections: clients.length + rooms.reduce((sum, room) => sum + browserRoomClients(room).length, 0),
        browserQueueClientCount: browserRoomClients(rooms[browserRoomIndex]).length,
        loopbackSourceAddressesPerRoom: rooms.map((room) => room.clients[0]?.localAddress),
        clientConnectionsPerRoomByProcess: rooms.map((room) => roomSummary(room, []).clientConnectionsByProcess),
      },
      methodology: {
        queueWorkload: `${rooms.length} rooms concurrently; ${clientsPerRoom} authenticated participants per room; ${mutationRatePerRoomHz} queue additions per second per room for ${durationSeconds} seconds; operations start at configured intervals and are flushed before report. Room ${rooms[browserRoomIndex].loungeId} uses ${browserRoomClients(rooms[browserRoomIndex]).length} real Chromium/React clients; other rooms use authenticated Socket.IO clients.`,
        warmup: 'No synthetic mutation warm-up is included; join and schema index initialization occur before measurement.',
        trace: 'Each queue attempt carries a UUID through the authenticated command, durable QueueEvent/outbox, queue broadcast, browser Socket.IO receipt, React queue-state application, two-requestAnimationFrame DOM marker, and server-received render acknowledgement. The marker reports the rendered revision, ordered track IDs, and canonical SHA-256 queue-state hash.',
        queueDriftDefinition: `For each accepted mutation, the conservative bound starts at queue-command receipt and ends when the same API process receives a valid render acknowledgement from every connected client in the measured room. Each acknowledgement follows the browser DOM marker and verifies identical broadcast revision, ordered queue IDs, and canonical state hash. The bound includes acknowledgement return latency and is not the exact client render instant. The target metric is the nearest-rank P95 of complete per-mutation bounds; every attempt, including incomplete samples, is counted separately and any incomplete sample prevents acceptance.`,
        clockMethod: 'Command receipt, database commit, broadcast, receipt acknowledgement, and render acknowledgement durations use performance.now() on the same API process. No server/browser or cross-process monotonic timestamps are subtracted. Browser receive-to-state-application and receive-to-render durations use performance.now() within the same page. Cross-process acknowledgement elapsed values are null unless the event originated on that API process; wall-clock stamps are informational only and never used for latency calculations.',
        rateLimitHandling: 'The benchmark uses a unique disposable database. To collect more than five segue samples per room despite the production limit of 10 playback actions/user/minute, the benchmark clears only the disposable database rate-limit counters before segue sample 16. Rate-limit throughput is not measured by this workload.',
        clientApplyAndRender: 'Browser receipt, React state application, and actual DOM completion are distinct measures. DOM completion follows a React commit and two requestAnimationFrame callbacks. Socket.IO-only clients record receipt and setImmediate state/render proxies for diagnostics only and are excluded from browser-render acceptance.',
        percentileMethod: 'Nearest-rank p50/p95/p99: sorted sample at ceil(p*n), 1-based. The queue P95 population consists only of complete, hash-valid all-client render acknowledgement upper bounds; attempted, accepted, rejected, late, complete, and incomplete counts are reported alongside it.',
        chatAndReconnect: 'One unique persisted chat message per room delivered to every currently joined socket; disconnect a listener, send a second message, reconnect/join, and verify authoritative queue snapshot plus history recovery.',
        clientSourceAddresses: `Each room uses a distinct loopback source address (127.0.0.1 onward) so its ${clientsPerRoom} initial sockets remain below the shared per-IP connection-attempt limit; this does not model a single-NAT multi-room burst.`,
        lifecycle: 'Host end command, durable ended status, and end notification count observed in the Socket.IO rooms; lifecycle and chat/reconnect checks are reported as skipped for the browser-measured room.',
        browserAuth: 'Each browser client uses an isolated context and a refresh-token cookie seeded only in the disposable Mongo database; the application restores a distinct real user session and Socket.IO authenticates normally. Contexts are opened sequentially to avoid startup bursts; all pages share one local Chromium process. Browser pages connect through Vite to the first API process; both API instances share the same Mongo database.',
        syntheticDataOnly: true,
      },
      prdTargets: {
        queueSyncDriftMs: 100,
        webSocketFanoutFromServerReceiptMs: 500,
        designParticipantsPerRoom: 50,
        concurrentRoomDescription: 'handful; local acceptance uses the configured room count',
        aiDjSegueP95Ms: 3000,
      },
      queueAcceptance: fullQueueTargetMetrics,
      acceptanceEvaluation,
      queuePerRoom: rooms.map((room) => roomSummary(room, queueMetrics)),
      diagnostics: {
        serverProcesses: processDiagnostics,
        browserClients: browserDiagnostics,
        limitations: 'CPU and event-loop telemetry is per API process; browser long-task entries are per page. This localhost benchmark does not establish production topology, network conditions, or production MongoDB contention.',
      },
      queueMutations: {
        requestedPerRoom: mutationSamplesPerRoom,
        requestedRatePerRoomHz: mutationRatePerRoomHz,
        requestedDurationSeconds: durationSeconds,
        measuredWorkloadElapsedMs: workload.workloadElapsedMs,
        perMutationMeasurements: queueMetrics.map(({ clientRecordByKey, ...row }) => row),
      },
      chatAndReconnect,
      segue: {
        samplesRequested: segueSamplesRequested,
        successfulSamples: segue.filter((sample) => sample.ok).length,
        triggerToRemoteAnnouncement: segueDecision,
        triggerAckRoundTrip: summarize(segue.map((sample) => sample.triggerAckRoundTripMs).filter(Number.isFinite)),
        notificationFailures: segue.filter((sample) => !sample.ok).length,
        samples: segue,
        disposition: 'Service/socket proxy only; no real media clock or browser render measurement. P95 target remains unverified even if the proxy is below 3000 ms.',
      },
      lifecycle,
      durableReconciliation: reconciliation,
      prdDisposition: {
        queueSyncDrift: `Local browser DOM render-ack upper bound for ${browserRoomClients(rooms[browserRoomIndex]).length} browser pages in one room; all-client render drift is incomplete if any Socket.IO-only participant remains in that room. Not production-representative.`,
        webSocketFanout: 'Server-observed command receipt-to-client receipt acknowledgement on one API process monotonic clock; cross-process samples are not compared. Production network fan-out remains unverified.',
        roomCapacity: clientsPerRoom === 50 ? 'Exercised at PRD design capacity in each local room; not production capacity proof.' : 'Not run at the PRD 50-user design capacity.',
        multipleRooms: `${rooms.length} rooms exercised concurrently across two app processes against one local MongoDB instance.`,
        segue: 'Measured separately from queue event fan-out and remains unverified at the true outro-entry-to-browser-rendered boundary.',
      },
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ reportPath, report }, null, 2));
  } finally {
    for (const socket of clients) socket.disconnect();
    if (browser) await browser.close();
    await stopApiProcess(frontend);
    await Promise.all(processes.map(stopApiProcess));
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
