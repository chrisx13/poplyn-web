/* ============================================================================
   POPLYN — chef d'orchestre monétisation (gating / waterfall).
   Toute la logique "quand a-t-on le droit de montrer quoi" vit ici, SANS DOM,
   pour rester testable sous Node (test/monetization.test.mjs).
   Règles :
     - jamais d'interstitiel pendant une partie ;
     - interstitiel toutes N parties terminées (N=3), coupé si 'noads' acheté ;
     - rewarded TOUJOURS dispo (même avec 'noads') : c'est du volontaire ;
     - une récompense n'est accordée que si showRewarded() a résolu true.
   ========================================================================== */

import { createAdProvider } from './ads.js';
import { createIapProvider } from './iap.js';
import { createStorage } from './storage.js';

export const INTERSTITIAL_EVERY = 3;   // N parties

export function createMonetization(opts = {}){
  const storage = opts.storage || createStorage();
  const ads     = opts.ads     || createAdProvider();
  const iap     = opts.iap     || createIapProvider({ storage });
  const every   = opts.interstitialEvery ?? INTERSTITIAL_EVERY;

  let inGame       = false;
  let gamesPlayed  = storage.get('games_played', 0);
  let coins        = storage.get('coins', 0);

  const hasNoAds = () => iap.owns('noads');

  // ---- Cycle de vie d'une partie ----
  function beginGame(){ inGame = true; }
  function resumeGame(){                       // après un revive : la partie repart
    if(!inGame){ inGame = true; gamesPlayed = Math.max(0, gamesPlayed - 1); storage.set('games_played', gamesPlayed); }
  }
  function endGame(){
    if(!inGame) return gamesPlayed;            // idempotent (game over déjà notifié)
    inGame = false;
    gamesPlayed += 1; storage.set('games_played', gamesPlayed);
    return gamesPlayed;
  }

  // ---- Interstitiel : à appeler ENTRE deux parties (bouton Rejouer) ----
  function interstitialDue(){
    if(inGame) return false;                   // jamais pendant une partie
    if(hasNoAds()) return false;               // achat 'noads'
    if(gamesPlayed === 0) return false;
    return gamesPlayed % every === 0;
  }
  async function maybeShowInterstitial(){
    if(!interstitialDue()) return false;
    if(!ads.isReady('interstitial')) return false;
    await ads.showInterstitial();
    return true;
  }

  // ---- Rewarded : la récompense suit STRICTEMENT le booléen ----
  async function revive(){
    const ok = await ads.showRewarded('revive');
    if(ok) resumeGame();
    return { ok };
  }
  // ---- Coffre de fin de partie : offert, puis encaissé une seule fois ----
  let chest = 0;
  function offerChest(base){ chest = Math.max(0, base|0); return chest; }
  function pendingChest(){ return chest; }
  function claimChest(){                       // encaissement simple (Rejouer / revive)
    const gained = chest; chest = 0;
    if(gained) addCoins(gained);
    return gained;
  }
  async function doubleChest(){                // encaissement x2, conditionné à la pub
    if(!chest) return { ok:false, coins:0 };
    const ok = await ads.showRewarded('double');
    const gained = chest * (ok ? 2 : 1); chest = 0;
    addCoins(gained);
    return { ok, coins:gained };
  }

  // ---- Porte-monnaie ----
  function getCoins(){ return coins; }
  function addCoins(n){ coins = Math.max(0, coins + n); storage.set('coins', coins); return coins; }

  // ---- Boutique ----
  async function getProducts(){ return iap.getProducts(); }
  async function purchase(sku){
    const res = await iap.purchase(sku);
    if(res.ok && !res.alreadyOwned){
      const grant = iap.product ? iap.product(sku) : null;
      if(grant && grant.coins) addCoins(grant.coins);
    }
    return res;
  }
  async function restore(){ return iap.restore(); }

  return { ads, iap, storage,
           beginGame, resumeGame, endGame, isInGame:() => inGame,
           gamesPlayed:() => gamesPlayed, interstitialEvery:every,
           interstitialDue, maybeShowInterstitial,
           revive, offerChest, pendingChest, claimChest, doubleChest,
           getCoins, addCoins,
           getProducts, purchase, restore, hasNoAds };
}
