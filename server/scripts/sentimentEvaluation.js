const labels = ['positive', 'neutral', 'negative'];

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
