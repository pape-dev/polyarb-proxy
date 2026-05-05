const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const { Pool } = require("pg");
const app     = express();

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const API_KEY  = process.env.POLY_API_KEY  || "";
const API_SEC  = process.env.POLY_API_SEC  || "";
const API_PASS = process.env.POLY_API_PASS || "";

// Base de données PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialiser la table historique au démarrage
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hist (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("[DB] Table hist prête");
  } catch(e) {
    console.error("[DB] Erreur init:", e.message);
  }
}
initDB();

// Sauvegarder historique
app.post("/hist/save", async (req, res) => {
  const { id, data } = req.body;
  try {
    await pool.query(
      `INSERT INTO hist (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=NOW()`,
      [id, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Charger historique
app.get("/hist/load", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, data FROM hist");
    const hist = {};
    for (const row of result.rows) hist[row.id] = row.data;
    res.json(hist);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Sert le bot HTML
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// Marchés Polymarket
app.get("/markets", async (req, res) => {
  try {
    const r = await fetch(
      "https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&ascending=false&limit=200"
    );
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Ordres
app.post("/order", async (req, res) => {
  const { market, tokenId, side, amount, price } = req.body;
  console.log(`[ORDER] ${side} ${market} $${amount} @${price}`);
  if (!API_KEY) {
    return res.json({
      status: "paper",
      msg: "Simulated — no API key",
      order: req.body
    });
  }
  try {
    const r = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: {
        "Content-Type":    "application/json",
        "POLY-API-KEY":    API_KEY,
        "POLY-SECRET":     API_SEC,
        "POLY-PASSPHRASE": API_PASS,
      },
      body: JSON.stringify({
        order_type: "FOK",
        token_id: tokenId,
        side, size: amount, price
      }),
    });
    const data = await r.json();
    res.json({ status:"live", data });
  } catch(e) {
    res.status(500).json({ status:"error", msg: e.message });
  }
});

// Keep-alive
setInterval(async () => {
  try {
    await fetch("https://polyarb-proxy-production.up.railway.app/");
    console.log("[PING] proxy actif");
  } catch(e) {}
}, 240000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`POLYARB proxy+DB running on :${PORT}`)
);
