const MAX_LOG = 500;

const listeners = new Set();
const log = [];

function emit(entry) {
  log.push(entry);
  if (log.length > MAX_LOG) {
    log.shift();
  }
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {}
  }
}

function onLog(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function recent(n = 100) {
  return log.slice(-n);
}

function clear() {
  log.length = 0;
}

module.exports = { emit, onLog, recent, clear };
