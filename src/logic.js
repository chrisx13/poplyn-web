/* ============================================================================
   POPLYN — logique pure (zéro DOM, zéro Canvas) : importable et testable en node.
   Tout ce qui décide (score, lignes/colonnes, combos, streak, coffre) vit ici ;
   tout ce qui dessine ou stocke vit dans game.js.
   ========================================================================== */

export const N = 8;                      // grille 8x8

export function newGrid(n = N){ return Array.from({length:n}, () => Array(n).fill(null)); }

// ---- Pièces ----------------------------------------------------------------
// Offsets [r,c], orientations incluses explicitement.
export const SHAPES = [
  [[0,0]],
  [[0,0],[0,1]], [[0,0],[1,0]],
  [[0,0],[0,1],[0,2]], [[0,0],[1,0],[2,0]],
  [[0,0],[0,1],[0,2],[0,3]], [[0,0],[1,0],[2,0],[3,0]],
  [[0,0],[0,1],[1,0],[1,1]],                        // carré 2x2
  [[0,0],[1,0],[1,1]], [[0,1],[1,0],[1,1]],         // L-tromino
  [[0,0],[0,1],[1,0]], [[0,0],[0,1],[1,1]],
  [[0,0],[1,0],[2,0],[2,1]], [[0,1],[1,1],[2,0],[2,1]], // L-tetromino
  [[0,0],[0,1],[0,2],[1,0]], [[0,0],[0,1],[0,2],[1,2]],
  [[0,0],[0,1],[1,1],[1,2]], [[1,0],[1,1],[0,1],[0,2]], // S / Z
  [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2]],            // 2x3
  [[0,0],[0,1],[1,0],[1,1],[2,0],[2,1]],            // 3x2
];

// Dimensions (h,w) d'un jeu d'offsets.
export function pieceBounds(cells){
  let mr=0, mc=0; cells.forEach(([r,c]) => { mr=Math.max(mr,r); mc=Math.max(mc,c); });
  return { h:mr+1, w:mc+1 };
}

// ---- Détection / effacement des lignes & colonnes --------------------------
export function findFullLines(grid){
  const n = grid.length, rows=[], cols=[];
  for(let r=0;r<n;r++) if(grid[r].every(Boolean)) rows.push(r);
  for(let c=0;c<n;c++){ let f=true; for(let r=0;r<n;r++) if(!grid[r][c]){f=false;break;} if(f) cols.push(c); }
  return { rows, cols };
}

// Vide les lignes/colonnes en place et rend les cases effacées (pour les particules).
export function clearLines(grid, rows, cols){
  const n = grid.length, seen = new Set(), cleared = [];
  const wipe = (r,c) => { const k=r*n+c; if(seen.has(k)) return;
    seen.add(k); cleared.push({ r, c, color: grid[r][c] }); grid[r][c] = null; };
  rows.forEach(r => { for(let c=0;c<n;c++) wipe(r,c); });
  cols.forEach(c => { for(let r=0;r<n;r++) wipe(r,c); });
  return cleared;
}

// ---- Score & combos --------------------------------------------------------
export function placementScore(cells){ return cells.length; }

// Le combo escalade tant que chaque pose vide au moins une ligne/colonne.
export function nextCombo(combo, clears){ return clears>0 ? combo+1 : 0; }

export function comboMultiplier(combo){ return Math.max(1, combo); }

export function clearScore(clears, combo){ return clears * 10 * comboMultiplier(combo); }

// ---- Fin de partie ---------------------------------------------------------
export function canPlaceAnywhere(grid, piece){
  const n = grid.length;
  for(let r=0;r<=n-piece.h;r++) for(let c=0;c<=n-piece.w;c++)
    if(piece.cells.every(([dr,dc]) => !grid[r+dr][c+dc])) return true;
  return false;
}

export function isAlive(grid, tray){
  return tray.some(p => p && !p.used && canPlaceAnywhere(grid, p));
}

// ---- Daily streak ----------------------------------------------------------
// Clé datée locale (YYYY-MM-DD) : une récompense par jour civil.
export function dayKey(date = new Date()){
  const p = n => String(n).padStart(2,'0');
  return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
}

export function daysBetween(fromKey, toKey){
  const d = k => { const [y,m,day] = k.split('-').map(Number); return Date.UTC(y, m-1, day); };
  return Math.round((d(toKey) - d(fromKey)) / 86400000);
}

/* Fait avancer le streak pour `today`.
   - même jour   -> rien à réclamer (claimed reste false)
   - lendemain   -> streak +1
   - trou / vide -> streak remis à 1                                          */
export function updateStreak(prev, today = dayKey()){
  const last = prev && prev.lastDay ? prev.lastDay : null;
  const streak = prev && prev.streak ? prev.streak : 0;
  if(last === today) return { streak, lastDay:last, claimed:false, reward:0 };
  const gap = last ? daysBetween(last, today) : null;
  const next = gap === 1 ? streak + 1 : 1;
  return { streak:next, lastDay:today, claimed:true, reward:dailyReward(next) };
}

// Récompense journalière : palier de 7 jours, plafonnée pour rester lisible.
export function dailyReward(streak){ return 20 + 10 * Math.min(Math.max(streak,1), 7); }

// ---- Coffre à récompense variable -----------------------------------------
// Table de butin (somme des p = 1) : la variabilité est le crochet.
export const CHEST_TABLE = [
  { p:0.50, type:'coins', label:'Petit tas de pièces', coins:25 },
  { p:0.27, type:'coins', label:'Gros tas de pièces',  coins:60 },
  { p:0.15, type:'bonus', label:'Pièce bonus',         coins:0,  bonus:1 },
  { p:0.06, type:'coins', label:'JACKPOT',             coins:200 },
  { p:0.02, type:'skin',  label:'Skin NÉON',           coins:0,  skin:'neon' },
];

// r ∈ [0,1) -> butin déterministe (donc testable).
export function rollChest(r = Math.random()){
  let acc = 0;
  for(const row of CHEST_TABLE){ acc += row.p; if(r < acc) return { ...row }; }
  return { ...CHEST_TABLE[0] };
}

// "Doubler (pub)" : les pièces doublent, le reste se convertit en pièces.
export function doubleReward(reward){
  if(reward.coins > 0) return { ...reward, coins: reward.coins*2, doubled:true };
  if(reward.bonus)     return { ...reward, bonus: reward.bonus*2, doubled:true };
  return { ...reward, coins: 100, doubled:true };
}
