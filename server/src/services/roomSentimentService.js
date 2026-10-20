const clamp = (value) => Math.min(1, Math.max(0, value));

// Small, deterministic lexicon scorer. This is intentionally not described as ML.
const positiveWords = new Set('amazing awesome beautiful best brilliant dance enjoy excellent excited fun good great happy love lovely nice perfect positive beautiful vibe wonderful yes'.split(' '));
const negativeWords = new Set('awful bad boring dislike exhausted frustrated hate horrible low sad tired terrible worst negative'.split(' '));
const normalizeText = (text) => text.toLocaleLowerCase('en').normalize('NFKC').match(/[\p{L}\p{N}']+/gu) ?? [];

export function bucketSentiment(body) {
  const words = normalizeText(body);
  let signal = 0;
  for (const word of words) {
    if (positiveWords.has(word)) signal += 1;
    if (negativeWords.has(word)) signal -= 1;
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
