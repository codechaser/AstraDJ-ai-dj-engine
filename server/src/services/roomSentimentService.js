const clamp = (value) => Math.min(1, Math.max(0, value));

// Deterministic, context-aware lexicon scorer; this is not an ML model.
const positiveWords = new Set('amazing awesome beautiful best brilliant dance enjoy excellent excited fun good great happy love lovely nice perfect positive vibe wonderful yes sick fire slaps banger lit'.split(' '));
const negativeWords = new Set('awful bad boring dislike exhausted frustrated hate horrible low sad tired terrible worst negative dull annoying unhappy gloomy lifeless painful disappointing'.split(' '));
const normalizeText = (text) => text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [];
const negations = new Set(['not', 'no', 'never', "n't"]);
const positivePhrases = ['kills the dance floor', 'killing it', 'on fire', 'fire track', 'slaps hard'];
const negativePhrases = ['kills the mood', 'kills the vibe', 'killing the vibe', 'not feeling it', 'not feeling this', 'not feeling that'];

function hasPhrase(words, phrase) {
  const phraseWords = phrase.split(' ');
  return words.some((_, index) => phraseWords.every((word, offset) => words[index + offset] === word));
}

export function bucketSentiment(body) {
  const words = normalizeText(body);
  let signal = 0;
  for (const phrase of positivePhrases) if (hasPhrase(words, phrase)) signal += 2;
  for (const phrase of negativePhrases) if (hasPhrase(words, phrase)) signal -= 2;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const polarity = positiveWords.has(word) ? 1 : negativeWords.has(word) ? -1 : 0;
    if (!polarity) continue;
    const scopeStart = Math.max(0, index - 3);
    const scope = words.slice(scopeStart, index);
    const negated = scope.some((token, offset) => negations.has(token)
      && !scope.slice(offset + 1).some((between) => ['but', 'however'].includes(between)));
    const contrastWeight = words.slice(0, index).includes('but') || words.slice(0, index).includes('however') ? 2 : 1;
    signal += (negated ? -polarity : polarity) * contrastWeight;
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

  function snapshot(loungeId) {
    const cutoff = now() - windowSeconds * 1000;
    const entries = (messagesByLounge.get(loungeId) ?? []).filter((entry) => entry.at >= cutoff);
    const rollingScore = entries.length
      ? clamp(entries.reduce((sum, entry) => sum + sentimentScoreForBucket(entry.sentimentBucket), 0) / entries.length)
      : 0.5;
    return { rollingScore: Number(rollingScore.toFixed(4)), windowSeconds, sampleSize: entries.length };
  }

  function clear(loungeId) { messagesByLounge.delete(loungeId); }
  return { record, snapshot, clear, windowSeconds };
}

export const roomSentimentService = createRoomSentimentService();
