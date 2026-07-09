// ═══════════════════════════════════════════════════════════════
// Tests d'intégration — logique métier réelle de index.js (bot, executeOrder,
// closePosition, computeMarketUpdate, routes HTTP), SANS réseau ni vraie base
// de données. persistBotState() essaiera d'écrire en DB et échouera silencieusement
// (try/catch déjà présent en production) — c'est voulu et sans danger ici.
// ═══════════════════════════════════════════════════════════════
// NOTE: nécessite `npm install` au préalable (express/pg/node-fetch).
'use strict';
const test = require('node:test');
const http = require('node:http');
const assert = require('node:assert/strict');
const { makeMarket, makeBook } = require('./helpers/fixtures');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/testdb';
const idx = require('../index.js');
const { bot, engine, executeOrder, closePosition, computeMarketUpdate, tick, currentExposure,
        recordRejected, registerExecutionError, checkRiskLimits, app } = idx;

const TODAY = () => new Date().toISOString().slice(0,10);

function resetBot() {
  bot.markets = [];
  bot.positions = [];
  bot.bankroll = 2000;
  bot.startBr = 2000;
  bot.cfg = { ...engine.DEFAULT_CFG };
  bot.daily = { date: TODAY(), count: 0 };
  bot.cooldowns = {};
  bot.apiSt = { gamma:"boot", clob:"boot" };
  bot.discovering = false;
  bot.ticking = false;
  bot.tickCount = 0;
  bot.consecutiveErrors = 0;
  bot.paused = false;
  bot.pausedReason = null;
  bot.week = { start: TODAY(), startBr: 2000 };
  bot.rejected = [];
  bot.logs = [];
}

/** Construit un marché avec un arb RÉELLEMENT valide (calculé par le vrai moteur,
 * pas des valeurs inventées à la main) et l'ajoute à bot.markets. */
function seedValidMarket(overrides = {}) {
  const bookYes = makeBook({ askPrice: 0.45, askSize: 2000 });
  const bookNo  = makeBook({ askPrice: 0.40, askSize: 2000 });
  const m = makeMarket({ id: overrides.id ?? 'seed-market', slug: overrides.id ?? 'seed-market', ...overrides });
  const score = engine.scoreMarket(m, bookYes, bookNo);
  const candidateSize = engine.sizeArb(bookYes, bookNo, bot.cfg, bot.bankroll, score);
  const arb = engine.detectMarketArb(bookYes, bookNo, bot.cfg, candidateSize);
  const seeded = { ...m, bookYes, bookNo, arb, sizeUSDC: arb.valid ? candidateSize : 0, score };
  bot.markets.push(seeded);
  return seeded;
}

test.beforeEach(() => resetBot());

// ─── executeOrder — comportement nominal ───────────────────────────────
test('executeOrder: crée une position et débite le COÛT RÉEL (pas juste la taille visée)', async () => {
  const m = seedValidMarket();
  assert.equal(m.arb.valid, true, 'pré-requis: le marché de test doit avoir un arb valide');
  const brAvant = bot.bankroll;
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 1);
  const pos = bot.positions[0];
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.mode, 'PAPER'); // pas de POLY_PRIVATE_KEY en environnement de test
  assert.ok(Math.abs((brAvant - bot.bankroll) - pos.size) < 1e-6, 'la bankroll doit diminuer exactement du coût réel enregistré');
  assert.equal(bot.daily.count, 1);
  assert.ok(bot.cooldowns[m.id] > Date.now());
});

test('executeOrder: refuse si le signal est invalide', async () => {
  const m = seedValidMarket();
  bot.markets[0].arb = { valid:false, reason:'EDGE_BAS' };
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 0);
});

test('executeOrder: refuse si la taille est < $1', async () => {
  const m = seedValidMarket();
  bot.markets[0].sizeUSDC = 0.5;
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 0);
});

test('executeOrder: respecte le cooldown — un second appel immédiat ne recrée pas de position', async () => {
  const m = seedValidMarket();
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 1);
  await executeOrder(m.id); // toujours en cooldown
  assert.equal(bot.positions.length, 1, 'aucune deuxième position ne doit être créée pendant le cooldown');
});

test('executeOrder: refuse au-delà de la limite journalière maxDaily', async () => {
  const m = seedValidMarket();
  bot.daily.count = bot.cfg.maxDaily;
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 0);
});

test('executeOrder: refuse si le bot est en pause (kill-switch)', async () => {
  const m = seedValidMarket();
  bot.paused = true;
  bot.pausedReason = 'test';
  await executeOrder(m.id);
  assert.equal(bot.positions.length, 0);
});

test('executeOrder: [régression] réinitialise le compteur journalier si la date a changé', async () => {
  const m = seedValidMarket();
  bot.daily = { date: '2020-01-01', count: 999 }; // ancienne date, jamais réinitialisée par l'ancien code
  await executeOrder(m.id);
  assert.equal(bot.daily.date, TODAY(), 'la date doit être remise à jour au jour courant');
  assert.equal(bot.daily.count, 1, 'le compteur doit repartir de 0 puis être incrémenté à 1, pas continuer depuis 999');
});

test('executeOrder: plafonne la taille par l\'exposition maximale autorisée', async () => {
  bot.cfg.maxExposure = 0.05; // 5% de 2000 = $100 max d'exposition totale
  seedValidMarket({ id: 'm1' });
  await executeOrder('m1');
  seedValidMarket({ id: 'm2' });
  await executeOrder('m2');
  const totalExposure = bot.positions.filter(p=>p.status==='OPEN').reduce((s,p)=>s+p.size,0);
  assert.ok(totalExposure <= 2000 * 0.05 + 1e-6, `exposition totale $${totalExposure} ne doit jamais dépasser le plafond configuré ($100)`);
  assert.ok(bot.positions.length >= 1, 'au moins la première position doit avoir été acceptée');
});

// ─── closePosition — la régression la plus importante : pas de profit fictif ──
test('closePosition("RESOLVED"): crédite le paiement garanti (parts × $1)', async () => {
  const m = seedValidMarket();
  await executeOrder(m.id);
  const pos = bot.positions[0];
  const brAvant = bot.bankroll;
  closePosition(pos.id, 'RESOLVED');
  const closed = bot.positions.find(p=>p.id===pos.id);
  assert.equal(closed.status, 'CLOSED');
  assert.ok(Math.abs((bot.bankroll - brAvant) - pos.shares) < 1e-6, 'la bankroll doit augmenter exactement du nombre de parts (paiement garanti à $1)');
  assert.ok(closed.pnlUSDC > 0, 'un arb valide doit rester profitable à la résolution');
});

test('closePosition("MANUAL"): [régression critique] NE crédite AUCUN profit fictif avant résolution confirmée', async () => {
  const m = seedValidMarket();
  await executeOrder(m.id);
  const pos = bot.positions[0];
  const brAvant = bot.bankroll;
  closePosition(pos.id, 'MANUAL');
  const closed = bot.positions.find(p=>p.id===pos.id);
  assert.equal(closed.pnlUSDC, 0, 'une clôture manuelle ne doit jamais fabriquer de profit — aucune vente réelle n\'a eu lieu');
  assert.ok(Math.abs((bot.bankroll - brAvant) - pos.size) < 1e-6, 'seul le capital engagé doit être repris, pas le paiement garanti théorique');
});

test('closePosition: ignore un id de position inconnu ou déjà clôturé (aucun crash)', () => {
  assert.doesNotThrow(() => closePosition('id-inexistant', 'RESOLVED'));
});

// ─── computeMarketUpdate — régressions ciblées ─────────────────────────
test('computeMarketUpdate: [régression] un marché résolu invalide IMMÉDIATEMENT son signal', () => {
  const m = seedValidMarket();
  assert.equal(m.arb.valid, true);
  const result = computeMarketUpdate(m, bot.cfg, bot.bankroll, { closed:true }, null, null);
  assert.equal(result.market.arb.valid, false, 'un marché résolu ne doit plus jamais apparaître comme tradable, même s\'il l\'était juste avant');
  assert.equal(result.market.closed, true);
  assert.equal(result.shouldClosePositions, true);
});

test('computeMarketUpdate: rejette un marché dont le score est sous le seuil minMarketScore configuré', () => {
  bot.cfg.minMarketScore = 99; // seuil quasi-inatteignable
  const m = makeMarket();
  const bookYes = makeBook({ askPrice:0.45, askSize:2000 });
  const bookNo  = makeBook({ askPrice:0.40, askSize:2000 });
  const result = computeMarketUpdate(m, bot.cfg, bot.bankroll, { closed:false }, bookYes, bookNo);
  assert.equal(result.market.arb.valid, false);
  assert.ok(result.market.arb.reason.startsWith('SCORE_BAS'));
});

test('computeMarketUpdate: un bon carnet + bon score produit un arb cohérent avec un calcul direct du moteur', () => {
  const m = makeMarket();
  const bookYes = makeBook({ askPrice:0.45, askSize:2000 });
  const bookNo  = makeBook({ askPrice:0.40, askSize:2000 });
  const result = computeMarketUpdate(m, bot.cfg, bot.bankroll, { closed:false }, bookYes, bookNo);
  assert.equal(result.market.arb.valid, true);
  assert.ok(result.market.sizeUSDC > 0);
  assert.ok(result.market.score > 0);
});

// ─── tick() — garde anti-chevauchement ─────────────────────────────────
test('tick(): [régression] si un cycle est déjà en cours, un appel concurrent est un no-op immédiat', async () => {
  bot.ticking = true;
  const countAvant = bot.tickCount;
  await tick();
  assert.equal(bot.tickCount, countAvant, 'tick() ne doit pas progresser si un cycle est déjà marqué en cours');
});

test('tick(): ne fait rien si aucun marché n\'est suivi (pas de crash)', async () => {
  bot.markets = [];
  await assert.doesNotReject(() => tick());
});

// ─── Gestion des risques (kill-switch) ─────────────────────────────────
test('registerExecutionError: met le bot en pause après maxConsecutiveErrors échecs', () => {
  bot.cfg.maxConsecutiveErrors = 3;
  registerExecutionError();
  registerExecutionError();
  assert.equal(bot.paused, false, 'pas encore en pause avant d\'atteindre le seuil');
  registerExecutionError();
  assert.equal(bot.paused, true, 'doit être en pause une fois le seuil atteint');
  assert.ok(bot.pausedReason.length > 0);
});

test('checkRiskLimits: met le bot en pause si la perte journalière dépasse dailyLossLimitPct', () => {
  bot.cfg.dailyLossLimitPct = 0.10; // 10%
  bot.startBr = 1000;
  bot.bankroll = 850; // perte de 15%
  checkRiskLimits();
  assert.equal(bot.paused, true);
});

test('checkRiskLimits: ne déclenche rien tant que la perte reste sous la limite', () => {
  bot.cfg.dailyLossLimitPct = 0.10;
  bot.startBr = 1000;
  bot.bankroll = 950; // perte de 5%, sous la limite de 10%
  checkRiskLimits();
  assert.equal(bot.paused, false);
});

test('checkRiskLimits: met le bot en pause si la perte hebdomadaire dépasse weeklyLossLimitPct', () => {
  bot.cfg.weeklyLossLimitPct = 0.20;
  bot.cfg.dailyLossLimitPct = 1.0; // désactivé pour isoler le test hebdo
  bot.week = { start: TODAY(), startBr: 1000 };
  bot.startBr = 1000;
  bot.bankroll = 700; // perte de 30%
  checkRiskLimits();
  assert.equal(bot.paused, true);
});

// ─── recordRejected — apprentissage passif, jamais d'auto-réglage ──────
test('recordRejected: enregistre une opportunité refusée avec sa raison', () => {
  const m = seedValidMarket();
  recordRejected(m, 'raison de test');
  assert.equal(bot.rejected.length, 1);
  assert.equal(bot.rejected[0].reason, 'raison de test');
  assert.equal(bot.rejected[0].marketId, m.id);
});
test('recordRejected: reste borné à 300 entrées maximum', () => {
  const m = seedValidMarket();
  for (let i = 0; i < 350; i++) recordRejected(m, `raison ${i}`);
  assert.ok(bot.rejected.length <= 300);
});

// ─── Routes HTTP — bout en bout via le vrai `app` Express ──────────────
function withServer(fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, async () => {
      const port = server.address().port;
      try {
        await fn(`http://127.0.0.1:${port}`);
        resolve();
      } catch(e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test('GET /bot-state: renvoie la forme attendue avec les stats avancées', async () => {
  seedValidMarket();
  await withServer(async (base) => {
    const r = await fetch(`${base}/bot-state`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok('cfg' in body);
    assert.ok('markets' in body);
    assert.ok('positions' in body);
    assert.ok('holdStats' in body, 'stats avancées (point 6 du cahier des charges) doivent être exposées');
    assert.ok('paused' in body);
    assert.ok('rejected' in body);
  });
});

test('POST /bot-cfg: fusionne la config et ignore toujours proxyUrl', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/bot-cfg`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ minEdge: 0.09, proxyUrl: 'http://devrait-etre-ignore.example' }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.cfg.minEdge, 0.09);
    assert.notEqual(bot.cfg.proxyUrl, 'http://devrait-etre-ignore.example');
  });
});

test('POST /bot-resume: réinitialise la pause et le compteur d\'erreurs', async () => {
  bot.paused = true; bot.pausedReason = 'test'; bot.consecutiveErrors = 5;
  await withServer(async (base) => {
    const r = await fetch(`${base}/bot-resume`, { method: 'POST' });
    assert.equal(r.status, 200);
  });
  assert.equal(bot.paused, false);
  assert.equal(bot.consecutiveErrors, 0);
});

test('POST /bot-exec puis /bot-close: cycle complet ouverture → clôture manuelle sans profit fictif', async () => {
  const m = seedValidMarket();
  await withServer(async (base) => {
    const rExec = await fetch(`${base}/bot-exec`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ marketId: m.id }),
    });
    assert.equal(rExec.status, 200);
    assert.equal(bot.positions.length, 1);
    const posId = bot.positions[0].id;
    const rClose = await fetch(`${base}/bot-close`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ posId }),
    });
    assert.equal(rClose.status, 200);
    const closed = bot.positions.find(p=>p.id===posId);
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.pnlUSDC, 0, 'clôture via la route HTTP: toujours pas de profit fictif');
  });
});
