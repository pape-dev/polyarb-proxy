const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const app     = express();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false }
});

// ─── [FIX] Client CLOB signé (ordres réels) ────────────────────
// npm i @polymarket/clob-client ethers@5
// Variables d'env nécessaires pour le mode LIVE réel :
//   POLY_PRIVATE_KEY   → clé privée du wallet (jamais côté client !)
//   POLY_FUNDER        → adresse du wallet Polymarket (proxy wallet)
//   ANTHROPIC_API_KEY  → clé API Claude (jamais côté client !)
let clobClient = null;
async function getClobClient() {
  if (clobClient) return clobClient;
  if (!process.env.POLY_PRIVATE_KEY) return null;
  try {
    const { ClobClient } = require("@polymarket/clob-client");
    const { Wallet } = require("ethers");
    const signer = new Wallet(process.env.POLY_PRIVATE_KEY);
    const host = "https://clob.polymarket.com";
    const chainId = 137; // Polygon
    const creds = await new ClobClient(host, chainId, signer).createOrDeriveApiKey();
    clobClient = new ClobClient(host, chainId, signer, creds, undefined, process.env.POLY_FUNDER || undefined);
    console.log('[CLOB] Client signé initialisé ✅');
    return clobClient;
  } catch (e) {
    console.error('[CLOB] Impossible d\'initialiser le client signé:', e.message);
    return null;
  }
}

// [v9-4] Helper de fetch externe robuste : Polymarket/Cloudflare bloque parfois les requêtes
// sans User-Agent "normal" (le UA par défaut de node-fetch ressemble à un bot). On force un
// UA de navigateur + timeout explicite, et on loggue le détail réel de l'échec côté serveur
// (visible dans les logs Render) au lieu de laisser le frontend deviner avec un "bloquée" opaque.
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
    // [FIX] table générique pour persister positions/historique/bankroll/etc,
    // car window.storage n'existe pas hors du runtime Claude Artifacts.
    await pool.query(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
    console.log('[DB] PostgreSQL connecté ✅');
  } catch(e) {
    console.error('[DB] Erreur connexion:', e.message);
  }
}
initDB();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get('/markets', async (req, res) => {
  try {
    const r = await fetchExternal("https://gamma-api.polymarket.com/markets?limit=500&active=true&order=volume&ascending=false");
    const data = await r.json();
    res.json(data);
  } catch(e) {
    // [v9-4] on renvoie le détail de l'échec pour diagnostic (visible en Network tab si besoin)
    res.status(502).json({ error: e.message, hint: "Voir logs serveur Render pour le détail (préfixe [EXT])" });
  }
});

// [FIX] Route proxy pour un prix unique — évite l'appel direct navigateur → Gamma (CORS)
// Renvoie aussi l'état "closed" pour permettre le règlement des positions à résolution.
app.get('/price', async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: "slug requis" });
  try {
    const r = await fetchExternal(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
    const raw = await r.json();
    const m = Array.isArray(raw) ? raw[0] : raw?.markets?.[0];
    if (!m) return res.json({ price: null, closed: false, found: false });
    const outcomePrices = Array.isArray(m.outcomePrices) ? m.outcomePrices.map(Number) : null;
    const p = outcomePrices ? outcomePrices[0] : parseFloat(m.bestAsk ?? "0.5");
    res.json({
      price: isNaN(p) ? null : p,
      closed: !!m.closed,
      active: !!m.active,
      // [FIX] prix de règlement final si le marché est résolu (0 ou 1)
      resolvedPrice: (m.closed && outcomePrices) ? outcomePrices[0] : null,
      found: true,
    });
  } catch(e) {
    res.status(500).json({ error: e.message, price: null, closed: false, found: false });
  }
});

// [FIX] Route proxy pour le carnet d'ordres — évite l'appel direct navigateur → CLOB (CORS)
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

// [FIX] Route serveur pour l'analyse IA — la clé Anthropic ne doit JAMAIS être exposée côté client
app.post('/ai', async (req, res) => {
  const API_KEY = process.env.ANTHROPIC_API_KEY || "";
  if (!API_KEY) return res.status(503).json({ error: "ANTHROPIC_API_KEY non configurée sur le serveur" });
  const { labelA, labelB, pA, pB, fair, fairCI, edge, est } = req.body;
  if (!est) return res.status(400).json({ error: "est requis" });
  try {
    const r = await fetchExternal("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 200,
        system: `Tu es un analyste quantitatif de marchés de prédiction. Réponds UNIQUEMENT avec un JSON valide sans markdown:
{"bull":"string (1 phrase, argument causal)","risk":"string (1 phrase, risque principal)","confidence":number 0-10}`,
        messages: [{ role: "user", content:
          `Pair: "${labelA}" / "${labelB}"\n` +
          `Prix marché: A=${(pA*100).toFixed(0)}¢  B=${(pB*100).toFixed(0)}¢\n` +
          `Modèle Bayésien: P(B|A)=${(est.pB_givenA*100).toFixed(0)}¢  P(B|¬A)=${(est.pB_givenNotA*100).toFixed(0)}¢\n` +
          `δ=${(est.delta*100).toFixed(0)}pp  Classe=${est.depClass.toUpperCase()}\n` +
          `Prix juste=${(fair*100).toFixed(0)}¢  IC95=[${(fairCI[0]*100).toFixed(0)}¢–${(fairCI[1]*100).toFixed(0)}¢]\n` +
          `Edge=${(edge*100).toFixed(1)}%  p=${est.pValue.toFixed(3)}  N=${est.n}`
        }],
      }),
    });
    const d = await r.json();
    const text = (d.content?.[0]?.text ?? "{}").replace(/```[a-z]*|```/g,"").trim();
    res.json(JSON.parse(text));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// [v9-3] Route proxy pour l'historique de prix — alimente le backtest sur données réelles.
app.get('/history', async (req, res) => {
  const { tokenId, interval = 'max', fidelity = '60' } = req.query;
  if (!tokenId) return res.status(400).json({ error: "tokenId requis", history: [] });
  try {
    const r = await fetchExternal(`https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=${encodeURIComponent(interval)}&fidelity=${encodeURIComponent(fidelity)}`);
    const d = await r.json();
    res.json(d);
  } catch(e) {
    res.status(500).json({ error: e.message, history: [] });
  }
});

app.get('/cfg', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM cfg');
    const cfg = {};
    r.rows.forEach(row => cfg[row.key] = row.value);
    res.json(cfg);
  } catch(e) {
    console.error('[CFG GET] Erreur:', e.message);
    res.json({});
  }
});

app.post('/cfg', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO cfg (key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, String(value)]
      );
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[CFG POST] Erreur:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// [FIX] Persistance générique (positions, bankroll, historique glissant, compteur journalier…)
// remplace window.storage (indisponible hors runtime Claude Artifacts) par Neon/Postgres.
app.get('/state', async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM state');
    const out = {};
    r.rows.forEach(row => out[row.key] = row.value);
    res.json(out);
  } catch(e) {
    console.error('[STATE GET] Erreur:', e.message);
    res.json({});
  }
});

app.post('/state', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO state (key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()',
        [key, String(value)]
      );
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[STATE POST] Erreur:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/order", async (req, res) => {
  const { market, tokenId, side, amount, price } = req.body;
  console.log(`[ORDER] ${side} ${market} $${amount} @${price}`);
  const client = await getClobClient();
  // [FIX] Sans client signé (POLY_PRIVATE_KEY absente), on reste explicitement en PAPER —
  // l'ancien code envoyait un ordre non signé (API key/secret/passphrase seuls) que le CLOB
  // réel rejette systématiquement (les ordres Polymarket doivent être signés EIP-712).
  if (!client) return res.json({ status:"paper", msg:"Simulated (POLY_PRIVATE_KEY non configurée)", order:req.body });
  try {
    const order = await client.createOrder({
      tokenID: tokenId,
      price: Number(price),
      side: side === "SELL" ? "SELL" : "BUY",
      size: Number(amount),
      feeRateBps: 0,
    });
    const resp = await client.postOrder(order, "FOK");
    res.json({ status:"live", data: resp });
  } catch(e) {
    res.status(500).json({ status:"error", msg:e.message });
  }
});

setInterval(async () => {
  try { await fetch("https://polyarb-proxy.onrender.com/markets"); } catch(e) {}
}, 120000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`POLYARB proxy on :${PORT}`));
