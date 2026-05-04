const express = require("express");
const fetch   = require("node-fetch");
const app     = express();

app.use(express.json());

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

app.get("/", (req, res) =>
  res.json({ status:"ok", mode: API_KEY ? "live" : "paper" })
);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`POLYARB proxy running on :${PORT}`)
);
