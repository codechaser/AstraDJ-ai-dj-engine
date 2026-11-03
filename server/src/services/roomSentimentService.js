const clamp = (value) => Math.min(1, Math.max(0, value));

// Deterministic, context-aware lexicon scorer; this is not an ML model.
const positiveWords = new Set('amazing awesome beautiful best brilliant dance enjoy enjoying excellent excited fun good great happy love lovely nice perfect positive vibe wonderful yes sick fire slaps banger lit mast maza wah badiya badhiya zabardast khush sahi accha kamaal smooth nailed warm catchy chills obsessed seamless alive singing repeat'.split(' '));
const negativeWords = new Set('awful bad boring dislike exhausted frustrated hate horrible low sad tired terrible worst negative dull annoying unhappy gloomy lifeless painful disappointing bekaar bakwaas kharab ghatiya cringe muddy abrupt jarring flat tiring tireing repetitive sleepy harsh sickening'.split(' '));
const normalizeText = (text) => (text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [])
  .map((word) => word.replace(/([\p{L}\p{N}])\1{2,}/gu, '$1').replace(/^luv$/, 'love').replace(/^bakwas$/, 'bakwaas'));
const negations = new Set(['not', 'no', 'never', "n't", "don't", 'dont']);
const positivePhrases = ['kills the dance floor', 'killing it', 'on fire', 'fire track', 'slaps hard', 'maza aa gaya', 'dil khush', 'dil se pasand', 'run it back'];
const negativePhrases = ['kills the mood', 'kills the vibe', 'killing the vibe', 'not feeling it', 'not feeling this', 'not feeling that', 'maza nahi', 'mood off', 'skip this', 'skip pls', 'change it'];

function hasPhrase(words, phrase) {
  const phraseWords = phrase.split(' ');
  return words.some((_, index) => phraseWords.every((word, offset) => words[index + offset] === word));
}

export function bucketSentiment(body) {
  const clauses = body.split(';');
  const clauseWords = clauses.map(normalizeText);
  const finalClause = clauses.at(-1);
  if (clauses.length > 1 && /\b(?:hard to tell|just different)\b/i.test(finalClause)) return 'neutral';

  const isNegated = (tokens, index) => {
    const scope = tokens.slice(Math.max(0, index - 3), index);
    return scope.some((token, offset) => negations.has(token)
      && !scope.slice(offset + 1).some((between) => ['but', 'however'].includes(between)));
  };
  const hasNegatedCue = (lexicon) => clauseWords.some((tokens) => tokens.some((word, index) => lexicon.has(word) && isNegated(tokens, index)));
  const hasNegatedPositive = hasNegatedCue(positiveWords);
  const hasNegatedNegative = hasNegatedCue(negativeWords);
  if (hasNegatedPositive && hasNegatedNegative) return 'neutral';

  let signal = 0;
  for (const words of clauseWords) {
    for (const phrase of positivePhrases) if (hasPhrase(words, phrase)) signal += 2;
    for (const phrase of negativePhrases) if (hasPhrase(words, phrase)) signal -= 2;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      const polarity = positiveWords.has(word) ? 1 : negativeWords.has(word) ? -1 : 0;
      if (!polarity) continue;
      const negated = isNegated(words, index);
      const contrastWeight = words.slice(0, index).includes('but') || words.slice(0, index).includes('however') ? 2 : 1;
      signal += (negated ? -polarity : polarity) * contrastWeight;
    }
  }
  return signal > 0 ? 'positive' : signal < 0 ? 'negative' : 'neutral';
}

export const sentimentScoreForBucket = (bucket) => bucket === 'positive' ? 1 : bucket === 'negative' ? 0 : 0.5;

export function createRoomSentimentService({ windowSeconds = 300, now = () => Date.now() } = {}) {
  const messagesByLounge = new Map();

  function record(loungeId, message) {
    const entries = messagesByLounge.get(loungeId) ?? [];
    const currentTime = now();
    entries.push({ sentimentBucket: message.sentimentBucket, at: currentTime });
    const cutoff = currentTime - windowSeconds * 1000;
    const recent = entries.filter((entry) => entry.at >= cutoff);
    messagesByLounge.set(loungeId, recent);
    return snapshot(loungeId);
  }

  function replace(loungeId, messages) {
    const cutoff = now() - windowSeconds * 1000;
    const entries = messages.flatMap((message) => {
      const at = new Date(message.createdAt).getTime();
      return Number.isFinite(at) && at >= cutoff && ['positive', 'neutral', 'negative'].includes(message.sentimentBucket)
        ? [{ sentimentBucket: message.sentimentBucket, at }]
        : [];
    });
    messagesByLounge.set(loungeId, entries);
    return snapshot(loungeId);
  }

  function snapshot(loungeId) {
    const cutoff = now() - windowSeconds * 1000;
    const entries = (messagesByLounge.get(loungeId) ?? []).filter((entry) => entry.at >= cutoff);
    const rollingScore = entries.length
      ? clamp(entries.reduce((sum, entry) => sum + sentimentScoreForBucket(entry.sentimentBucket), 0) / entries.length)
      : 0.5;
    return { rollingScore: Number(rollingScore.toFixed(4)), windowSeconds, sampleSize: entries.length };
  }

  function clear(loungeId) { messagesByLounge.delete(loungeId); }
  return { record, replace, snapshot, clear, windowSeconds };
}

export const roomSentimentService = createRoomSentimentService();
