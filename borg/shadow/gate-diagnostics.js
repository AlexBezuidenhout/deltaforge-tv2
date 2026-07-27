'use strict';

/**
 * In-memory attribution for paper-strategy predicates.
 *
 * This is telemetry only: it does not alter an action, threshold, price or
 * size. A strategy calls begin() once per evaluation and then exactly one of
 * reject()/accept(). Snapshots are persisted through borg_strategy_runtime.
 */
class GateDiagnostics {
  constructor(strategy) {
    this.strategy = strategy;
    this.evaluations = 0;
    this.actionEvaluations = 0;
    this.actions = 0;
    this.rejections = new Map();
    this.lastRejection = null;
    this.lastActionAt = null;
  }

  begin() {
    this.evaluations += 1;
  }

  reject(reason, at = Date.now()) {
    const key = String(reason || 'unspecified_rejection');
    this.rejections.set(key, (this.rejections.get(key) || 0) + 1);
    this.lastRejection = {
      reason: key,
      at: new Date(at).toISOString(),
    };
    return [];
  }

  accept(actions, at = Date.now()) {
    const rows = Array.isArray(actions) ? actions : [];
    if (!rows.length) return this.reject('empty_action_builder_result', at);
    this.actionEvaluations += 1;
    this.actions += rows.length;
    this.lastActionAt = new Date(at).toISOString();
    return rows;
  }

  snapshot() {
    const rejectionCounts = Object.fromEntries(
      [...this.rejections.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
    );
    const [topReason, topCount] = Object.entries(rejectionCounts)[0] || [null, 0];
    const rejectedEvaluations = Object.values(rejectionCounts)
      .reduce((sum, count) => sum + count, 0);
    return {
      version: 'gate-rejections-v1',
      strategy: this.strategy,
      evaluations: this.evaluations,
      actionEvaluations: this.actionEvaluations,
      actions: this.actions,
      rejectedEvaluations,
      topRejection: topReason ? {
        reason: topReason,
        count: topCount,
        share: rejectedEvaluations > 0 ? topCount / rejectedEvaluations : 0,
      } : null,
      rejectionCounts,
      lastRejection: this.lastRejection,
      lastActionAt: this.lastActionAt,
    };
  }
}

module.exports = GateDiagnostics;
