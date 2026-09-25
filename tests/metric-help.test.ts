import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricHelp, metricHelpPosition } from '../src/web/MetricHelp';

describe('compact accessible metric help', () => {
  it('renders an explicitly labeled keyboard button without a visible explanatory card', () => {
    const html = renderToStaticMarkup(createElement(MetricHelp, { label: '主动买额占比', children: '主动买额 / 总成交额' }));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="主动买额占比说明"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('主动买额 / 总成交额');
    expect(html).not.toContain('role="tooltip"');
  });
  it('keeps bubbles inside narrow-screen left and right bounds', () => {
    const bubble = { width: 280, height: 150 }, viewport = { width: 320, height: 640 };
    expect(metricHelpPosition({ left: 0, width: 22, top: 30, bottom: 52 }, bubble, viewport)).toEqual({ left: 12, top: 60 });
    expect(metricHelpPosition({ left: 296, width: 22, top: 30, bottom: 52 }, bubble, viewport)).toEqual({ left: 28, top: 60 });
  });
  it('flips above an anchor near the bottom and clamps oversized heights', () => {
    expect(metricHelpPosition({ left: 200, width: 22, top: 600, bottom: 622 }, { width: 280, height: 150 }, { width: 800, height: 640 }))
      .toEqual({ left: 71, top: 442 });
    expect(metricHelpPosition({ left: 200, width: 22, top: 20, bottom: 42 }, { width: 280, height: 900 }, { width: 800, height: 640 }).top).toBe(12);
  });
});
