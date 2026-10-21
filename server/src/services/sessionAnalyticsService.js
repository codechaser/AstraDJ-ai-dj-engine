const millis = (value) => {
  const time = value == null ? NaN : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

function peakParticipants(events, startedAt, endedAt) {
  const active = new Set();
  let peak = 0;
  let invalid = false;
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!['participant.joined', 'participant.left'].includes(event.type)) continue;
    const eventTime = millis(event.createdAt);
    if (eventTime !== null && ((startedAt !== null && eventTime < startedAt) || (endedAt !== null && eventTime > endedAt))) continue;
    const participant = String(event.userId ?? '');
    if (!participant) { invalid = true; continue; }
    if (event.type === 'participant.joined') active.add(participant);
    else active.delete(participant);
    peak = Math.max(peak, active.size);
    if (Number.isInteger(event.participantCount) && event.participantCount !== active.size) invalid = true;
  }
  return invalid ? null : peak;
}

export function buildSessionAnalytics({ lounge, queueEvents = [], metricEvents = [], messages = [] }) {
  const startedAt = millis(lounge?.startedAt);
  const endedAt = millis(lounge?.endedAt);
  const durationSeconds = startedAt !== null && endedAt !== null && endedAt >= startedAt
    ? Math.floor((endedAt - startedAt) / 1000) : null;
  const sessionEvents = queueEvents.filter((event) => {
    const eventTime = millis(event.createdAt);
    return eventTime === null || ((startedAt === null || eventTime >= startedAt) && (endedAt === null || eventTime <= endedAt));
  });
  const sessionMetricEvents = metricEvents.filter((event) => {
    const eventTime = millis(event.createdAt);
    return eventTime === null || ((startedAt === null || eventTime >= startedAt) && (endedAt === null || eventTime <= endedAt));
  });
  const sessionMessages = messages.filter((message) => {
    const messageTime = millis(message.createdAt);
    return messageTime === null || ((startedAt === null || messageTime >= startedAt) && (endedAt === null || messageTime <= endedAt));
  });
  const openedBattles = sessionEvents.filter((event) => event.type === 'soundclash.opened');
  const battleIds = openedBattles.map((event) => event.payload?.battleId).filter((id) => typeof id === 'string' && id.length > 0);
  const battleMetricComplete = battleIds.length === openedBattles.length;
  const questionEvents = sessionMetricEvents.filter((event) => event.type === 'ai.question.asked');
  const questionIds = questionEvents
    .filter((event) => typeof event.requestId === 'string' && event.requestId.length > 0 && event.userId != null)
    .map((event) => `${String(event.userId)}:${event.requestId}`);
  const questionMetricComplete = questionIds.length === questionEvents.length;
  const coverage = lounge?.analyticsTrackingVersion === 1;
  const timeline = sessionMessages
    .sort((a, b) => millis(a.createdAt) - millis(b.createdAt) || String(a.messageId ?? '').localeCompare(String(b.messageId ?? '')))
    .map((message) => ({ at: new Date(message.createdAt).toISOString(), score: message.sentimentScore, bucket: message.sentimentBucket }));

  const unavailableMetrics = {
    ...(durationSeconds === null ? { durationSeconds: 'Persisted session start or end timestamp is missing or invalid.' } : {}),
    ...(!coverage ? {
      peakConcurrentParticipants: 'Durable presence event coverage is unavailable for this legacy Lounge.',
      aiDjQuestionCount: 'Durable AI question event coverage is unavailable for this legacy Lounge.',
    } : {
      ...(!battleMetricComplete ? { soundclashBattles: 'One or more Soundclash open events lack a battle identifier.' } : {}),
      ...(!questionMetricComplete ? { aiDjQuestionCount: 'One or more AI question events lack a user-scoped idempotency identifier.' } : {}),
    }),
  };
  const summary = {
    durationSeconds,
    queueEventCount: sessionEvents.length,
    soundclashBattles: battleMetricComplete ? new Set(battleIds).size : null,
    chatMessageCount: sessionMessages.length,
    sentimentTimeline: timeline,
    peakConcurrentParticipants: coverage ? peakParticipants(sessionMetricEvents, startedAt, endedAt) : null,
    aiDjQuestionCount: coverage && questionMetricComplete ? new Set(questionIds).size : null,
  };
  return { ...summary, unavailableMetrics };
}

export function createSessionAnalyticsService(repository) {
  return {
    async forLounge(lounge) {
      const [queueEvents, metricEvents, messages] = await Promise.all([
        repository.listQueueEvents(lounge.loungeId),
        repository.listLoungeMetricEvents(lounge.loungeId),
        repository.listSentimentMessages(lounge.loungeId),
      ]);
      return buildSessionAnalytics({ lounge, queueEvents, metricEvents, messages });
    },
  };
}
