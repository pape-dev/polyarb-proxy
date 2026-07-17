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

// ─── [v15-7] CONTRÔLE D'INTÉGRITÉ POSTGRESQL ───────────────────────────────
// PROBLÈME RÉSOLU : jusqu'ici, une perte de connexion DB n'était visible qu'indirectement
// (le message générique "[BOT] Erreur persistance: ..." dans les logs bruts), sans état
// consultable ni alerte. Impossible de savoir d'un coup d'œil si la persistance
// fonctionne réellement en ce moment.
// CHOIX TECHNIQUE : `pool.on('error', ...)` est l'API standard du driver `pg` pour
// détecter la perte d'un client inactif dans le pool — écouter cet événement ne modifie
// AUCUN appel pool.query() existant (zéro risque de régression sur le code déjà validé).
// Le suivi des succès/échecs d'écriture spécifiques est ajouté séparément, de façon
// additive, à l'intérieur des try/catch déjà présents dans persistBotState/loadBotState
// (mêmes lignes, mêmes comportements, juste une ligne de plus pour mettre à jour dbHealth).
const dbHealth = { connected: true, lastError: null, lastErrorAt: null, totalErrors: 0, lastSuccessfulWriteAt: null, lastSuccessfulReadAt: null };
pool.on('error', (err) => {
  dbHealth.connected = false;
  dbHealth.lastError = err.message;
  dbHealth.lastErrorAt = new Date().toISOString();
  dbHealth.totalErrors++;
  botLog("RISK", `⛔ PostgreSQL : erreur de connexion détectée — ${err.message}`);
  triggerAlert('db_connection_lost', { error: err.message }).catch(()=>{});
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

// ─── [v14-3] SURVEILLANCE AVANCÉE DES API (Gamma / CLOB) ──────────────────
// PROBLÈME RÉSOLU : jusqu'ici, les seules traces de la santé des API externes étaient
// les logs bruts [EXT] (un par appel, non agrégés) et le badge simplifié apiSt.gamma/
// clob ("ok"/"err"/"boot"). Impossible de répondre à "la latence Gamma se dégrade-t-elle
// progressivement ?" ou "quel est le taux d'erreur réel sur la dernière heure ?".
// RISQUES ÉVITÉS : ces métriques sont PUREMENT informatives (exposées en lecture via
// /bot-state) — aucune logique de trading ne les consulte ni n'en dépend. Le moteur ne
// modifie jamais son comportement automatiquement en fonction de ces chiffres, comme
// demandé : c'est un tableau de bord, pas un déclencheur.
// CHOIX TECHNIQUE : classification par nom d'hôte dans l'URL (gamma-api vs clob), un seul
// point d'instrumentation (fetchExternal, déjà le passage obligé de tous les appels
// externes) plutôt que d'instrumenter chaque fonction d'appel individuellement —
// garantit qu'aucun appel réseau ne peut échapper au comptage par erreur d'oubli.
const apiMetrics = {
  gamma: { totalRequests:0, totalErrors:0, responseTimes:[], incidents:[] },
  clob:  { totalRequests:0, totalErrors:0, responseTimes:[], incidents:[] },
  other: { totalRequests:0, totalErrors:0, responseTimes:[], incidents:[] },
};
function classifyApi(url) {
  if (url.includes('gamma-api.polymarket.com')) return 'gamma';
  if (url.includes('clob.polymarket.com')) return 'clob';
  return 'other';
}
function recordApiCall(api, durationMs, ok, errorMsg) {
  const m = apiMetrics[api] ?? apiMetrics.other;
  m.totalRequests++;
  if (!ok) {
    m.totalErrors++;
    m.incidents.push({ ts: new Date().toISOString(), error: (errorMsg||"").slice(0,200) });
    if (m.incidents.length > 20) m.incidents = m.incidents.slice(-20); // borné, pas de fuite mémoire
  }
  m.responseTimes.push(durationMs);
  if (m.responseTimes.length > 200) m.responseTimes = m.responseTimes.slice(-200); // idem
}
// Agrégation à la demande (jamais recalculée en continu) — lue uniquement par /bot-state.
function computeApiHealth() {
  const out = {};
  for (const [name, m] of Object.entries(apiMetrics)) {
    const times = m.responseTimes;
    const avg = times.length ? times.reduce((s,v)=>s+v,0)/times.length : 0;
    const max = times.length ? Math.max(...times) : 0;
    out[name] = {
      totalRequests: m.totalRequests,
      totalErrors: m.totalErrors,
      errorRate: m.totalRequests > 0 ? m.totalErrors / m.totalRequests : 0,
      availability: m.totalRequests > 0 ? 1 - (m.totalErrors / m.totalRequests) : 1,
      avgResponseMs: Math.round(avg),
      maxResponseMs: Math.round(max),
      recentIncidents: m.incidents.slice(-10),
    };
  }
  return out;
}

// ─── [v15-8] SYSTÈME D'ALERTES EXTENSIBLE ──────────────────────────────────
// PROBLÈME RÉSOLU : les événements critiques (pause automatique, circuit breaker,
// perte DB, erreurs répétées) n'étaient visibles que dans les logs — il fallait
// activement consulter l'app pour les remarquer. Ce système garde une trace interne
// ET peut pousser vers un canal externe (Telegram, Discord, email...) SANS que le
// reste du moteur n'ait besoin de savoir comment ce canal fonctionne.
// CHOIX TECHNIQUE : un tableau de callbacks (`alertChannels`) plutôt qu'une intégration
// figée à un seul service — ajouter un canal ne demande qu'un `registerAlertChannel(fn)`,
// aucune modification du code qui déclenche les alertes. Par défaut, AUCUN canal externe
// n'est configuré (rien n'est envoyé nulle part) ; si la variable d'env ALERT_WEBHOOK_URL
// est présente, un canal webhook générique (POST JSON) est enregistré automatiquement —
// compatible out-of-the-box avec la plupart des services (Discord/Slack/Zapier acceptent
// un POST JSON simple), sans dépendance supplémentaire à installer.
// RISQUES ÉVITÉS : chaque canal est appelé dans son propre try/catch — un webhook qui
// timeout ou renvoie une erreur ne doit JAMAIS faire planter le moteur ni bloquer une
// décision de trading (les alertes sont toujours déclenchées en fire-and-forget).
const alertChannels = [];
function registerAlertChannel(fn) { alertChannels.push(fn); }
async function triggerAlert(type, details) {
  const alert = { type, details, ts: new Date().toISOString() };
  bot.alerts.push(alert);
  if (bot.alerts.length > 100) bot.alerts = bot.alerts.slice(-100); // borné, pas de fuite mémoire
  for (const channel of alertChannels) {
    try { await channel(alert); } catch(e) { console.error('[ALERT] canal en échec:', e.message); }
  }
}
if (process.env.ALERT_WEBHOOK_URL) {
  registerAlertChannel(async (alert) => {
    // [FIX] Timeout explicite — sans lui, un webhook lent ou muet bloquerait
    // indéfiniment ce canal (et donc triggerAlert, qui l'attend), pouvant accumuler
    // des promesses jamais résolues si plusieurs alertes se déclenchent en rafale.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(process.env.ALERT_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🔔 POLYARB [${alert.type}] ${JSON.stringify(alert.details)}` }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  });
}

// ─── [v15-1] CIRCUIT BREAKER PAR API EXTERNE (Gamma / CLOB) ────────────────
// PROBLÈME RÉSOLU : jusqu'ici, le bot continuait d'interroger Gamma/CLOB même après
// une longue série d'échecs consécutifs — chaque appel retente, timeout après 12s
// (fetchExternal), échoue à nouveau. En cas de panne prolongée d'une API, ça gaspille
// du temps et des ressources sans aucun bénéfice (aucune chance de succès tant que
// l'API est réellement en panne).
// RISQUES ÉVITÉS : sans ce filet, une panne CLOB de plusieurs minutes ferait quand
// même tenter ~4 appels/marché toutes les 15s pendant toute la durée de la panne —
// avec le circuit ouvert, on arrête d'essayer pendant circuitBreakerCooldownMs et on
// laisse les fallbacks existants (book simulé, closed:false) faire leur travail habituel.
// IMPORTANT : ce mécanisme ne fait QUE bloquer des appels réseau — il ne modifie jamais
// une décision de trading. Un circuit ouvert produit exactement le même résultat qu'un
// échec réseau ordinaire (déjà géré partout par les try/catch existants), juste sans
// solliciter l'API pendant le cooldown.
const circuitBreakers = {
  gamma: { state: 'closed', consecutiveErrors: 0, openedAt: null },
  clob:  { state: 'closed', consecutiveErrors: 0, openedAt: null },
  other: { state: 'closed', consecutiveErrors: 0, openedAt: null },
};
function isCircuitOpen(api) {
  const cb = circuitBreakers[api] ?? circuitBreakers.other;
  if (cb.state !== 'open') return false;
  const elapsed = Date.now() - cb.openedAt;
  if (elapsed >= (bot.cfg.circuitBreakerCooldownMs ?? 60000)) {
    // Délai de suspension écoulé → on autorise UNE tentative de sonde (half-open),
    // sans encore déclarer le circuit refermé tant qu'elle n'a pas réussi.
    cb.state = 'half-open';
    return false;
  }
  return true;
}
function recordCircuitResult(api, ok) {
  const cb = circuitBreakers[api] ?? circuitBreakers.other;
  if (ok) {
    if (cb.state !== 'closed') botLog("SYS", `⚡ Circuit breaker [${api}] refermé — API de nouveau opérationnelle`);
    cb.state = 'closed';
    cb.consecutiveErrors = 0;
    cb.openedAt = null;
  } else {
    cb.consecutiveErrors++;
    const threshold = bot.cfg.circuitBreakerThreshold ?? 5;
    if (cb.state === 'half-open' || cb.consecutiveErrors >= threshold) {
      if (cb.state !== 'open') {
        const cooldownS = Math.round((bot.cfg.circuitBreakerCooldownMs ?? 60000)/1000);
        botLog("RISK", `⛔ Circuit breaker [${api}] OUVERT après ${cb.consecutiveErrors} erreurs consécutives — appels suspendus ${cooldownS}s`);
        triggerAlert('circuit_breaker_open', { api, consecutiveErrors: cb.consecutiveErrors }).catch(()=>{});
      }
      cb.state = 'open';
      cb.openedAt = Date.now();
    }
  }
}

async function fetchExternal(url, opts = {}, timeoutMs = 12000) {
  const apiName = classifyApi(url);         // [v14-3]
  // [v15-1] Circuit ouvert → on échoue immédiatement SANS solliciter le réseau, exactement
  // comme un échec réseau ordinaire (mêmes fallbacks en aval, aucune décision différente).
  if (isCircuitOpen(apiName)) {
    throw new Error(`Circuit breaker ouvert pour ${apiName} — appel bloqué`);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();             // [v14-3]
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
      recordApiCall(apiName, Date.now()-startedAt, false, `HTTP ${r.status}`); // [v14-3]
      recordCircuitResult(apiName, false); // [v15-1]
      throw new Error(`HTTP ${r.status}`);
    }
    recordApiCall(apiName, Date.now()-startedAt, true, null); // [v14-3]
    recordCircuitResult(apiName, true); // [v15-1]
    return r;
  } catch (e) {
    clearTimeout(t);
    console.error(`[EXT] ${url} → ÉCHEC: ${e.message}`);
    // [v14-3] Si l'erreur vient du throw HTTP ci-dessus, l'appel est déjà comptabilisé —
    // on ne le recompte pas une deuxième fois (sinon un seul échec compterait double).
    if (!e.message.startsWith('HTTP ') && !e.message.startsWith('Circuit breaker')) {
      recordApiCall(apiName, Date.now()-startedAt, false, e.message);
      recordCircuitResult(apiName, false); // [v15-1]
    }
    throw e;
  }
}

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cfg (key TEXT PRIMARY KEY, value TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
    // [v15-6] Table dédiée à la journalisation persistante — les logs en mémoire
    // (bot.logs, 400 entrées max) restent inchangés et continuent d'alimenter /bot-state
    // comme avant ; cette table est un historique DURABLE en parallèle, qui survit aux
    // redémarrages. Index sur created_at pour que le nettoyage (DELETE WHERE created_at <
    // ...) et la consultation triée restent rapides même avec beaucoup de lignes.
    await pool.query(`CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY, kind TEXT, msg TEXT, created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at)`);
    // [v15-9] Snapshots quotidiens du bankroll — nécessaires pour "l'évolution du
    // bankroll dans le temps" : bot.positions seul ne suffit pas (capé à 200 entrées
    // persistées, et un jour sans aucun trade ne laisserait aucune trace du bankroll
    // à ce moment-là). ON CONFLICT permet un appel idempotent (rejouable sans dupliquer).
    await pool.query(`CREATE TABLE IF NOT EXISTS daily_snapshots (
      date DATE PRIMARY KEY, bankroll NUMERIC, created_at TIMESTAMPTZ DEFAULT now()
    )`);
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
  alerts: [],                            // [v15-8] historique des alertes déclenchées (borné à 100)
  startedAt: Date.now(),                 // [v15-3] pour le watchdog avant le tout premier tick
  lastTickCompletedAt: null,             // [v15-3] mis à jour à la fin de chaque cycle réussi
  flaggedPositionLegs: new Set(),        // [v15-2 FIX] évite de re-signaler la même incohérence en boucle
  eventCounters: {},                     // [v14-5] compteur par type d'événement (kind) depuis le démarrage
  lastSummaryAt: Date.now(),             // [v14-5] pour espacer les résumés périodiques
};

// [v14-5] PROBLÈME RÉSOLU : les logs bruts (jusqu'à 400 lignes conservées) permettent de
// voir un événement précis, mais pas de répondre vite à "combien de SIG/ORDER/WARN
// depuis le démarrage ?" sans compter les lignes à la main. Un compteur par type,
// incrémenté au même endroit que chaque log (donc jamais désynchronisé du journal),
// répond à ce besoin sans surcoût perceptible (un `++` sur un objet en mémoire).
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // résumé périodique toutes les 30 min

// [v15-6] Écriture fire-and-forget vers la table `logs` persistante — botLog() reste
// une fonction SYNCHRONE comme avant (aucun appelant existant ne doit être changé en
// async), donc cette écriture DB part en arrière-plan sans jamais être attendue ici.
// Un échec d'écriture (DB indisponible) est capturé par son propre .catch() et ne
// remonte JAMAIS à l'appelant de botLog — la persistance des logs est un bonus, pas
// une dépendance critique du fonctionnement du moteur.
function persistLogAsync(kind, msg) {
  pool.query('INSERT INTO logs (kind, msg) VALUES ($1,$2)', [kind, msg]).catch(()=>{});
}

function botLog(kind, msg) {
  const ts = new Date().toISOString().slice(11,22);
  bot.logs.push({ ts, kind, msg, id: Date.now()+Math.random() });
  console.log(`[BOT ${kind}] ${msg}`);
  persistLogAsync(kind, msg); // [v15-6]
  // [v14-5] Compteur par type — jamais réinitialisé automatiquement (compteur de vie du
  // process), remis à zéro seulement par un redémarrage du serveur.
  bot.eventCounters[kind] = (bot.eventCounters[kind] ?? 0) + 1;
  // [v14-5] Résumé périodique — volontairement ESPACÉ (30 min) et volontairement exclu
  // de son propre comptage (pas de log "SYS" recursif à chaque résumé) pour ne jamais
  // gonfler artificiellement le volume de journalisation, comme demandé.
  if (Date.now() - bot.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
    bot.lastSummaryAt = Date.now();
    const c = bot.eventCounters;
    const summary = `Résumé 30min — SIG:${c.SIG??0} ORDER:${c.ORDER??0} CLOSE:${c.CLOSE??0} SETTLE:${c.SETTLE??0} RISK:${c.RISK??0} WARN:${c.WARN??0} ERR:${c.ERR??0} | bankroll=$${bot.bankroll.toFixed(2)} | ${bot.markets.length} marchés suivis | ${bot.positions.filter(p=>p.status==="OPEN").length} positions ouvertes`;
    bot.logs.push({ ts: new Date().toISOString().slice(11,22), kind:"SYS", msg:summary, id: Date.now()+Math.random() });
    console.log(`[BOT SYS] ${summary}`);
    persistLogAsync("SYS", summary); // [v15-6]
  }
  // [FIX] Retronqué APRÈS l'ajout éventuel du résumé ci-dessus, sinon ce dernier pourrait
  // pousser le journal à 402 entrées sans jamais être ramené à la limite de 400.
  if (bot.logs.length > 400) bot.logs = bot.logs.slice(-400);
}

async function loadBotState() {
  try {
    const r = await pool.query('SELECT key, value FROM state');
    dbHealth.connected = true; dbHealth.lastSuccessfulReadAt = new Date().toISOString(); // [v15-7]
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
    // [FIX] bot.rejected n'était jamais persisté — le journal de diagnostic (v14-2)
    // disparaissait donc à chaque redémarrage (déploiement, veille Render, crash),
    // rendant impossible tout suivi de son évolution dans le temps comme demandé.
    if (s.pa6_rejected) bot.rejected = JSON.parse(s.pa6_rejected);
    botLog("SYS", "État restauré depuis Postgres — moteur v11 (arbitrage mécanique)");
  } catch(e) {
    // [v15-7] Le message et le comportement de repli ("Démarrage frais") restent
    // identiques — on ajoute seulement le suivi de santé DB en parallèle.
    dbHealth.connected = false; dbHealth.lastError = e.message; dbHealth.lastErrorAt = new Date().toISOString(); dbHealth.totalErrors++;
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
      // [FIX] voir note dans loadBotState — persistance manquante du journal de rejets.
      // Bornée à 300 entrées déjà (recordRejected), donc taille raisonnable en base.
      ["pa6_rejected", JSON.stringify(bot.rejected)],
    ];
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO state (key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
        [key, value]
      );
    }
    dbHealth.connected = true; dbHealth.lastSuccessfulWriteAt = new Date().toISOString(); // [v15-7]
  } catch(e) {
    console.error('[BOT] Erreur persistance:', e.message);
    // [v15-7] Suivi additif — le comportement existant (log + continuer sans crasher)
    // reste strictement identique, on ajoute seulement l'état consultable via /bot-state.
    dbHealth.connected = false; dbHealth.lastError = e.message; dbHealth.lastErrorAt = new Date().toISOString(); dbHealth.totalErrors++;
    if (dbHealth.totalErrors === 1 || dbHealth.totalErrors % 10 === 0) {
      // [v15-8] Alerte seulement à la première occurrence puis toutes les 10 — évite
      // de spammer le canal d'alerte si la DB reste indisponible pendant longtemps.
      triggerAlert('db_write_failed', { error: e.message, totalErrors: dbHealth.totalErrors }).catch(()=>{});
    }
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
  let orderIdYes = null, orderIdNo = null; // [v15-2/4] nécessaires à la validation périodique et à la réconciliation au redémarrage
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
      // [v15-2/4] Capture des IDs d'ordres — jusqu'ici jamais conservés, rendant
      // impossible toute vérification ultérieure ("cet ordre existe-t-il encore
      // réellement sur Polymarket ?") ou réconciliation après un redémarrage. Plusieurs
      // noms de champ tentés par prudence : la forme exacte de la réponse de
      // @polymarket/clob-client n'est pas garantie identique entre versions.
      orderIdYes = rYes.value?.orderID ?? rYes.value?.orderId ?? rYes.value?.id ?? null;
      orderIdNo  = rNo.value?.orderID  ?? rNo.value?.orderId  ?? rNo.value?.id  ?? null;
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

  // [v15-10] Simulation réaliste de l'exécution PAPER — UNIQUEMENT si aucun client CLOB
  // n'est configuré (mode encore "PAPER" à ce stade). Le bloc if(client) ci-dessus, qui
  // gère intégralement le mode LIVE, n'est ni touché ni traversé quand client existe
  // (il aurait déjà fait `return` en cas de problème) : son comportement reste
  // strictement identique à avant, conformément à la consigne.
  if (!client) {
    const sim = engine.simulatePaperExecution(arbUsed, c);
    if (sim.delayMs > 0) await new Promise(r => setTimeout(r, sim.delayMs)); // latence réseau simulée
    if (sim.outcome === 'failed') {
      // [FIX] Ne PAS appeler registerExecutionError() ici — c'est un échec SIMULÉ à des
      // fins de réalisme du mode paper, pas un vrai problème d'exécution. Le confondre
      // avec de vrais échecs LIVE (même compteur, même kill-switch) pourrait mettre le
      // bot en pause pour une simple malchance statistique simulée, en faisant croire à
      // tort qu'un problème opérationnel réel est survenu.
      botLog("WARN", `[PAPER] Échec d'exécution simulé sur ${m.title.slice(0,40)} (latence ${sim.delayMs}ms) → annulé`);
      return;
    }
    if (sim.outcome === 'rejected') {
      botLog("WARN", `[PAPER] Ordre rejeté (simulé) sur ${m.title.slice(0,40)} (latence ${sim.delayMs}ms) → annulé`);
      return;
    }
    // 'filled' ou 'partial' : on ajuste arbUsed (prix effectif dégradé + fraction
    // réellement remplie) — le code de création de position ci-dessous, commun à LIVE
    // et PAPER, n'a besoin d'aucune modification supplémentaire pour en tenir compte.
    const feeCost = (c.feeBps ?? 0) / 10000;
    arbUsed = {
      ...arbUsed,
      cost: sim.effectiveCost,
      edge: 1 - sim.effectiveCost - feeCost,
      realCostUSDC: (arbUsed.realCostUSDC ?? targetSize) * sim.filledFraction,
      roundedShares: (arbUsed.roundedShares ?? (targetSize/arbUsed.cost)) * sim.filledFraction,
    };
    if (sim.outcome === 'partial') {
      botLog("WARN", `[PAPER] Remplissage partiel simulé (${(sim.filledFraction*100).toFixed(0)}%) sur ${m.title.slice(0,40)} (latence ${sim.delayMs}ms)`);
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
    category: m.category, // [v15-9] nécessaire pour le rendement par catégorie de marché
    tokenYes: m.tokenYes, tokenNo: m.tokenNo, // [v15-2] nécessaires pour interroger le CLOB plus tard
    orderIdYes, orderIdNo,                     // [v15-2/4] idem
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

// [v14-4] PROBLÈME RÉSOLU : avec 60 marchés suivis, la majorité sont peu liquides et
// leur coût combiné (OUI+NON) ne bouge quasiment jamais entre deux cycles — interroger
// leur carnet toutes les 15s est un appel réseau presque toujours pour rien. On espace
// ces vérifications SANS jamais ignorer un marché définitivement (voir forceRescan).
// RISQUES ÉVITÉS : un marché qui redevient intéressant (regain de liquidité, mouvement
// de prix) doit être détecté — d'où le double filet de sécurité : un rescan complet
// forcé périodique (staleRescanEveryNTicks) ET une remise à zéro immédiate dès qu'un
// changement de coût est observé lors d'une vérification (retour à un suivi normal).
function shouldSkipBookFetch(m, cfg, tickCount) {
  const isLowActivity = (m.liquidity ?? 0) < (cfg.lowActivityLiquidityThreshold ?? 0)
                      && (m.volume24h ?? 0) < (cfg.lowActivityVolumeThreshold ?? 0);
  if (!isLowActivity) return false; // marché actif → jamais throttlé
  const forceRescan = (tickCount % Math.max(cfg.staleRescanEveryNTicks ?? 1, 1)) === 0;
  if (forceRescan) return false; // filet de sécurité périodique → jamais ignoré définitivement
  return tickCount < (m.nextCheckTick ?? 0);
}
// Calcule le prochain cycle où ce marché devra être revérifié, à appeler UNIQUEMENT
// après une vérification réellement effectuée (pas après un cycle sauté).
function computeNextCheckTick(prevArb, newMarket, cfg, tickCount) {
  const stillLowActivity = (newMarket.liquidity ?? 0) < (cfg.lowActivityLiquidityThreshold ?? 0)
                         && (newMarket.volume24h ?? 0) < (cfg.lowActivityVolumeThreshold ?? 0);
  if (!stillLowActivity) return tickCount; // redevenu actif → aucun délai, vérifié au prochain cycle
  const prevCost = prevArb?.cost, newCost = newMarket.arb?.cost;
  const changed = prevCost == null || newCost == null || Math.abs(newCost - prevCost) > 0.005;
  // Un changement de coût détecté = signal d'un possible retour à une situation
  // intéressante → on ne le laisse PAS s'endormir, contrairement à un marché
  // véritablement figé qui peut être vérifié moins souvent en toute sécurité.
  return changed ? tickCount : tickCount + (cfg.lowActivitySkipTicks ?? 1);
}

// ─── [v15-2/4] VALIDATION DES POSITIONS LIVE (périodique + réconciliation au démarrage) ──
// PROBLÈME RÉSOLU : une position ouverte en mode LIVE attendait jusqu'ici uniquement la
// résolution du marché, sans jamais revérifier que les ordres CLOB sous-jacents existent
// encore réellement (un ordre peut être annulé côté plateforme, expirer, ou l'état
// interne peut diverger de l'état réel pour toute autre raison).
// RISQUES ÉVITÉS : détecter ce genre d'incohérence tôt permet une intervention humaine
// avant qu'elle ne s'aggrave — mais JAMAIS d'action automatique (annulation, fermeture) :
// uniquement une détection et une journalisation, exactement comme demandé.
// CHOIX TECHNIQUE : une seule fonction, appelée à la fois périodiquement (toutes les
// positionValidationEveryNTicks cycles) ET une fois juste après le chargement de l'état
// au démarrage (réconciliation v15-4) — évite toute duplication entre les deux besoins,
// qui sont fonctionnellement identiques ("l'état interne correspond-il au réel ?").
async function validateOpenLivePositions() {
  const client = await getClobClient();
  const openLive = bot.positions.filter(p => p.status === "OPEN" && p.mode === "LIVE");
  if (openLive.length === 0) return;
  if (!client) {
    // Cas typique juste après un redémarrage sans POLY_PRIVATE_KEY reconfigurée, ou si
    // la clé a été retirée entre-temps — on le signale clairement plutôt que d'échouer
    // silencieusement.
    botLog("RISK", `⚠ ${openLive.length} position(s) LIVE ouverte(s) mais aucun client CLOB disponible — impossible de vérifier leur état réel sur Polymarket`);
    return;
  }
  for (const p of openLive) {
    for (const [leg, orderId] of [["YES", p.orderIdYes], ["NO", p.orderIdNo]]) {
      // [FIX] Une même incohérence non résolue serait re-signalée à CHAQUE cycle de
      // validation (~toutes les 5 min) tant que la position reste ouverte — ça spamme le
      // journal et, surtout, réenverrait une alerte externe (webhook) en boucle pour le
      // même incident jamais résolu. On ne signale qu'une seule fois par (position, jambe).
      const flagKey = `${p.id}:${leg}`;
      if (bot.flaggedPositionLegs.has(flagKey)) continue;
      if (!orderId) {
        botLog("RISK", `⚠ Position ${p.id} (${leg}) : aucun ID d'ordre enregistré (position antérieure à ce correctif ?), impossible à valider`);
        bot.flaggedPositionLegs.add(flagKey);
        continue;
      }
      try {
        // [v15-2] Nom de méthode standard de @polymarket/clob-client pour interroger un
        // ordre par son ID — enveloppé dans son propre try/catch : une méthode absente
        // ou une erreur réseau ne doit jamais interrompre la vérification des autres
        // positions ni, a fortiori, le moteur de trading.
        const order = await client.getOrder(orderId);
        const status = (order?.status ?? "").toString().toUpperCase();
        if (!order || status === "CANCELED" || status === "CANCELLED" || status === "EXPIRED") {
          botLog("RISK", `⚠ INCOHÉRENCE : position ${p.id} (${leg}) suivie ouverte en interne, mais l'ordre ${orderId} est ${order ? status : "INTROUVABLE"} côté Polymarket — vérification manuelle recommandée, aucune fermeture automatique effectuée`);
          triggerAlert('position_incoherence', { positionId:p.id, leg, orderId, status: order ? status : "NOT_FOUND" }).catch(()=>{});
          bot.flaggedPositionLegs.add(flagKey);
        }
      } catch(e) {
        // [FIX] Une erreur de vérification (réseau, méthode indisponible) N'EST PAS une
        // incohérence confirmée — on ne marque PAS flagKey ici, pour retenter la
        // prochaine fois plutôt que d'abandonner silencieusement cette jambe pour toujours.
        botLog("WARN", `Validation position ${p.id} (${leg}, ordre ${orderId}) impossible : ${e.message}`);
      }
    }
  }
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
  // [v15-2] Validation périodique des positions live — volontairement en fire-and-forget
  // (pas de `await`) : c'est une vérification de diagnostic, elle ne doit jamais ralentir
  // ni bloquer le cycle principal de scan/trading, même si l'appel CLOB est lent.
  if ((bot.tickCount % Math.max(c.positionValidationEveryNTicks ?? 20, 1)) === 0) {
    validateOpenLivePositions().catch(e => console.error('[POS-VALIDATE]', e.message));
  }

  const batchSize = 4, delayMs = 200;
  for (let i=0; i<bot.markets.length; i += batchSize) {
    const batch = bot.markets.slice(i, i+batchSize);
    await Promise.all(batch.map(async (m, j) => {
      const idx = i+j;
      const closedInfo = shouldCheckClosed ? await fetchMarketClosedServer(m.slug) : { closed: m.closed ?? false };
      let bookYes = m.bookYes, bookNo = m.bookNo; // [v14-4] réutilisées par défaut si le cycle est sauté
      // [v14-4] Marché peu actif (faible liquidité+volume) et pas encore dû pour un
      // rescan → on réutilise le dernier carnet connu au lieu de re-solliciter l'API,
      // sauf si le rescan périodique de sécurité tombe sur ce cycle précis.
      const skipBookFetch = !closedInfo.closed && shouldSkipBookFetch(m, c, bot.tickCount);
      if (!closedInfo.closed && !skipBookFetch) {
        [bookYes, bookNo] = await Promise.all([fetchBookServer(m.tokenYes), fetchBookServer(m.tokenNo)]);
      }
      const result = computeMarketUpdate(m, c, bot.bankroll, closedInfo, bookYes, bookNo);
      // [v14-4] Planifie la prochaine vérification réelle — uniquement quand une
      // vérification a effectivement eu lieu ce cycle (jamais après un cycle sauté,
      // sinon le délai s'accumulerait indéfiniment sans jamais revérifier le marché).
      result.market.nextCheckTick = skipBookFetch
        ? (m.nextCheckTick ?? bot.tickCount)
        : computeNextCheckTick(m.arb, result.market, c, bot.tickCount);
      bot.markets[idx] = result.market;
      if (result.clobOk) bot.apiSt.clob = "ok";
      if (result.market.arb?.valid) {
        const a = result.market.arb;
        botLog("SIG", `${m.title.slice(0,40)} bestAsk(O/N)=${(a.bestAskYes*100).toFixed(1)}/${(a.bestAskNo*100).toFixed(1)}¢ VWAP(O/N)=${(a.askYes*100).toFixed(1)}/${(a.askNo*100).toFixed(1)}¢ coût=${(a.cost*100).toFixed(1)}¢ edge=${(a.edge*100).toFixed(1)}% commun=${a.commonShares.toFixed(2)}parts niv(O/N)=${a.levelsUsedYes}/${a.levelsUsedNo} slip=${(a.slippage*100).toFixed(2)}% taille=$${result.market.sizeUSDC.toFixed(0)}`);
      } else if (!skipBookFetch && shouldCheckClosed && result.market.arb?.reason && !["INIT","CLOSED"].includes(result.market.arb.reason)) {
        // [FIX] recordRejected() n'était en réalité jamais appelée depuis le cycle
        // principal — seulement dans des cas rares d'appel manuel. Le tableau de
        // diagnostic "opportunités refusées" restait donc vide en permanence, alors
        // même qu'il sert justement à répondre à "pourquoi aucun trade ?". On
        // échantillonne au même rythme que la vérif de résolution (~1x/min) pour
        // rester représentatif sans saturer le tableau borné à 300 entrées.
        // [FIX v14-scan] `!skipBookFetch` ajouté : sans cette condition, un marché mis
        // en veille par l'optimisation réseau (v14-4) pouvait quand même être enregistré
        // ici avec une raison de refus basée sur un carnet PÉRIMÉ (pas re-vérifié ce
        // cycle) — le journal de diagnostic (v14-2) aurait alors mélangé des données
        // fraîches et obsolètes sans distinction possible.
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
    // [v14-1] Filtre d'abord tous les candidats exécutables (mêmes conditions qu'avant,
    // aucun changement de règle), PUIS les classe par qualité décroissante avant de les
    // exécuter dans cet ordre — au lieu de l'ordre de bot.markets (trié par volume24h,
    // un critère de découverte, pas de qualité d'arbitrage). À un seul candidat, le tri
    // est un no-op : comportement strictement identique à avant dans ce cas.
    const candidates = bot.markets.filter(m =>
      m.arb?.valid && m.sizeUSDC >= 1 &&
      (bot.cooldowns[m.id]??0) <= now &&
      !bot.positions.some(p=>p.marketId===m.id && p.status==="OPEN")
    );
    candidates.sort((a,b) => engine.rankOpportunity(b) - engine.rankOpportunity(a));
    for (const m of candidates) {
      await executeOrder(m.id);
    }
  }

  await persistBotState();
  } finally {
    bot.ticking = false;
    // [v15-3] Marqué APRÈS le persistBotState ci-dessus, à la toute fin du cycle — c'est
    // précisément ce que le watchdog surveille : "le moteur a-t-il terminé un cycle
    // complet récemment ?", pas juste "a-t-il commencé à en exécuter un".
    bot.lastTickCompletedAt = Date.now();
  }
}

// [v15-6] Nettoyage automatique — limite la croissance de la table `logs` en supprimant
// les entrées plus vieilles que cfg.logRetentionDays. Appelé au démarrage puis toutes
// les 6h (une tâche de maintenance, pas besoin d'une cadence plus fine).
// [v15-9] Snapshot idempotent du bankroll du jour — appelé au démarrage puis toutes les
// heures ; ON CONFLICT DO UPDATE garantit qu'on garde toujours la valeur la PLUS RÉCENTE
// de la journée en cours (pas la première), sans jamais créer de doublon par date.
async function snapshotBankroll() {
  try {
    const today = new Date().toISOString().slice(0,10);
    await pool.query(
      `INSERT INTO daily_snapshots (date, bankroll) VALUES ($1,$2)
       ON CONFLICT (date) DO UPDATE SET bankroll=$2, created_at=now()`,
      [today, bot.bankroll]
    );
  } catch(e) {
    console.error('[DB] Erreur snapshot bankroll:', e.message);
  }
}

async function cleanupOldLogs() {
  try {
    const days = bot.cfg.logRetentionDays ?? 14;
    const r = await pool.query(`DELETE FROM logs WHERE created_at < now() - interval '${days} days'`);
    if (r.rowCount > 0) console.log(`[DB] Nettoyage logs : ${r.rowCount} entrées de plus de ${days}j supprimées`);
  } catch(e) {
    console.error('[DB] Erreur nettoyage logs:', e.message);
  }
}

let tickTimer = null, discTimer = null, watchdogTimer = null, logCleanupTimer = null;

// ─── [v15-3] WATCHDOG DU MOTEUR PRINCIPAL ──────────────────────────────────
// PROBLÈME RÉSOLU : si tick() reste bloqué indéfiniment (ex. une promesse qui ne se
// résout jamais dans un cas limite non prévu) ou si setInterval s'arrête pour une
// raison quelconque, rien ne le détectait — le bot semblait "actif" (process vivant,
// serveur qui répond) tout en ayant complètement cessé de scanner/trader.
// RISQUES ÉVITÉS : sans watchdog, ce genre de blocage silencieux pourrait passer
// inaperçu pendant des heures avant qu'un humain ne remarque l'absence de nouveaux logs.
// CHOIX TECHNIQUE : totalement indépendant de la logique d'arbitrage — ce timer ne
// touche jamais bot.markets/positions/bankroll, il ne fait que lire lastTickCompletedAt
// et, en cas de silence prolongé, recréer le SEUL setInterval de tick() (un "redémarrage
// contrôlé" du minuteur, pas un redémarrage du process — plus sûr, n'interrompt jamais
// une connexion DB ou un état en mémoire déjà valide).
function startWatchdog() {
  watchdogTimer = setInterval(() => {
    const silenceMs = Date.now() - (bot.lastTickCompletedAt ?? bot.startedAt ?? Date.now());
    const maxSilence = bot.cfg.watchdogMaxSilenceMs ?? 120000;
    if (silenceMs > maxSilence) {
      botLog("RISK", `⛔ WATCHDOG : aucun cycle terminé depuis ${Math.round(silenceMs/1000)}s (seuil ${Math.round(maxSilence/1000)}s) — redémarrage contrôlé du minuteur`);
      triggerAlert('watchdog_restart', { silenceMs, maxSilence }).catch(()=>{});
      // Redémarrage contrôlé : on ne touche qu'au minuteur, jamais à bot.ticking (au cas
      // où un cycle serait réellement encore en cours de traitement légitime) — si
      // bot.ticking était bloqué à true par un vrai blocage, on le libère explicitement
      // ici pour permettre au prochain tick() de repartir plutôt que de rester bloqué
      // indéfiniment par la garde anti-chevauchement (v11).
      bot.ticking = false;
      clearInterval(tickTimer);
      tickTimer = setInterval(() => { tick().catch(e=>console.error('[TICK]',e.message)); }, Math.max(bot.cfg.refreshMs || 15000, 15000));
      tick().catch(e=>console.error('[TICK]',e.message)); // relance immédiate, sans attendre le prochain intervalle
    }
  }, 30000); // vérification toutes les 30s — largement plus fréquent que le seuil d'alerte
}

async function startEngine() {
  await loadBotState();
  // [v15-4] Réconciliation au redémarrage : si des positions LIVE existaient déjà avant
  // ce redémarrage (déploiement, crash, veille Render), on vérifie une fois leur état
  // réel sur Polymarket avant de reprendre le scan normal — réutilise exactement la même
  // logique que la validation périodique (v15-2), aucune duplication. Détection seule,
  // jamais de création/modification/annulation automatique d'ordre.
  await validateOpenLivePositions().catch(e => console.error('[RECONCILE]', e.message));
  await discover();
  tickTimer = setInterval(() => { tick().catch(e=>console.error('[TICK]',e.message)); }, Math.max(bot.cfg.refreshMs || 15000, 15000));
  discTimer = setInterval(() => { discover().catch(e=>console.error('[DISC]',e.message)); }, 300000);
  startWatchdog(); // [v15-3]
  cleanupOldLogs().catch(()=>{});
  logCleanupTimer = setInterval(() => { cleanupOldLogs().catch(()=>{}); }, 6*60*60*1000); // [v15-6] toutes les 6h
  snapshotBankroll().catch(()=>{});
  setInterval(() => { snapshotBankroll().catch(()=>{}); }, 60*60*1000); // [v15-9] toutes les heures
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
// [v15-6] Consultation de l'historique persistant des logs — au-delà des 400 entrées
// gardées en mémoire (bot.logs, toujours utilisées telles quelles par /bot-state).
// Pagination simple (limit/offset) + filtre optionnel par type d'événement.
// [v15-9] Tableau de bord historique — évolution du bankroll (table dédiée, survit aux
// redémarrages) + répartition par jour/semaine/mois/catégorie (calculée à la demande
// depuis les positions en mémoire, jamais recalculée en continu).
app.get('/bot-history-stats', async (req, res) => {
  try {
    const r = await pool.query('SELECT date, bankroll FROM daily_snapshots ORDER BY date ASC LIMIT 366');
    res.json({
      bankrollEvolution: r.rows,
      breakdown: engine.computeHistoricalBreakdown(bot.positions),
      advancedStats: engine.computeAdvancedStats(bot.positions), // [v15-5] au passage, même esprit reporting
    });
  } catch(e) {
    res.status(500).json({ error: e.message, bankrollEvolution: [], breakdown: {} });
  }
});

app.get('/bot-logs-history', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const kind = req.query.kind;
  try {
    const params = kind ? [kind, limit, offset] : [limit, offset];
    const where = kind ? 'WHERE kind = $1' : '';
    const limitIdx = kind ? '$2' : '$1', offsetIdx = kind ? '$3' : '$2';
    const r = await pool.query(
      `SELECT id, kind, msg, created_at FROM logs ${where} ORDER BY created_at DESC LIMIT ${limitIdx} OFFSET ${offsetIdx}`,
      params
    );
    dbHealth.connected = true; dbHealth.lastSuccessfulReadAt = new Date().toISOString();
    res.json({ logs: r.rows, limit, offset });
  } catch(e) {
    res.status(500).json({ error: e.message, logs: [] });
  }
});

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
    apiHealth: computeApiHealth(), // [v14-3] surveillance avancée Gamma/CLOB (lecture seule)
    discovering: bot.discovering,
    logs: bot.logs.slice(-150),
    eventCounters: bot.eventCounters, // [v14-5] compteurs par type d'événement depuis le démarrage
    daily: bot.daily,
    week: bot.week,
    paused: bot.paused,
    pausedReason: bot.pausedReason,
    consecutiveErrors: bot.consecutiveErrors,
    rejected: bot.rejected.slice(-50), // [v12-8] dernières opportunités refusées
    rejectedStats: engine.computeRejectedStats(bot.rejected), // [v14-2] agrégation exploitable, purement passive
    circuitBreakers, // [v15-1] état du circuit breaker par API (lecture seule)
    dbHealth,        // [v15-7] santé de la connexion PostgreSQL
    alerts: bot.alerts.slice(-30), // [v15-8] dernières alertes déclenchées
    advancedStats: engine.computeAdvancedStats(bot.positions), // [v15-5] Profit Factor, Max Drawdown, etc.
  });
});

// [v14-2] Route dédiée aux statistiques de rejet — mêmes données que le champ
// rejectedStats de /bot-state, exposées séparément pour un accès direct/léger sans
// devoir télécharger tout l'état du bot (marchés, positions, logs...).
app.get('/bot-rejected-stats', (req, res) => {
  res.json(engine.computeRejectedStats(bot.rejected));
});

// [v14-3] Route dédiée à la santé des API — mêmes données que apiHealth dans
// /bot-state, exposées séparément pour un monitoring externe léger (ex. un service
// de supervision qui ne s'intéresse qu'à la disponibilité, pas à l'état complet du bot).
app.get('/bot-api-health', (req, res) => {
  res.json(computeApiHealth());
});

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

// [v12-9] Reprise manuelle explicite après un arrêt du kill-switch — jamais automatique,
// conformément à la consigne : le système ne modifie/relance jamais seul ses paramètres.
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
  shouldSkipBookFetch, computeNextCheckTick,          // [v14-4]
  computeApiHealth, classifyApi, apiMetrics,           // [v14-3]
  circuitBreakers, isCircuitOpen, recordCircuitResult, // [v15-1]
  validateOpenLivePositions,                           // [v15-2/4]
  startWatchdog,                                       // [v15-3]
  dbHealth,                                            // [v15-7]
  registerAlertChannel, triggerAlert,                  // [v15-8]
  snapshotBankroll, cleanupOldLogs,                    // [v15-6/9]
};
