/* ============================================================================
   POPLYN — méta-jeu : catalogue de skins/thèmes, leaderboard local, meilleur
   du jour. Logique pure (zéro DOM, zéro localStorage) : game.js branche la
   persistance et le rendu, ce module ne fait que décider.
   ========================================================================== */
import { dayKey } from './logic.js';

// ---- Catalogue de skins ----------------------------------------------------
/* Chaque skin porte sa palette de blocs ET son thème de fond, pour que le
   changement se voie tout de suite. Déblocage :
     free  -> possédé d'entrée
     coins -> acheté avec la monnaie du jeu (B1)
     chest -> tombe au coffre (table de butin de logic.js)
     iap   -> compris dans un pack payant (B2), ici 'skinpack'                */
export const SKINS = [
  {
    id:'base', name:'Classique', unlock:{ type:'free' },
    blocks:['#ff5c7a','#ffd23f','#4dd0e1','#7c6cff','#5bd68a','#ff9f45','#e879f9'],
    theme:{ bg:'#0f1226', glow:'#1c2050', panel:'#171a33', board:'#171a33',
            cell:'#20244a', ink:'#eef0ff', muted:'#8b90c0', accent:'#ffd23f' },
  },
  {
    id:'candy', name:'Bonbon', unlock:{ type:'coins', price:400 },
    blocks:['#ff6fb5','#ffd6e8','#ffe066','#7ee8fa','#b28dff','#ff9770','#8ef6c4'],
    theme:{ bg:'#2a1030', glow:'#4a1a52', panel:'#3a1745', board:'#3a1745',
            cell:'#4d1f5c', ink:'#fff2fb', muted:'#c79ad6', accent:'#ffd6e8' },
  },
  {
    id:'forest', name:'Forêt', unlock:{ type:'coins', price:900 },
    blocks:['#7bc47f','#d9ed92','#52b69a','#e9c46a','#a68a64','#76c893','#bfd200'],
    theme:{ bg:'#0d1a14', glow:'#16301f', panel:'#132720', board:'#132720',
            cell:'#1c3a2c', ink:'#eaf7ee', muted:'#7fa58d', accent:'#d9ed92' },
  },
  {
    id:'neon', name:'Néon', unlock:{ type:'chest' },
    blocks:['#00ffc6','#ff2fd0','#ffe93f','#3ba0ff','#a4ff3f','#ff6a00','#c34bff'],
    theme:{ bg:'#07030f', glow:'#1b0640', panel:'#12082a', board:'#12082a',
            cell:'#1e0d45', ink:'#f4eaff', muted:'#9a7dd6', accent:'#00ffc6' },
  },
  {
    id:'ink', name:'Encre', unlock:{ type:'iap', pack:'skinpack' },
    blocks:['#f4f4f6','#c9ccd6','#9aa0b4','#6f7690','#4c5270','#e0b34a','#2f3450'],
    theme:{ bg:'#111114', glow:'#26262e', panel:'#1a1a20', board:'#1a1a20',
            cell:'#26262e', ink:'#f4f4f6', muted:'#8b8ea0', accent:'#e0b34a' },
  },
  {
    id:'sunset', name:'Coucher', unlock:{ type:'iap', pack:'skinpack' },
    blocks:['#ff9a3c','#ff5964','#ffd166','#f28f3b','#c8553d','#ffb997','#e56b6f'],
    theme:{ bg:'#1c0f1e', glow:'#48203a', panel:'#2a1428', board:'#2a1428',
            cell:'#3d1d36', ink:'#fff1e6', muted:'#c08fa0', accent:'#ff9a3c' },
  },
];

export const DEFAULT_SKIN = 'base';

export function skinById(id){ return SKINS.find(s => s.id === id) || null; }

// Skins possédés d'entrée de jeu (les 'free').
export function defaultOwned(){ return SKINS.filter(s => s.unlock.type === 'free').map(s => s.id); }

/* État méta manipulé par ce module — toujours rendu en copie (jamais muté) :
   { coins, owned:[id], packs:[pack], skin }                                  */
export function normalizeMeta(state){
  const s = state || {};
  const owned = Array.isArray(s.owned) && s.owned.length ? s.owned.slice() : defaultOwned();
  defaultOwned().forEach(id => { if(!owned.includes(id)) owned.push(id); });
  const packs = Array.isArray(s.packs) ? s.packs.slice() : [];
  const skin  = skinById(s.skin) ? s.skin : DEFAULT_SKIN;
  return { coins: Math.max(0, +s.coins || 0), owned, packs, skin };
}

// Un skin IAP est débloqué dès que son pack est acheté.
export function isOwned(state, id){
  const st = normalizeMeta(state), sk = skinById(id);
  if(!sk) return false;
  if(st.owned.includes(id)) return true;
  return sk.unlock.type === 'iap' && st.packs.includes(sk.unlock.pack);
}

export function skinPrice(id){
  const sk = skinById(id);
  return sk && sk.unlock.type === 'coins' ? sk.unlock.price : 0;
}

/* Achat avec la monnaie du jeu. Rend { ok, reason, state } ; la monnaie n'est
   débitée que si l'achat aboutit.                                            */
export function unlockSkin(state, id){
  const st = normalizeMeta(state), sk = skinById(id);
  if(!sk)                       return { ok:false, reason:'unknown', state:st };
  if(isOwned(st, id))           return { ok:false, reason:'owned',   state:st };
  if(sk.unlock.type !== 'coins')return { ok:false, reason:'not-for-sale', state:st };
  if(st.coins < sk.unlock.price)return { ok:false, reason:'poor',    state:st };
  return { ok:true, reason:'bought',
           state:{ ...st, coins: st.coins - sk.unlock.price, owned:[...st.owned, id] } };
}

// Déblocage hors boutique : coffre (skin rare) ou tout autre don.
export function grantSkin(state, id){
  const st = normalizeMeta(state);
  if(!skinById(id) || st.owned.includes(id)) return st;
  return { ...st, owned:[...st.owned, id] };
}

// Achat IAP : le pack débloque d'un coup tous ses skins.
export function grantPack(state, pack){
  const st = normalizeMeta(state);
  if(!pack || st.packs.includes(pack)) return st;
  return { ...st, packs:[...st.packs, pack] };
}

export function packSkins(pack){ return SKINS.filter(s => s.unlock.pack === pack); }

// Sélection : on ne peut équiper que ce qu'on possède.
export function selectSkin(state, id){
  const st = normalizeMeta(state);
  return isOwned(st, id) ? { ...st, skin:id } : st;
}

// Palette + thème effectivement appliqués (retombe sur 'base' si l'id est cassé).
export function activeSkin(state){ return skinById(normalizeMeta(state).skin) || SKINS[0]; }

// ---- Leaderboard local -----------------------------------------------------
export const LEADERBOARD_MAX = 10;

/* Insère un score dans le classement : tri décroissant, tronqué au top 10.
   À score égal, l'entrée déjà présente reste devant (le record tient).       */
export function insertScore(list, score, day = dayKey()){
  const entries = Array.isArray(list) ? list.filter(e => e && Number.isFinite(+e.score)) : [];
  const next = [...entries.map(e => ({ score:+e.score, day:e.day || null })), { score:+score||0, day }];
  next.sort((a,b) => b.score - a.score);
  return next.slice(0, LEADERBOARD_MAX);
}

// Le score entre-t-il au classement ? (sert à souligner l'entrée fraîche)
export function isHighScore(list, score){
  const entries = Array.isArray(list) ? list : [];
  return entries.length < LEADERBOARD_MAX || (+score||0) > entries[entries.length-1].score;
}

export function bestScore(list){
  const entries = Array.isArray(list) ? list : [];
  return entries.length ? Math.max(...entries.map(e => +e.score||0)) : 0;
}

// ---- Meilleur du jour ------------------------------------------------------
/* Remis à zéro au changement de jour civil local (minuit) : une entrée
   { day, score } périmée vaut 0.                                             */
export function readDailyBest(prev, today = dayKey()){
  if(!prev || prev.day !== today) return { day:today, score:0 };
  return { day:today, score:+prev.score||0 };
}

export function updateDailyBest(prev, score, today = dayKey()){
  const cur = readDailyBest(prev, today);
  const s = +score||0;
  return s > cur.score ? { day:today, score:s } : cur;
}
