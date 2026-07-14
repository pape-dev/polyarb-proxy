// ═══════════════════════════════════════════════════════════════
// Tests unitaires — engine.js v12 (moteur pur, aucune dépendance externe)
// ═══════════════════════════════════════════════════════════════
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine');
const { makeBook, makeMarket } = require('./helpers/fixtures');

// ─── clamp ──────────────────────────────────────────────────────
test('clamp: borne en dessous du minimum', () => {
  assert.equal(engine.clamp(-5, 0, 10), 0);
});
test('clamp: borne au-dessus du maximum', () => {
  assert.equal(engine.clamp(15, 0, 10), 10);
});
test('clamp: laisse passer une valeur dans l\'intervalle', () => {
  assert.equal(engine.clamp(5, 0, 10), 5);
});

// ─── categorize ─────────────────────────────────────────────────
test('categorize: détecte CRYPTO via mot-clé', () => {
  assert.equal(engine.categorize('Will Bitcoin hit $100k?', 'will-bitcoin-hit-100k').id, 'CRYPTO');
});
test('categorize: détecte SPORTS via mot-clé', () => {
  assert.equal(engine.categorize('Will the Lakers win tonight?', 'lakers-win-tonight').id, 'SPORTS');
});
test('categorize: retombe sur AUTRE si aucun mot-clé ne correspond', () => {
  assert.equal(engine.categorize('Some obscure niche question', 'obscure-niche-question').id, 'AUTRE');
});

// ─── calcSharpe ─────────────────────────────────────────────────
test('calcSharpe: 0 pour moins de 2 valeurs', () => {
  assert.equal(engine.calcSharpe([]), 0);
  assert.equal(engine.calcSharpe([0.05]), 0);
});
test('calcSharpe: 0 quand l\'écart-type est nul', () => {
  assert.equal(engine.calcSharpe([0.02, 0.02, 0.02]), 0);
});
test('calcSharpe: positif pour des rendements positifs avec variance', () => {
  assert.ok(engine.calcSharpe([0.01, 0.02, 0.015, 0.018, 0.012]) > 0);
});

// ─── validateBookSanity — contrôle de cohérence des données ────
test('validateBookSanity: rejette un carnet manquant', () => {
  assert.equal(engine.validateBookSanity(null).ok, false);
});
test('validateBookSanity: rejette un carnet marqué "simulated" (échec réseau)', () => {
  assert.equal(engine.validateBookSanity({ simulated:true, asks:[] }).ok, false);
});
test('validateBookSanity: rejette un carnet sans niveau ask', () => {
  assert.equal(engine.validateBookSanity({ asks:[], bids:[] }).ok, false);
  assert.equal(engine.validateBookSanity({ asks:[], bids:[] }).reason, 'NO_ASKS');
});
test('validateBookSanity: rejette un prix invalide (négatif, >=1, NaN)', () => {
  assert.equal(engine.validateBookSanity({ asks:[{price:-0.1,size:10}] }).ok, false);
  assert.equal(engine.validateBookSanity({ asks:[{price:1.5,size:10}] }).ok, false);
  assert.equal(engine.validateBookSanity({ asks:[{price:NaN,size:10}] }).ok, false);
});
test('validateBookSanity: rejette une taille nulle ou négative', () => {
  assert.equal(engine.validateBookSanity({ asks:[{price:0.5,size:0}] }).ok, false);
});
test('validateBookSanity: rejette un carnet mal trié (prix décroissant sur les asks)', () => {
  const r = engine.validateBookSanity({ asks:[{price:0.5,size:10},{price:0.4,size:10}] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'UNSORTED_BOOK');
});
test('validateBookSanity: rejette un carnet croisé (meilleur bid >= meilleur ask)', () => {
  const r = engine.validateBookSanity({ asks:[{price:0.5,size:10}], bids:[{price:0.55,size:10}] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CROSSED_BOOK');
});
test('validateBookSanity: accepte un carnet propre et cohérent', () => {
  const r = engine.validateBookSanity({ asks:[{price:0.5,size:10},{price:0.52,size:20}], bids:[{price:0.48,size:10}] });
  assert.equal(r.ok, true);
});

// ─── bookDepthUSDC ──────────────────────────────────────────────
test('bookDepthUSDC: somme correctement prix×taille sur tous les niveaux', () => {
  const depth = engine.bookDepthUSDC([{price:0.5,size:100},{price:0.6,size:50}]);
  assert.ok(Math.abs(depth - (50+30)) < 1e-9);
});
test('bookDepthUSDC: retourne 0 pour un tableau vide/absent', () => {
  assert.equal(engine.bookDepthUSDC([]), 0);
  assert.equal(engine.bookDepthUSDC(undefined), 0);
});

// ─── weightedFill — prix moyen pondéré multi-niveaux ───────────
test('weightedFill: reste au meilleur prix si un seul niveau suffit', () => {
  const r = engine.weightedFill([{price:0.5,size:1000}], 100);
  assert.ok(Math.abs(r.avgPrice - 0.5) < 1e-9);
  assert.equal(r.filledFully, true);
});
test('weightedFill: doit descendre sur un 2e niveau si le 1er ne suffit pas — prix moyen dégradé', () => {
  // Niveau 1: $50 dispo à 0.50 → puis niveau 2 à 0.60 pour le reste
  const r = engine.weightedFill([{price:0.50,size:100},{price:0.60,size:1000}], 100);
  // 50$ au niveau 1 (100 parts à 0.50), 50$ au niveau 2 (83.33 parts à 0.60)
  assert.ok(r.avgPrice > 0.50 && r.avgPrice < 0.60, `prix moyen attendu entre 0.50 et 0.60, reçu ${r.avgPrice}`);
  assert.equal(r.filledFully, true);
});
test('weightedFill: filledFully=false si la profondeur totale est insuffisante', () => {
  const r = engine.weightedFill([{price:0.5,size:10}], 1000); // seulement $5 dispo
  assert.equal(r.filledFully, false);
});
test('weightedFill: avgPrice null si aucune part ne peut être acquise', () => {
  const r = engine.weightedFill([], 100);
  assert.equal(r.avgPrice, null);
});

// ─── detectMarketArb — le cœur du système (API v12: nécessite targetUSDC) ──
test('detectMarketArb: invalide si le carnet OUI est absent/invalide', () => {
  const r = engine.detectMarketArb(null, makeBook({askPrice:0.4}), { minEdge:0.03, feeBps:200 }, 100);
  assert.equal(r.valid, false);
  assert.ok(r.reason.startsWith('YES_'));
});
test('detectMarketArb: invalide si le carnet NON est absent/invalide', () => {
  const r = engine.detectMarketArb(makeBook({askPrice:0.4}), null, { minEdge:0.03, feeBps:200 }, 100);
  assert.equal(r.valid, false);
  assert.ok(r.reason.startsWith('NO_'));
});
test('detectMarketArb: invalide si targetUSDC est nul ou absent (SIZE_NULLE) — régression', () => {
  // [régression] c'est exactement le bug trouvé en prod : appeler sans taille cible
  // retournait TOUJOURS invalide, quel que soit l'état réel du marché.
  const bookYes = makeBook({ askPrice: 0.40, askSize: 1000 });
  const bookNo  = makeBook({ askPrice: 0.45, askSize: 1000 });
  const cfg = { minEdge: 0.03, feeBps: 200 };
  assert.equal(engine.detectMarketArb(bookYes, bookNo, cfg).valid, false);
  assert.equal(engine.detectMarketArb(bookYes, bookNo, cfg, 0).valid, false);
  assert.equal(engine.detectMarketArb(bookYes, bookNo, cfg).reason, 'SIZE_NULLE');
  // ...mais AVEC une taille cible valide, le même marché doit être détecté correctement
  assert.equal(engine.detectMarketArb(bookYes, bookNo, cfg, 100).valid, true);
});

test('detectMarketArb: valide quand OUI+NON coûte nettement moins de 1$ net de frais', () => {
  const cfg = { minEdge: 0.03, feeBps: 200 };
  const bookYes = makeBook({ askPrice: 0.45, askSize: 1000 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000 });
  const r = engine.detectMarketArb(bookYes, bookNo, cfg, 100);
  assert.equal(r.valid, true);
  assert.ok(Math.abs(r.cost - 0.85) < 1e-6, `coût attendu ~0.85, reçu ${r.cost}`);
  assert.ok(Math.abs(r.edge - 0.13) < 1e-6, `edge attendu ~0.13, reçu ${r.edge}`);
});

test('detectMarketArb: [v13] la profondeur commune limitante est correctement identifiée via depthLimited/commonShares', () => {
  const cfg = { minEdge: 0.03, feeBps: 200 };
  const bookYes = makeBook({ askPrice: 0.45, askSize: 1 });   // seulement 1 part disponible côté OUI
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000 });
  const r = engine.detectMarketArb(bookYes, bookNo, cfg, 1000); // budget largement suffisant, mais profondeur OUI très limitée
  assert.equal(r.valid, true, 'même 1 seule part doit rester un arb valide si l\'edge tient');
  assert.equal(r.commonShares, 1, 'la taille commune doit être bornée par le côté le plus fin (1 part OUI dispo)');
  assert.equal(r.depthLimited, true, 'la contrainte limitante doit être identifiée comme la profondeur, pas le budget');
  assert.equal(r.roundedShares, 1, 'on ne doit jamais prétendre pouvoir acheter plus que la profondeur réellement commune');
});

test('detectMarketArb: rejette (SIZE_TROP_PETITE) quand la quantité obtenue s\'arrondit à zéro part', () => {
  const cfg = { minEdge: 0.0, feeBps: 0 };
  // Profondeur dérisoire (moins de 0.01 part obtenable après arrondi à 2 décimales)
  const bookYes = makeBook({ askPrice: 0.50, askSize: 0.001 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000 });
  const r = engine.detectMarketArb(bookYes, bookNo, cfg, 100);
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'SIZE_TROP_PETITE');
});

test('detectMarketArb: les frais réduisent bien l\'edge net', () => {
  const bookYes = makeBook({ askPrice: 0.45, askSize: 1000 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000 });
  const sansFrais = engine.detectMarketArb(bookYes, bookNo, { minEdge: 0.03, feeBps: 0 }, 100);
  const avecFrais = engine.detectMarketArb(bookYes, bookNo, { minEdge: 0.03, feeBps: 500 }, 100);
  assert.ok(avecFrais.edge < sansFrais.edge, 'les frais doivent réduire l\'edge net');
  assert.ok(Math.abs(sansFrais.edge - 0.15) < 1e-6);
  assert.ok(Math.abs(avecFrais.edge - 0.10) < 1e-6);
});

test('detectMarketArb: le coût réel se dégrade (edge diminue) quand la taille demandée dépasse le meilleur niveau', () => {
  const cfg = { minEdge: 0.0, feeBps: 0 };
  const bookYes = makeBook({ askPrice: 0.45, askSize: 100, extraAsks: [{price:0.55, size:1000}] });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000 });
  const petit  = engine.detectMarketArb(bookYes, bookNo, cfg, 10);   // reste au meilleur niveau
  const grand  = engine.detectMarketArb(bookYes, bookNo, cfg, 500);  // doit descendre au 2e niveau OUI
  assert.ok(grand.edge < petit.edge, 'l\'edge doit se dégrader quand on consomme plus de profondeur (VWAP)');
});

test('detectMarketArb: arrondit les parts à 2 décimales (contrainte Polymarket)', () => {
  const cfg = { minEdge: 0.0, feeBps: 0 };
  const bookYes = makeBook({ askPrice: 0.333333, askSize: 1000 });
  const bookNo  = makeBook({ askPrice: 0.333333, askSize: 1000 });
  const r = engine.detectMarketArb(bookYes, bookNo, cfg, 100);
  assert.ok(r.valid);
  assert.equal(r.roundedShares, Math.floor(r.roundedShares*100)/100, 'roundedShares doit avoir au plus 2 décimales');
});

// ─── sizeArb ────────────────────────────────────────────────────
test('sizeArb: retourne 0 si un des deux carnets est vide', () => {
  const cfg = { maxPct: 0.05 };
  assert.equal(engine.sizeArb(makeBook(), { asks: [] }, cfg, 2000), 0);
});

test('sizeArb: plafonné par la profondeur réelle du carnet le plus fin (×2 car 2 jambes)', () => {
  const cfg = { maxPct: 1.0 };
  const bookYes = makeBook({ askPrice: 0.50, askSize: 1000 }); // profondeur $500
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 10 });   // profondeur $4 ← limitant
  const size = engine.sizeArb(bookYes, bookNo, cfg, 100000);
  assert.ok(Math.abs(size - 8) < 1e-6, `attendu ~$8 (2×profondeur limitante $4), reçu $${size}`);
});

test('sizeArb: plafonné par maxPct*bankroll même si la profondeur est énorme', () => {
  const cfg = { maxPct: 0.05 };
  const bookYes = makeBook({ askPrice: 0.50, askSize: 1000000 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000000 });
  const size = engine.sizeArb(bookYes, bookNo, cfg, 2000);
  assert.ok(Math.abs(size - 100) < 1e-6, `attendu $100 (5% de $2000), reçu $${size}`);
});

test('sizeArb: un score bas réduit la taille allouée (limitation dynamique)', () => {
  const cfg = { maxPct: 1.0 };
  const bookYes = makeBook({ askPrice: 0.50, askSize: 1000000 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 1000000 });
  const sizeBonScore = engine.sizeArb(bookYes, bookNo, cfg, 2000, 100);
  const sizeScoreBas = engine.sizeArb(bookYes, bookNo, cfg, 2000, 25);
  assert.ok(sizeScoreBas < sizeBonScore, 'un score plus bas doit réduire la taille allouée');
});

test('sizeArb: jamais négatif', () => {
  assert.ok(engine.sizeArb(null, null, { maxPct: 0.05 }, 2000) >= 0);
});

// ─── calcArbProfit ──────────────────────────────────────────────
test('calcArbProfit: cohérent avec la formule taille×edge/coût', () => {
  assert.ok(Math.abs(engine.calcArbProfit(100, 0.85, 0.13) - (100*0.13/0.85)) < 1e-9);
});
test('calcArbProfit: profit nul si edge nul', () => {
  assert.equal(engine.calcArbProfit(100, 0.9, 0), 0);
});

// ─── scoreMarket — notation composite ──────────────────────────
test('scoreMarket: un marché liquide, profond, actif et proche de résolution obtient un score élevé', () => {
  const m = makeMarket({ liquidity: 100000, volume24h: 100000, endDate: new Date(Date.now()+2*86400000).toISOString() });
  const bookYes = makeBook({ askPrice:0.50, askSize:10000, bidPrice:0.495 });
  const bookNo  = makeBook({ askPrice:0.40, askSize:10000, bidPrice:0.395 });
  const score = engine.scoreMarket(m, bookYes, bookNo);
  assert.ok(score >= 70, `score attendu élevé (≥70), reçu ${score}`);
});

test('scoreMarket: un marché sans liquidité ni volume ni profondeur obtient un score bas', () => {
  const m = makeMarket({ liquidity: 0, volume24h: 0, endDate: null });
  const bookYes = makeBook({ askPrice:0.50, askSize:1, bidPrice:0.10 });
  const bookNo  = makeBook({ askPrice:0.40, askSize:1, bidPrice:0.05 });
  const score = engine.scoreMarket(m, bookYes, bookNo);
  assert.ok(score < 40, `score attendu bas (<40), reçu ${score}`);
});

test('scoreMarket: pénalise une résolution déjà passée (daysLeft<0)', () => {
  const m = makeMarket({ endDate: new Date(Date.now()-86400000).toISOString() });
  const bookYes = makeBook(), bookNo = makeBook();
  const scoreExpired = engine.scoreMarket(m, bookYes, bookNo);
  const mFuture = makeMarket({ endDate: new Date(Date.now()+2*86400000).toISOString() });
  const scoreFuture = engine.scoreMarket(mFuture, bookYes, bookNo);
  assert.ok(scoreExpired < scoreFuture, 'un marché déjà expiré doit être moins bien noté');
});

test('scoreMarket: toujours borné entre 0 et 100', () => {
  const m = makeMarket({ liquidity: 999999999, volume24h: 999999999 });
  const bookYes = makeBook({ askSize: 999999999 }), bookNo = makeBook({ askSize: 999999999 });
  const score = engine.scoreMarket(m, bookYes, bookNo);
  assert.ok(score >= 0 && score <= 100);
});

// ─── computeHoldStats — statistiques avancées ──────────────────
test('computeHoldStats: valeurs neutres si aucune position clôturée', () => {
  const s = engine.computeHoldStats([]);
  assert.equal(s.avgHoldHours, 0);
  assert.equal(s.arbFrequencyPerDay, 0);
});

test('computeHoldStats: calcule une durée moyenne de détention cohérente', () => {
  const now = Date.now();
  const positions = [
    { status:'CLOSED', ts: new Date(now - 2*3600000).toISOString(), closedAt: new Date(now).toISOString(), pnlUSDC: 5, size: 100 },
    { status:'CLOSED', ts: new Date(now - 4*3600000).toISOString(), closedAt: new Date(now).toISOString(), pnlUSDC: 3, size: 100 },
  ];
  const s = engine.computeHoldStats(positions);
  assert.ok(Math.abs(s.avgHoldHours - 3) < 0.01, `durée moyenne attendue ~3h, reçu ${s.avgHoldHours}`);
});

test('computeHoldStats: ignore les positions encore ouvertes', () => {
  const positions = [{ status:'OPEN', ts: new Date().toISOString() }];
  const s = engine.computeHoldStats(positions);
  assert.equal(s.avgHoldHours, 0);
});

// ─── [v13] weightedFillByShares — remplissage par NOMBRE DE PARTS ──────
test('weightedFillByShares: reste au meilleur niveau si la profondeur y suffit', () => {
  const r = engine.weightedFillByShares([{price:0.5,size:1000}], 100);
  assert.ok(Math.abs(r.avgPrice - 0.5) < 1e-9);
  assert.equal(r.filledFully, true);
  assert.equal(r.levelsUsed, 1);
});
test('weightedFillByShares: descend sur plusieurs niveaux si nécessaire', () => {
  const r = engine.weightedFillByShares([{price:0.50,size:100},{price:0.60,size:1000}], 500);
  assert.ok(r.avgPrice > 0.50 && r.avgPrice < 0.60);
  assert.equal(r.levelsUsed, 2);
});
test('weightedFillByShares: filledFully=false si la profondeur totale est insuffisante', () => {
  const r = engine.weightedFillByShares([{price:0.5,size:10}], 1000);
  assert.equal(r.filledFully, false);
  assert.ok(Math.abs(r.sharesAcquired - 10) < 1e-9);
});
test('weightedFillByShares: respecte le plafond maxLevels même si plus de niveaux existent', () => {
  const levels = [{price:0.10,size:1},{price:0.20,size:1},{price:0.30,size:1000}];
  const r = engine.weightedFillByShares(levels, 500, 2); // ne doit consulter que les 2 premiers niveaux
  assert.equal(r.filledFully, false, 'le 3e niveau, plus profond, ne doit pas être consulté');
  assert.ok(Math.abs(r.sharesAcquired - 2) < 1e-9);
});

// ─── [v13] computeCommonArbitrableSize — taille commune multi-niveaux ──
test('computeCommonArbitrableSize: bornée par le côté le plus fin', () => {
  const bookYes = makeBook({ askPrice:0.5, askSize:1000 });
  const bookNo  = makeBook({ askPrice:0.4, askSize:50 });
  const r = engine.computeCommonArbitrableSize(bookYes, bookNo, 5);
  assert.equal(r.commonShares, 50);
});
test('computeCommonArbitrableSize: fonctionne sur plusieurs niveaux cumulés', () => {
  const bookYes = makeBook({ askPrice:0.5, askSize:10, extraAsks:[{price:0.55,size:10}] }); // 20 parts sur 2 niveaux
  const bookNo  = makeBook({ askPrice:0.4, askSize:1000 });
  const r = engine.computeCommonArbitrableSize(bookYes, bookNo, 5);
  assert.equal(r.commonShares, 20);
});
test('computeCommonArbitrableSize: retourne 0 si un carnet est vide', () => {
  const r = engine.computeCommonArbitrableSize({asks:[]}, makeBook(), 5);
  assert.equal(r.commonShares, 0);
});

// ─── [v13] computeArbitrableFill — combine profondeur ET budget ────────
test('computeArbitrableFill: le budget limite la taille quand la profondeur est abondante', () => {
  const bookYes = makeBook({ askPrice:0.5, askSize:1000000 });
  const bookNo  = makeBook({ askPrice:0.4, askSize:1000000 });
  const r = engine.computeArbitrableFill(bookYes, bookNo, 90, 5); // budget $90 pour coût unitaire ~0.9
  assert.equal(r.depthLimited, false);
  assert.ok(r.shares > 0 && r.shares < 1000000);
});
test('computeArbitrableFill: la profondeur limite la taille quand le budget est abondant', () => {
  const bookYes = makeBook({ askPrice:0.5, askSize:5 });
  const bookNo  = makeBook({ askPrice:0.4, askSize:1000 });
  const r = engine.computeArbitrableFill(bookYes, bookNo, 1_000_000, 5);
  assert.equal(r.depthLimited, true);
  assert.equal(r.shares, 5);
});
test('computeArbitrableFill: ne dépasse jamais le budget demandé (conservateur)', () => {
  const bookYes = makeBook({ askPrice:0.5, askSize:1000000 });
  const bookNo  = makeBook({ askPrice:0.4, askSize:1000000 });
  const r = engine.computeArbitrableFill(bookYes, bookNo, 90, 5);
  const realCost = r.shares * (r.fillYes.avgPrice + r.fillNo.avgPrice);
  assert.ok(realCost <= 90 + 1e-6, `coût réel $${realCost} ne doit jamais dépasser le budget visé $90`);
});

// ─── [v13] estimateSlippage ─────────────────────────────────────────────
test('estimateSlippage: 0 si le VWAP égale le meilleur prix (pas de dégradation)', () => {
  assert.equal(engine.estimateSlippage(0.5, 0.5), 0);
});
test('estimateSlippage: positif si le VWAP est pire que le meilleur prix', () => {
  assert.ok(Math.abs(engine.estimateSlippage(0.5, 0.55) - 0.10) < 1e-9);
});
test('estimateSlippage: 0 si bestAsk est invalide (pas de division par zéro/négatif)', () => {
  assert.equal(engine.estimateSlippage(0, 0.5), 0);
  assert.equal(engine.estimateSlippage(-1, 0.5), 0);
});

// ─── [v14-1] rankOpportunity — classement des opportunités simultanées ──
test('rankOpportunity: -Infinity pour un arb invalide (ne doit jamais être classé)', () => {
  const m = makeMarket({ arb: { valid:false, reason:'EDGE_BAS' } });
  assert.equal(engine.rankOpportunity(m), -Infinity);
});
test('rankOpportunity: un edge plus élevé produit un score plus élevé, toutes choses égales par ailleurs', () => {
  const base = { sizeUSDC:100, liquidity:10000, volume24h:10000, score:70 };
  const mBon  = makeMarket({ ...base, arb:{ valid:true, cost:0.85, edge:0.13, slippage:0.01 } });
  const mFaible = makeMarket({ ...base, arb:{ valid:true, cost:0.97, edge:0.01, slippage:0.01 } });
  assert.ok(engine.rankOpportunity(mBon) > engine.rankOpportunity(mFaible));
});
test('rankOpportunity: un slippage plus élevé pénalise le score, toutes choses égales par ailleurs', () => {
  const base = { sizeUSDC:100, liquidity:10000, volume24h:10000, score:70, arb:{ valid:true, cost:0.85, edge:0.13 } };
  const mPropre = makeMarket({ ...base, arb:{ ...base.arb, slippage:0.001 } });
  const mGlissant = makeMarket({ ...base, arb:{ ...base.arb, slippage:0.20 } });
  assert.ok(engine.rankOpportunity(mPropre) > engine.rankOpportunity(mGlissant));
});
test('rankOpportunity: trier un tableau à une seule opportunité valide ne change rien (comportement préservé)', () => {
  const m = makeMarket({ arb:{ valid:true, cost:0.9, edge:0.05, slippage:0.01 } });
  const arr = [m];
  const sorted = [...arr].sort((a,b)=>engine.rankOpportunity(b)-engine.rankOpportunity(a));
  assert.deepEqual(sorted, arr);
});
test('rankOpportunity: classe correctement plusieurs opportunités par ordre décroissant de qualité', () => {
  const excellent = makeMarket({ id:'m1', sizeUSDC:500, liquidity:100000, volume24h:100000, score:90, arb:{ valid:true, cost:0.80, edge:0.18, slippage:0.005 } });
  const mediocre  = makeMarket({ id:'m2', sizeUSDC:20,  liquidity:500,   volume24h:500,   score:35, arb:{ valid:true, cost:0.965, edge:0.015, slippage:0.03 } });
  const sorted = [mediocre, excellent].sort((a,b)=>engine.rankOpportunity(b)-engine.rankOpportunity(a));
  assert.equal(sorted[0].id, 'm1', 'la meilleure opportunité doit être classée en premier');
});

// ─── [v14-2] computeRejectedStats — agrégation du journal de rejets ────
test('computeRejectedStats: valeurs neutres sur un journal vide', () => {
  const s = engine.computeRejectedStats([]);
  assert.equal(s.totalRejected, 0);
  assert.equal(s.mostCommonReason, null);
});
test('computeRejectedStats: identifie correctement la raison la plus fréquente (regroupée par type, pas par message exact)', () => {
  const rejected = [
    { reason:'edge=-2.1%<3%', category:'SPORTS', edge:-0.021 },
    { reason:'edge=-4.5%<3%', category:'POLITICS', edge:-0.045 },
    { reason:'edge=-1.0%<3%', category:'SPORTS', edge:-0.01 },
    { reason:'SCORE_BAS(24<30)', category:'AUTRE', edge:null },
  ];
  const s = engine.computeRejectedStats(rejected);
  assert.equal(s.mostCommonReason, 'edge', 'les 3 messages "edge=...%<3%" doivent être regroupés sous le même type');
  assert.equal(s.totalRejected, 4);
});
test('computeRejectedStats: calcule l\'edge moyen uniquement sur les entrées où il est connu', () => {
  const rejected = [{ reason:'x', edge:-0.05 }, { reason:'y', edge:-0.03 }, { reason:'z', edge:null }];
  const s = engine.computeRejectedStats(rejected);
  assert.ok(Math.abs(s.avgRejectedEdge - (-0.04)) < 1e-9);
});
test('computeRejectedStats: le profit théorique non réalisé ne compte que les edges positifs refusés', () => {
  const rejected = [
    { reason:'SCORE_BAS', edge:0.05 },  // vrai arb refusé pour une autre raison → profit perdu
    { reason:'edge_bas', edge:-0.02 },  // pas un vrai arb → ne compte pas comme profit perdu
  ];
  const s = engine.computeRejectedStats(rejected);
  assert.ok(Math.abs(s.theoreticalUnrealizedProfit - 0.05) < 1e-9);
});
test('computeRejectedStats: répartition par catégorie correcte', () => {
  const rejected = [{category:'SPORTS',reason:'a'},{category:'SPORTS',reason:'b'},{category:'POLITICS',reason:'c'}];
  const s = engine.computeRejectedStats(rejected);
  assert.equal(s.byCategory.SPORTS, 2);
  assert.equal(s.byCategory.POLITICS, 1);
});
test('computeRejectedStats: n\'est jamais appelée automatiquement pour modifier des paramètres (vérification de contrat: pure fonction, aucun effet de bord)', () => {
  const rejected = [{reason:'a',edge:0.01}];
  const copy = JSON.parse(JSON.stringify(rejected));
  engine.computeRejectedStats(rejected);
  assert.deepEqual(rejected, copy, 'le tableau source ne doit jamais être modifié par cette fonction');
});

// ─── [v15-5] computeAdvancedStats — métriques de performance avancées ──
test('computeAdvancedStats: valeurs neutres sans aucune position clôturée', () => {
  const s = engine.computeAdvancedStats([]);
  assert.equal(s.profitFactor, 0);
  assert.equal(s.maxDrawdownPct, 0);
  assert.equal(s.expectancy, 0);
});
test('computeAdvancedStats: profitFactor = Infinity si aucune perte', () => {
  const positions = [
    { status:'CLOSED', pnlUSDC:10, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T01:00:00Z' },
    { status:'CLOSED', pnlUSDC:5,  ts:'2026-01-01T02:00:00Z', closedAt:'2026-01-01T03:00:00Z' },
  ];
  assert.equal(engine.computeAdvancedStats(positions).profitFactor, Infinity);
});
test('computeAdvancedStats: profitFactor cohérent avec gains/pertes bruts', () => {
  const positions = [
    { status:'CLOSED', pnlUSDC:20, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T01:00:00Z' },
    { status:'CLOSED', pnlUSDC:-10, ts:'2026-01-01T02:00:00Z', closedAt:'2026-01-01T03:00:00Z' },
  ];
  assert.ok(Math.abs(engine.computeAdvancedStats(positions).profitFactor - 2) < 1e-9);
});
test('computeAdvancedStats: expectancy = PnL total / nombre de trades', () => {
  const positions = [
    { status:'CLOSED', pnlUSDC:30, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T01:00:00Z' },
    { status:'CLOSED', pnlUSDC:-10, ts:'2026-01-01T02:00:00Z', closedAt:'2026-01-01T03:00:00Z' },
  ];
  assert.ok(Math.abs(engine.computeAdvancedStats(positions).expectancy - 10) < 1e-9);
});
test('computeAdvancedStats: maxDrawdownPct détecte une vraie baisse depuis un sommet', () => {
  const positions = [
    { status:'CLOSED', pnlUSDC:100, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T01:00:00Z' }, // equity: 100 (pic)
    { status:'CLOSED', pnlUSDC:-40, ts:'2026-01-01T02:00:00Z', closedAt:'2026-01-01T03:00:00Z' }, // equity: 60 → dd 40%
    { status:'CLOSED', pnlUSDC:10,  ts:'2026-01-01T04:00:00Z', closedAt:'2026-01-01T05:00:00Z' }, // equity: 70
  ];
  const s = engine.computeAdvancedStats(positions);
  assert.ok(Math.abs(s.maxDrawdownPct - 0.4) < 1e-9, `drawdown attendu 40%, reçu ${s.maxDrawdownPct*100}%`);
});
test('computeAdvancedStats: ignore les positions encore ouvertes', () => {
  const positions = [{ status:'OPEN', pnlUSDC:0, ts:'2026-01-01T00:00:00Z' }];
  const s = engine.computeAdvancedStats(positions);
  assert.equal(s.expectancy, 0);
});
test('computeAdvancedStats: calmarRatio reste 0 si l\'historique couvre moins d\'une journée (pas d\'annualisation trompeuse)', () => {
  const positions = [
    { status:'CLOSED', pnlUSDC:10, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T00:10:00Z' },
    { status:'CLOSED', pnlUSDC:-5, ts:'2026-01-01T00:20:00Z', closedAt:'2026-01-01T00:30:00Z' },
  ];
  assert.equal(engine.computeAdvancedStats(positions).calmarRatio, 0);
});
test('computeAdvancedStats: n\'a aucun effet de bord sur le tableau source', () => {
  const positions = [{ status:'CLOSED', pnlUSDC:5, ts:'2026-01-01T00:00:00Z', closedAt:'2026-01-01T01:00:00Z' }];
  const copy = JSON.parse(JSON.stringify(positions));
  engine.computeAdvancedStats(positions);
  assert.deepEqual(positions, copy);
});

// ─── [v15-9] computeHistoricalBreakdown — agrégation par période/catégorie ──
test('computeHistoricalBreakdown: structures vides sans aucune position clôturée', () => {
  const b = engine.computeHistoricalBreakdown([]);
  assert.deepEqual(b.byDay, {});
  assert.deepEqual(b.byCategory, {});
});
test('computeHistoricalBreakdown: agrège correctement plusieurs trades le même jour', () => {
  const positions = [
    { status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:10, category:'SPORTS' },
    { status:'CLOSED', closedAt:'2026-01-15T18:00:00Z', pnlUSDC:-4, category:'SPORTS' },
  ];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.equal(b.byDay['2026-01-15'].trades, 2);
  assert.ok(Math.abs(b.byDay['2026-01-15'].pnl - 6) < 1e-9);
  assert.equal(b.byDay['2026-01-15'].wins, 1);
});
test('computeHistoricalBreakdown: sépare correctement deux jours différents', () => {
  const positions = [
    { status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:10, category:'SPORTS' },
    { status:'CLOSED', closedAt:'2026-01-16T10:00:00Z', pnlUSDC:5, category:'SPORTS' },
  ];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.equal(Object.keys(b.byDay).length, 2);
});
test('computeHistoricalBreakdown: regroupe correctement par catégorie', () => {
  const positions = [
    { status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:10, category:'SPORTS' },
    { status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:-3, category:'POLITICS' },
  ];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.ok(Math.abs(b.byCategory.SPORTS.pnl - 10) < 1e-9);
  assert.ok(Math.abs(b.byCategory.POLITICS.pnl - (-3)) < 1e-9);
});
test('computeHistoricalBreakdown: catégorie absente regroupée sous AUTRE', () => {
  const positions = [{ status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:1 }];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.equal(b.byCategory.AUTRE.trades, 1);
});
test('computeHistoricalBreakdown: ignore les positions ouvertes ou sans date de clôture', () => {
  const positions = [
    { status:'OPEN', pnlUSDC:100, category:'SPORTS' },
    { status:'CLOSED', pnlUSDC:5, category:'SPORTS' }, // sans closedAt
  ];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.deepEqual(b.byCategory, {});
});
test('computeHistoricalBreakdown: regroupe correctement par mois', () => {
  const positions = [
    { status:'CLOSED', closedAt:'2026-01-15T10:00:00Z', pnlUSDC:10, category:'SPORTS' },
    { status:'CLOSED', closedAt:'2026-02-01T10:00:00Z', pnlUSDC:5, category:'SPORTS' },
  ];
  const b = engine.computeHistoricalBreakdown(positions);
  assert.equal(b.byMonth['2026-01'].trades, 1);
  assert.equal(b.byMonth['2026-02'].trades, 1);
});

// ─── [v15-10] simulatePaperExecution — réalisme du mode paper ──────────
test('simulatePaperExecution: échec technique si le tirage tombe sous failureRate', () => {
  const cfg = { paperFailureRate:0.5, paperRejectRate:0, paperPartialFillRate:0 };
  const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => 0.1); // 0.1 < 0.5
  assert.equal(r.outcome, 'failed');
  assert.equal(r.filledFraction, 0);
});
test('simulatePaperExecution: rejet si le tirage tombe entre failureRate et failureRate+rejectRate', () => {
  const cfg = { paperFailureRate:0.1, paperRejectRate:0.5, paperPartialFillRate:0 };
  const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => 0.3); // entre 0.1 et 0.6
  assert.equal(r.outcome, 'rejected');
});
test('simulatePaperExecution: remplissage complet si le tirage dépasse tous les taux d\'incident', () => {
  const cfg = { paperFailureRate:0.02, paperRejectRate:0.03, paperPartialFillRate:0.10, paperExtraSlippageMax:0.01 };
  const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => 0.99); // au-delà de tous les seuils
  assert.equal(r.outcome, 'filled');
  assert.equal(r.filledFraction, 1);
});
test('simulatePaperExecution: remplissage partiel dans la bonne tranche de probabilité', () => {
  const cfg = { paperFailureRate:0.02, paperRejectRate:0.03, paperPartialFillRate:0.10, paperExtraSlippageMax:0.01 };
  const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => 0.10); // dans la tranche partial (0.05-0.15)
  assert.equal(r.outcome, 'partial');
  assert.ok(r.filledFraction > 0 && r.filledFraction < 1);
});
test('simulatePaperExecution: le coût effectif inclut toujours un glissement additionnel ≥ 0', () => {
  const cfg = { paperFailureRate:0, paperRejectRate:0, paperPartialFillRate:0, paperExtraSlippageMax:0.02 };
  const r = engine.simulatePaperExecution({cost:0.80}, cfg, () => 0.9);
  assert.ok(r.effectiveCost >= 0.80, 'le glissement simulé ne doit jamais AMÉLIORER le prix par rapport au VWAP déjà calculé');
});
test('simulatePaperExecution: coût effectif null si rejeté ou en échec (aucun remplissage réel)', () => {
  const cfg = { paperFailureRate:1, paperRejectRate:0, paperPartialFillRate:0 };
  const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => 0);
  assert.equal(r.effectiveCost, null);
});
test('simulatePaperExecution: delayMs toujours dans la fourchette configurée', () => {
  const cfg = { paperLatencyMinMs:200, paperLatencyMaxMs:400, paperFailureRate:0, paperRejectRate:0, paperPartialFillRate:0 };
  for (const seed of [0, 0.25, 0.5, 0.75, 0.99]) {
    const r = engine.simulatePaperExecution({cost:0.9}, cfg, () => seed);
    assert.ok(r.delayMs >= 200 && r.delayMs <= 400, `delay ${r.delayMs} hors de [200,400]`);
  }
});
test('simulatePaperExecution: reproductible avec la même seed (déterminisme du RNG injecté)', () => {
  const cfg = engine.DEFAULT_CFG;
  const rng = () => 0.42;
  const r1 = engine.simulatePaperExecution({cost:0.85}, cfg, rng);
  const r2 = engine.simulatePaperExecution({cost:0.85}, cfg, rng);
  assert.deepEqual(r1, r2);
});

// ─── DEFAULT_CFG — garde-fous de sanité ─────────────────────────
test('DEFAULT_CFG: valeurs de seuil raisonnables', () => {
  const c = engine.DEFAULT_CFG;
  assert.ok(c.minEdge > 0 && c.minEdge < 1);
  assert.ok(c.maxPct > 0 && c.maxPct <= 1);
  assert.ok(c.feeBps >= 0);
  assert.ok([0,1].includes(c.autoExec));
  assert.ok(c.dailyLossLimitPct > 0 && c.dailyLossLimitPct < 1);
  assert.ok(c.weeklyLossLimitPct > 0 && c.weeklyLossLimitPct < 1);
  assert.ok(c.maxConsecutiveErrors >= 1);
});
