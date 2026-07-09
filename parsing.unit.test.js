// ═══════════════════════════════════════════════════════════════
// Tests unitaires — parsing des données Gamma API (index.js)
// ═══════════════════════════════════════════════════════════════
// NOTE: nécessite `npm install` au préalable (express/pg/node-fetch) — ces tests
// importent index.js. Le require() lui-même NE démarre PAS le serveur ni ne se
// connecte à Postgres (voir la garde `if (require.main === module)` dans index.js).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRawGammaMarket } = require('./helpers/fixtures');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/testdb';
const idx = require('../index.js');
const { parseSingleMarkets, getTokenIds } = idx;

// ─── getTokenIds — régression du bug réel trouvé en production ────────
test('getTokenIds: parse clobTokenIds fourni comme une CHAÎNE JSON (régression bug réel)', () => {
  // C'est exactement ce que Polymarket renvoie parfois — et qui faisait disparaître
  // TOUS les marchés silencieusement avant ce fix.
  const m = { clobTokenIds: '["111111111111111111","222222222222222222"]' };
  const ids = getTokenIds(m);
  assert.deepEqual(ids, ['111111111111111111', '222222222222222222']);
});
test('getTokenIds: accepte aussi un vrai tableau natif', () => {
  const m = { clobTokenIds: ['aaa', 'bbb'] };
  assert.deepEqual(getTokenIds(m), ['aaa', 'bbb']);
});
test('getTokenIds: rejette une chaîne JSON malformée (ne doit jamais crasher)', () => {
  const m = { clobTokenIds: '["not", "closed"' };
  assert.equal(getTokenIds(m), null);
});
test('getTokenIds: rejette un tableau de longueur != 2 (marché non-binaire)', () => {
  assert.equal(getTokenIds({ clobTokenIds: ['only-one'] }), null);
  assert.equal(getTokenIds({ clobTokenIds: ['a','b','c'] }), null);
  assert.equal(getTokenIds({ clobTokenIds: [] }), null);
});
test('getTokenIds: rejette l\'absence totale du champ', () => {
  assert.equal(getTokenIds({}), null);
});

// ─── parseSingleMarkets — filtrage et classification ───────────────────
test('parseSingleMarkets: exclut un marché inactif', () => {
  const raw = [makeRawGammaMarket({ slug:'m1', active:false })];
  assert.equal(parseSingleMarkets(raw).length, 0);
});
test('parseSingleMarkets: exclut un marché déjà clos', () => {
  const raw = [makeRawGammaMarket({ slug:'m1', closed:true })];
  assert.equal(parseSingleMarkets(raw).length, 0);
});
test('parseSingleMarkets: exclut un marché sans clobTokenIds exploitables', () => {
  const raw = [makeRawGammaMarket({ slug:'m1', clobTokenIds: null })];
  assert.equal(parseSingleMarkets(raw).length, 0);
});
test('parseSingleMarkets: inclut un marché binaire actif valide, avec les bons champs', () => {
  const raw = [makeRawGammaMarket({ slug:'trump-2028', question:'Will Trump run in 2028?', volume24hr: 42000, liquidity: 8000 })];
  const out = parseSingleMarkets(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'trump-2028');
  assert.equal(out[0].tokenYes, '111111111111111111');
  assert.equal(out[0].tokenNo, '222222222222222222');
  assert.equal(out[0].volume24h, 42000);
  assert.equal(out[0].liquidity, 8000);
  assert.equal(out[0].category, 'POLITICS');
});
test('parseSingleMarkets: gère clobTokenIds en chaîne JSON de bout en bout (régression)', () => {
  const raw = [makeRawGammaMarket({ slug:'m1', clobTokenIds: '["y1","n1"]' })];
  const out = parseSingleMarkets(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].tokenYes, 'y1');
  assert.equal(out[0].tokenNo, 'n1');
});
test('parseSingleMarkets: accepte le format enveloppe {results:[...]} en plus du tableau brut', () => {
  const raw = { results: [makeRawGammaMarket({ slug:'m1' })] };
  assert.equal(parseSingleMarkets(raw).length, 1);
});

// ─── Fenêtre SPORTS 14 jours ────────────────────────────────────────────
test('parseSingleMarkets: exclut un marché SPORTS dont la résolution est à plus de 14 jours', () => {
  const raw = [makeRawGammaMarket({
    slug:'lakers-season-champion', question:'Will the Lakers win the championship?',
    endDate: new Date(Date.now() + 30*86400000).toISOString(),
  })];
  assert.equal(parseSingleMarkets(raw).length, 0);
});
test('parseSingleMarkets: inclut un marché SPORTS dont la résolution est sous 14 jours', () => {
  const raw = [makeRawGammaMarket({
    slug:'lakers-tonight', question:'Will the Lakers win tonight?',
    endDate: new Date(Date.now() + 2*86400000).toISOString(),
  })];
  assert.equal(parseSingleMarkets(raw).length, 1);
});
test('parseSingleMarkets: la fenêtre 14 jours ne s\'applique PAS aux catégories non-SPORTS', () => {
  const raw = [makeRawGammaMarket({
    slug:'trump-2028', question:'Will Trump run in 2028?',
    endDate: new Date(Date.now() + 300*86400000).toISOString(), // très lointain
  })];
  assert.equal(parseSingleMarkets(raw).length, 1, 'un marché POLITICS lointain ne doit pas être exclu');
});
test('parseSingleMarkets: exclut un marché SPORTS déjà passé sa date de résolution (daysLeft<0)', () => {
  const raw = [makeRawGammaMarket({
    slug:'lakers-yesterday', question:'Did the Lakers win yesterday?',
    endDate: new Date(Date.now() - 86400000).toISOString(),
  })];
  assert.equal(parseSingleMarkets(raw).length, 0);
});
