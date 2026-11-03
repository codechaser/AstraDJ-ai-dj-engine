import { randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';

const safeName = (value) => value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');

function redactText(value, secrets) {
  let result = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) result = result.split(secret).join('[redacted]');
  }
  return result
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, '[redacted Mongo URI]')
    .replace(/\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted token]')
    .slice(0, 500);
}

function redactObject(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactObject(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item, secrets)]));
}

export function classifyBenchmarkFailure(error) {
  if (error?.timedOut === true || error?.code === 'ACK_TIMEOUT' || error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timed_out';
  if (/timed?\s*out|timeout/i.test(String(error?.message ?? ''))) return 'timed_out';
  return 'failed';
}

export function summarizeBenchmarkError(error, secrets = []) {
  return {
    name: redactText(error?.name ?? 'Error', secrets),
    code: error?.code ? redactText(error.code, secrets) : null,
    message: redactText(error?.message ?? error, secrets),
    ...(error?.diagnostics ? { diagnostics: redactObject(error.diagnostics, secrets) } : {}),
  };
}

async function createJsonAtomicallyWithoutOverwrite(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A hard link atomically publishes a fully written file and fails if a
    // prior run already owns the destination. Both paths are in one directory.
    await link(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

export async function createRuntimeBenchmarkJournal({
  baseDirectory,
  runId,
  manifest,
  plannedStages,
  secrets = [],
  wallNow = () => new Date(),
  monotonicNow = () => Number(process.hrtime.bigint()) / 1e6,
}) {
  if (typeof runId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(runId)) throw new Error('Runtime benchmark run ID is invalid');
  if (!Array.isArray(plannedStages) || plannedStages.length === 0 || new Set(plannedStages).size !== plannedStages.length) {
    throw new Error('Runtime benchmark stage plan must contain unique stage names');
  }

  await mkdir(baseDirectory, { recursive: true });
  const runDirectory = path.join(baseDirectory, runId);
  await mkdir(runDirectory, { recursive: false });
  const stageDirectory = path.join(runDirectory, 'stages');
  await mkdir(stageDirectory, { recursive: false });

  const state = {
    schemaVersion: 1,
    runId,
    status: 'running',
    createdAt: wallNow().toISOString(),
    manifest,
    stagePlan: plannedStages.map((name) => ({ name, status: 'pending' })),
    stages: [],
    measurements: {},
  };
  const manifestPath = path.join(runDirectory, `manifest-${runId}.json`);
  await createJsonAtomicallyWithoutOverwrite(manifestPath, state);

  let snapshotSequence = 0;
  const writeSnapshot = async (reason) => {
    snapshotSequence += 1;
    const snapshotPath = path.join(runDirectory, `snapshot-${String(snapshotSequence).padStart(3, '0')}-${safeName(reason) || 'update'}-${runId}.json`);
    await createJsonAtomicallyWithoutOverwrite(snapshotPath, { ...state, snapshotReason: reason, snapshotAt: wallNow().toISOString() });
    return snapshotPath;
  };
  const stagePath = (index, name, status) => path.join(stageDirectory, `${String(index + 1).padStart(2, '0')}-${safeName(name)}-${status}-${runId}.json`);
  const stageRecord = (name) => {
    const record = state.stages.find((item) => item.name === name);
    if (!record) throw new Error(`Runtime benchmark stage was not started: ${name}`);
    return record;
  };
  const planRecord = (name) => {
    const record = state.stagePlan.find((item) => item.name === name);
    if (!record) throw new Error(`Runtime benchmark stage is not in the plan: ${name}`);
    return record;
  };

  return {
    runDirectory,
    manifestPath,
    get state() { return state; },
    async beginStage(name) {
      const planIndex = state.stagePlan.findIndex((item) => item.name === name);
      const plan = planRecord(name);
      if (plan.status !== 'pending') throw new Error(`Runtime benchmark stage cannot start from ${plan.status}: ${name}`);
      plan.status = 'running';
      const record = { name, status: 'running', startedAt: wallNow().toISOString() };
      state.stages.push(record);
      record.startedMonotonicMs = monotonicNow();
      await createJsonAtomicallyWithoutOverwrite(stagePath(planIndex, name, 'started'), { runId, ...record });
      await writeSnapshot(`${name}-started`);
    },
    async completeStage(name, result) {
      const record = stageRecord(name);
      if (record.status !== 'running') throw new Error(`Runtime benchmark stage is not running: ${name}`);
      const planIndex = state.stagePlan.findIndex((item) => item.name === name);
      const plan = planRecord(name);
      const endedAt = wallNow();
      record.status = 'completed';
      record.endedAt = endedAt.toISOString();
      record.durationMs = Number(Math.max(0, monotonicNow() - record.startedMonotonicMs).toFixed(3));
      delete record.startedMonotonicMs;
      record.result = result;
      plan.status = 'completed';
      state.measurements[name] = result;
      await createJsonAtomicallyWithoutOverwrite(stagePath(planIndex, name, 'completed'), { runId, ...record });
      await writeSnapshot(`${name}-completed`);
    },
    async failStage(name, error) {
      const record = stageRecord(name);
      if (record.status !== 'running') throw new Error(`Runtime benchmark stage is not running: ${name}`);
      const planIndex = state.stagePlan.findIndex((item) => item.name === name);
      const plan = planRecord(name);
      const endedAt = wallNow();
      record.status = classifyBenchmarkFailure(error);
      record.endedAt = endedAt.toISOString();
      record.durationMs = Number(Math.max(0, monotonicNow() - record.startedMonotonicMs).toFixed(3));
      delete record.startedMonotonicMs;
      record.error = summarizeBenchmarkError(error, secrets);
      plan.status = record.status;
      state.failures = [...(state.failures ?? []), { stage: name, ...record.error }];
      await createJsonAtomicallyWithoutOverwrite(stagePath(planIndex, name, record.status), { runId, ...record });
      await writeSnapshot(`${name}-${record.status}`);
    },
    async skipPendingStages(reason, except = []) {
      for (let index = 0; index < state.stagePlan.length; index += 1) {
        const plan = state.stagePlan[index];
        if (plan.status !== 'pending' || except.includes(plan.name)) continue;
        plan.status = 'skipped';
        plan.reason = reason;
        const record = { name: plan.name, status: 'skipped', reason, endedAt: wallNow().toISOString() };
        state.stages.push(record);
        await createJsonAtomicallyWithoutOverwrite(stagePath(index, plan.name, 'skipped'), { runId, ...record });
      }
      await writeSnapshot('remaining-stages-skipped');
    },
    async finish({ cleanupStatus, finalData = {} } = {}) {
      const failed = state.stagePlan.some((item) => item.status === 'failed' || item.status === 'timed_out' || item.status === 'skipped');
      const cleanupFailed = cleanupStatus === 'failed' || state.stagePlan.find((item) => item.name === 'cleanup')?.status !== 'completed';
      const complete = !failed && !cleanupFailed;
      state.status = complete ? 'completed' : 'partial';
      state.completedAt = wallNow().toISOString();
      state.cleanupStatus = cleanupStatus ?? 'unknown';
      Object.assign(state, finalData);
      const reportPath = path.join(runDirectory, `report-${runId}-${complete ? 'complete' : 'partial'}.json`);
      await createJsonAtomicallyWithoutOverwrite(reportPath, state);
      return { reportPath, complete, report: state };
    },
  };
}
