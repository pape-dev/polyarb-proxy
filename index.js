const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const app     = express();
const { Pool } = require('pg');
const engine  = require("./engine");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

// ─── Client CLOB signé (ordres réels) ────────────────────
let clobClient = null;
async function getClobClient() {
  if (clobClient) return clobClient;
  if (!process.env.POLY_PRIVATE_KEY) return null;
  try {
    const { ClobClient } = require("@polymarket/clob-client");
    const { Wallet } = require("ethers");
    const signer = new Wallet(process.env.POLY_PRIVATE_KEY);
    const host = "https://clob.polymarket.com";
    const chainId = 137;
    const creds = await new ClobClient(host, chainId, signer).createOrDeriveApiKey();
    clobClient = new ClobClient(host, chainId, signer, creds, undefined, process.env.POLY_FUNDER || undefined);
    console.log('[CLOB] Client signé initialisé ✅');
    return clobClient;
  } catch (e) {
    console.error('[CLOB] Impossible d\'initialiser le client signé:', e.message);
    return null;
  }
}

async function fetchExternal(url, opts = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "application/json",
        ...(opts.headers || {}),
      },
    });
    clearTimeout(t);
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error(`[EXT] ${url} → HTTP ${r.status} — ${body.slice(0, 200)}`);
      throw new Error(`HTTP ${r.status}`);
    }
    return r;
  } catch (e) {
    clearTimeout(t);
    console.error(`[EXT] ${url} → ÉCHEC: ${e.message}`);
    throw e;
  }
}

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cfg (key TEXT PRIMARY KEY, value TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
    console.log('[DB] PostgreSQL connecté ✅');
  } catch(e) {
    console.error('[DB] Erreur connexion:', e.message);
  }
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ═══════════════════════════════════════════════════════════════
// [v11] MOTEUR AUTONOME — ARBITRAGE MÉCANIQUE PAR MARCHÉ UNIQUE
// ═══════════════════════════════════════════════════════════════
// Plus de paires, plus de corrélation, plus de test statistique. Chaque marché binaire
// est scanné individuellement : ses deux jetons (OUI/NON) doivent valoir $1 ensemble à
// la résolution — si les acheter coûte moins que ça (net de frais), le profit est garanti.

const bot = {
  cfg: { ...engine.DEFAULT_CFG },
  markets: [],       // marchés uniques scannés (plus de "pairs")
  positions: [],
  bankroll: engine.DEFAULT_CFG.bankroll,
  startBr: engine.DEFAULT_CFG.bankroll,
  logs: [],
  daily: { date: new Date().toISOString().slice(0,10), count: 0 },
  cooldowns: {},
  apiSt: { gamma: "boot", clob: "boot" },
  loaded: false,
  discovering: false,
  ticking: false,
  tickCount: 0,                          // [v12-11] pour espacer les vérifs de résolution
  consecutiveErrors: 0,                  // [v12-9] kill-switch erreurs d'exécution
  paused: false, pausedReason: null,      // [v12-9] kill-switch perte journalière/hebdo
  week: { start: new Date().toISOString().slice(0,10), startBr: engine.DEFAULT_CFG.bankroll },
  rejected: [],                          // [v12-8] opportunités refusées (apprentissage passif)
};

function botLog(kind, msg) {
  const ts = new Date().toISOString().slice(11,22);
  bot.logs.push({ ts, kind, msg, id: Date.now()+Math.random() });
  if (bot.logs.length > 400) bot.logs = bot.logs.slice(-400);
  console.log(`[BOT ${kind}] ${msg}`);
}

async function loadBotState() {
  try {
    const r = await pool.query('SELECT key, value FROM state');
    const s = {};
    r.rows.forEach(row => s[row.key] = row.value);
    if (s.pa6_pos) bot.positions = JSON.parse(s.pa6_pos);
    if (s.pa6_br) bot.bankroll = parseFloat(s.pa6_br);
    if (s.pa6_cfg) {
      const { proxyUrl, ...restored } = JSON.parse(s.pa6_cfg);
      bot.cfg = { ...bot.cfg, ...restored };
    }
    if (s.pa6_startbr) bot.startBr = parseFloat(s.pa6_startbr);
    if (s.pa6_daily) {
      const saved = JSON.parse(s.pa6_daily);
      const today = new Date().toISOString().slice(0,10);
      bot.daily = saved.date === today ? saved : { date: today, count: 0 };
    }
    // [v12-9] Restaure l'état de pause (kill-switch) — un crash/redémarrage ne doit pas
    // relancer silencieusement le trading si le bot avait été mis en pause pour une bonne raison.
    if (s.pa6_risk) {
      const risk = JSON.parse(s.pa6_risk);
      bot.paused = !!risk.paused;
      bot.pausedReason = risk.pausedReason ?? null;
      bot.consecutiveErrors = risk.consecutiveErrors ?? 0;
    }
    if (s.pa6_week) {
      const week = JSON.parse(s.pa6_week);
      const weekAgeDays = (Date.now() - new Date(week.start).getTime()) / 86400000;
      // Rotation hebdomadaire : au-delà de 7 jours, on redémarre la fenêtre de suivi
      bot.week = weekAgeDays >= 7 ? { start: new Date().toISOString().slice(0,10), startBr: bot.bankroll } : week;
    }
    botLog("SYS", "État restauré depuis Postgres — moteur v11 (arbitrage mécanique)");
  } catch(e) {
    botLog("SYS", "Démarrage frais — moteur v11");
  }
  bot.loaded = true;
}

async function persistBotState() {
  try {
    const { proxyUrl, ...cfgToSave } = bot.cfg;
    const entries = [
      ["pa6_pos", JSON.stringify(bot.positions.slice(-200))],
      ["pa6_br", String(bot.bankroll)],
      ["pa6_cfg", JSON.stringify(cfgToSave)],
      ["pa6_startbr", String(bot.startBr)],
      ["pa6_daily", JSON.stringify(bot.daily)],
      ["pa6_risk", JSON.stringify({ paused: bot.paused, pausedReason: bot.pausedReason, consecutiveErrors: bot.consecutiveErrors })],
      ["pa6_week", JSON.stringify(bot.week)],
    ];
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO state (key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
        [key, value]
      );
    }
  } catch(e) {
    console.error('[BOT] Erreur persistance:', e.message);
  }
}

async function fetchGammaMarkets(tagId) {
  const tagParam = tagId ? `&tag_id=${encodeURIComponent(tagId)}` : "";
  const r = await fetchExternal(`https://gamma-api.polymarket.com/markets?limit=500&active=true&order=volume&ascending=false${tagParam}`);
  return await r.json();
}

// [v11] Ne garde que les marchés binaires à 2 jetons (condition nécessaire pour l'arb OUI+NON)
// [FIX] Polymarket renvoie parfois clobTokenIds comme une CHAÎNE contenant du JSON
// (ex: '["123...","456..."]') plutôt qu'un vrai tableau — sans ce parsing, le filtre
// Array.isArray() rejetait silencieusement TOUS les marchés (0 résultat interprété à
// tort comme "API bloquée", alors que Gamma répondait normalement).
function getTokenIds(m) {
  let ids = m.clobTokenIds;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { return null; }
  }
  return Array.isArray(ids) && ids.length === 2 ? ids : null;
}
// [FIX] Les marchés sport "saison entière" (endDate à plusieurs mois) immobilisent le
// capital bien plus longtemps qu'un match du jour, pour le même mécanisme d'arb — on
// les exclut pour prioriser les matchs qui se résolvent sous 14 jours.
const SPORTS_MAX_DAYS = 14;
function parseSingleMarkets(raw) {
  const list = Array.isArray(raw) ? raw : (raw.results ?? raw.markets ?? []);
  return list
    .map(m => ({ m, ids: getTokenIds(m) }))
    .filter(({ m, ids }) => m.active && !m.closed && ids)
    .map(({ m, ids }) => {
      const cat = engine.categorize(m.question ?? m.slug ?? "", m.slug ?? "");
      return {
        id: m.slug,
        slug: m.slug,
        title: (m.question ?? m.title ?? m.slug).slice(0, 90),
        tokenYes: ids[0],
        tokenNo: ids[1],
        volume24h: parseFloat(m.volume24hr ?? m.volume ?? 0),
        liquidity: parseFloat(m.liquidity ?? 0),
        endDate: m.endDate ?? m.endDateIso ?? null,
        category: cat.id, emoji: cat.emoji,
        bookYes: null, bookNo: null, arb: { valid:false, reason:"INIT" },
        sizeUSDC: 0, closed: false,
      };
    })
    .filter(m => {
      if (m.category !== "SPORTS" || !m.endDate) return true;
      const daysLeft = (new Date(m.endDate) - Date.now()) / 86400000;
      return daysLeft <= SPORTS_MAX_DAYS && daysLeft >= 0;
    });
}

async function discoverMarketsServer() {
  try {
    // [FIX] Scan général (top 500 volume, toutes catégories) + scan dédié Sports
    // (tag_id=100639) en parallèle — sinon les matchs du jour à volume modeste sont
    // systématiquement exclus du top 500 dominé par la politique/crypto/futures long terme.
    const [rawGen, rawSports] = await Promise.all([
      fetchGammaMarkets(),
      fetchGammaMarkets("100639").catch(() => null),
    ]);
    const listGen = Array.isArray(rawGen) ? rawGen : (rawGen.results ?? rawGen.markets ?? []);
    const listSports = rawSports ? (Array.isArray(rawSports) ? rawSports : (rawSports.results ?? rawSports.markets ?? [])) : [];
    const seen = new Set(); const mergedRaw = [];
    for (const m of [...listGen, ...listSports]) {
      if (seen.has(m.slug)) continue;
      seen.add(m.slug); mergedRaw.push(m);
    }
    return { markets: parseSingleMarkets(mergedRaw), fetchOk: true, totalRaw: mergedRaw.length };
  } catch(e) { return { markets: [], fetchOk: false, totalRaw: 0 }; }
}

async function fetchBookServer(tokenId) {
  try {
    const r = await fetchExternal(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    const d = await r.json();
    // [FIX] Tri explicite — tout le calcul d'edge suppose que asks[0] est le meilleur prix
    // (le plus bas) et bids[0] le plus haut. Rien ne garantit que l'API renvoie déjà les
    // niveaux dans cet ordre ; sans ce tri, un mauvais ordre pourrait faire calculer un
    // edge basé sur un prix qui n'est pas réellement le meilleur disponible.
    const asks = (d.asks ?? []).map(a=>({price:+a.price,size:+a.size})).sort((a,b)=>a.price-b.price).slice(0,5);
    const bids = (d.bids ?? []).map(b=>({price:+b.price,size:+b.size})).sort((a,b)=>b.price-a.price).slice(0,5);
    return { simulated: false, bids, asks };
  } catch { return { simulated:true, bids:[], asks:[] }; }
}

async function fetchMarketClosedServer(slug) {
  try {
    const r = await fetchExternal(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
    const raw = await r.json();
    const m = Array.isArray(raw) ? raw[0] : raw?.markets?.[0];
    if (!m) return { closed:false, resolvedPrice:null };
    const outcomePrices = Array.isArray(m.outcomePrices) ? m.outcomePrices.map(Number) : null;
    return { closed: !!m.closed, resolvedPrice: (m.closed && outcomePrices) ? outcomePrices[0] : null };
  } catch { return { closed:false, resolvedPrice:null }; }
}

async function discover() {
  if (bot.discovering) return;
  bot.discovering = true;
  botLog("DISC", "Scan marchés Polymarket (binaires à 2 jetons)…");
  const { markets, fetchOk, totalRaw } = await discoverMarketsServer();
  if (!fetchOk) {
    bot.apiSt.gamma = "err";
    botLog("WARN", "Gamma API inaccessible (voir logs [EXT] pour le détail)");
  } else if (markets.length === 0) {
    bot.apiSt.gamma = "ok";
    botLog("WARN", `${totalRaw} marchés reçus mais aucun binaire à 2 jetons éligible`);
    bot.markets = [];
  } else {
    bot.apiSt.gamma = "ok";
    const prevById = {}; bot.markets.forEach(m => prevById[m.id] = m);
    bot.markets = markets.map(m => prevById[m.id] ? { ...m, ...prevById[m.id], title:m.title, volume24h:m.volume24h, liquidity:m.liquidity } : m)
      .sort((a,b)=>b.volume24h-a.volume24h)
      .slice(0, 60);
    botLog("DISC", `${totalRaw} marchés reçus → ${markets.length} binaires éligibles → ${bot.markets.length} suivis (top volume)`);
  }
  bot.discovering = false;
}

function currentExposure() {
  return bot.positions.filter(p=>p.status==="OPEN").reduce((s,p)=>s+p.size,0);
}

// [v11] Clôture par résolution du marché — le profit est garanti et connu dès
// l'ouverture, pas de SL/TP à gérer une fois les deux jambes remplies.
function closePosition(posId, reason) {
  const idx = bot.positions.findIndex(p=>p.id===posId && p.status==="OPEN");
  if (idx===-1) return;
  const p = bot.positions[idx];
  const label = p.label.slice(0,40);
  let pnlUSDC;
  if (reason === "RESOLVED") {
    // [FIX] Paiement garanti = nombre de parts réellement acquises × $1 (pas size/cost,
    // qui perdait en précision face à l'arrondi à 2 décimales du moteur v12).
    const payoff = p.shares ?? (p.size / p.cost);
    pnlUSDC = payoff - p.size;
    bot.bankroll += payoff;
    botLog("SETTLE", `RÉSOLU ${label} PnL=${pnlUSDC>=0?"+":""}$${pnlUSDC.toFixed(2)} (attendu $${(p.expectedProfit??0).toFixed(2)})`);
  } else {
    // [FIX] MANUAL — le marché n'est PAS confirmé résolu. Aucune vente réelle n'est
    // exécutée ici (ce bouton ne fait que nettoyer une position bloquée/orpheline côté
    // suivi interne) : créditer le profit garanti serait mensonger puisque rien ne
    // prouve que le marché a effectivement résolu. On ne recrédite que le capital
    // engagé, sans profit fictif, et on le signale clairement dans le log.
    pnlUSDC = 0;
    bot.bankroll += p.size;
    botLog("CLOSE", `${label} — clôture manuelle AVANT résolution confirmée : capital repris ($${p.size.toFixed(2)}), aucun profit crédité (aucune vente réelle exécutée — vérifier manuellement l'état du marché sur Polymarket)`);
  }
  bot.positions[idx] = { ...p, status:"CLOSED", pnlUSDC, closedAt:new Date().toISOString() };
}

// [v12-8] Enregistre une opportunité refusée (borné à 300 entrées) — sert uniquement à
// l'analyse ultérieure (comparer profit espéré vs jamais réalisé, causes de refus les
// plus fréquentes par catégorie). Ne modifie JAMAIS les paramètres automatiquement.
function recordRejected(m, reason) {
  const a = m.arb ?? {};
  bot.rejected.push({
    ts: new Date().toISOString(), marketId: m.id, title: m.title, category: m.category,
    reason, score: m.score ?? null,
    // [v13-6] détail complet du calcul refusé — pour l'analyse ultérieure (point 8 :
    // comparer profit attendu vs réel, causes de refus les plus fréquentes par catégorie)
    edge: a.edge ?? null, cost: a.cost ?? null,
    bestAskYes: a.bestAskYes ?? null, bestAskNo: a.bestAskNo ?? null,
    vwapYes: a.askYes ?? null, vwapNo: a.askNo ?? null,
    commonShares: a.commonShares ?? null, slippage: a.slippage ?? null,
    levelsUsedYes: a.levelsUsedYes ?? null, levelsUsedNo: a.levelsUsedNo ?? null,
  });
  if (bot.rejected.length > 300) bot.rejected = bot.rejected.slice(-300);
}

// [v12-9] Comptabilise un échec d'exécution — utilisé par le kill-switch. Ne fait PAS
// s'arrêter le bot lui-même : ne fait qu'incrémenter, checkRiskLimits() décide de la pause.
function registerExecutionError() {
  bot.consecutiveErrors = (bot.consecutiveErrors ?? 0) + 1;
  if (bot.consecutiveErrors >= (bot.cfg.maxConsecutiveErrors ?? 5)) {
    bot.paused = true;
    bot.pausedReason = `${bot.consecutiveErrors} échecs d'exécution consécutifs`;
    botLog("RISK", `⛔ AUTO-EXECUTE mis en pause : ${bot.pausedReason}. Reprise manuelle requise (POST /bot-resume).`);
  }
}

// [v12-9] Vérifie les limites de perte journalière/hebdomadaire après chaque trade —
// arrêt automatique du trading si dépassées. Ne modifie jamais les paramètres eux-mêmes,
// seulement le drapeau bot.paused (reprise manuelle explicite requise).
function checkRiskLimits() {
  const c = bot.cfg;
  if (bot.paused) return;
  const dailyLossPct = bot.startBr > 0 ? (bot.startBr - bot.bankroll) / bot.startBr : 0;
  if (dailyLossPct >= (c.dailyLossLimitPct ?? 1)) {
    bot.paused = true;
    bot.pausedReason = `perte journalière ${(dailyLossPct*100).toFixed(1)}% ≥ limite ${(c.dailyLossLimitPct*100).toFixed(0)}%`;
    botLog("RISK", `⛔ AUTO-EXECUTE mis en pause : ${bot.pausedReason}`);
    return;
  }
  if (bot.week?.startBr > 0) {
    const weeklyLossPct = (bot.week.startBr - bot.bankroll) / bot.week.startBr;
    if (weeklyLossPct >= (c.weeklyLossLimitPct ?? 1)) {
      bot.paused = true;
      bot.pausedReason = `perte hebdomadaire ${(weeklyLossPct*100).toFixed(1)}% ≥ limite ${(c.weeklyLossLimitPct*100).toFixed(0)}%`;
      botLog("RISK", `⛔ AUTO-EXECUTE mis en pause : ${bot.pausedReason}`);
    }
  }
}

async function executeOrder(marketId) {
  const m = bot.markets.find(x=>x.id===marketId);
  if (!m) return;
  const c = bot.cfg, br = bot.bankroll, now = Date.now();
  const today = new Date().toISOString().slice(0,10);
  if (bot.daily.date !== today) bot.daily = { date: today, count: 0 };
  if ((bot.cooldowns[marketId]??0) > now) return;
  if (bot.daily.count >= c.maxDaily) { botLog("RISK","Limite journalière atteinte"); return; }
  // [v12-9] Kill-switch : arrêt automatique si les limites de risque sont déclenchées
  if (bot.paused) { botLog("RISK", `Trading en pause: ${bot.pausedReason}`); return; }
  if (!m.arb?.valid) {
    recordRejected(m, "Signal invalide: " + m.arb?.reason);
    return;
  }
  if (m.sizeUSDC < 1) { recordRejected(m, "Taille arb < $1 (liquidité insuffisante)"); return; }

  const expo = currentExposure(), expoMax = br*c.maxExposure;
  let targetSize = m.sizeUSDC;
  if (expo+targetSize > expoMax) {
    const room = expoMax-expo;
    if (room < 1) { recordRejected(m, "EXPO_LIMIT"); return; }
    targetSize = room; botLog("RISK", `EXPO_CAP → $${targetSize.toFixed(2)}`);
  }

  let mode = "PAPER";
  // [FIX] arbUsed reflète maintenant la forme v12 (roundedShares, realCostUSDC, cost=VWAP)
  let arbUsed = m.arb;
  const client = await getClobClient();
  if (client) {
    // [FIX 1] Re-vérifier le carnet juste avant d'exécuter — m.arb peut dater de
    // jusqu'à refreshMs (15s) plus tôt ; le prix a pu bouger depuis le dernier scan.
    const [freshYes, freshNo] = await Promise.all([fetchBookServer(m.tokenYes), fetchBookServer(m.tokenNo)]);
    const freshArb = engine.detectMarketArb(freshYes, freshNo, c, targetSize);
    if (!freshArb.valid) {
      botLog("WARN", `Edge disparu entre le scan et l'exécution (${freshArb.reason}) → annulé`);
      return;
    }
    arbUsed = freshArb;
    const shares = freshArb.roundedShares;
    // [FIX 2] Les deux jambes partent EN PARALLÈLE (Promise.allSettled) plutôt qu'en
    // séquence — ça réduit la fenêtre de latence entre les deux ordres pendant laquelle
    // le prix de la seconde jambe pourrait bouger avant même d'être soumise.
    const [rYes, rNo] = await Promise.allSettled([
      (async()=>{ const o = await client.createOrder({ tokenID:m.tokenYes, price:freshArb.askYes, side:"BUY", size:shares, feeRateBps:0 }); return client.postOrder(o,"FOK"); })(),
      (async()=>{ const o = await client.createOrder({ tokenID:m.tokenNo, price:freshArb.askNo, side:"BUY", size:shares, feeRateBps:0 }); return client.postOrder(o,"FOK"); })(),
    ]);
    const yesOk = rYes.status === "fulfilled", noOk = rNo.status === "fulfilled";

    if (yesOk && noOk) {
      mode = "LIVE";
      bot.consecutiveErrors = 0;
      botLog("EXEC", "Ordres live remplis (2 jambes) ✅");
    } else if (yesOk || noOk) {
      // [FIX 3] REMPLISSAGE PARTIEL — une jambe a rempli, l'autre non. On est exposé
      // directionnellement (plus du tout un arbitrage sans risque). On tente de
      // dénouer IMMÉDIATEMENT la jambe remplie en la revendant au marché, plutôt que
      // de silencieusement traiter tout ça comme du paper (ce qui masquerait un vrai
      // capital engagé et non couvert).
      const filledSide = yesOk ? "YES" : "NO";
      const filledToken = yesOk ? m.tokenYes : m.tokenNo;
      const entryPrice = yesOk ? freshArb.askYes : freshArb.askNo;
      botLog("RISK", `REMPLISSAGE PARTIEL sur ${m.title.slice(0,40)} — jambe ${filledSide} remplie seule, tentative de dénouement immédiat`);
      registerExecutionError();
      try {
        const unwindPrice = 0.01;
        const unwindOrder = await client.createOrder({ tokenID: filledToken, price: unwindPrice, side:"SELL", size: shares, feeRateBps:0 });
        await client.postOrder(unwindOrder, "FOK");
        // [FIX] Une vraie transaction a eu lieu (achat puis revente à perte) — sans
        // l'enregistrer, la bankroll suivie en interne resterait plus élevée que le
        // capital réellement disponible sur le portefeuille, un écart qui s'accumulerait
        // silencieusement à chaque incident de ce type.
        const realizedLoss = shares * (entryPrice - unwindPrice);
        bot.bankroll -= realizedLoss;
        botLog("RISK", `Dénouement réussi — position ${filledSide} revendue, perte réalisée ~$${realizedLoss.toFixed(2)} déduite de la bankroll`);
        await persistBotState();
        checkRiskLimits();
      } catch(e) {
        botLog("ERR", `⚠ DÉNOUEMENT ÉCHOUÉ — position ${filledSide} RESTE OUVERTE ET EXPOSÉE sans couverture sur ${m.title.slice(0,40)} (${shares} parts à ~${(entryPrice*100).toFixed(1)}¢, capital réel engagé non reflété dans la bankroll suivie). Intervention manuelle requise. (${e.message})`);
      }
      return; // ne crée pas de position "arb" classique — l'incident est déjà loggé
    } else {
      // [FIX CRITIQUE] Aucune des deux jambes n'a rempli — AUCUN capital réel n'a été
      // engagé. L'ancien code continuait malgré tout vers la création d'une position et
      // débitait la bankroll comme si un trade avait eu lieu ("→ PAPER" trompeur) : en
      // mode live, ça aurait fait diverger silencieusement le suivi interne du capital
      // par rapport au portefeuille réel, à chaque échec d'exécution. On abandonne
      // proprement, sans toucher à la bankroll ni créer de position fictive.
      registerExecutionError();
      botLog("WARN", `Aucune des deux jambes n'a rempli (${rYes.reason?.message ?? ""} / ${rNo.reason?.message ?? ""}) → annulé, aucun capital engagé`);
      return;
    }
  }

  // [FIX] Le coût réel engagé (realCostUSDC) peut différer légèrement de targetSize à
  // cause de l'arrondi à 2 décimales des parts — on enregistre le coût RÉEL, pas la
  // taille visée initialement, pour un suivi de bankroll exact.
  const realCost = arbUsed.realCostUSDC ?? targetSize;
  const shares = arbUsed.roundedShares ?? (targetSize / arbUsed.cost);
  const expectedProfit = engine.calcArbProfit(realCost, arbUsed.cost, arbUsed.edge);

  const pos = {
    id: `${marketId}-${now}`, marketId, label: m.title, slug: m.slug,
    cost: arbUsed.cost, edge: arbUsed.edge, size: realCost, shares,
    expectedProfit, // [v12-6/8] pour comparaison profit attendu vs profit réel
    ts: new Date().toISOString(), status: "OPEN", mode, pnlUSDC: 0,
  };
  bot.positions.push(pos);
  bot.bankroll -= realCost;
  if (bot.daily.count === 0) bot.startBr = br;
  bot.daily = { ...bot.daily, count: bot.daily.count+1 };
  bot.cooldowns[marketId] = now + c.cooldown;
  botLog("ORDER", `[${mode}] ARB ${m.title.slice(0,40)} VWAP(O/N)=${(arbUsed.askYes*100).toFixed(1)}/${(arbUsed.askNo*100).toFixed(1)}¢ coût=${(arbUsed.cost*100).toFixed(1)}¢ $${realCost.toFixed(2)} edge=${(arbUsed.edge*100).toFixed(1)}% commun=${(arbUsed.commonShares??0).toFixed(2)}parts niv(O/N)=${arbUsed.levelsUsedYes??'-'}/${arbUsed.levelsUsedNo??'-'} slip=${((arbUsed.slippage??0)*100).toFixed(2)}% profit attendu=$${expectedProfit.toFixed(2)}`);
  // [FIX] Persister IMMÉDIATEMENT après ce trade — l'ancien code ne sauvegardait qu'une
  // fois à la toute fin du cycle. Si plusieurs trades s'exécutent dans le même cycle et
  // que le process crashe entre deux, les trades déjà envoyés (potentiellement de vrais
  // ordres en mode live) disparaissaient du suivi interne au redémarrage, alors que
  // l'ordre réel, lui, avait bien été passé sur Polymarket.
  await persistBotState();
  checkRiskLimits();
}

// [TEST] Logique de décision pure extraite de tick() — aucune I/O ici, uniquement du
// calcul à partir de données déjà récupérées. Permet de tester unitairement (sans réseau)
// le comportement exact utilisé en production.
// [FIX CRITIQUE] Le moteur v12 calcule l'edge réel (VWAP multi-niveaux) À UNE TAILLE
// DONNÉE — il faut donc d'abord déterminer une taille candidate (profondeur/bankroll/
// score), PUIS demander au moteur l'edge réel à cette taille précise. L'ancien code
// appelait detectMarketArb sans taille cible : il retournait systématiquement
// "SIZE_NULLE" et ne détectait plus jamais rien.
function computeMarketUpdate(m, cfg, bankroll, closedInfo, bookYes, bookNo) {
  if (closedInfo.closed) {
    return {
      market: { ...m, closed:true, arb:{ valid:false, reason:"CLOSED" }, sizeUSDC:0, score:0 },
      shouldClosePositions: true,
      clobOk: false,
    };
  }
  const clobOk = !bookYes?.simulated || !bookNo?.simulated;
  // [v12-4] Score composite du marché (liquidité, profondeur, volume, échéance, spread)
  const score = engine.scoreMarket(m, bookYes, bookNo);
  const minScore = cfg.minMarketScore ?? 0;
  if (score < minScore) {
    return {
      market: { ...m, bookYes, bookNo, arb: { valid:false, reason:`SCORE_BAS(${score}<${minScore})` }, sizeUSDC:0, score },
      shouldClosePositions: false, clobOk,
    };
  }
  // Taille candidate d'abord (profondeur réelle + bankroll + facteur de score),
  // puis edge RÉEL (VWAP + arrondi + frais) recalculé À cette taille précise.
  const candidateSize = engine.sizeArb(bookYes, bookNo, cfg, bankroll, score);
  const arb = engine.detectMarketArb(bookYes, bookNo, cfg, candidateSize);
  const sizeUSDC = arb.valid ? candidateSize : 0;
  return {
    market: { ...m, bookYes, bookNo, arb, sizeUSDC, score },
    shouldClosePositions: false,
    clobOk,
  };
}

async function tick() {
  // [FIX] Garde anti-chevauchement — sans elle, si un cycle prend plus de temps que
  // refreshMs (réseau lent, 60 marchés à vérifier), le cycle suivant pourrait démarrer
  // avant la fin du précédent et déclencher un double trade sur le même signal avant
  // que la position du premier n'ait eu le temps d'être enregistrée.
  if (bot.ticking || !bot.markets.length) return;
  bot.ticking = true;
  try {
  const c = bot.cfg;
  // [FIX] Le compteur journalier n'était réinitialisé qu'au démarrage du serveur — au-delà
  // de maxDaily trades au total (pas par jour), le bot restait bloqué indéfiniment après
  // minuit. On vérifie la date à chaque cycle.
  const today = new Date().toISOString().slice(0,10);
  if (bot.daily.date !== today) bot.daily = { date: today, count: 0 };
  // [v12-9] Rotation hebdomadaire du suivi de perte
  const weekAgeDays = (Date.now() - new Date(bot.week.start).getTime()) / 86400000;
  if (weekAgeDays >= 7) bot.week = { start: today, startBr: bot.bankroll };

  bot.tickCount = (bot.tickCount ?? 0) + 1;
  // [v12-11] Vérifier la résolution coûte un appel Gamma en plus par marché ; le faire à
  // CHAQUE cycle (15s) pour 60 marchés = ~180 requêtes externes/15s, un vrai risque de
  // rate-limit. On l'espace désormais selon cfg.closedCheckEveryNTicks (défaut: 1 fois
  // sur 4, soit environ toutes les minutes) — le carnet d'ordres, lui, reste vérifié à
  // chaque cycle car c'est lui qui détermine si un arbitrage est tradable maintenant.
  const shouldCheckClosed = (bot.tickCount % Math.max(c.closedCheckEveryNTicks ?? 1, 1)) === 0;

  const batchSize = 4, delayMs = 200;
  for (let i=0; i<bot.markets.length; i += batchSize) {
    const batch = bot.markets.slice(i, i+batchSize);
    await Promise.all(batch.map(async (m, j) => {
      const idx = i+j;
      const closedInfo = shouldCheckClosed ? await fetchMarketClosedServer(m.slug) : { closed: m.closed ?? false };
      let bookYes = null, bookNo = null;
      if (!closedInfo.closed) {
        [bookYes, bookNo] = await Promise.all([fetchBookServer(m.tokenYes), fetchBookServer(m.tokenNo)]);
      }
      const result = computeMarketUpdate(m, c, bot.bankroll, closedInfo, bookYes, bookNo);
      bot.markets[idx] = result.market;
      if (result.clobOk) bot.apiSt.clob = "ok";
      if (result.market.arb?.valid) {
        const a = result.market.arb;
        botLog("SIG", `${m.title.slice(0,40)} bestAsk(O/N)=${(a.bestAskYes*100).toFixed(1)}/${(a.bestAskNo*100).toFixed(1)}¢ VWAP(O/N)=${(a.askYes*100).toFixed(1)}/${(a.askNo*100).toFixed(1)}¢ coût=${(a.cost*100).toFixed(1)}¢ edge=${(a.edge*100).toFixed(1)}% commun=${a.commonShares.toFixed(2)}parts niv(O/N)=${a.levelsUsedYes}/${a.levelsUsedNo} slip=${(a.slippage*100).toFixed(2)}% taille=$${result.market.sizeUSDC.toFixed(0)}`);
      } else if (shouldCheckClosed && result.market.arb?.reason && !["INIT","CLOSED"].includes(result.market.arb.reason)) {
        // [FIX] recordRejected() n'était en réalité jamais appelée depuis le cycle
        // principal — seulement dans des cas rares d'appel manuel. Le tableau de
        // diagnostic "opportunités refusées" restait donc vide en permanence, alors
        // même qu'il sert justement à répondre à "pourquoi aucun trade ?". On
        // échantillonne au même rythme que la vérif de résolution (~1x/min) pour
        // rester représentatif sans saturer le tableau borné à 300 entrées.
        recordRejected(result.market, result.market.arb.reason);
      }
      if (result.shouldClosePositions) {
        bot.positions.forEach((p) => { if (p.marketId===m.id && p.status==="OPEN") closePosition(p.id, "RESOLVED"); });
        persistBotState().catch(()=>{});
      }
    }));
    if (i+batchSize < bot.markets.length) await new Promise(r=>setTimeout(r, delayMs));
  }

  if (c.autoExec === 1 && !bot.paused) {
    const now = Date.now();
    for (const m of bot.markets) {
      if (!m.arb?.valid) continue;
      if (m.sizeUSDC < 1) continue;
      if ((bot.cooldowns[m.id]??0) > now) continue;
      if (bot.positions.some(p=>p.marketId===m.id && p.status==="OPEN")) continue;
      await executeOrder(m.id);
    }
  }

  await persistBotState();
  } finally {
    bot.ticking = false;
  }
}

let tickTimer = null, discTimer = null;
async function startEngine() {
  await loadBotState();
  await discover();
  tickTimer = setInterval(() => { tick().catch(e=>console.error('[TICK]',e.message)); }, Math.max(bot.cfg.refreshMs || 15000, 15000));
  discTimer = setInterval(() => { discover().catch(e=>console.error('[DISC]',e.message)); }, 300000);
  botLog("SYS", "Moteur autonome v11 démarré — arbitrage mécanique, sans corrélation");

  // [FIX] Sans trafic entrant, Render (plan gratuit) met le service en veille après 15 min
  // d'inactivité — ce qui tuerait le moteur si personne n'a l'app ouverte. On s'auto-ping
  // toutes les 10 min via notre propre URL publique pour rester éveillé, indépendamment
  // du navigateur de l'utilisateur.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl) {
    setInterval(() => {
      fetch(selfUrl).catch(()=>{});
    }, 600000);
    botLog("SYS", `Auto-ping activé (${selfUrl}) — le moteur reste actif même sans app ouverte`);
  } else {
    botLog("WARN", "RENDER_EXTERNAL_URL absente — le service pourrait s'endormir après 15min sans trafic externe");
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════
function serializeMarket(m) {
  const { bookYes, bookNo, ...rest } = m;
  return rest;
}
app.get('/bot-state', (req, res) => {
  const cl = bot.positions.filter(p=>p.status==="CLOSED");
  const pnl = cl.reduce((s,p)=>s+(p.pnlUSDC??0),0);
  const wins = cl.filter(p=>(p.pnlUSDC??0)>0).length;
  const metrics = { pnl, winRate: cl.length?wins/cl.length:0, sharpe: engine.calcSharpe(cl.map(p=>(p.pnlUSDC??0)/Math.max(p.size,1))), trades: bot.positions.length };
  res.json({
    cfg: bot.cfg,
    markets: bot.markets.map(serializeMarket),
    positions: bot.positions.slice(-200),
    bankroll: bot.bankroll,
    startBr: bot.startBr,
    metrics,
    holdStats: engine.computeHoldStats(bot.positions), // [v12-6] stats avancées
    apiSt: bot.apiSt,
    discovering: bot.discovering,
    logs: bot.logs.slice(-150),
    daily: bot.daily,
    week: bot.week,
    paused: bot.paused,
    pausedReason: bot.pausedReason,
    consecutiveErrors: bot.consecutiveErrors,
    rejected: bot.rejected.slice(-50), // [v12-8] dernières opportunités refusées
  });
});

// [v12-9] Reprise manuelle explicite après un arrêt du kill-switch — jamais automatique,
// conformément à la consigne : le système ne modifie/relance jamais seul ses paramètres.
// [FIX] Purge les réglages hérités de versions précédentes (ex: minEdge resté à 8%
// depuis l'ancien moteur par corrélation, jamais mis à jour par les migrations
// automatiques puisque la fusion cfg préserve toujours les valeurs déjà sauvegardées).
app.post('/bot-cfg/reset', (req, res) => {
  const oldCfg = { ...bot.cfg };
  bot.cfg = { ...engine.DEFAULT_CFG };
  botLog("SYS", `Config réinitialisée aux valeurs par défaut (ancien minEdge=${oldCfg.minEdge}, nouveau=${bot.cfg.minEdge})`);
  persistBotState().catch(()=>{});
  res.json({ ok:true, cfg: bot.cfg });
});

app.post('/bot-resume', (req, res) => {
  bot.paused = false;
  bot.pausedReason = null;
  bot.consecutiveErrors = 0;
  botLog("SYS", "Trading repris manuellement après pause");
  persistBotState().catch(()=>{});
  res.json({ ok:true });
});

app.post('/bot-cfg', (req, res) => {
  const { proxyUrl, ...incoming } = req.body || {};
  const oldRefresh = bot.cfg.refreshMs;
  bot.cfg = { ...bot.cfg, ...incoming };
  if (incoming.refreshMs && incoming.refreshMs !== oldRefresh) {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { tick().catch(e=>console.error('[TICK]',e.message)); }, Math.max(bot.cfg.refreshMs, 15000));
  }
  persistBotState().catch(()=>{});
  res.json({ ok:true, cfg: bot.cfg });
});

app.post('/bot-discover', async (req, res) => {
  discover().catch(e=>console.error('[DISC]', e.message));
  res.json({ ok:true });
});

app.post('/bot-exec', async (req, res) => {
  const { marketId } = req.body || {};
  if (!marketId) return res.status(400).json({ ok:false, error:"marketId requis" });
  await executeOrder(marketId);
  res.json({ ok:true });
});

app.post('/bot-close', (req, res) => {
  const { posId } = req.body || {};
  if (!posId) return res.status(400).json({ ok:false, error:"posId requis" });
  closePosition(posId, "MANUAL");
  persistBotState().catch(()=>{});
  res.json({ ok:true });
});

app.get('/markets', async (req, res) => {
  try {
    const r = await fetchExternal(`https://gamma-api.polymarket.com/markets?limit=500&active=true&order=volume&ascending=false`);
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(502).json({ error: e.message, hint: "Voir logs serveur Render pour le détail (préfixe [EXT])" });
  }
});

app.get('/book', async (req, res) => {
  const { tokenId } = req.query;
  if (!tokenId) return res.status(400).json({ error: "tokenId requis" });
  try {
    const r = await fetchExternal(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    const d = await r.json();
    res.json({
      simulated: false,
      bids: (d.bids ?? []).slice(0,5).map(b => ({ price:+b.price, size:+b.size })),
      asks: (d.asks ?? []).slice(0,5).map(a => ({ price:+a.price, size:+a.size })),
    });
  } catch(e) {
    res.json({ simulated:true, bids:[], asks:[], error: e.message });
  }
});

app.get('/state', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM state');
    const out = {};
    r.rows.forEach(row => out[row.key] = row.value);
    res.json(out);
  } catch(e) {
    res.json({});
  }
});
app.post('/state', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await pool.query('INSERT INTO state (key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()', [key, value]);
    }
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/order", async (req, res) => {
  const { market, tokenId, side, amount, price } = req.body;
  console.log(`[ORDER] ${side} ${market} $${amount} @${price}`);
  const client = await getClobClient();
  if (!client) return res.json({ status:"paper", msg:"Simulated (POLY_PRIVATE_KEY non configurée)", order:req.body });
  try {
    const order = await client.createOrder({ tokenID: tokenId, price: Number(price), side: side === "SELL" ? "SELL" : "BUY", size: Number(amount), feeRateBps: 0 });
    const resp = await client.postOrder(order, "FOK");
    res.json({ status:"live", data: resp });
  } catch(e) {
    res.status(500).json({ status:"error", msg:e.message });
  }
});

const PORT = process.env.PORT || 3000;
// [TEST] Garde require.main : `node index.js` (production) démarre normalement le
// serveur et le moteur. `require('./index.js')` depuis un test NE les démarre PAS —
// aucun changement de comportement en production, ça n'affecte que les tests.
if (require.main === module) {
  app.listen(PORT, () => console.log(`POLYARB proxy on :${PORT}`));
  initDB().then(startEngine);
}

// [TEST] Exports pour la suite de tests — n'affecte en rien le fonctionnement normal
// (module.exports n'est lu que par du code qui fait explicitement require('./index.js')).
module.exports = {
  app, bot, engine,
  tick, discover, executeOrder, closePosition, computeMarketUpdate,
  parseSingleMarkets, getTokenIds, discoverMarketsServer,
  fetchBookServer, fetchMarketClosedServer, fetchExternal,
  loadBotState, persistBotState, initDB,
  recordRejected, registerExecutionError, checkRiskLimits, currentExposure,
};
