// ═══════════════════════════════════════════════════════════════
// POLYARB — Moteur v11 : arbitrage mécanique par marché unique
// ═══════════════════════════════════════════════════════════════
// [v11] SUPPRESSION COMPLÈTE DE LA CORRÉLATION INTER-MARCHÉS.
// L'ancien moteur pariait des marchés A et B ensemble et testait une "dépendance
// bayésienne" entre leurs mouvements de prix — même corrigée (N effectif, décalage
// causal), cette approche reste une INFÉRENCE : elle suppose une relation qui pourrait
// n'être qu'une coïncidence, sur un nombre de paires testées assez grand pour produire
// des faux positifs récurrents, sur des marchés qui n'existent parfois que quelques jours.
//
// Le nouveau signal ne teste plus AUCUNE relation entre deux marchés différents. Il
// exploite un fait mécanique sur UN SEUL marché binaire : le jeton OUI et le jeton NON
// paient togeteher exactement $1 à la résolution (l'un paie $1, l'autre $0). Si acheter
// les deux jetons coûte moins de $1 (net de frais), le profit est garanti dès l'achat,
// quel que soit le résultat — ce n'est pas une prédiction, c'est de l'arithmétique.
// Aucune paire, aucune corrélation, aucun test statistique.

const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));

// Catégorisation purement cosmétique (affichage), sans aucun rôle dans la détection.
const SEEDS = [
  { id:"CRYPTO",   emoji:"₿",  kw:["bitcoin","ethereum","crypto","solana","btc","eth","binance","coinbase","defi"] },
  { id:"POLITICS", emoji:"🗳", kw:["trump","president","congress","election","senate","vote","democrat","republican","biden","harris","governor"] },
  { id:"MACRO",    emoji:"📉", kw:["fed","rate","recession","inflation","gdp","cpi","fomc","dollar","treasury","unemployment","powell"] },
  { id:"SPORTS",   emoji:"🏆", kw:["win","match","game","nba","nfl","mlb","nhl","soccer","football","tennis","ufc","boxing","f1","cricket","rugby","golf","esports","olympics"] },
  { id:"GEO",      emoji:"🌍", kw:["iran","russia","china","war","conflict","ukraine","nato","israel","gaza","military","sanctions"] },
];
function categorize(title, slug) {
  const txt = (title + " " + slug).toLowerCase();
  for (const seed of SEEDS) if (seed.kw.some(k => txt.includes(k))) return seed;
  return { id:"AUTRE", emoji:"•" };
}

function calcSharpe(returns) {
  if(returns.length<2) return 0;
  const avg=returns.reduce((s,v)=>s+v,0)/returns.length;
  const std=Math.sqrt(returns.reduce((s,v)=>s+(v-avg)**2,0)/(returns.length-1));
  return std<1e-9?0:avg/std*Math.sqrt(252);
}

// ─── DÉTECTION ARBITRAGE OUI+NON (mécanique, pas statistique) ────────────
// edge net de frais : combien on "gagne" par dollar misé, garanti à la résolution.
function detectMarketArb(bookYes, bookNo, cfg) {
  const askYes = bookYes?.asks?.[0]?.price;
  const askNo  = bookNo?.asks?.[0]?.price;
  if (askYes == null || askNo == null) return { valid:false, reason:"NO_BOOK" };
  const cost = askYes + askNo;
  const feeCost = (cfg.feeBps ?? 0) / 10000;
  const edge = 1 - cost - feeCost;
  if (edge < cfg.minEdge) return { valid:false, reason:`edge=${(edge*100).toFixed(1)}%<${(cfg.minEdge*100).toFixed(0)}%`, edge, cost, askYes, askNo };
  return { valid:true, reason:"OK", edge, cost, askYes, askNo };
}

// Taille limitée par la profondeur RÉELLE du carnet aux deux prix ciblés — pas de Kelly
// probabiliste ici : il n'y a pas d'incertitude sur le résultat, seulement une limite de
// liquidité et un risque d'exécution partielle (les deux jambes doivent se remplir).
function sizeArb(bookYes, bookNo, cfg, bankroll) {
  const depthYes = (bookYes?.asks?.[0]?.size ?? 0) * (bookYes?.asks?.[0]?.price ?? 0);
  const depthNo  = (bookNo?.asks?.[0]?.size ?? 0) * (bookNo?.asks?.[0]?.price ?? 0);
  const maxByDepth = Math.min(depthYes, depthNo);
  const maxByBankroll = bankroll * cfg.maxPct;
  return clamp(Math.min(maxByDepth, maxByBankroll), 0, bankroll);
}

// Profit garanti (déterministe) pour une mise `size`, connu dès l'exécution — pas de
// SL/TP nécessaires : il n'y a pas de risque de prix résiduel une fois les deux jambes
// remplies, seulement une attente jusqu'à la résolution du marché.
function calcArbProfit(size, cost, edge) {
  return size * edge / cost;
}

const DEFAULT_CFG = {
  minEdge: 0.03,      // [v11] seuil plus bas que l'ancien 8% : un arb mécanique de 3% net
                        // de frais est déjà un vrai profit garanti, pas besoin d'un edge énorme
  maxPct: 0.05,        // part max du bankroll par arb individuel
  maxDaily: 20,
  cooldown: 45000,
  refreshMs: 15000,
  feeBps: 200,
  autoExec: 0,
  autoExecMinConf: 0,
  maxExposure: 0.25,
  bankroll: 2000,
};

module.exports = {
  SEEDS, categorize, clamp, calcSharpe, detectMarketArb, sizeArb, calcArbProfit, DEFAULT_CFG,
};
