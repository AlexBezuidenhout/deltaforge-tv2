'use strict';

/**
 * Small process-local cache for read-only dashboard reports.
 *
 * The important property is single-flight: when several browser refreshes ask
 * for the same expensive report, one loader runs and every caller awaits that
 * promise. This is deliberately unrelated to signal, execution or risk state.
 */
function createReadThroughCache({ now = Date.now } = {}) {
  const entries = new Map();

  async function get(key, ttlMs, loader) {
    const current = entries.get(key);
    const timestamp = now();
    if (current?.value !== undefined && timestamp - current.at < ttlMs) return current.value;
    if (current?.inFlight) return current.inFlight;

    const inFlight = Promise.resolve().then(loader);
    entries.set(key, {
      value: current?.value,
      at: current?.at || 0,
      inFlight,
    });
    try {
      const value = await inFlight;
      entries.set(key, { value, at: now(), inFlight: null });
      return value;
    } catch (error) {
      if (current?.value !== undefined) entries.set(key, current);
      else entries.delete(key);
      throw error;
    }
  }

  function clear() {
    entries.clear();
  }

  return { clear, get };
}

module.exports = { createReadThroughCache };
