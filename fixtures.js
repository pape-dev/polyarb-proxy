// ═══════════════════════════════════════════════════════════════
// Fixtures partagées — générateurs de données synthétiques pour les tests
// ═══════════════════════════════════════════════════════════════
'use strict';

/** Carnet d'ordres synthétique. askPrice/bidPrice = meilleur niveau, depth = taille dispo.
 * bidPrice par défaut est dérivé de askPrice (spread de 2¢) plutôt qu'une valeur absolue
 * fixe — sinon personnaliser askPrice seul produirait un carnet croisé invalide par accident. */
function makeBook({ askPrice = 0.5, askSize = 1000, bidPrice, bidSize = 1000, simulated = false, extraAsks = [], extraBids = [] } = {}) {
  const resolvedBid = bidPrice !== undefined ? bidPrice : Math.max(askPrice - 0.02, 0.001);
  return {
    simulated,
    asks: [{ price: askPrice, size: askSize }, ...extraAsks],
    bids: [{ price: resolvedBid, size: bidSize }, ...extraBids],
  };
}

/** Marché synthétique conforme à la forme produite par parseSingleMarkets(). */
function makeMarket(overrides = {}) {
  return {
    id: overrides.id ?? 'test-market-slug',
    slug: overrides.slug ?? overrides.id ?? 'test-market-slug',
    title: overrides.title ?? 'Test market question?',
    tokenYes: overrides.tokenYes ?? 'token-yes-123',
    tokenNo: overrides.tokenNo ?? 'token-no-456',
    volume24h: overrides.volume24h ?? 10000,
    liquidity: overrides.liquidity ?? 5000,
    endDate: overrides.endDate ?? new Date(Date.now() + 86400000).toISOString(),
    category: overrides.category ?? 'AUTRE',
    emoji: overrides.emoji ?? '•',
    bookYes: overrides.bookYes ?? null,
    bookNo: overrides.bookNo ?? null,
    arb: overrides.arb ?? { valid:false, reason:'INIT' },
    sizeUSDC: overrides.sizeUSDC ?? 0,
    closed: overrides.closed ?? false,
  };
}

/** Cru Gamma API brut minimal, tel que renvoyé par gamma-api.polymarket.com/markets. */
function makeRawGammaMarket(overrides = {}) {
  const base = {
    slug: overrides.slug ?? 'raw-market-slug',
    question: overrides.question ?? 'Will X happen?',
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
    volume24hr: overrides.volume24hr ?? 10000,
    liquidity: overrides.liquidity ?? 5000,
    endDate: overrides.endDate ?? new Date(Date.now() + 86400000).toISOString(),
    clobTokenIds: overrides.clobTokenIds !== undefined ? overrides.clobTokenIds : ['111111111111111111', '222222222222222222'],
  };
  return { ...base, ...overrides };
}

/** Générateur pseudo-aléatoire déterministe (seedable) — reproductibilité des simulations. */
function makeRng(seed = 42) {
  let s = seed >>> 0;
  return function rng() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

module.exports = { makeBook, makeMarket, makeRawGammaMarket, makeRng };
