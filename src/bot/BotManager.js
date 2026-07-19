const BotInstance = require('./BotInstance');
const CopyBotInstance = require('./CopyBotInstance');
const GeorgeBotInstance = require('./GeorgeBotInstance');

class BotManager {
  constructor() {
    this.instances = new Map();       // userId -> BotInstance
    this.copyInstances = new Map();   // userId -> CopyBotInstance
    this.georgeInstances = new Map(); // userId -> retired legacy-source telemetry/control
  }

  async startBot(userId, settings) {
    // Stop existing instance if running
    if (this.instances.has(userId)) {
      await this.stopBot(userId);
    }

    const bot = new BotInstance(userId, settings);
    bot.on('high_conviction_trade', (signal) => {
      const george = this.georgeInstances.get(userId);
      // george_mirror_enabled (default OFF, audit 2026-07-12): all of George's
      // paper profit was mirror trades (own signal 18W/20L −$27; mirror 12W/1L
      // +$268 — and the mirror wins don't survive tape-verified fills). Mirror
      // stays off so the divergence signal can be measured cleanly; flip the
      // flag in bot_settings to re-enable.
      if (george && george.isRunning && george.settings?.george_mirror_enabled === true) {
        george.forceTakeTrade(signal);
      }
    });
    this.instances.set(userId, bot);
    await bot.start();
    return bot;
  }

  async stopBot(userId) {
    const bot = this.instances.get(userId);
    if (bot) {
      await bot.stop();
      this.instances.delete(userId);
    }
  }

  async startCopyBot(userId, settings) {
    if (this.copyInstances.has(userId)) {
      await this.stopCopyBot(userId);
    }

    const bot = new CopyBotInstance(userId, settings);
    this.copyInstances.set(userId, bot);
    await bot.start();
    return bot;
  }

  async stopCopyBot(userId) {
    const bot = this.copyInstances.get(userId);
    if (bot) {
      await bot.stop();
      this.copyInstances.delete(userId);
    }
  }

  async startGeorgeBot(userId, settings) {
    if (this.georgeInstances.has(userId)) {
      await this.stopGeorgeBot(userId);
    }
    const bot = new GeorgeBotInstance(userId, settings);
    this.georgeInstances.set(userId, bot);
    await bot.start();
    return bot;
  }

  async stopGeorgeBot(userId) {
    const bot = this.georgeInstances.get(userId);
    if (bot) {
      await bot.stop();
      this.georgeInstances.delete(userId);
    }
  }

  getGeorgeBotStatus(userId) {
    const bot = this.georgeInstances.get(userId);
    return bot ? bot.getStatus() : null;
  }

  isGeorgeRunning(userId) {
    const bot = this.georgeInstances.get(userId);
    return bot ? bot.isRunning : false;
  }

  getBot(userId) {
    return this.instances.get(userId) || null;
  }

  getBotStatus(userId) {
    const bot = this.instances.get(userId);
    return bot ? bot.getStatus() : null;
  }

  getCopyBotStatus(userId) {
    const bot = this.copyInstances.get(userId);
    return bot ? bot.getStatus() : null;
  }

  getActiveCount() {
    return this.instances.size + this.copyInstances.size;
  }

  getAllLogs(limit = 200) {
    const logs = [];
    for (const [userId, bot] of this.instances) {
      const entries = bot.decisionLog || [];
      for (const e of entries) logs.push({ ...e, userId });
    }
    logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return logs.slice(0, limit);
  }

  isRunning(userId) {
    const bot = this.instances.get(userId);
    return bot ? bot.isRunning : false;
  }

  isCopyRunning(userId) {
    const bot = this.copyInstances.get(userId);
    return bot ? bot.isRunning : false;
  }

  /**
   * Stop all bot instances — used for graceful shutdown
   */
  async stopAll() {
    console.log(`[BotManager] Stopping all instances (${this.instances.size} signal, ${this.copyInstances.size} copy)...`);

    const stopPromises = [];

    // Stop signal bots — preserve is_active so auto-restart works after deploy
    for (const [userId, instance] of this.instances) {
      stopPromises.push(
        instance.stop(true).catch(err => {
          console.error(`[BotManager] Error stopping signal bot for user ${userId}:`, err.message);
        })
      );
    }

    // Stop copy bots — same
    for (const [userId, instance] of this.copyInstances) {
      stopPromises.push(
        instance.stop(true).catch(err => {
          console.error(`[BotManager] Error stopping copy bot for user ${userId}:`, err.message);
        })
      );
    }

    // Stop George split-test bots — preserve george_is_active for auto-restart
    for (const [userId, instance] of this.georgeInstances) {
      stopPromises.push(
        instance.stop(true).catch(err => {
          console.error(`[BotManager] Error stopping George bot for user ${userId}:`, err.message);
        })
      );
    }

    await Promise.all(stopPromises);

    this.instances.clear();
    this.copyInstances.clear();
    this.georgeInstances.clear();

    console.log('[BotManager] All instances stopped.');
  }
}

module.exports = BotManager;
