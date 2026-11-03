import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { measureFiftyParticipantQueue } from './prdSocketQueueBenchmark.js';
import { rankSegueCandidates } from '../src/services/acousticMatcher.js';
import { bucketSentiment } from '../src/services/roomSentimentService.js';
import { sentimentLabeledDataset } from '../tests/fixtures/sentimentLabeledDataset.js';
import { sentimentHeldoutDataset } from '../tests/fixtures/sentimentHeldoutDataset.js';
import { baselineLexiconClassifier, evaluateClassifier, frozenCurrentSentimentClassifier } from './sentimentEvaluation.js';
import { sentimentDevelopmentDataset } from '../tests/fixtures/sentimentDevelopmentDataset.js';
import { sentimentIndependentHeldoutDataset } from '../tests/fixtures/sentimentIndependentHeldoutDataset.js';
import { runMultiProfileRecommendationEvaluation } from '../src/services/recommendationEvaluation.js';
import { createSegueService } from '../src/services/segueService.js';

const labels = ['positive', 'neutral', 'negative'];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const acousticTrack = (trackId, bpm, camelotKey, energy = 0.5, valence = 0.5) => ({
  trackId, title: trackId, artist: 'Benchmark fixture', durationSeconds: 120,
  acoustic: { bpm, camelotKey, energy, valence }, timeline: [{ ts: 10, type: 'trivia', text: 'Synthetic benchmark timeline fact.' }],
});

function evaluateAcousticDecisions() {
  const validKeys = ['12A', '11A', '1A', '12B'];
  let invalidSelections = 0;
  let weightErrors = 0;
  const decisions = 20;
  for (let index = 0; index < decisions; index += 1) {
    const current = acousticTrack(`current-${index}`, 120 + index % 6, '12A', 0.2 + (index % 5) * 0.15);
    const valid = acousticTrack(`valid-${index}`, current.acoustic.bpm * [1, 0.5, 2][index % 3], validKeys[index % validKeys.length], 0.1 + (index % 8) * 0.1);
    const ranked = rankSegueCandidates(current, [
      valid,
      acousticTrack(`bad-bpm-${index}`, 90, '12A'),
      acousticTrack(`bad-key-${index}`, current.acoustic.bpm, '9B'),
      acousticTrack(`missing-${index}`, current.acoustic.bpm, '13A'),
    ], { currentSentimentScore: (index % 11) / 10 });
    const selected = ranked.eligible[0];
    const incompatibleCandidateIds = [`bad-bpm-${index}`, `bad-key-${index}`, `missing-${index}`];
    const compatibleSelection = selected?.track.trackId === valid.trackId
      && selected.match.bpmDeltaPct <= 8
      && ['same', 'adjacent', 'relative'].includes(selected.match.camelotRelation)
      && incompatibleCandidateIds.every((trackId) => ranked.rejected.some((item) => item.track.trackId === trackId));
    if (!compatibleSelection) invalidSelections += 1;
    if (selected && Math.abs(selected.match.score - (0.5 * selected.match.harmonicCloseness + 0.3 * selected.match.energyFit + 0.2 * selected.match.recencyScore)) > 0.0001) weightErrors += 1;
  }
  return { decisions, invalidSelections, compliancePercent: (decisions - invalidSelections) / decisions * 100, weightErrors };
}

function evaluateSentiment() {
  const countByLabel = (dataset) => Object.fromEntries(labels.map((label) => [label, dataset.filter((entry) => entry.label === label).length]));
  const legacyBaseline = evaluateClassifier(sentimentLabeledDataset, baselineLexiconClassifier);
  const legacyCurrent = evaluateClassifier(sentimentLabeledDataset, bucketSentiment);
  const heldoutBaseline = evaluateClassifier(sentimentHeldoutDataset, baselineLexiconClassifier);
  const heldoutFinal = evaluateClassifier(sentimentHeldoutDataset, bucketSentiment);
  return {
    language: 'English and Hinglish transliteration',
    PRDTargetPercent: 85,
    legacyLexiconAwareDiagnostic: {
      datasetSize: sentimentLabeledDataset.length,
      classBalance: countByLabel(sentimentLabeledDataset),
      origin: 'synthetic and manually labeled after reviewing the original lexicon; diagnostic/regression fixture, not independent validation',
      originalBaseline: legacyBaseline,
      currentClassifier: legacyCurrent,
    },
    separatelyAuthoredEvaluation: {
      datasetSize: sentimentHeldoutDataset.length,
      classBalance: countByLabel(sentimentHeldoutDataset),
      origin: 'developer-authored synthetic English examples labeled before scoring; one-shot held-out evaluation, not real-user data',
      labelingGuide: 'docs/sentiment-evaluation.md',
      baselineBeforeRuleChanges: heldoutBaseline,
      frozenClassifier: heldoutFinal,
      meetsTarget: heldoutFinal.accuracy >= 0.85,
      limitation: 'Small synthetic evaluation set; accuracy does not establish production or real-user performance.',
    },
    independent2026Evaluation: {
      datasetSize: sentimentIndependentHeldoutDataset.length,
      classBalance: countByLabel(sentimentIndependentHeldoutDataset),
      fixtureSha256: createHash('sha256').update(readFileSync(new URL('../tests/fixtures/sentimentIndependentHeldoutDataset.js', import.meta.url))).digest('hex'),
      origin: 'developer-authored synthetic English/Hinglish examples, manually labeled before classifier changes; not real-user data',
      labelingGuide: 'docs/sentiment-evaluation.md',
      developmentSetSize: sentimentDevelopmentDataset.length,
      developmentBaseline: evaluateClassifier(sentimentDevelopmentDataset, frozenCurrentSentimentClassifier),
      developmentUpdated: evaluateClassifier(sentimentDevelopmentDataset, bucketSentiment),
      preChangeFrozenClassifier: evaluateClassifier(sentimentIndependentHeldoutDataset, frozenCurrentSentimentClassifier),
      updatedClassifier: evaluateClassifier(sentimentIndependentHeldoutDataset, bucketSentiment),
      meetsTarget: evaluateClassifier(sentimentIndependentHeldoutDataset, bucketSentiment).accuracy >= 0.85,
      limitation: 'One small synthetic one-author holdout; useful for regression discovery, not representative production accuracy evidence.',
    },
  };
}

class Query {
  constructor(value) { this.value = value; }
  select() { return this; }
  lean() { return Promise.resolve(this.value); }
}

async function measureSegueService(iterations = 250) {
  const current = acousticTrack('t_current', 124, '8A', 0.6, 0.6);
  const next = acousticTrack('t_next', 128, '9A', 0.62, 0.62);
  const lounge = { loungeId: 'lg_benchmark1234', status: 'live', currentTrackId: 't_current', participantIds: ['benchmark-user'], settings: { bpmTolerancePct: 8 } };
  const service = createSegueService({
    loungeModel: { findOne: () => new Query(lounge) },
    trackModel: {
      findOne: () => new Query(current),
      find: () => new Query([next]),
    },
    sentimentService: { snapshot: () => ({ rollingScore: 0.5, windowSeconds: 300, sampleSize: 0 }) },
  });
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    const response = await service.requestSegue({ loungeId: lounge.loungeId, userId: 'benchmark-user', input: { currentTrackId: current.trackId, currentTs: 100, candidateTrackIds: [next.trackId], currentSentimentScore: 0.5, recentTrackIds: [] } });
    durations.push(performance.now() - start);
    if (response.selectedTrackId !== next.trackId) throw new Error('Segue benchmark unexpectedly failed to select the eligible fixture track');
  }
  return { iterations, timing: 'in-process service wall time; fake repository; deterministic fallback; excludes MongoDB, socket transport and an outro scheduler', p50Ms: Number(percentile(durations, 0.5).toFixed(3)), p95Ms: Number(percentile(durations, 0.95).toFixed(3)), maxMs: Number(Math.max(...durations).toFixed(3)) };
}

const result = {
  benchmark: 'AstraDJ PRD acceptance microbenchmark',
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform + '-' + process.arch,
  },
  acousticCompatibility: evaluateAcousticDecisions(),
  sentiment: evaluateSentiment(),
  recommendation: await runMultiProfileRecommendationEvaluation(),
  segueLatency: await measureSegueService(),
  socketQueueLoad: await measureFiftyParticipantQueue(),
};
const report = JSON.stringify(result, null, 2);
if (process.env.PRD_BENCHMARK_REPORT_PATH) {
  await writeFile(path.resolve(process.env.PRD_BENCHMARK_REPORT_PATH), report + '\n', { encoding: 'utf8', flag: 'wx' });
}
console.log(report);
if (result.socketQueueLoad.status !== 'PASS_LOCAL_SYNTHETIC_ONLY') process.exitCode = 1;
