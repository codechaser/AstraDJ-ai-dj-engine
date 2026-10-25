const labels = ['positive', 'neutral', 'negative'];

// Exact snapshot of bucketSentiment at fd8126e. Keep stable for paired
// before/after evaluation; this is a reproducible baseline, not production code.
const frozenPositiveWords = new Set('amazing awesome beautiful best brilliant dance enjoy excellent excited fun good great happy love lovely nice perfect positive vibe wonderful yes sick fire slaps banger lit'.split(' '));
const frozenNegativeWords = new Set('awful bad boring dislike exhausted frustrated hate horrible low sad tired terrible worst negative dull annoying unhappy gloomy lifeless painful disappointing'.split(' '));
const frozenNegations = new Set(['not', 'no', 'never', "n't"]);
const frozenPositivePhrases = ['kills the dance floor', 'killing it', 'on fire', 'fire track', 'slaps hard'];
const frozenNegativePhrases = ['kills the mood', 'kills the vibe', 'killing the vibe', 'not feeling it', 'not feeling this', 'not feeling that'];
const normalizeWords = (text) => text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [];
const containsPhrase = (words, phrase) => words.some((_, index) => phrase.split(' ').every((word, offset) => words[index + offset] === word));

export function frozenCurrentSentimentClassifier(body) {
  const words = normalizeWords(body);
  let signal = 0;
  for (const phrase of frozenPositivePhrases) if (containsPhrase(words, phrase)) signal += 2;
  for (const phrase of frozenNegativePhrases) if (containsPhrase(words, phrase)) signal -= 2;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const polarity = frozenPositiveWords.has(word) ? 1 : frozenNegativeWords.has(word) ? -1 : 0;
    if (!polarity) continue;
    const scope = words.slice(Math.max(0, index - 3), index);
    const negated = scope.some((token, offset) => frozenNegations.has(token)
      && !scope.slice(offset + 1).some((between) => ['but', 'however'].includes(between)));
    const contrastWeight = words.slice(0, index).includes('but') || words.slice(0, index).includes('however') ? 2 : 1;
    signal += (negated ? -polarity : polarity) * contrastWeight;
  }
  return signal > 0 ? 'positive' : signal < 0 ? 'negative' : 'neutral';
}

export function evaluateClassifier(dataset, classify) {
  const confusionMatrix = Object.fromEntries(labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]));
  const challenge = Object.fromEntries(['ambiguous', 'mixed'].map((kind) => [kind, { total: 0, correct: 0 }]));
  for (const example of dataset) {
    const predicted = classify(example.text);
    if (!confusionMatrix[example.label]?.[predicted] && confusionMatrix[example.label]?.[predicted] !== 0) throw new Error(`Invalid sentiment label or prediction for: ${example.text}`);
    confusionMatrix[example.label][predicted] += 1;
    if (example.caseType && challenge[example.caseType]) {
      challenge[example.caseType].total += 1;
      if (predicted === example.label) challenge[example.caseType].correct += 1;
    }
  }
  const perClass = Object.fromEntries(labels.map((label) => {
    const tp = confusionMatrix[label][label];
    const support = Object.values(confusionMatrix[label]).reduce((sum, count) => sum + count, 0);
    const predictedCount = labels.reduce((sum, actual) => sum + confusionMatrix[actual][label], 0);
    const precision = predictedCount ? tp / predictedCount : 0;
    const recall = support ? tp / support : 0;
    return [label, { precision: Number(precision.toFixed(4)), recall: Number(recall.toFixed(4)), f1: Number((precision + recall ? 2 * precision * recall / (precision + recall) : 0).toFixed(4)), support }];
  }));
  const correct = labels.reduce((sum, label) => sum + confusionMatrix[label][label], 0);
  return {
    sampleCount: dataset.length,
    accuracy: Number((correct / dataset.length).toFixed(4)),
    correct,
    confusionMatrix,
    perClass,
    challengeCases: Object.fromEntries(Object.entries(challenge).map(([kind, value]) => [kind, { ...value, accuracy: value.total ? Number((value.correct / value.total).toFixed(4)) : null }])),
  };
}

export function baselineLexiconClassifier(text) {
  const positiveWords = new Set('amazing awesome beautiful best brilliant dance enjoy excellent excited fun good great happy love lovely nice perfect positive beautiful vibe wonderful yes'.split(' '));
  const negativeWords = new Set('awful bad boring dislike exhausted frustrated hate horrible low sad tired terrible worst negative'.split(' '));
  const words = text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [];
  const signal = words.reduce((sum, word) => sum + (positiveWords.has(word) ? 1 : 0) - (negativeWords.has(word) ? 1 : 0), 0);
  return signal > 0 ? 'positive' : signal < 0 ? 'negative' : 'neutral';
}
