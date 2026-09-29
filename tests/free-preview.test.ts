import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config';
import type { BackendStatus } from '../src/shared/types';
import { BackendConnectionBar, SettingsDialog } from '../src/web/App';
import { DEFAULT_SETTINGS } from '../src/web/storage';

vi.mock('../src/web/notifications', async importOriginal => ({
  ...await importOriginal<typeof import('../src/web/notifications')>(), notificationSupport: () => false,
}));

const backend: BackendStatus = { mode: 'server', version: 'test', collecting: false, lastSuccess: null,
  storage: 'sqlite', pushEnabled: false, retentionDays: 30, lastError: null };
const props = { mode: 'server' as const, backend, warning: false, collecting: false, pushConnected: false, onSettings: vi.fn() };

describe('free preview configuration and visible limitations', () => {
  it('accepts only the explicit free-preview value and preserves the unset default', () => {
    expect(loadConfig({})).not.toHaveProperty('deploymentTier');
    expect(loadConfig({ DEPLOYMENT_TIER: '' })).not.toHaveProperty('deploymentTier');
    expect(loadConfig({ DEPLOYMENT_TIER: 'free-preview' }).deploymentTier).toBe('free-preview');
    for (const value of ['free', 'production', 'FREE-PREVIEW', ' free-preview', ' ']) {
      expect(() => loadConfig({ DEPLOYMENT_TIER: value })).toThrow('Invalid DEPLOYMENT_TIER');
    }
  });

  it('renders the free tier and history risk directly without a thirty-day guarantee', () => {
    const html = renderToStaticMarkup(createElement(BackendConnectionBar, { ...props, backend: { ...backend, deploymentTier: 'free-preview' }, pushConnected: true }));
    expect(html).toContain('免费测试后台');
    expect(html).toContain('闲置会休眠 · 历史可能丢失');
    expect(html).toContain('warning-dot');
    expect(html).not.toContain('30 天历史');
    expect(html).not.toContain('推送已开启');
  });

  it('keeps legacy connected, pending, and direct states distinct', () => {
    const regular = renderToStaticMarkup(createElement(BackendConnectionBar, props));
    expect(regular).toContain('已连接后台'); expect(regular).toContain('30 天历史');
    const pending = renderToStaticMarkup(createElement(BackendConnectionBar, { ...props, backend: null }));
    expect(pending).toContain('后台连接待确认'); expect(pending).not.toContain('免费测试后台');
    const direct = renderToStaticMarkup(createElement(BackendConnectionBar, { ...props, mode: 'direct', backend: { ...backend, deploymentTier: 'free-preview' } }));
    expect(direct).toContain('浏览器采集 · 未连接后台'); expect(direct).not.toContain('免费测试后台');
  });

  it('does not promise that every connected backend runs continuously or preserves history', () => {
    const done = async () => {};
    const html = renderToStaticMarkup(createElement(SettingsDialog, { settings: { ...DEFAULT_SETTINGS, mode: 'server' },
      onSave: done, onClose: vi.fn(), pushConnected: true, onConnectPush: done, onDisconnectPush: done,
      onEnableNotifications: done, onDisableNotifications: done, onTest: vi.fn() }));
    expect(html).not.toContain('连接持续运行的后台');
    expect(html).toContain('采集、历史与推送取决于后台配置');
    expect(html).toContain('免费测试后台闲置会休眠，历史可能丢失');
    expect(html).toContain('送达仍取决于后台运行');
  });
});
