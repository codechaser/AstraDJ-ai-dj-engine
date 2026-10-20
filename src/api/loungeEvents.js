export const LOUNGE_LIVE_EVENTS = Object.freeze([
  'lounge.chat.message',
  'lounge.sentiment.score',
  'lounge.soundclash.open',
  'lounge.soundclash.submission',
  'lounge.soundclash.vote',
  'lounge.soundclash.resolved',
  'lounge.ai.dj_announcement',
]);

export function subscribeToLoungeEvents(socket, loungeId, onEvent) {
  if (!socket || typeof onEvent !== 'function') return () => {};
  const listeners = new Map();
  for (const eventName of LOUNGE_LIVE_EVENTS) {
    const listener = (envelope) => {
      if (envelope?.loungeId === loungeId) onEvent(eventName, envelope);
    };
    listeners.set(eventName, listener);
    socket.on(eventName, listener);
  }
  return () => {
    for (const [eventName, listener] of listeners) socket.off(eventName, listener);
    listeners.clear();
  };
}
