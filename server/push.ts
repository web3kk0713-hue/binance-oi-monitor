import { createHash, timingSafeEqual, randomBytes, ECDH } from 'node:crypto';
import { lookup } from 'node:dns';
import { Agent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import webpush from 'web-push';
import type { AlertEvent } from '../src/shared/types';
import type { ServerConfig } from './config';

export function hashSecret(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function newDeleteToken() { return randomBytes(32).toString('base64url'); }
export function tokenMatches(token: string | undefined, expectedHash: string) {
  if (!token || token.length > 200) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashSecret(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    if (endpoint.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname) || url.pathname === '/') return false;
    return ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(url.hostname)
      || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
  } catch { return false; }
}

export function validPushSubscription(subscription: PushSubscriptionJSON): boolean {
  if (!subscription.endpoint || !validPushEndpoint(subscription.endpoint)) return false;
  const { p256dh, auth } = subscription.keys ?? {};
  if (!p256dh || !auth || !/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return false;
  const key = Buffer.from(p256dh, 'base64url');
  if (key.length !== 65 || key[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) return false;
  try { ECDH.convertKey(key, 'prime256v1'); return true; } catch { return false; }
}

const deniedIpv4 = new BlockList();
const deniedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deniedIpv4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['::ffff:0:0', 96]] as const) {
  deniedIpv6.addSubnet(address, prefix, 'ipv6');
}
export function publicPushAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !deniedIpv4.check(address, 'ipv4') : family === 6 && !deniedIpv6.check(address, 'ipv6');
}

/** Address resolution is constrained at connection time, closing DNS rebinding to private hosts. */
function pushAgent() {
  return new Agent({ keepAlive: true, maxSockets: 4, lookup(hostname, options, callback) {
    lookup(hostname, { all: true, family: typeof options === 'number' ? options : options.family }, (error, addresses) => {
      if (error) { callback(error, '', 0); return; }
      const safe = addresses.filter(item => publicPushAddress(item.address));
      if (!safe.length) { callback(new Error('Push endpoint address rejected'), '', 0); return; }
      if (typeof options === 'object' && options.all) callback(null, safe);
      else callback(null, safe[0].address, safe[0].family);
    });
  } });
}

export interface PushSender {
  readonly enabled: boolean; readonly publicKey: string | null;
  send(subscription: PushSubscriptionJSON, event: AlertEvent): Promise<void>;
  close?(): void;
}
export class BrowserPushSender implements PushSender {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  private agent = pushAgent();
  constructor(private config: ServerConfig) {
    this.enabled = Boolean(config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject);
    this.publicKey = this.enabled ? config.vapidPublicKey! : null;
    if (this.enabled) {
      // Validate once; configuration errors must fail startup rather than silently dropping alerts.
      webpush.setVapidDetails(config.vapidSubject!, config.vapidPublicKey!, config.vapidPrivateKey!);
    }
  }
  async send(subscription: PushSubscriptionJSON, event: AlertEvent) {
    if (!this.enabled || !validPushSubscription(subscription)) throw new Error('Push is unavailable');
    const level = { warning: '关注', danger: '高风险', critical: '强提醒' }[event.level];
    const payload = JSON.stringify({ title: `${level} · ${event.symbol} OI/FDV ${event.ratio.toFixed(1)}%`,
      body: `合约 OI $${event.oiUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}，FDV $${event.fdvUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      tag: `oi-fdv:${event.assetId}`, url: this.config.notificationUrl, event });
    // Reuse audited message encryption/VAPID construction, while imposing an absolute network deadline.
    const details = webpush.generateRequestDetails(subscription as webpush.PushSubscription, payload, {
      vapidDetails: { subject: this.config.vapidSubject!, publicKey: this.config.vapidPublicKey!, privateKey: this.config.vapidPrivateKey! },
      TTL: 600, urgency: 'high',
    });
    await new Promise<void>((resolveRequest, rejectRequest) => {
      // Native HTTPS never follows Location redirects. The caller cannot replace the agent or headers.
      const request = httpsRequest(new URL(subscription.endpoint!), { method: 'POST', headers: details.headers,
        agent: this.agent, signal: AbortSignal.timeout(8000) }, response => {
        response.on('error', rejectRequest);
        response.resume();
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) resolveRequest();
          else rejectRequest(Object.assign(new Error('Push service rejected notification'), { statusCode }));
        });
      });
      request.on('error', rejectRequest);
      request.end(details.body);
    });
  }
  close() { this.agent.destroy(); }
}
