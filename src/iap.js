/* ============================================================================
   POPLYN — couche achats in-app (IapProvider).
   Même principe que ads.js : interface stable + provider MOCK persistant.
   Le flag 'noads' est la seule donnée qui pilote du gating côté jeu.
   ========================================================================== */

import { createStorage } from './storage.js';

const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

// Catalogue. 'consumable' = rachetable (pièces), sinon possession définitive.
export const PRODUCTS = [
  { sku:'noads',       type:'nonconsumable', title:'Supprimer les pubs', price:'2,99 €',
    desc:'Fini les interstitiels. Les pubs bonus restent dispo si tu veux.' },
  { sku:'skinpack',    type:'nonconsumable', title:'Pack de skins',      price:'1,99 €',
    desc:'6 habillages de blocs.' },
  { sku:'coins_small', type:'consumable',    title:'100 pièces',         price:'0,99 €',
    desc:'Petit sac de pièces.', coins:100 },
  // Rachetable : le lot est consommé en jeu (cf. src/boosters.js).
  { sku:'boosterpack', type:'consumable',    title:'Pack de boosters',   price:'1,99 €',
    desc:'8 boosters : 3 lignes, 3 rafraîchissements, 2 bombes.',
    boosters:{ removeLine:3, refresh:3, bomb:2 } },
];

export class IapProvider {
  async getProducts(){ return []; }
  async purchase(/* sku */){ return { ok:false, error:'not-implemented' }; }
  async restore(){ return { ok:false, owned:[] }; }
  owns(/* sku */){ return false; }
}

// ---- Provider MOCK : achats instantanés, possessions persistées ----
export class MockIapProvider extends IapProvider {
  /**
   * @param {object} opts
   *  - latencyMs   : délai simulé de la feuille de paiement
   *  - autoApprove : bool | (sku)=>bool   (false = utilisateur annule)
   *  - storage     : createStorage() injectable (mémoire en test)
   */
  constructor(opts = {}){
    super();
    this.latencyMs   = opts.latencyMs   ?? 400;
    this.autoApprove = opts.autoApprove ?? true;
    this.storage     = opts.storage     || createStorage();
    this.products    = opts.products    || PRODUCTS;
    this.purchases   = [];                                   // historique de session
    this._owned      = new Set(this.storage.get('iap_owned', []));
  }

  _persist(){ this.storage.set('iap_owned', [...this._owned]); }

  product(sku){ return this.products.find(p => p.sku === sku) || null; }

  async getProducts(){
    await wait(this.latencyMs ? 1 : 0);
    return this.products.map(p => ({ ...p, owned:this.owns(p.sku) }));
  }

  async purchase(sku){
    const product = this.product(sku);
    if(!product) return { ok:false, error:'unknown-sku' };
    if(product.type !== 'consumable' && this.owns(sku)) return { ok:true, sku, product, alreadyOwned:true };
    await wait(this.latencyMs);
    const approve = typeof this.autoApprove === 'function' ? !!this.autoApprove(sku) : !!this.autoApprove;
    if(!approve) return { ok:false, sku, error:'cancelled' };
    if(product.type !== 'consumable'){ this._owned.add(sku); this._persist(); }
    this.purchases.push(sku);
    return { ok:true, sku, product };
  }

  // Restauration : les non-consommables déjà payés reviennent (changement d'appareil).
  async restore(){
    await wait(this.latencyMs);
    this._owned = new Set(this.storage.get('iap_owned', []));
    return { ok:true, owned:[...this._owned] };
  }

  owns(sku){ return this._owned.has(sku); }
}

/* TODO(PREREQUIS PORTEUR) — Billing réel : c'est ICI.
   Il faut : fiche Play Console + App Store Connect, les 3 SKU créés à l'identique
   ('noads', 'skinpack', 'coins_small'), et le plugin de facturation (Capacitor).
     class RealIapProvider extends IapProvider {
       async getProducts(){ return billing.queryProducts(SKUS); }
       async purchase(sku){ const r = await billing.purchase(sku); return { ok:r.state==='purchased', sku }; }
       async restore(){ return { ok:true, owned: await billing.queryPurchases() }; }
     }
   Penser à valider le reçu côté serveur avant d'accorder 'noads' en prod. */
export function createIapProvider(opts = {}){
  return new MockIapProvider(opts);
}
