export function canApplyQueueRevision(currentRevision, incomingRevision) {
  const hasCurrentRevision = Number.isSafeInteger(currentRevision) && currentRevision >= 0;
  const hasIncomingRevision = Number.isSafeInteger(incomingRevision) && incomingRevision >= 0;

  if (!hasIncomingRevision) return !hasCurrentRevision;
  if (!hasCurrentRevision) return true;
  return incomingRevision >= currentRevision;
}
