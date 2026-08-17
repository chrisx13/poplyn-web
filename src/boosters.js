/* ============================================================================
   POPLYN — boosters (power-ups jouables en partie). Logique pure : zéro DOM,
   zéro Canvas, importable et testable en node (test/boosters.test.mjs).
   game.js ne fait que dessiner les boutons, viser et appliquer le résultat.

   Trois boosters :
     removeLine — efface UNE ligne ou UNE colonne choisie ;
     refresh    — remplace les 3 pièces du plateau (le tirage reste côté jeu) ;
     bomb       — fait sauter une case et ses 4 voisines (petite zone en croix).

   Économie (la rareté est le crochet : le gratuit dépanne, il ne joue pas à
   la place du joueur) :
     - dose GRATUITE quotidienne, remise à son plancher une fois par jour civil
       (même clé datée que le streak) : elle ne s'empile pas d'un jour sur
       l'autre, donc pas de stock infini ;
     - achat en pièces (PRICES) qui débite la monnaie du jeu ;
     - pub récompensée (placement 'booster') : +1 si la pub a bien été vue ;
     - pack IAP 'boosterpack' (cf. src/iap.js) qui accorde un lot d'un coup.

   Les fonctions de grille rendent une NOUVELLE grille (immuable) ; l'inventaire
   se manipule pareil : chaque fonction rend un état neuf, la persistance est
   le travail de createBoosters().
   ========================================================================== */
import { dayKey } from './logic.js';
import { createStorage } from './storage.js';

// ---- Catalogue -------------------------------------------------------------
/* `free` = plancher rechargé chaque jour, `price` = prix en pièces. Les prix
   sont volontairement décorrélés du nombre de cases effacées : la bombe coûte
   plus cher parce qu'elle est chirurgicale (elle débloque une situation). */
export const BOOSTERS = [
  { id:'removeLine', name:'Ligne',  icon:'➖', price:40, free:1,
    desc:'Efface une ligne ou une colonne entière.' },
  { id:'refresh',    name:'Pièces', icon:'🔄', price:25, free:1,
    desc:'Remplace les 3 pièces du plateau.' },
  { id:'bomb',       name:'Bombe',  icon:'💣', price:60, free:1,
    desc:'Fait sauter une case et ses voisines.' },
];

export const BOOSTER_IDS = BOOSTERS.map(b => b.id);
export const PRICES      = Object.fromEntries(BOOSTERS.map(b => [b.id, b.price]));
export const DAILY_FREE  = Object.fromEntries(BOOSTERS.map(b => [b.id, b.free]));

export const STORAGE_KEY        = 'boosters';   // préfixé par createStorage()
export const REWARDED_PLACEMENT = 'booster';    // ads.showRewarded('booster')
export const IAP_PACK           = 'boosterpack';

export function boosterById(id){ return BOOSTERS.find(b => b.id === id) || null; }

export function boosterPrice(id){ const b = boosterById(id); return b ? b.price : 0; }

// ---- Effets sur la grille --------------------------------------------------
const copyGrid = grid => grid.map(row => row.slice());

// Cible valide ? { type:'row'|'col', index } dans les bornes de la grille.
export function isLineTarget(grid, target){
  if(!grid || !target) return false;
  const i = Number(target.index);
  return (target.type === 'row' || target.type === 'col')
      && Number.isInteger(i) && i >= 0 && i < grid.length;
}

/* Cases effacées par un retrait de ligne/colonne (les pleines seulement : c'est
   ce que game.js envoie aux particules). */
export function lineCells(grid, target){
  if(!isLineTarget(grid, target)) return [];
  const n = grid.length, i = Number(target.index), out = [];
  for(let k=0;k<n;k++){
    const r = target.type === 'row' ? i : k;
    const c = target.type === 'row' ? k : i;
    if(grid[r][c]) out.push({ r, c, color:grid[r][c] });
  }
  return out;
}

// Cible hors bornes -> la grille est rendue telle quelle (aucun effet).
export function applyRemoveLine(grid, target){
  if(!isLineTarget(grid, target)) return grid;
  const n = grid.length, i = Number(target.index), next = copyGrid(grid);
  for(let k=0;k<n;k++){
    if(target.type === 'row') next[i][k] = null;
    else                      next[k][i] = null;
  }
  return next;
}

// Zone de la bombe : la case visée + ses 4 voisines orthogonales (croix).
export const BOMB_OFFSETS = [[0,0],[-1,0],[1,0],[0,-1],[0,1]];

const inGrid = (grid, r, c) => r >= 0 && r < grid.length && c >= 0 && c < grid.length;

export function bombCells(grid, at){
  if(!grid || !at) return [];
  const out = [];
  BOMB_OFFSETS.forEach(([dr,dc]) => {
    const r = at.r + dr, c = at.c + dc;
    if(inGrid(grid, r, c) && grid[r][c]) out.push({ r, c, color:grid[r][c] });
  });
  return out;
}

// Case visée hors grille -> grille rendue telle quelle.
export function applyBomb(grid, at){
  if(!grid || !at || !inGrid(grid, at.r, at.c)) return grid;
  const next = copyGrid(grid);
  BOMB_OFFSETS.forEach(([dr,dc]) => {
    const r = at.r + dr, c = at.c + dc;
    if(inGrid(next, r, c)) next[r][c] = null;
  });
  return next;
}

// ---- Inventaire (état pur) -------------------------------------------------
/* Forme : { counts:{ removeLine, refresh, bomb }, freeDay:'YYYY-MM-DD'|null }.
   `freeDay` porte la dernière recharge gratuite : une par jour civil. */
export function normalizeInventory(state){
  const s = state && typeof state === 'object' ? state : {};
  const src = s.counts && typeof s.counts === 'object' ? s.counts : {};
  const counts = {};
  BOOSTER_IDS.forEach(id => { counts[id] = Math.max(0, Math.floor(+src[id] || 0)); });
  return { counts, freeDay: typeof s.freeDay === 'string' ? s.freeDay : null };
}

export function boosterCount(state, id){ return normalizeInventory(state).counts[id] || 0; }

/* Recharge quotidienne : on REMONTE au plancher, on n'empile pas. Un joueur
   qui a acheté 5 bombes ne reçoit donc rien de plus — le gratuit est un filet,
   pas une rente. Rend { inv, granted, gained } ; `granted:false` = déjà servi
   aujourd'hui (l'inventaire est rendu inchangé).                              */
export function refillDaily(state, today = dayKey()){
  const inv = normalizeInventory(state);
  if(inv.freeDay === today) return { inv, granted:false, gained:{} };
  const counts = { ...inv.counts }, gained = {};
  BOOSTER_IDS.forEach(id => {
    const add = Math.max(0, DAILY_FREE[id] - counts[id]);
    if(add > 0){ counts[id] += add; gained[id] = add; }
  });
  return { inv:{ counts, freeDay:today }, granted:true, gained };
}

/* Achat en pièces. Rend { ok, reason, inv, coins, price } ; la monnaie n'est
   débitée que si l'achat aboutit (game.js garde LE porte-monnaie, cf. meta). */
export function buyBooster(state, id, coins){
  const inv = normalizeInventory(state), b = boosterById(id);
  const wallet = Math.max(0, +coins || 0);
  if(!b)                return { ok:false, reason:'unknown', inv, coins:wallet, price:0 };
  if(wallet < b.price)  return { ok:false, reason:'poor',    inv, coins:wallet, price:b.price };
  return { ok:true, reason:'bought', price:b.price, coins:wallet - b.price,
           inv:{ ...inv, counts:{ ...inv.counts, [id]:inv.counts[id] + 1 } } };
}

// Don hors boutique : pub récompensée, cadeau, coffre.
export function grantBooster(state, id, n = 1){
  const inv = normalizeInventory(state);
  if(!boosterById(id) || n <= 0) return inv;
  return { ...inv, counts:{ ...inv.counts, [id]:inv.counts[id] + Math.floor(n) } };
}

// Lot IAP : { removeLine:3, refresh:3, bomb:2 } -> tout accordé d'un coup.
export function grantBoosterPack(state, pack){
  let inv = normalizeInventory(state);
  if(!pack || typeof pack !== 'object') return inv;
  BOOSTER_IDS.forEach(id => { if(pack[id] > 0) inv = grantBooster(inv, id, pack[id]); });
  return inv;
}

// Consommation : bloquée à 0 (jamais de compteur négatif).
export function useBooster(state, id){
  const inv = normalizeInventory(state);
  if(!boosterById(id))    return { ok:false, reason:'unknown', inv };
  if(inv.counts[id] <= 0) return { ok:false, reason:'empty',   inv };
  return { ok:true, reason:'used',
           inv:{ ...inv, counts:{ ...inv.counts, [id]:inv.counts[id] - 1 } } };
}

// ---- Inventaire persisté ---------------------------------------------------
/* createBoosters({ storage, ads }) : même esprit que createMonetization() —
   l'état vit ici, la persistance est immédiate, et rien ne touche au DOM.
   `buy(id, coins)` reçoit le solde et rend le nouveau : le porte-monnaie reste
   celui du jeu (meta.coins), on n'en crée pas un second.                      */
export function createBoosters(opts = {}){
  const storage = opts.storage || createStorage();
  const ads     = opts.ads     || null;
  const key     = opts.key     || STORAGE_KEY;

  let inv = normalizeInventory(storage.get(key, null));
  const save = next => { inv = next; storage.set(key, inv); return inv; };

  return {
    state: () => inv,
    count: id => inv.counts[id] || 0,
    has:   id => (inv.counts[id] || 0) > 0,
    total: () => BOOSTER_IDS.reduce((n, id) => n + inv.counts[id], 0),

    refill(today = dayKey()){
      const res = refillDaily(inv, today);
      if(res.granted) save(res.inv);
      return res;
    },
    buy(id, coins){
      const res = buyBooster(inv, id, coins);
      if(res.ok) save(res.inv);
      return res;
    },
    grant(id, n = 1){ return save(grantBooster(inv, id, n)); },
    grantPack(pack){ return save(grantBoosterPack(inv, pack)); },
    use(id){
      const res = useBooster(inv, id);
      if(res.ok) save(res.inv);
      return res;
    },
    // Pub récompensée : +1 booster UNIQUEMENT si le provider résout true.
    async watchAd(id, provider = ads){
      if(!provider || !boosterById(id)) return { ok:false };
      const ok = await provider.showRewarded(REWARDED_PLACEMENT);
      if(ok) save(grantBooster(inv, id, 1));
      return { ok };
    },
  };
}
