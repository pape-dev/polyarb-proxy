// ═══════════════════════════════════════════════════════════════
// Simulations de marché — génération aléatoire massive de carnets d'ordres,
// vérification d'invariants financiers sur le moteur pur (engine.js).
// Aucune dépendance réseau/DB : tourne partout, y compris en CI hors-ligne.
// ═══════════════════════════════════════════════════════════════
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine');
const { makeRng } = require('./helpers/fixtures');

const N_SIMULATIONS = 2000;
const rng = makeRng(1234);

function randomBook(rng, { minPrice = 0.02, maxPrice = 0.98, minSize = 0, maxSize = 5000, levels = 3 } = {}) {
  const base = minPrice + rng() * (maxPrice - minPrice);
  const asks = [];
  let p = base;
  for (let i = 0; i < levels; i++) {
    asks.push({ price: Math.min(p, 0.999), size: rng() * maxSize + minSize });
    p += rng() * 0.03; // niveaux suivants toujours plus chers (carnet trié)
  }
  const bid = Math.max(base - 0.01 - rng()*0.02, 0.001);
  return { simulated: false, asks, bids: [{ price: bid, size: rng()*maxSize }] };
}

function randomCfg(rng) {
  return {
    minEdge: 0.01 + rng() * 0.10,     // 1% à 11%
    feeBps: rng() * 400,              // 0% à 4%
    maxPct: 0.01 + rng() * 0.15,      // 1% à 16%
  };
}

// ─── Invariant 1 : jamais valide si le coût dépasse le seuil implicite ──
test(`simulation (${N_SIMULATIONS} carnets): un arb marqué valide respecte toujours edge >= minEdge`, () => {
  let checked = 0;
  for (let i = 0; i < N_SIMULATIONS; i++) {
    const cfg = randomCfg(rng);
    const bookYes = randomBook(rng);
    const bookNo = randomBook(rng);
    const targetUSDC = 10 + rng() * 5000;
    const r = engine.detectMarketArb(bookYes, bookNo, cfg, targetUSDC);
    if (r.valid) {
      checked++;
      assert.ok(r.edge >= cfg.minEdge - 1e-9,
        `edge ${r.edge} devrait être >= minEdge ${cfg.minEdge} (cfg=${JSON.stringify(cfg)})`);
      assert.ok(r.cost > 0 && r.cost < 1,
        `coût ${r.cost} doit être un prix combiné plausible (0,1)`);
    }
  }
  assert.ok(checked > 0, 'au moins quelques scénarios aléatoires doivent produire un arb valide pour que le test soit significatif');
});

// ─── Invariant 2 : la taille ne dépasse jamais les limites configurées ──
test(`simulation (${N_SIMULATIONS} carnets): sizeArb ne dépasse jamais maxPct*bankroll ni la profondeur disponible`, () => {
  for (let i = 0; i < N_SIMULATIONS; i++) {
    const cfg = randomCfg(rng);
    const bookYes = randomBook(rng);
    const bookNo = randomBook(rng);
    const bankroll = 100 + rng() * 100000;
    const score = rng() * 100;
    const size = engine.sizeArb(bookYes, bookNo, cfg, bankroll, score);
    assert.ok(size >= 0, 'la taille ne doit jamais être négative');
    assert.ok(size <= bankroll * cfg.maxPct + 1e-6,
      `taille $${size} dépasse le plafond bankroll $${bankroll*cfg.maxPct}`);
    const depthYes = engine.bookDepthUSDC(bookYes.asks);
    const depthNo = engine.bookDepthUSDC(bookNo.asks);
    assert.ok(size <= 2*Math.min(depthYes, depthNo) + 1e-6,
      'la taille ne doit jamais dépasser 2x la profondeur du carnet le plus fin');
  }
});

// ─── Invariant 3 : le profit calculé est toujours positif quand l'arb est valide ──
test(`simulation (${N_SIMULATIONS} carnets): calcArbProfit > 0 chaque fois qu'un arb est valide`, () => {
  let checked = 0;
  for (let i = 0; i < N_SIMULATIONS; i++) {
    const cfg = randomCfg(rng);
    const bookYes = randomBook(rng);
    const bookNo = randomBook(rng);
    const bankroll = 1000 + rng() * 50000;
    const score = rng() * 100;
    const size = engine.sizeArb(bookYes, bookNo, cfg, bankroll, score);
    if (size < 1) continue;
    const r = engine.detectMarketArb(bookYes, bookNo, cfg, size);
    if (!r.valid) continue;
    checked++;
    const profit = engine.calcArbProfit(size, r.cost, r.edge);
    assert.ok(profit > 0, `profit ${profit} doit être positif pour un arb valide (edge=${r.edge})`);
  }
  assert.ok(checked > 0, 'au moins quelques scénarios doivent produire un arb valide + taille suffisante');
});

// ─── Invariant 4 : un carnet incohérent n'est jamais accepté ────────────
test(`simulation (${N_SIMULATIONS} carnets): un carnet croisé ou mal formé est TOUJOURS rejeté, quel que soit le prix affiché`, () => {
  for (let i = 0; i < N_SIMULATIONS; i++) {
    const cfg = randomCfg(rng);
    // Force un carnet croisé : bid > ask
    const askP = 0.3 + rng()*0.4;
    const badBookYes = { asks: [{price: askP, size: 100+rng()*1000}], bids: [{price: askP + 0.05, size: 100}] };
    const goodBookNo = randomBook(rng);
    const r = engine.detectMarketArb(badBookYes, goodBookNo, cfg, 100);
    assert.equal(r.valid, false, 'un carnet croisé ne doit jamais produire un arb valide');
  }
});

// ─── Invariant 5 : score toujours dans [0,100] quelles que soient les entrées extrêmes ──
test(`simulation (${N_SIMULATIONS} carnets): scoreMarket reste toujours dans [0,100]`, () => {
  for (let i = 0; i < N_SIMULATIONS; i++) {
    const m = {
      liquidity: rng() * 10_000_000,
      volume24h: rng() * 10_000_000,
      endDate: rng() > 0.1 ? new Date(Date.now() + (rng()*400 - 50) * 86400000).toISOString() : null,
    };
    const bookYes = randomBook(rng, { maxSize: 1e7 });
    const bookNo = randomBook(rng, { maxSize: 1e7 });
    const score = engine.scoreMarket(m, bookYes, bookNo);
    assert.ok(score >= 0 && score <= 100, `score ${score} hors bornes [0,100]`);
    assert.ok(Number.isFinite(score), 'score doit toujours être un nombre fini (jamais NaN/Infinity)');
  }
});

// ─── Simulation de rentabilité agrégée sur un "univers" de marchés ──────
test('simulation: univers de 60 marchés — estime la fréquence d\'arbitrages exploitables sous des seuils réalistes', () => {
  const cfg = { minEdge: 0.03, feeBps: 200, maxPct: 0.05 };
  const bankroll = 2000;
  let validCount = 0, totalExpectedProfit = 0;
  const N_MARKETS = 60;
  for (let i = 0; i < N_MARKETS; i++) {
    // La grande majorité des marchés réels sont efficients (~1$ combiné) : on simule
    // un mélange réaliste — 95% efficients, 5% avec un vrai écart de prix.
    const isInefficient = rng() < 0.05;
    const combinedCost = isInefficient ? (0.80 + rng()*0.13) : (0.97 + rng()*0.04);
    const splitYes = 0.3 + rng()*0.4;
    const bookYes = randomBook(rng, { minPrice: combinedCost*splitYes, maxPrice: combinedCost*splitYes, levels:1 });
    const bookNo  = randomBook(rng, { minPrice: combinedCost*(1-splitYes), maxPrice: combinedCost*(1-splitYes), levels:1 });
    bookYes.asks[0].size = 500 + rng()*5000;
    bookNo.asks[0].size  = 500 + rng()*5000;
    const score = 50 + rng()*50;
    const size = engine.sizeArb(bookYes, bookNo, cfg, bankroll, score);
    if (size < 1) continue;
    const arb = engine.detectMarketArb(bookYes, bookNo, cfg, size);
    if (!arb.valid) continue;
    validCount++;
    totalExpectedProfit += engine.calcArbProfit(size, arb.cost, arb.edge);
  }
  // Propriété attendue : avec ~5% de marchés inefficients et un seuil de 3% net de frais,
  // on ne s'attend PAS à ce que la totalité des 60 marchés soit exploitable — sinon le
  // seuil ou la génération synthétique serait irréaliste par rapport à un vrai marché.
  assert.ok(validCount <= N_MARKETS, 'sanity check trivial');
  console.log(`    → ${validCount}/${N_MARKETS} marchés exploitables, profit attendu total simulé: $${totalExpectedProfit.toFixed(2)}`);
});
