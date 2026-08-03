'use strict';

const DEFAULTS = Object.freeze({
  diagnosticHeartbeatMs: 5 * 60_000,
  executableHeartbeatMs: 60_000,
  transitionDwellMs: 250,
  diagnosticTransitionDwellMs: 30_000,
  maximumStates: 20_000,
});

function stateSignature(mark) {
  return JSON.stringify([
    mark.executable === true,
    mark.executionBarrier || null,
    mark.surfaceFidelity || null,
    mark.targetSurfaceMode || null,
    mark.valuationSurfaceMode || null,
    mark.dataQualityGrade || null,
  ]);
}

function transitionKind(previous, next) {
  if (previous.executable !== true && next.executable === true) return 'EXECUTABLE_ENTER';
  if (previous.executable === true && next.executable !== true) return 'EXECUTABLE_EXIT';
  if (previous.targetSurfaceMode !== next.targetSurfaceMode
      || previous.valuationSurfaceMode !== next.valuationSurfaceMode
      || previous.surfaceFidelity !== next.surfaceFidelity) return 'SURFACE_TRANSITION';
  if (previous.executionBarrier !== next.executionBarrier) return 'BARRIER_TRANSITION';
  return 'QUALITY_TRANSITION';
}

class TransitionMarkSampler {
  constructor(options = {}) {
    this.diagnosticHeartbeatMs = Math.max(30_000,
      Number(options.diagnosticHeartbeatMs || DEFAULTS.diagnosticHeartbeatMs));
    this.executableHeartbeatMs = Math.max(5_000,
      Number(options.executableHeartbeatMs || DEFAULTS.executableHeartbeatMs));
    this.transitionDwellMs = Math.max(0,
      Number(options.transitionDwellMs ?? DEFAULTS.transitionDwellMs));
    this.diagnosticTransitionDwellMs = Math.max(this.transitionDwellMs,
      Number(options.diagnosticTransitionDwellMs
        ?? DEFAULTS.diagnosticTransitionDwellMs));
    this.maximumStates = Math.max(100,
      Number(options.maximumStates || DEFAULTS.maximumStates));
    this.states = new Map();
    this.metrics = { accepted: 0, suppressed: 0, pending: 0, pruned: 0 };
  }

  _result(key, state, mark, now, eventKind) {
    state.sequence += 1;
    state.lastPersistAt = now;
    this.metrics.accepted += 1;
    return {
      persist: true,
      eventKind,
      sequence: state.sequence,
      dedupSuffix: `${key}:${state.sequence}`,
      priorPersistedAt: state.sequence > 1 ? state.priorPersistedAt : null,
      mark,
    };
  }

  observe(keyValue, mark, nowValue = Date.now()) {
    const key = String(keyValue);
    const now = Number(nowValue);
    const signature = stateSignature(mark);
    let state = this.states.get(key);
    if (!state) {
      state = {
        accepted: { ...mark },
        acceptedSignature: signature,
        pending: null,
        pendingSignature: null,
        pendingSince: null,
        lastPersistAt: 0,
        priorPersistedAt: null,
        lastObservedAt: now,
        sequence: 0,
      };
      this.states.set(key, state);
      this._boundStates();
      return this._result(key, state, mark, now, 'INITIAL_STATE');
    }

    state.lastObservedAt = now;
    if (signature !== state.acceptedSignature) {
      if (state.pendingSignature !== signature) {
        state.pending = { ...mark };
        state.pendingSignature = signature;
        state.pendingSince = now;
        this.metrics.pending += 1;
        this.metrics.suppressed += 1;
        return { persist: false, reason: 'TRANSITION_DWELL', mark };
      }
      // Entry-eligibility transitions retain the 250ms execution dwell. Purely
      // diagnostic surface/barrier flicker is raw-WAL replayable and must stay
      // stable much longer before becoming another SQL gold fact. Treating
      // every subsecond bid/ask-IV mode oscillation as a durable transition
      // created millions of redundant rows without adding causal evidence.
      const dwellMs = state.accepted.executable === true || mark.executable === true
        ? this.transitionDwellMs : this.diagnosticTransitionDwellMs;
      if (now - state.pendingSince < dwellMs) {
        this.metrics.suppressed += 1;
        return { persist: false, reason: 'TRANSITION_DWELL', mark };
      }
      const previous = state.accepted;
      const accepted = state.pending;
      const eventKind = transitionKind(previous, accepted);
      state.accepted = accepted;
      state.acceptedSignature = state.pendingSignature;
      state.pending = null;
      state.pendingSignature = null;
      state.pendingSince = null;
      state.priorPersistedAt = state.lastPersistAt;
      return this._result(key, state, accepted, now, eventKind);
    }

    state.pending = null;
    state.pendingSignature = null;
    state.pendingSince = null;
    const heartbeatMs = mark.executable === true
      ? this.executableHeartbeatMs : this.diagnosticHeartbeatMs;
    if (now - state.lastPersistAt >= heartbeatMs) {
      state.accepted = { ...mark };
      state.priorPersistedAt = state.lastPersistAt;
      return this._result(key, state, mark, now,
        mark.executable === true ? 'EXECUTABLE_HEARTBEAT' : 'DIAGNOSTIC_HEARTBEAT');
    }
    this.metrics.suppressed += 1;
    return { persist: false, reason: 'UNCHANGED_STATE', mark };
  }

  prune(activeKeys) {
    const active = new Set([...activeKeys].map(String));
    for (const key of this.states.keys()) {
      if (!active.has(key)) {
        this.states.delete(key);
        this.metrics.pruned += 1;
      }
    }
  }

  _boundStates() {
    while (this.states.size > this.maximumStates) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, state] of this.states) {
        if (state.lastObservedAt < oldestAt) {
          oldestAt = state.lastObservedAt;
          oldestKey = key;
        }
      }
      if (oldestKey == null) break;
      this.states.delete(oldestKey);
      this.metrics.pruned += 1;
    }
  }
}

module.exports = {
  DEFAULTS,
  TransitionMarkSampler,
  stateSignature,
  transitionKind,
};
