import { useEffect, useState } from 'react';
import type { AssetRow } from '../shared/types';
import { createMarketTracker, emptyMarket, LIVE_PAUSE_MS, LIVE_SILENCE_MS, selectFuturesMarket, verifySpotMarket,
  type MarketObservation, type MarketTarget } from '../shared/liveMarket';

export interface LiveMarkets { futures: MarketObservation; spot: MarketObservation; }
interface Subscription { close(): void; restart(reason: string): void; }

// Binance docs checked 2026-09-23: trades and books use separate UM routing domains.
// https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market
// https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public
export function marketStreamUrls(target: MarketTarget): string[] {
  const symbol = target.symbol.toLowerCase();
  return target.venue === 'futures'
    ? [`wss://fstream.binance.com/market/ws/${symbol}@aggTrade`, `wss://fstream.binance.com/public/ws/${symbol}@bookTicker`]
    : [`wss://stream.binance.com:9443/stream?streams=${symbol}@aggTrade/${symbol}@bookTicker`];
}

/** Only the selected asset is subscribed. No all-market streams, account endpoints or order actions. */
export function useLiveMarket(asset: AssetRow | undefined): LiveMarkets {
  const selected = selectFuturesMarket(asset);
  const symbol = selected?.symbol ?? null; const baseAsset = selected?.baseAsset ?? null;
  const quoteAsset = selected?.quoteAsset ?? null; const multiplier = selected?.multiplier ?? 1;
  const key = `${asset?.id ?? ''}:${symbol ?? ''}:${baseAsset ?? ''}:${quoteAsset ?? ''}:${multiplier}`;
  const placeholder: LiveMarkets = {
    futures: emptyMarket(asset ? '没有可核实的永续合约' : '请选择币种', selected, selected ? 'connecting' : 'unavailable'),
    spot: emptyMarket(asset ? '正在核实 Binance 同币种 USDT 现货' : '请选择币种', null, selected ? 'connecting' : 'unavailable'),
  };
  const [state, setState] = useState<{ key: string; markets: LiveMarkets }>(() => ({ key, markets: placeholder }));

  useEffect(() => {
    if (!symbol || !baseAsset || !quoteAsset || typeof WebSocket === 'undefined') {
      setState({ key, markets: { futures: emptyMarket('没有可用的官方实时连接'), spot: emptyMarket('现货行情不可用') } });
      return;
    }
    const target: MarketTarget = { venue: 'futures', symbol, baseAsset, quoteAsset, multiplier };
    let stopped = false;
    const subscriptions: Subscription[] = [];
    const readers: Partial<Record<'futures' | 'spot', () => MarketObservation>> = {};
    const fixed: LiveMarkets = { futures: emptyMarket('正在连接 Binance 永续', target, 'connecting'),
      spot: emptyMarket('正在核实现货交易对', null, 'connecting') };
    const controller = new AbortController();
    let metadataRetry: ReturnType<typeof setTimeout> | undefined;
    let metadataFailures = 0;
    let lastTick = Date.now();
    function publish() {
      if (!stopped) setState({ key, markets: { futures: readers.futures?.() ?? fixed.futures, spot: readers.spot?.() ?? fixed.spot } });
    }

    function subscribe(market: MarketTarget): Subscription {
      const tracker = createMarketTracker(market);
      readers[market.venue] = () => tracker.observe(Date.now());
      let disposed = false; let generation = 0; let failures = 0;
      let sockets: WebSocket[] = [];
      let retry: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      let openedAt = 0;
      function closeSockets() {
        generation++;
        for (const socket of sockets) {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        }
        sockets = [];
        if (watchdog) clearInterval(watchdog);
        watchdog = undefined;
      }
      function reconnect(reason: string) {
        if (disposed || stopped) return;
        if (retry) clearTimeout(retry);
        closeSockets();
        tracker.disconnect(Date.now(), reason);
        failures++;
        const delay = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6)) + Math.floor(Math.random() * 500);
        retry = setTimeout(connect, delay);
        publish();
      }
      function connect() {
        retry = undefined;
        if (disposed || stopped) return;
        const current = ++generation;
        const opened = new Set<WebSocket>();
        const received = new Map<WebSocket, number>();
        const startedAt = Date.now();
        try {
          for (const url of marketStreamUrls(market)) sockets.push(new WebSocket(url));
          for (const socket of sockets) {
            socket.onopen = () => {
              if (disposed || current !== generation) return;
              opened.add(socket); received.set(socket, Date.now());
              if (opened.size === sockets.length) { openedAt = Date.now(); tracker.connect(openedAt); publish(); }
            };
            socket.onmessage = event => {
              if (disposed || current !== generation) return;
              if (typeof event.data !== 'string' || event.data.length > 100_000) { reconnect('行情消息无法校验，重新积累'); return; }
              const now = Date.now();
              try {
                const data: unknown = JSON.parse(event.data);
                if (tracker.ingest(data, now)) received.set(socket, now);
              } catch { reconnect('行情消息无法解析，重新积累'); }
            };
            socket.onerror = () => { if (current === generation) reconnect('官方行情连接失败，稍后重试'); };
            socket.onclose = () => { if (current === generation) reconnect('连接已断开，5分钟窗口重新积累'); };
          }
          watchdog = setInterval(() => {
            if (disposed || current !== generation) return;
            const now = Date.now();
            if (opened.size !== sockets.length && now - startedAt > 12_000) reconnect('连接超时，稍后重试');
            else if (opened.size === sockets.length && [...received.values()].some(time => now - time > LIVE_SILENCE_MS)) reconnect('行情超过30秒未更新，重新连接');
            else if (opened.size === sockets.length && now - openedAt > 60_000) failures = 0;
          }, 1000);
        } catch { reconnect('浏览器无法连接官方行情，稍后重试'); }
      }
      connect();
      return { close() { disposed = true; if (retry) clearTimeout(retry); closeSockets(); }, restart: reconnect };
    }

    subscriptions.push(subscribe(target));
    async function loadSpot() {
      try {
        const response = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbol=${encodeURIComponent(baseAsset! + 'USDT')}`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), cache: 'no-store' });
        if (stopped) return;
        if (response.status === 400) { fixed.spot = emptyMarket('Binance 没有已核实的同币种 USDT 现货'); publish(); return; }
        if ([418, 429].includes(response.status)) {
          fixed.spot = emptyMarket('官方现货接口限流，已停止本次验证；不绕过限制'); publish(); return;
        }
        if ([403, 451].includes(response.status)) {
          fixed.spot = emptyMarket('官方现货接口访问受限；不使用替代地区连接'); publish(); return;
        }
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const market = verifySpotMarket(await response.json(), baseAsset!);
        if (stopped) return;
        if (market) subscriptions.push(subscribe(market));
        else fixed.spot = emptyMarket('未找到同一基础资产的可交易 USDT 现货');
        publish();
      } catch {
        if (stopped || controller.signal.aborted) return;
        fixed.spot = emptyMarket('官方现货信息暂不可用；不以零代替缺失'); publish();
        if (++metadataFailures < 3) metadataRetry = setTimeout(() => void loadSpot(), 30_000 * metadataFailures);
      }
    }
    void loadSpot();
    const timer = setInterval(() => {
      const now = Date.now();
      if (now < lastTick || now - lastTick > LIVE_PAUSE_MS) for (const subscription of subscriptions) subscription.restart('页面休眠后恢复，5分钟窗口重新积累');
      lastTick = now; publish();
    }, 1000);
    const visibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastTick > LIVE_PAUSE_MS) {
        for (const subscription of subscriptions) subscription.restart('页面恢复，重新积累连续窗口');
        lastTick = Date.now(); publish();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    publish();
    return () => {
      stopped = true; controller.abort(); clearInterval(timer);
      if (metadataRetry) clearTimeout(metadataRetry);
      document.removeEventListener('visibilitychange', visibility);
      for (const subscription of subscriptions) subscription.close();
    };
  }, [key, symbol, baseAsset, quoteAsset, multiplier]);

  // Do not flash the previous coin while its effect is waiting to clean up.
  return state.key === key ? state.markets : placeholder;
}
