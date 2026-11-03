import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const MAX_SAMPLES = 600;
const MAX_MONGO_BUCKETS = 64;
const MAX_MONGO_LATENCIES = 1_000;

function mongoCommandLabel(event) {
  const command = event.command ?? {};
  const collection = command.find ?? command.aggregate ?? command.insert ?? command.update
    ?? command.delete ?? command.findAndModify ?? command.count ?? command.distinct;
  return `${event.commandName}:${typeof collection === 'string' ? collection : 'other'}`;
}

function percentile(samples, fraction) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3));
}

export function startAcceptanceDiagnostics(connection) {
  if (process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE !== 'true' || typeof process.send !== 'function') {
    return null;
  }

  const delayMonitor = monitorEventLoopDelay({ resolution: 10 });
  delayMonitor.enable();
  const startedAt = performance.now();
  let previousAt = startedAt;
  let previousCpu = process.cpuUsage();
  let previousUtilization = performance.eventLoopUtilization();
  const samples = [];
  const pendingMongoCommands = new Map();
  const mongoBuckets = new Map();

  const recordMongoCommand = (event, failed) => {
    const started = pendingMongoCommands.get(event.requestId);
    if (started === undefined) return;
    pendingMongoCommands.delete(event.requestId);
    const label = started.label;
    let bucket = mongoBuckets.get(label);
    if (!bucket) {
      if (mongoBuckets.size >= MAX_MONGO_BUCKETS) return;
      bucket = { operations: 0, failures: 0, durationsMs: [] };
      mongoBuckets.set(label, bucket);
    }
    bucket.operations += 1;
    if (failed) bucket.failures += 1;
    if (bucket.durationsMs.length < MAX_MONGO_LATENCIES) {
      bucket.durationsMs.push(Number((performance.now() - started.at).toFixed(3)));
    }
  };

  const client = connection.getClient();
  client.on('commandStarted', (event) => {
    if (pendingMongoCommands.size >= 2_000) {
      pendingMongoCommands.delete(pendingMongoCommands.keys().next().value);
    }
    pendingMongoCommands.set(event.requestId, { at: performance.now(), label: mongoCommandLabel(event) });
  });
  client.on('commandSucceeded', (event) => recordMongoCommand(event, false));
  client.on('commandFailed', (event) => recordMongoCommand(event, true));

  const sample = () => {
    const now = performance.now();
    const elapsedMs = Math.max(0.001, now - previousAt);
    const cpu = process.cpuUsage(previousCpu);
    const utilization = performance.eventLoopUtilization(previousUtilization);
    const memory = process.memoryUsage();
    samples.push({
      atElapsedMs: Number((now - startedAt).toFixed(3)),
      intervalMs: Number(elapsedMs.toFixed(3)),
      cpuUserMs: Number((cpu.user / 1_000).toFixed(3)),
      cpuSystemMs: Number((cpu.system / 1_000).toFixed(3)),
      cpuPercentOfOneCore: Number((((cpu.user + cpu.system) / 1_000) / elapsedMs * 100).toFixed(2)),
      eventLoopUtilization: Number(utilization.utilization.toFixed(4)),
      eventLoopActiveMs: Number(utilization.active.toFixed(3)),
      eventLoopIdleMs: Number(utilization.idle.toFixed(3)),
      eventLoopDelayP50Ms: Number((delayMonitor.percentile(50) / 1e6).toFixed(3)),
      eventLoopDelayP95Ms: Number((delayMonitor.percentile(95) / 1e6).toFixed(3)),
      eventLoopDelayP99Ms: Number((delayMonitor.percentile(99) / 1e6).toFixed(3)),
      eventLoopDelayMaxMs: Number((delayMonitor.max / 1e6).toFixed(3)),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    });
    if (samples.length > MAX_SAMPLES) samples.shift();
    previousAt = now;
    previousCpu = process.cpuUsage();
    previousUtilization = performance.eventLoopUtilization();
    delayMonitor.reset();
  };

  const timer = setInterval(sample, 1_000);
  timer.unref?.();

  const snapshot = () => {
    sample();
    const mongoOperations = Object.fromEntries([...mongoBuckets.entries()].map(([label, bucket]) => [
      label,
      {
        operations: bucket.operations,
        failures: bucket.failures,
        latencyMs: {
          samples: bucket.durationsMs.length,
          p50: percentile(bucket.durationsMs, 0.5),
          p95: percentile(bucket.durationsMs, 0.95),
          p99: percentile(bucket.durationsMs, 0.99),
          max: bucket.durationsMs.length ? Number(Math.max(...bucket.durationsMs).toFixed(3)) : null,
        },
      },
    ]));
    return {
      processId: process.pid,
      processStartedAt: new Date(Date.now() - performance.now()).toISOString(),
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      sampleIntervalMs: 1_000,
      retainedSampleLimit: MAX_SAMPLES,
      samples: [...samples],
      mongoCommandMonitoring: 'driver command-started/succeeded/failed; aggregate by command and collection; durations use this process monotonic clock',
      mongoOperations,
      unmatchedMongoCommands: pendingMongoCommands.size,
    };
  };

  const onMessage = (message) => {
    if (message?.type !== 'acceptance-diagnostics-snapshot' || typeof message.requestId !== 'string') return;
    process.send?.({
      type: 'acceptance-diagnostics-snapshot',
      requestId: message.requestId,
      report: snapshot(),
    });
  };
  process.on('message', onMessage);

  return {
    snapshot,
    close() {
      clearInterval(timer);
      process.off('message', onMessage);
      delayMonitor.disable();
    },
  };
}
