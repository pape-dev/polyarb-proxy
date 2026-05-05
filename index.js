const express = require("express");
const fetch   = require("node-fetch");
const path    = require("path");
const app     = express();

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

app.get("/markets", async (req, res) => {
  try {
    const r = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume&ascending=false&limit=100");
    const data = await r.json();
    const markets = Array.isArray(data) ? data : (data.results || []);
const filtered = markets.filter(m => {
  const p = parseFloat(m.price);
  return p > 0.10 && p < 0.90;
});
res.json(filtered);;
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
