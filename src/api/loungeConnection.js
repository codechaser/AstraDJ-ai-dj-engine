import { io } from 'socket.io-client';

export function connectToLounge({ inviteCode, token, origin, ioFactory = io, onState = () => {}, onQueueUpdate = () => {}, onStatus = () => {}, onError = () => {} }) {
  let loungeId = null;
  let disposed = false;
  const socket = ioFactory(origin, { auth: { token }, autoConnect: false });
  const join = () => {
    onStatus('connecting');
    socket.emit('lounge.join', { inviteCode: inviteCode.trim().toUpperCase() }, (ack) => {
      if (disposed) return;
      if (!ack?.ok) { onStatus('error'); onError(ack?.error); return; }
      loungeId = ack.loungeId;
      onState(ack.state);
      onStatus('connected');
    });
  };
  const queueUpdate = (envelope) => {
    if (!disposed && loungeId && envelope?.loungeId === loungeId) onQueueUpdate(envelope);
  };
  const connectError = (error) => { if (!disposed) { onStatus('error'); onError(error); } };
  const disconnectEvent = () => { if (!disposed) onStatus('disconnected'); };

  socket.on('connect', join);
  socket.on('connect_error', connectError);
  socket.on('disconnect', disconnectEvent);
  socket.on('lounge.queue.update', queueUpdate);
  socket.connect();
  return {
    socket,
    disconnect() {
      if (disposed) return;
      disposed = true;
      socket.off('connect', join);
      socket.off('connect_error', connectError);
      socket.off('disconnect', disconnectEvent);
      socket.off('lounge.queue.update', queueUpdate);
      socket.disconnect();
    },
  };
}
