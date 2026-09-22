/** Explicitly reviewed unit mappings; never infer token identity by stripping digits. */
export interface UnitAlias {
  symbol: string;
  geckoId: string;
  multiplier: number;
  acceptedGeckoIds: string[];
  evidence: string;
}

export const UNIT_ALIASES: Readonly<Record<string, UnitAlias>> = {
  '1000BONK': {
    symbol: 'BONK', geckoId: 'bonk', multiplier: 1000,
    acceptedGeckoIds: ['1000bonk', 'bonk'],
    evidence: 'https://www.coingecko.com/en/coins/1000bonk',
  },
  '1000SHIB': {
    symbol: 'SHIB', geckoId: 'shiba-inu', multiplier: 1000,
    acceptedGeckoIds: ['1000shib', 'shiba-inu'],
    evidence: 'https://www.coingecko.com/en/coins/1000shib',
  },
  '1000RATS': {
    symbol: 'RATS', geckoId: 'rats', multiplier: 1000,
    acceptedGeckoIds: ['1000rats', 'rats'],
    evidence: 'https://www.coingecko.com/en/coins/1000rats',
  },
  '1000PEPE': {
    symbol: 'PEPE', geckoId: 'pepe', multiplier: 1000,
    acceptedGeckoIds: ['pepe', '1000pepe'],
    evidence: 'https://www.binance.com/en/futures/1000PEPEUSDT',
  },
  '1000000MOG': {
    symbol: 'MOG', geckoId: 'mog-coin', multiplier: 1000000,
    acceptedGeckoIds: ['mog-coin'],
    evidence: 'https://www.binance.com/en/futures/1000000MOGUSDT',
  },
  '1MBABYDOGE': {
    symbol: 'BABYDOGE', geckoId: 'baby-doge-coin', multiplier: 1000000,
    acceptedGeckoIds: ['baby-doge-coin'],
    evidence: 'https://www.binance.com/en/support/announcement/detail/4336ae4908154736acff8302509f7a05',
  },
};

/** Reviewed against Binance listing notices and provider token contracts on 2026-09-22.
 * Provider exchange tickers are candidates, not infallible identities: both examples below
 * were misidentified by CoinGecko's Binance derivatives endpoint during live acceptance.
 */
export const IDENTITY_OVERRIDES: Readonly<Record<string, {
  symbol: string; geckoId: string; cmcId: number; chain: string; address?: string; sources: string[];
}>> = {
  BTC: {
    symbol: 'BTC', geckoId: 'bitcoin', cmcId: 1, chain: 'Bitcoin',
    sources: ['https://www.binance.com/en/futures/BTCUSDT', 'https://coinmarketcap.com/currencies/bitcoin/', 'https://www.coingecko.com/en/coins/bitcoin'],
  },
  ETH: {
    symbol: 'ETH', geckoId: 'ethereum', cmcId: 1027, chain: 'Ethereum',
    sources: ['https://www.binance.com/en/futures/ETHUSDT', 'https://coinmarketcap.com/currencies/ethereum/', 'https://www.coingecko.com/en/coins/ethereum'],
  },
  NEIRO: {
    symbol: 'NEIRO', geckoId: 'neiro-3', cmcId: 32521, chain: 'Ethereum',
    address: '0x812ba41e071c7b7fa4ebcfb62df5f45f6fa853ee',
    sources: [
      'https://www.binance.com/en-AE/support/announcement/detail/4336ae4908154736acff8302509f7a05',
      'https://www.coingecko.com/en/coins/neiro-3',
      'https://coinmarketcap.com/currencies/neiro/',
    ],
  },
  PUMP: {
    symbol: 'PUMP', geckoId: 'pump-fun', cmcId: 36507, chain: 'Solana',
    address: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
    sources: [
      'https://www.binance.com/en-AE/support/announcement/detail/4bc8b483d10d4619babb2015066b2d89',
      'https://www.coingecko.com/en/coins/pump-fun',
      'https://pro-api.coinmarketcap.com/public-api/v1/cryptocurrency/map?symbol=PUMP',
    ],
  },
};
