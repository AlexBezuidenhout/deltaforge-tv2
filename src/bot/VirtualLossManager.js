/**
 * Virtual Loss gate: accumulate N simulated losses before allowing real entries.
 * After one real WIN, disarm and require N virtual losses again.
 */
class VirtualLossManager {
  constructor(settings = {}) {
    this.reload(settings);
    this._persist = null;
  }

  setPersistCallback(fn) {
    this._persist = typeof fn === 'function' ? fn : null;
  }

  reload(settings = {}) {
    this.enabled = settings.virtual_loss_enabled === true;
    const req = parseInt(settings.virtual_loss_required, 10);
    this.required = Number.isFinite(req) && req >= 1 ? req : 2;
    this.count = Math.max(0, parseInt(settings.virtual_loss_count, 10) || 0);
    this.armed = settings.virtual_loss_armed === true;
  }

  shouldExecuteVirtual() {
    return this.enabled && !this.armed;
  }

  shouldAllowRealTrade() {
    return !this.enabled || this.armed;
  }

  /**
   * @param {object} trade - DB row (is_virtual boolean)
   * @param {'WIN'|'LOSS'} result
   */
  async onTradeClosed(trade, result) {
    if (!this.enabled) return;

    const isVirtual = trade.is_virtual === true;
    const isWin = result === 'WIN';

    if (isVirtual) {
      if (isWin) {
        this.count = 0;
      } else {
        this.count += 1;
        if (this.count >= this.required) {
          this.armed = true;
          this.count = 0;
        }
      }
    } else if (this.armed && isWin) {
      this.armed = false;
      this.count = 0;
    }

    if (this._persist) await this._persist();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      required: this.required,
      count: this.count,
      armed: this.armed,
      lossesUntilArm: this.enabled && !this.armed
        ? Math.max(0, this.required - this.count)
        : 0,
    };
  }
}

module.exports = VirtualLossManager;
