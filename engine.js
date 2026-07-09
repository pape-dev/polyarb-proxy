// ═══════════════════════════════════════════════════════════════
// POLYARB — Moteur v12 : arbitrage mécanique par marché unique
// ═══════════════════════════════════════════════════════════════
// [v11] SUPPRESSION COMPLÈTE DE LA CORRÉLATION INTER-MARCHÉS.
// L'ancien moteur pariait des marchés A et B ensemble et testait une "dépendance
// bayésienne" entre leurs mouvements de prix — même corrigée (N effectif, décalage
// causal), cette approche reste une INFÉRENCE : elle suppose une relation qui pourrait
// n'être qu'une coïncidence. Le signal actuel ne teste plus AUCUNE relation entre deux
// marchés différents : sur chaque marché binaire, le jeton OUI et le jeton NON paient
// ensemble exactement $1 à la résolution. Si les acheter coûte moins que $1 net de
// frais et de slippage réel, le profit est garanti — de l'arithmétique, pas une prédiction.
//
// [v12] AMÉLIORATIONS DE ROBUSTESSE — toutes les fonctions ci-dessous d'origine (v11)
// sont conservées et complétées, aucune n'est supprimée :
//   - coût réel d'exécution multi-niveaux (VWAP) au lieu du seul meilleur prix
//   - contrôle de cohérence du carnet avant tout calcul
//   - score composite par marché (liquidité, profondeur, volume, échéance, stabilité)
//   - statistiques avancées par position (profit attendu vs réel, durée, rendement annualisé)

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

// ─── [v12-7] CONTRÔLE DE COHÉRENCE DU CARNET ──────────────────────────────
// Ignore automatiquement un marché si les données sont invalides/incomplètes/
// incohérentes — le bot ne doit jamais trader sur des données douteuses.
function validateBookSanity(book) {
  if (!book || book.simulated) return { ok:false, reason:"NO_BOOK" };
  const asks = book.asks ?? [];
  if (asks.length === 0) return { ok:false, reason:"NO_ASKS" };
  for (const lvl of asks) {
    if (!(lvl.price > 0) || !(lvl.price < 1) || !(lvl.size > 0) || !isFinite(lvl.price) || !isFinite(lvl.size)) {
      return { ok:false, reason:"INVALID_LEVEL" };
    }
  }
  for (let i=1;i<asks.length;i++) {
    if (asks[i].price < asks[i-1].price) return { ok:false, reason:"UNSORTED_BOOK" };
  }
  const bids = book.bids ?? [];
  if (bids.length > 0 && bids[0].price >= asks[0].price) return { ok:false, reason:"CROSSED_BOOK" };
  return { ok:true };
}

// USDC total disponible sur les niveaux fournis (jusqu'à la profondeur renvoyée par l'API, 5 niveaux ici)
function bookDepthUSDC(levels) {
  return (levels ?? []).reduce((s,l)=>s+l.price*l.size, 0);
}

// ─── [v12-2] PRIX MOYEN PONDÉRÉ MULTI-NIVEAUX (par montant USDC visé) ─────
// Ne suppose JAMAIS que toute la taille s'exécute au meilleur prix : on "descend"
// le carnet niveau par niveau jusqu'à atteindre la taille USDC visée. Si le meilleur
// niveau suffit à lui seul, la boucle s'arrête immédiatement dessus (comportement
// best-ask conservé intact dans ce cas précis, comme demandé).
function weightedFill(levels, targetUSDC, maxLevels) {
  const capped = (levels ?? []).slice(0, maxLevels ?? (levels ?? []).length);
  let remaining = targetUSDC, shares = 0, spent = 0, levelsUsed = 0;
  for (const lvl of capped) {
    if (remaining <= 0) break;
    const levelUSDC = lvl.price * lvl.size;
    const take = Math.min(levelUSDC, remaining);
    shares += take / lvl.price;
    spent += take;
    remaining -= take;
    levelsUsed++;
  }
  const filledFully = remaining <= 1e-9;
  return { avgPrice: shares > 0 ? spent/shares : null, usdcSpent: spent, sharesAcquired: shares, filledFully, levelsUsed };
}

// ─── [v13-1] PRIX MOYEN PONDÉRÉ MULTI-NIVEAUX (par NOMBRE DE PARTS visé) ──
// Nécessaire pour la taille arbitrable commune : les deux jambes doivent acheter
// exactement le MÊME NOMBRE DE PARTS (pas le même montant en dollars — OUI et NON
// n'ont presque jamais le même prix, un split 50/50 en dollars sous-estime ou
// déséquilibre la vraie taille commune disponible).
function weightedFillByShares(levels, targetShares, maxLevels) {
  const capped = (levels ?? []).slice(0, maxLevels ?? (levels ?? []).length);
  let remaining = targetShares, spent = 0, shares = 0, levelsUsed = 0;
  for (const lvl of capped) {
    if (remaining <= 1e-9) break;
    const take = Math.min(lvl.size, remaining);
    spent += take * lvl.price;
    shares += take;
    remaining -= take;
    levelsUsed++;
  }
  const filledFully = remaining <= 1e-9;
  return { avgPrice: shares > 0 ? spent/shares : null, usdcSpent: spent, sharesAcquired: shares, filledFully, levelsUsed };
}

// Nombre total de parts disponibles sur les N premiers niveaux d'un carnet.
function levelsSharesAvailable(levels, maxLevels) {
  const capped = (levels ?? []).slice(0, maxLevels ?? (levels ?? []).length);
  return capped.reduce((s,l) => s + l.size, 0);
}

// ─── [v13-2] TAILLE ARBITRABLE COMMUNE ─────────────────────────────────────
// Détermine le nombre maximal de PARTS pouvant être achetées SIMULTANÉMENT sur les
// deux carnets (OUI et NON), en tenant compte de plusieurs niveaux de profondeur sur
// chaque jambe. Remplace l'ancienne approximation (split 50/50 du budget en dollars,
// qui déséquilibrait la taille réelle dès que prix OUI ≠ prix NON).
function computeCommonArbitrableSize(bookYes, bookNo, maxLevels) {
  const sharesYes = levelsSharesAvailable(bookYes?.asks, maxLevels);
  const sharesNo  = levelsSharesAvailable(bookNo?.asks, maxLevels);
  const commonShares = Math.min(sharesYes, sharesNo);
  if (!(commonShares > 0)) return { commonShares: 0, fillYes: null, fillNo: null };
  return {
    commonShares,
    fillYes: weightedFillByShares(bookYes?.asks, commonShares, maxLevels),
    fillNo:  weightedFillByShares(bookNo?.asks, commonShares, maxLevels),
  };
}

// ─── [v13-3] Remplissage réellement exécutable pour un budget USDC donné ──
// Combine la contrainte de PROFONDEUR (taille commune ci-dessus) et la contrainte de
// BUDGET (targetUSDC) pour déterminer le nombre de parts final. Toujours conservateur :
// arrondi vers le bas et jamais vers le haut, jamais un chiffre optimiste.
function computeArbitrableFill(bookYes, bookNo, targetUSDC, maxLevels) {
  const { commonShares, fillYes: fillAtDepth, fillNo: fillAtDepthNo } = computeCommonArbitrableSize(bookYes, bookNo, maxLevels);
  if (!(commonShares > 0) || !fillAtDepth || !fillAtDepthNo || fillAtDepth.avgPrice == null || fillAtDepthNo.avgPrice == null) {
    return { shares: 0, fillYes: null, fillNo: null, depthLimited: true };
  }
  const costAtFullDepth = fillAtDepth.avgPrice + fillAtDepthNo.avgPrice;
  const budgetShares = costAtFullDepth > 0 ? targetUSDC / costAtFullDepth : 0;

  if (budgetShares >= commonShares) {
    // La profondeur du carnet est la contrainte limitante — on utilise déjà le fill exact.
    return { shares: commonShares, fillYes: fillAtDepth, fillNo: fillAtDepthNo, depthLimited: true };
  }
  // Le budget est la contrainte limitante. Le VWAP à une taille plus petite est
  // légèrement meilleur (ou égal) qu'à la profondeur totale — cette première estimation
  // est donc prudente par construction (jamais optimiste).
  const estimate = Math.max(budgetShares, 0);
  const fillYesEst = weightedFillByShares(bookYes?.asks, estimate, maxLevels);
  const fillNoEst  = weightedFillByShares(bookNo?.asks, estimate, maxLevels);
  const costEst = (fillYesEst.avgPrice ?? 0) + (fillNoEst.avgPrice ?? 0);
  // Deuxième passe conservatrice : si le coût réel à cette taille dépasse encore
  // légèrement le budget visé, on réduit une fois de plus plutôt que de le dépasser.
  const finalShares = (costEst > 0 && estimate * costEst > targetUSDC)
    ? Math.floor((targetUSDC / costEst) * 100) / 100
    : Math.floor(estimate * 100) / 100;
  return {
    shares: finalShares,
    fillYes: weightedFillByShares(bookYes?.asks, finalShares, maxLevels),
    fillNo:  weightedFillByShares(bookNo?.asks, finalShares, maxLevels),
    depthLimited: false,
  };
}

// ─── [v13-4] ESTIMATION DE SLIPPAGE (conservatrice) ───────────────────────
// Isolé comme une valeur propre plutôt qu'implicite dans le calcul d'edge : combien
// le prix moyen réellement obtenu est pire que le meilleur prix affiché, à cause de
// la profondeur consommée. Jamais un slippage fixe — dépend de la taille demandée,
// de la profondeur du carnet et du nombre de niveaux réellement consommés.
function estimateSlippage(bestAsk, avgPrice) {
  if (!(bestAsk > 0) || avgPrice == null) return 0;
  return clamp((avgPrice - bestAsk) / bestAsk, 0, 1);
}

// ─── DÉTECTION ARBITRAGE OUI+NON (mécanique, pas statistique) ────────────
// [v12-1] Coût réel d'exécution = VWAP multi-niveaux + frais + arrondi de taille
// (Polymarket exige 2 décimales), PAS le simple prix affiché au sommet du carnet.
// [v13] Le remplissage utilise désormais la vraie taille arbitrable COMMUNE (nombre de
// parts identiques disponibles simultanément sur les deux carnets), plus précise que
// l'ancien split 50/50 du budget en dollars entre les deux jambes.
// `targetUSDC` est la taille candidate (déterminée par sizeArb avant cet appel) ;
// le bénéfice net est recalculé ICI sur le coût réel, pas sur une estimation optimiste.
function detectMarketArb(bookYes, bookNo, cfg, targetUSDC) {
  const sanityYes = validateBookSanity(bookYes);
  if (!sanityYes.ok) return { valid:false, reason:`YES_${sanityYes.reason}` };
  const sanityNo = validateBookSanity(bookNo);
  if (!sanityNo.ok) return { valid:false, reason:`NO_${sanityNo.reason}` };

  const size = targetUSDC ?? 0;
  if (size < 1) return { valid:false, reason:"SIZE_NULLE" };

  const maxLevels = cfg.maxBookLevels ?? 5;
  const { shares: rawShares, fillYes, fillNo, depthLimited } = computeArbitrableFill(bookYes, bookNo, size, maxLevels);
  if (!fillYes || !fillNo || fillYes.avgPrice == null || fillNo.avgPrice == null) return { valid:false, reason:"NO_FILL" };

  // [arrondi] Polymarket exige des tailles à 2 décimales — l'arrondi réduit légèrement
  // le nombre de parts réellement achetables par rapport au calcul continu ci-dessus.
  const roundedShares = Math.floor(rawShares * 100) / 100;
  if (roundedShares <= 0) return { valid:false, reason:"SIZE_TROP_PETITE" };

  const realCostYes = roundedShares * fillYes.avgPrice;
  const realCostNo  = roundedShares * fillNo.avgPrice;
  const realCostUSDC = realCostYes + realCostNo;
  const avgCostPerShare = realCostUSDC / roundedShares; // équivalent pondéré de (askYes+askNo)
  const feeCost = (cfg.feeBps ?? 0) / 10000;
  const edge = 1 - avgCostPerShare - feeCost;
  const filledFully = fillYes.filledFully && fillNo.filledFully;

  // [v13-4] Slippage isolé : écart entre le meilleur prix affiché et le VWAP réellement
  // obtenu sur chaque jambe, à la taille effectivement tradée.
  const bestAskYes = bookYes.asks[0].price, bestAskNo = bookNo.asks[0].price;
  const slippageYes = estimateSlippage(bestAskYes, fillYes.avgPrice);
  const slippageNo  = estimateSlippage(bestAskNo, fillNo.avgPrice);

  const base = {
    edge, cost: avgCostPerShare,
    askYes: fillYes.avgPrice, askNo: fillNo.avgPrice,       // VWAP réel (nom conservé pour compatibilité)
    bestAskYes, bestAskNo,                                   // [v13] meilleur prix affiché, pour comparaison/log
    realCostUSDC, roundedShares, filledFully,
    commonShares: rawShares, depthLimited,                   // [v13-2] taille arbitrable commune brute
    slippage: Math.max(slippageYes, slippageNo),             // [v13-4] conservateur : la pire des deux jambes
    levelsUsedYes: fillYes.levelsUsed, levelsUsedNo: fillNo.levelsUsed, // [v13-6] pour la journalisation
  };
  if (edge < cfg.minEdge) return { valid:false, reason:`edge=${(edge*100).toFixed(1)}%<${(cfg.minEdge*100).toFixed(0)}%`, ...base };
  return { valid:true, reason:"OK", ...base };
}

// ─── [v12-2] Taille candidate — limitée par la profondeur RÉELLE multi-niveaux ────
// Pas de Kelly probabiliste ici : pas d'incertitude sur le résultat, seulement une
// limite de liquidité et un risque d'exécution partielle (les deux jambes doivent remplir).
// [v12-4/5] La taille est aussi réduite pour les marchés mal notés (liquidité fragile,
// spread large) — limitation dynamique de l'exposition selon la qualité du marché.
function sizeArb(bookYes, bookNo, cfg, bankroll, score) {
  const maxLevels = cfg.maxBookLevels ?? 5;
  const depthYes = bookDepthUSDC((bookYes?.asks ?? []).slice(0, maxLevels));
  const depthNo  = bookDepthUSDC((bookNo?.asks ?? []).slice(0, maxLevels));
  // Facteur 2 : chaque jambe ne consomme que la moitié de la taille totale (OUI + NON)
  const maxByDepth = Math.min(depthYes, depthNo) * 2;
  const maxByBankroll = bankroll * cfg.maxPct;
  // [v12-9] Limitation dynamique : un marché mal noté (score bas) reçoit une allocation
  // réduite proportionnellement, même s'il passe le seuil minimal de score.
  const scoreFactor = score != null ? clamp(score/100, 0.25, 1) : 1;
  return clamp(Math.min(maxByDepth, maxByBankroll) * scoreFactor, 0, bankroll);
}

// Profit garanti (déterministe) pour une mise `size` au coût réel `cost`, connu dès
// l'exécution — pas de SL/TP nécessaires : aucun risque de prix résiduel une fois les
// deux jambes remplies, seulement une attente jusqu'à la résolution du marché.
function calcArbProfit(size, cost, edge) {
  return size * edge / cost;
}

// ─── [v12-4] SCORE COMPOSITE DE MARCHÉ (0-100) ────────────────────────────
// Le moteur doit privilégier les marchés les mieux notés : liquidité, profondeur
// réelle du carnet, volume, proximité de résolution (rotation du capital), et
// stabilité des prix (spread bid-ask serré = marché sain, moins de risque d'exécution).
function scoreMarket(m, bookYes, bookNo) {
  let score = 0;

  // Liquidité déclarée par Polymarket (0-25 pts)
  score += clamp((m.liquidity ?? 0) / 50000, 0, 1) * 25;

  // Profondeur réelle du carnet, les deux jambes combinées (0-25 pts)
  const depth = bookDepthUSDC(bookYes?.asks) + bookDepthUSDC(bookNo?.asks);
  score += clamp(depth / 2000, 0, 1) * 25;

  // Volume 24h (0-15 pts)
  score += clamp((m.volume24h ?? 0) / 20000, 0, 1) * 15;

  // [v12-5] Proximité de résolution (0-20 pts) — favorise la rotation du capital :
  // trop loin = capital immobilisé longtemps ; trop proche (<1h) = risque d'exécution
  // ou de résolution surprise pendant que l'ordre est en vol.
  let dayScore = 8; // neutre si pas de date connue
  if (m.endDate) {
    const daysLeft = (new Date(m.endDate) - Date.now()) / 86400000;
    if (daysLeft < 0) dayScore = 0;
    else if (daysLeft < 1/24) dayScore = 4;
    else if (daysLeft <= 3) dayScore = 20;
    else if (daysLeft <= 14) dayScore = 14;
    else if (daysLeft <= 30) dayScore = 7;
    else dayScore = 2;
  }
  score += dayScore;

  // Stabilité des prix / étroitesse du spread (0-15 pts)
  const spreadYes = (bookYes?.asks?.[0]?.price ?? 1) - (bookYes?.bids?.[0]?.price ?? 0);
  const spreadNo  = (bookNo?.asks?.[0]?.price ?? 1) - (bookNo?.bids?.[0]?.price ?? 0);
  const avgSpread = (spreadYes + spreadNo) / 2;
  score += clamp(1 - avgSpread/0.05, 0, 1) * 15;

  return Math.round(clamp(score, 0, 100));
}

// ─── [v12-6] STATISTIQUES AVANCÉES PAR POSITION ───────────────────────────
function computeHoldStats(positions) {
  const closed = positions.filter(p => p.status === "CLOSED" && p.closedAt);
  if (closed.length === 0) {
    return { avgHoldHours:0, avgAnnualizedReturn:0, avgExpectedVsActual:0, arbFrequencyPerDay:0 };
  }
  const holdHours = closed.map(p => (new Date(p.closedAt) - new Date(p.ts)) / 3600000);
  const avgHoldHours = holdHours.reduce((s,v)=>s+v,0) / holdHours.length;
  // Rendement annualisé estimé à partir du rendement réel moyen par trade et de la durée moyenne
  const rets = closed.map(p => (p.pnlUSDC ?? 0) / Math.max(p.size,1));
  const avgRet = rets.reduce((s,v)=>s+v,0) / rets.length;
  const avgAnnualizedReturn = avgHoldHours > 0 ? avgRet * (365*24/avgHoldHours) : 0;
  // Écart profit attendu (edge×size à l'ouverture) vs profit réellement observé
  const diffs = closed.filter(p=>p.expectedProfit != null).map(p => (p.pnlUSDC ?? 0) - p.expectedProfit);
  const avgExpectedVsActual = diffs.length ? diffs.reduce((s,v)=>s+v,0)/diffs.length : 0;
  // Fréquence : trades / jour sur la période couverte par l'historique conservé
  const span = (Date.now() - new Date(closed[0].ts).getTime()) / 86400000;
  const arbFrequencyPerDay = span > 0 ? closed.length / span : closed.length;
  return { avgHoldHours, avgAnnualizedReturn, avgExpectedVsActual, arbFrequencyPerDay };
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
  // [v12] nouveaux paramètres de robustesse — valeurs par défaut prudentes
  minMarketScore: 30,        // [v12-4] score minimum pour qu'un marché soit tradable
  dailyLossLimitPct: 0.10,   // [v12-9] arrêt auto si perte journalière > 10% du bankroll de début de journée
  weeklyLossLimitPct: 0.20,  // [v12-9] arrêt auto si perte hebdomadaire > 20%
  maxConsecutiveErrors: 5,   // [v12-9] arrêt auto après N échecs d'exécution consécutifs
  closedCheckEveryNTicks: 4, // [v12-11] vérifier la résolution moins souvent que le carnet (perf)
  maxBookLevels: 5,          // [v13-1] nombre max de niveaux de carnet analysés pour le VWAP/taille commune
};

module.exports = {
  SEEDS, categorize, clamp, calcSharpe,
  validateBookSanity, bookDepthUSDC, weightedFill, weightedFillByShares,
  levelsSharesAvailable, computeCommonArbitrableSize, computeArbitrableFill, estimateSlippage,
  detectMarketArb, sizeArb, calcArbProfit, scoreMarket, computeHoldStats,
  DEFAULT_CFG,
};
