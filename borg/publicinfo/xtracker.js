'use strict';

const crypto = require('node:crypto');

const XTRACKER_BASE = 'https://xtracker.polymarket.com/api';
const GAMMA_BASE = 'https://gamma-api.polymarket.com';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function finite(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function payloadData(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, 'data')
    ? payload.data : payload;
}

function eventSlugFromMarketLink(value) {
  if (!value) return null;
  try {
    const parts = new URL(value).pathname.split('/').filter(Boolean);
    const eventIndex = parts.indexOf('event');
    return eventIndex >= 0 ? parts[eventIndex + 1] || null : null;
  } catch (_) {
    return null;
  }
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function plainText(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function fetchRawJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15_000));
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': options.userAgent || 'DeltaForge-Public-Research/1.0',
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    const receiveWallMs = Date.now();
    const receiveMonoNs = process.hrtime.bigint().toString();
    const envelope = options.wal?.append(raw, {
      channel: options.channel || 'http-json',
      receiveWallMs,
      receiveMonoNs,
      connectionEpoch: options.connectionEpoch || 0,
    }) || null;
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      throw new Error(`${url}: invalid JSON (${error.message})`);
    }
    return {
      data: payloadData(parsed),
      payload: parsed,
      raw,
      envelope,
      receiveWallMs,
      receiveMonoNs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function trackingWindow(tracking) {
  const startsAt = Date.parse(tracking?.startDate);
  const endsAt = Date.parse(tracking?.endDate);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return null;
  return { startsAt, endsAt };
}

function parseCountRange(market) {
  const label = String(market?.groupItemTitle || '').trim();
  const question = String(market?.question || '');
  const source = label || question;
  let match = source.match(/^<\s*(\d+)$/i);
  if (match) return { lower: 0, upper: Number(match[1]) - 1, label: `<${Number(match[1])}` };
  match = source.match(/^(\d+)\s*\+$/);
  if (match) return { lower: Number(match[1]), upper: null, label: `${Number(match[1])}+` };
  match = source.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (match) return { lower: Number(match[1]), upper: Number(match[2]), label: `${Number(match[1])}-${Number(match[2])}` };

  match = question.match(/post\s+(\d+)\s*[-–]\s*(\d+)\s+(?:truth social posts|posts|truths|tweets)/i);
  if (match) return { lower: Number(match[1]), upper: Number(match[2]), label: `${Number(match[1])}-${Number(match[2])}` };
  match = question.match(/post\s+(\d+)\s*\+\s+(?:truth social posts|posts|truths|tweets)/i);
  if (match) return { lower: Number(match[1]), upper: null, label: `${Number(match[1])}+` };
  return null;
}

function normalizedTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/donald\s+j\.?\s+trump/g, 'donald trump')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function certifyTrackingEvent(tracking, event) {
  const eventSlug = eventSlugFromMarketLink(tracking?.marketLink);
  const description = String(event?.description || '');
  const titleMatches = normalizedTitle(tracking?.title) === normalizedTitle(event?.title);
  const reasons = [];
  if (!eventSlug || eventSlug !== String(event?.slug || '')) reasons.push('EVENT_SLUG_MISMATCH');
  if (!titleMatches) reasons.push('TITLE_MISMATCH');
  if (!/xtracker\.polymarket\.com/i.test(description)) reasons.push('XTRACKER_NOT_PRIMARY_RULE_TEXT');
  if (!/post counter/i.test(description)) reasons.push('POST_COUNTER_RULE_MISSING');
  if (!/deleted posts will count/i.test(description)) reasons.push('MONOTONE_DELETE_RULE_MISSING');
  const window = trackingWindow(tracking);
  if (!window) reasons.push('INVALID_TRACKING_WINDOW');
  const ruleDocument = {
    provider: 'polymarket_xtracker',
    trackingId: tracking?.id || null,
    trackingTitle: tracking?.title || null,
    trackingStart: tracking?.startDate || null,
    trackingEnd: tracking?.endDate || null,
    marketLink: tracking?.marketLink || null,
    eventSlug: event?.slug || null,
    eventTitle: event?.title || null,
    description,
    resolutionSource: event?.resolutionSource || null,
  };
  return {
    certified: reasons.length === 0,
    reasons,
    ruleHash: sha256(JSON.stringify(ruleDocument)),
    ruleDocument,
  };
}

function barrierOutcome(countValue, bounds) {
  const count = Number(countValue);
  if (!Number.isInteger(count) || count < 0 || !bounds) return null;
  if (bounds.upper != null && count > Number(bounds.upper)) {
    return { outcome: 'No', kind: 'UPPER_BOUND_CROSSED' };
  }
  if (bounds.upper == null && count >= Number(bounds.lower)) {
    return { outcome: 'Yes', kind: 'OPEN_UPPER_LOWER_BOUND_REACHED' };
  }
  return null;
}

function barrierTransition(priorCount, currentCount, bounds) {
  const before = barrierOutcome(priorCount, bounds);
  const after = barrierOutcome(currentCount, bounds);
  return !before && after ? after : null;
}

function normalizePost(post, user, receipt) {
  const sourceMs = Date.parse(post?.createdAt);
  const importedMs = Date.parse(post?.importedAt);
  if (!post?.id || !user?.id || !Number.isFinite(sourceMs)) return null;
  const receiveWallMs = Number(receipt?.receiveWallMs || Date.now());
  const contentHtml = String(post?.content || '');
  return {
    provider: 'polymarket_xtracker',
    sourceEventId: String(post.id),
    platformEventId: post?.platformId == null ? null : String(post.platformId),
    sourceId: String(user.id),
    platform: String(user.platform || 'UNKNOWN'),
    actorHandle: String(user.handle || ''),
    sourceTimestamp: new Date(sourceMs),
    upstreamObservedAt: Number.isFinite(importedMs) ? new Date(importedMs) : null,
    receivedAt: new Date(receiveWallMs),
    receiveMonotonicNs: String(receipt?.receiveMonoNs || process.hrtime.bigint()),
    trackerLagMs: Number.isFinite(importedMs) ? Math.max(0, importedMs - sourceMs) : null,
    localPollLagMs: Number.isFinite(importedMs) ? Math.max(0, receiveWallMs - importedMs) : null,
    contentHash: sha256(JSON.stringify(post)),
    contentHtml,
    contentText: plainText(contentHtml),
    metrics: post?.metrics || {},
    raw: post,
    rawWalEventId: receipt?.envelope?.event_id || null,
  };
}

module.exports = {
  GAMMA_BASE,
  XTRACKER_BASE,
  barrierOutcome,
  barrierTransition,
  certifyTrackingEvent,
  eventSlugFromMarketLink,
  fetchRawJson,
  finite,
  normalizePost,
  parseArray,
  parseCountRange,
  payloadData,
  plainText,
  sha256,
  trackingWindow,
};
