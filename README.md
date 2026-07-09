# Suite de tests POLYARB

## Lancer les tests

```bash
npm install    # requis une seule fois (express, pg, node-fetch, etc.)
npm test       # tests hors-ligne (par défaut)
npm run test:network   # inclut aussi les tests qui appellent réellement Polymarket
```

## Structure

| Fichier | Type | Dépendances | Vérifié dans le sandbox de développement |
|---|---|---|---|
| `engine.unit.test.js` | Unitaire | Aucune (engine.js est pur) | ✅ 47/47 tests passent |
| `simulation.market.test.js` | Simulation Monte Carlo | Aucune | ✅ 6/6 tests passent |
| `parsing.unit.test.js` | Unitaire | `index.js` (express/pg) | ⚠️ Syntaxe vérifiée uniquement — nécessite `npm install` pour s'exécuter réellement |
| `integration.trading.test.js` | Intégration | `index.js` (express/pg) | ⚠️ Syntaxe vérifiée uniquement — nécessite `npm install` pour s'exécuter réellement |

**Pourquoi cette différence ?** Le sandbox utilisé pour écrire ces tests n'a pas accès au
registre npm (pas de réseau sortant), donc `express`/`pg` n'ont pas pu être installés
pour exécuter réellement les deux derniers fichiers. Leur syntaxe est valide et leur
logique a été relue attentivement contre le code réel d'`index.js`, mais **la première
exécution doit se faire chez toi** (Render, ou en local avec `npm install && npm test`).
Si un test échoue à ce moment-là, envoie-moi la sortie et je corrige.

## Ce que chaque suite vérifie

- **engine.unit.test.js** — le cœur financier : détection d'arbitrage (VWAP multi-niveaux,
  arrondi des parts, frais), dimensionnement, notation des marchés, contrôle de cohérence
  du carnet (`validateBookSanity`), statistiques de détention.
- **simulation.market.test.js** — génère des milliers de carnets d'ordres aléatoires et
  vérifie des invariants financiers globaux (jamais d'edge sous le seuil, jamais de taille
  hors limites, profit toujours positif si valide, carnet incohérent toujours rejeté, score
  toujours dans [0,100]) plutôt que des cas précis un par un.
- **parsing.unit.test.js** — inclut un test de non-régression explicite pour le bug réel
  trouvé en production (`clobTokenIds` renvoyé comme chaîne JSON au lieu d'un tableau).
- **integration.trading.test.js** — rejoue les scénarios réels (`executeOrder`,
  `closePosition`, `computeMarketUpdate`, routes HTTP) sans réseau ni vraie base de données,
  avec des tests de non-régression explicites pour chaque bug déjà corrigé : profit fictif
  sur clôture manuelle, marché résolu qui garde un signal figé, compteur journalier jamais
  réinitialisé, chevauchement de cycles.

## Réinitialisation entre les tests

`integration.trading.test.js` utilise un `beforeEach` qui réinitialise l'objet `bot`
partagé (positions, bankroll, config, compteurs) avant chaque test, pour éviter toute
contamination d'un test à l'autre.
