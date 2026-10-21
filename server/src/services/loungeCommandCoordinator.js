export function createLoungeCommandCoordinator() {
  const locks = new Map();
  return {
    async run(loungeId, operation) {
      const previous = locks.get(loungeId) ?? Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const chain = previous.then(() => gate);
      locks.set(loungeId, chain);
      await previous;
      try { return await operation(); }
      finally {
        release();
        if (locks.get(loungeId) === chain) locks.delete(loungeId);
      }
    },
  };
}

export const loungeCommandCoordinator = createLoungeCommandCoordinator();
