import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';

// JSON-compatible YAML keeps this small deployment manifest inspectable without another parser dependency.
const blueprint = JSON.parse(readFileSync(new URL('../render.yaml', import.meta.url), 'utf8'));

describe('explicit free-only Render preview blueprint', () => {
  it('defines exactly one free web service and no additional billable resources', () => {
    expect(Object.keys(blueprint).sort()).toEqual(['previews', 'services']);
    expect(blueprint.services).toHaveLength(1);
    const service = blueprint.services[0];
    expect(service.type).toBe('web');
    expect(service.plan).toBe('free');
    expect(Object.keys(service).sort()).toEqual(['autoDeployTrigger', 'branch', 'buildCommand', 'envVars',
      'healthCheckPath', 'name', 'plan', 'region', 'repo', 'runtime', 'startCommand', 'type'].sort());
    expect(blueprint.previews).toEqual({ generation: 'off' });
    expect(service.autoDeployTrigger).toBe('off');
  });

  it('uses the existing source, locked install and supported native runtime', () => {
    const service = blueprint.services[0];
    expect(service.repo).toBe('https://github.com/web3kk0713-hue/binance-oi-monitor');
    expect(service.branch).toBe('main');
    expect(service.runtime).toBe('node');
    expect(service.buildCommand).toBe('npx --yes pnpm@11.25.0 install --prod --frozen-lockfile');
    expect(service.startCommand).toBe('node --import tsx server/index.ts');
    expect(service.healthCheckPath).toBe('/api/v1/health');
  });

  it('loads preview configuration without secrets, paid storage or permissive CORS', () => {
    const service = blueprint.services[0];
    const env = Object.fromEntries(service.envVars.map(({ key, value }: { key: string; value: string }) => [key, value]));
    expect(Object.keys(env)).toHaveLength(service.envVars.length);
    expect(Object.keys(env).sort()).toEqual(['ALLOWED_ORIGINS', 'DEPLOYMENT_TIER', 'HOST', 'NODE_ENV',
      'NODE_VERSION', 'NOTIFICATION_URL', 'PORT', 'SQLITE_PATH'].sort());
    expect(env.NODE_VERSION).toBe('24.21.0');
    const config = loadConfig(env);
    expect(config).toMatchObject({ deploymentTier: 'free-preview', host: '0.0.0.0', port: 10000,
      sqlitePath: './data/monitor.sqlite', allowedOrigins: ['https://web3kk0713-hue.github.io'],
      notificationUrl: 'https://web3kk0713-hue.github.io/binance-oi-monitor/' });
    expect(config.databaseUrl).toBeUndefined();
    expect(config.cmcApiKey).toBeUndefined();
    expect(config.vapidPrivateKey).toBeUndefined();
  });
});
