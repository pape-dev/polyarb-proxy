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

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS cfg (key TEXT PRIMARY KEY, value TEXT)`);
    console.log('[DB] PostgreSQL connecté ✅');
  } catch(e) {
    console.error('[DB] Erreur connexion:', e.message);
  }
}
initDB();
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.get('/markets', async (req, res) => {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://gamma-api.polymarket.com/markets?limit=100&active=true");
      const data = await r.json();
      const markets = Array.isArray(data) ? data : (data.results || []);
      const filtered = markets.filter(m => {
        const p = parseFloat(m.price);
        return p > 0.10 && p < 0.90;
      });
      return res.json(filtered);
    } catch(e) {
      if (i === 2) return res.status(500).json({ error: e.message });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
});
app.get('/cfg', async (req, res) => {
  const r = await pool.query('SELECT key, value FROM cfg');
  const cfg = {};
  r.rows.forEach(row => cfg[row.key] = row.value);
  res.json(cfg);
});

app.post('/cfg', async (req, res) => {
  const entries = Object.entries(req.body);
  for (const [key, value] of entries) {
    await pool.query(
      'INSERT INTO cfg (key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
      [key, String(value)]
    );
  }
  res.json({ ok: true });
});
app.post("/order", async (req, res) => {
  const { market, tokenId, side, amount, price } = req.body;
  console.log(`[ORDER] ${side} ${market} $${amount} @${price}`);
  const API_KEY = process.env.POLY_API_KEY || "";
  if (!API_KEY) return res.json({ status:"paper", msg:"Simulated", order:req.body });
  try {
    const r = await fetch("https://clob.polymarket.com/order", {
      method:"POST",
      headers:{"Content-Type":"application/json","POLY-API-KEY":API_KEY,"POLY-SECRET":process.env.POLY_API_SEC||"","POLY-PASSPHRASE":process.env.POLY_API_PASS||""},
      body:JSON.stringify({order_type:"FOK",token_id:tokenId,side,size:amount,price}),
    });
    res.json({ status:"live", data: await r.json() });
  } catch(e) {
    res.status(500).json({ status:"error", msg:e.message });
  }
});

setInterval(async () => {
  try { await fetch("https://polyarb-proxy-production.up.railway.app/"); } catch(e) {}
}, 240000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`POLYARB proxy on :${PORT}`));
