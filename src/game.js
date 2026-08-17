/* ============================================================================
   POPLYN — proto jouable (vanilla JS + Canvas, zéro build, diffusable de suite).
   Boucle coeur : poser 3 pièces sur une grille 8x8, vider lignes/colonnes,
   combos, near-miss "revive" (stub pub récompensée). Record en localStorage.
   Crochets d'addiction : particules + flash, coffre à récompense variable,
   daily streak, haptique + son, monnaie persistée.
   Méta : écran d'accueil, skins/thèmes (monnaie ou IAP), leaderboard local.
   Monétisation : les pubs passent par window.Ads (stub ici, SDK réel ensuite)
   et c'est src/monetization.js qui décide QUAND on a le droit de les montrer
   (jamais d'interstitiel en partie, coupé par l'achat 'noads') ; les achats
   passent par src/iap.js. Le wrap Capacitor arrive ensuite.
   ========================================================================== */
import {
  N, SHAPES, newGrid, pieceBounds, findFullLines, clearLines,
  placementScore, nextCombo, clearScore, isAlive,
  dayKey, updateStreak, rollChest, doubleReward,
} from './logic.js';
import {
  SKINS, LEADERBOARD_MAX, normalizeMeta, isOwned, unlockSkin, grantSkin,
  grantPack, selectSkin, activeSkin,
  insertScore, isHighScore, bestScore, readDailyBest, updateDailyBest,
} from './meta.js';
import {
  BOOSTERS, IAP_PACK, boosterById, createBoosters,
  applyRemoveLine, applyBomb, lineCells, bombCells,
} from './boosters.js';
import { createMonetization } from './monetization.js';

(() => {
  const $ = id => document.getElementById(id);
  const cv = $('c');
  const ctx = cv.getContext('2d');
  const $score = $('score');
  const $best  = $('best');
  const $combo = $('combo');
  const $over  = $('over');

  // ---- Persistance (localStorage) ------------------------------------------
  const K = { best:'poplyn_best', coins:'poplyn_coins', bonus:'poplyn_bonus',
              skin:'poplyn_skin', streak:'poplyn_streak',
              owned:'poplyn_owned', packs:'poplyn_packs',
              scores:'poplyn_scores', dayBest:'poplyn_daybest' };
  const readNum  = k => +(localStorage.getItem(k) || 0);
  const writeNum = (k,v) => localStorage.setItem(k, v);
  const readJson = (k,fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch(_){ return fb; } };
  const writeJson= (k,v) => localStorage.setItem(k, JSON.stringify(v));

  let best  = readNum(K.best);
  let bonus = readNum(K.bonus);
  // État méta (monnaie, skins possédés, packs IAP, skin équipé) — meta.js décide.
  let meta = normalizeMeta({
    coins: readNum(K.coins), owned: readJson(K.owned, null),
    packs: readJson(K.packs, null), skin: localStorage.getItem(K.skin),
  });
  let scores  = readJson(K.scores, []);
  let dayBest = readDailyBest(readJson(K.dayBest, null), dayKey());
  let COLORS, THEME;

  let grid, score, combo, tray, drag, layout;
  let fx = { parts:[], flash:0, raf:0 };   // particules + flash de clear
  let streakDays = 0;

  function saveMeta(){
    writeNum(K.coins, meta.coins);
    localStorage.setItem(K.skin, meta.skin);
    writeJson(K.owned, meta.owned);
    writeJson(K.packs, meta.packs);
  }

  // ---- Monétisation --------------------------------------------------------
  /* Les pubs sont jouées par la régie (window.Ads) ; monetization.js ne fait
     que le gating (cadence de l'interstitiel, 'noads', cycle de partie) et la
     boutique. Le porte-monnaie du jeu reste ici : on ne passe donc jamais par
     mon.claimChest()/mon.purchase(), qui crediteraient une seconde fois. */
  const adsBridge = {
    isReady: () => true,
    showRewarded:     placement => window.Ads.showRewarded(placement),
    showInterstitial: () => window.Ads.showInterstitial(),
  };
  const mon = createMonetization({ ads:adsBridge });
  window.Monetization = mon;                 // pratique pour debug depuis la console
  // Inventaire de boosters : persisté sous 'poplyn_boosters', pubs via la régie.
  const boosters = createBoosters({ ads:adsBridge });
  // La boutique de skins ne connaît que window.IAP : on la branche sur l'adaptateur
  // réel (le stub d'index.html ne sert plus que si ce module ne charge pas).
  window.IAP = {
    purchase: sku => mon.iap.purchase(sku).then(r => r.ok),
    restore:  () => mon.iap.restore().then(r => r.owned),
  };

  // ---- HUD -----------------------------------------------------------------
  function pulse(el){ el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }
  function paintHud(){
    $('coins').textContent = meta.coins;
    $('shop-coins').textContent = meta.coins;
    $('bonus').textContent = bonus;
    $('bonus-chip').hidden = bonus <= 0;
  }
  function addCoins(n){ meta = { ...meta, coins:Math.max(0, meta.coins + n) };
    saveMeta(); paintHud(); pulse($('coins-chip')); }
  function addBonus(n){ bonus += n; writeNum(K.bonus, bonus); paintHud(); }

  // ---- Skins / thèmes ------------------------------------------------------
  /* Le skin pilote la palette des blocs ET les couleurs de l'interface :
     une variable CSS par couleur, le canvas lit THEME directement.           */
  function applyTheme(){
    const sk = activeSkin(meta);
    COLORS = sk.blocks; THEME = sk.theme;
    const css = document.documentElement.style;
    css.setProperty('--bg', THEME.bg);
    css.setProperty('--panel', THEME.panel);
    css.setProperty('--grid', THEME.cell);
    css.setProperty('--ink', THEME.ink);
    css.setProperty('--muted', THEME.muted);
    css.setProperty('--accent', THEME.accent);
    document.body.style.background =
      `radial-gradient(1200px 600px at 50% -10%, ${THEME.glow} 0%, ${THEME.bg} 60%)`;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if(themeMeta) themeMeta.setAttribute('content', THEME.bg);
  }
  function setSkin(id){
    const next = selectSkin(meta, id);
    if(next.skin === meta.skin) return;
    meta = next; saveMeta(); applyTheme();
    if(layout) draw();
  }

  applyTheme();
  $best.textContent = best;
  paintHud();

  // ---- Feedback : haptique + petit son WebAudio ----------------------------
  let ac = null;
  function audio(){
    if(ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(AC) ac = new AC();
    return ac;
  }
  // Blip court dont la hauteur grimpe avec le combo (récompense sonore lisible).
  function sfxClear(n){
    const a = audio(); if(!a) return;
    if(a.state === 'suspended') a.resume();
    const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(440 * Math.pow(1.12, Math.min(n,8)), t);
    o.frequency.exponentialRampToValueAtTime(880 * Math.pow(1.12, Math.min(n,8)), t+0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t+0.26);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t+0.28);
  }
  function haptic(pattern){ if(navigator.vibrate) try { navigator.vibrate(pattern); } catch(_){} }

  function newPiece(cells, color){
    const { h, w } = pieceBounds(cells);
    return { cells, color, h, w, used:false };
  }
  function randPiece(){
    return newPiece(SHAPES[(Math.random()*SHAPES.length)|0],
                    COLORS[(Math.random()*COLORS.length)|0]);
  }
  function refillTray(){ tray = [randPiece(), randPiece(), randPiece()]; }

  function reset(){
    grid = newGrid(); score = 0; combo = 0; drag = null; armed = null;
    fx.parts.length = 0; fx.flash = 0;
    refillTray();
    paintBoosters();
    // Une pièce bonus gagnée au coffre = un 1x1 offert au démarrage.
    if(bonus > 0){ addBonus(-1); tray[0] = newPiece([[0,0]], COLORS[1]); }
    $score.textContent = 0; $over.classList.remove('show');
    mon.beginGame();                        // partie en cours -> plus d'interstitiel
    resize(); draw();
  }

  // ---- Layout (recalculé au resize, canvas en haute résolution) ----
  function resize(){
    const cssW = Math.min(cv.clientWidth || 440, 520);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const boardPx = cssW;                 // board carré = largeur
    const trayH = cssW * 0.32;
    const cssH = boardPx + trayH;
    cv.width = cssW * dpr; cv.height = cssH * dpr;
    cv.style.height = cssH + 'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const pad = cssW*0.03, cell = (boardPx - pad*2)/N;
    layout = { cssW, cssH, pad, cell, boardTop:0, boardPx, trayTop:boardPx, trayH,
               traySlot: cssW/3 };
  }

  function cellRect(r,c){ const {pad,cell}=layout; return [pad+c*cell, pad+r*cell, cell, cell]; }

  function rr(x,y,w,h,rad){ ctx.beginPath(); ctx.moveTo(x+rad,y);
    ctx.arcTo(x+w,y,x+w,y+h,rad); ctx.arcTo(x+w,y+h,x,y+h,rad);
    ctx.arcTo(x,y+h,x,y,rad); ctx.arcTo(x,y,x+w,y,rad); ctx.closePath(); }

  function block(x,y,s,color,alpha){
    ctx.globalAlpha = alpha==null?1:alpha;
    rr(x+1,y+1,s-2,s-2,Math.max(4,s*0.16)); ctx.fillStyle=color; ctx.fill();
    rr(x+1,y+1,s-2,(s-2)*0.42,Math.max(4,s*0.16)); ctx.fillStyle='rgba(255,255,255,.18)'; ctx.fill();
    ctx.globalAlpha = 1;
  }

  function draw(){
    const {cssW,cssH,pad,cell,boardPx,trayTop,traySlot,trayH}=layout;
    ctx.clearRect(0,0,cssW,cssH);
    // fond board
    rr(0,0,boardPx,boardPx,20); ctx.fillStyle=THEME.board; ctx.fill();
    // cases vides + remplies
    for(let r=0;r<N;r++) for(let c=0;c<N;c++){
      const [x,y,s]=cellRect(r,c);
      rr(x+1,y+1,s-2,s-2,Math.max(4,s*0.16)); ctx.fillStyle=THEME.cell; ctx.fill();
      if(grid[r][c]) block(x,y,s,grid[r][c]);
    }
    drawAim();                                   // cibles valides du booster armé
    // aperçu de pose (ghost) si drag en cours
    if(drag){
      const g = ghostCells();
      if(g){ const ok=g.ok; g.cells.forEach(([r,c])=>{ const [x,y,s]=cellRect(r,c);
        block(x,y,s, ok?drag.piece.color:'#ff5c7a', ok?0.55:0.35); }); }
    }
    drawFx();
    // tray
    for(let i=0;i<3;i++){
      const p=tray[i]; if(!p||p.used) continue;
      if(drag && drag.idx===i) continue;         // pièce en main -> pas dans le tray
      drawTrayPiece(p, i);
    }
    // pièce en main (suit le doigt)
    if(drag){ const p=drag.piece, s=layout.cell;
      const ox = drag.x - (p.w*s)/2, oy = drag.y - (p.h*s)/2 - s*1.2; // lift au-dessus du doigt
      p.cells.forEach(([r,c])=> block(ox+c*s, oy+r*s, s, p.color));
    }
  }

  function drawTrayPiece(p,i){
    const {trayTop,traySlot,trayH}=layout;
    const s = Math.min(layout.cell*0.72, (traySlot*0.8)/Math.max(p.w,p.h), (trayH*0.7)/Math.max(p.w,p.h));
    const cx = traySlot*i + traySlot/2, cy = trayTop + trayH/2;
    const ox = cx - (p.w*s)/2, oy = cy - (p.h*s)/2;
    p._tray = {ox,oy,s};
    p.cells.forEach(([r,c])=> block(ox+c*s, oy+r*s, s, p.color));
  }

  // ---- Particules d'explosion + flash --------------------------------------
  function burst(cleared){
    cleared.forEach(({r,c,color}) => {
      const [x,y,s] = cellRect(r,c);
      for(let k=0;k<7;k++){
        const a = Math.random()*Math.PI*2, v = 60 + Math.random()*220;
        fx.parts.push({ x:x+s/2, y:y+s/2, vx:Math.cos(a)*v, vy:Math.sin(a)*v - 60,
                        life:1, size:s*(0.12+Math.random()*0.16), color });
      }
    });
    fx.flash = 1;
    loop();
  }
  function drawFx(){
    if(fx.flash > 0){
      ctx.globalAlpha = fx.flash * 0.5;
      rr(0,0,layout.boardPx,layout.boardPx,20); ctx.fillStyle='#fff'; ctx.fill();
      ctx.globalAlpha = 1;
    }
    fx.parts.forEach(p => {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
    });
    ctx.globalAlpha = 1;
  }
  // rAF actif seulement le temps de l'animation (0 CPU au repos).
  function loop(){
    if(fx.raf) return;
    let last = performance.now();
    const step = now => {
      const dt = Math.min((now - last)/1000, 0.05); last = now;
      fx.flash = Math.max(0, fx.flash - dt*4.5);
      fx.parts = fx.parts.filter(p => {
        p.vy += 900*dt; p.x += p.vx*dt; p.y += p.vy*dt; p.life -= dt*1.5;
        return p.life > 0;
      });
      draw();
      if(fx.parts.length || fx.flash > 0){ fx.raf = requestAnimationFrame(step); }
      else { fx.raf = 0; draw(); }
    };
    fx.raf = requestAnimationFrame(step);
  }

  // ---- Géométrie du drag ----
  function pointer(e){
    const rect = cv.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x:(t.clientX-rect.left), y:(t.clientY-rect.top) };
  }
  function ghostCells(){
    const {pad,cell}=layout, p=drag.piece, s=cell;
    const ox = drag.x - (p.w*s)/2, oy = drag.y - (p.h*s)/2 - s*1.2;
    const c0 = Math.round((ox - pad)/cell), r0 = Math.round((oy - pad)/cell);
    const cells = p.cells.map(([r,c])=>[r0+r, c0+c]);
    const ok = cells.every(([r,c]) => r>=0&&r<N&&c>=0&&c<N && !grid[r][c]);
    return { cells, ok, r0, c0 };
  }

  // ---- Événements ----
  function onDown(e){
    e.preventDefault();
    audio();                                     // débloque le son au 1er geste
    const pt = pointer(e);
    if(armed){ aimBooster(pt); return; }         // booster en main : on vise, on ne pose pas
    // toucher une pièce du tray ?
    for(let i=0;i<3;i++){ const p=tray[i]; if(!p||p.used||!p._tray) continue;
      const {ox,oy,s}=p._tray, W=p.w*s, H=p.h*s;
      if(pt.x>=ox-14 && pt.x<=ox+W+14 && pt.y>=oy-14 && pt.y<=oy+H+14){
        drag = { idx:i, piece:p, x:pt.x, y:pt.y }; draw(); return;
      }
    }
  }
  function onMove(e){ if(!drag) return; e.preventDefault();
    const pt = pointer(e); drag.x=pt.x; drag.y=pt.y; draw(); }
  function onUp(e){
    if(!drag) return; e.preventDefault();
    const g = ghostCells();
    if(g && g.ok){ place(drag.piece, drag.idx, g.r0, g.c0); }
    drag = null; draw();
  }

  function flashCombo(n){
    if(n>=2){ $combo.textContent = 'COMBO x'+n; $combo.classList.add('show');
      clearTimeout(flashCombo._t); flashCombo._t=setTimeout(()=>$combo.classList.remove('show'),900); }
  }

  function place(p, idx, r0, c0){
    p.cells.forEach(([dr,dc])=> grid[r0+dr][c0+dc]=p.color);
    score += placementScore(p.cells);
    tray[idx].used = true;
    // lignes/colonnes complètes
    const { rows:fullR, cols:fullC } = findFullLines(grid);
    const clears = fullR.length + fullC.length;
    if(clears>0){
      const cleared = clearLines(grid, fullR, fullC);
      combo = nextCombo(combo, clears);
      score += clearScore(clears, combo);          // récompense qui escalade
      flashCombo(combo);
      burst(cleared);                              // particules + flash
      sfxClear(combo);
      haptic(clears>1 ? [16,40,16] : 14);
    } else { combo = nextCombo(combo, 0); }
    $score.textContent = score;
    if(score>best){ best=score; $best.textContent=best; writeNum(K.best, best); }
    // tray vidé -> refill
    if(tray.every(t=>t.used)) refillTray();
    // game over ?
    if(!isAlive(grid, tray)) gameOver();
  }

  // ---- Boosters (power-ups) ------------------------------------------------
  /* Flux : taper un booster l'ARME (les cibles valides s'allument), taper une
     cible APPLIQUE l'effet et décrémente le compteur, re-taper le booster
     DÉSARME. Aucun effet destructeur sans ce tap de confirmation. 'refresh' n'a
     pas de cible : il agit tout de suite. Stock à 0 -> l'offre s'ouvre (pièces,
     pub récompensée, pack IAP) ; l'inventaire vit dans src/boosters.js.
     Un booster ne rapporte NI score NI combo : il dépanne, il ne farme pas.   */
  let armed = null;                          // id du booster en main, ou null
  let lineAxis = 'row';                      // removeLine : ligne ou colonne

  function buildBoosters(){
    const el = $('boosters');
    el.innerHTML = '';
    BOOSTERS.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'booster'; btn.dataset.b = b.id; btn.title = b.desc;
      btn.innerHTML = `${b.icon}<span class="nm">${b.name}</span><span class="n">0</span>`;
      btn.onclick = () => onBoosterTap(b.id);
      el.appendChild(btn);
    });
    // Choix de l'axe : visible seulement quand removeLine est armé.
    const axis = document.createElement('button');
    axis.className = 'booster-axis'; axis.id = 'booster-axis'; axis.hidden = true;
    axis.onclick = () => { lineAxis = lineAxis === 'row' ? 'col' : 'row'; paintBoosters(); draw(); };
    el.appendChild(axis);
  }

  function paintBoosters(){
    BOOSTERS.forEach(b => {
      const btn = $('boosters').querySelector(`[data-b="${b.id}"]`);
      const n = boosters.count(b.id);
      btn.querySelector('.n').textContent = n;
      btn.classList.toggle('empty', n === 0);
      btn.classList.toggle('on', armed === b.id);
    });
    const axis = $('booster-axis');
    axis.hidden = armed !== 'removeLine';
    axis.textContent = lineAxis === 'row' ? '↔ Ligne' : '↕ Colonne';
  }

  function disarm(){ if(armed){ armed = null; paintBoosters(); draw(); } }

  function onBoosterTap(id){
    if(armed === id){ disarm(); return; }                  // re-tap -> désarmer
    if(!boosters.has(id)){ armed = null; paintBoosters(); draw(); openOffer(id); return; }
    if(id === 'refresh'){ armed = null; useRefresh(); return; }
    armed = id; haptic(8); paintBoosters(); draw();
  }

  // refresh : pas de cible, les 3 pièces sont remplacées immédiatement.
  function useRefresh(){
    if(!boosters.use('refresh').ok) return;
    refillTray(); drag = null;
    paintBoosters(); sfxClear(2); haptic([10,24,10]); draw();
    if(!isAlive(grid, tray)) gameOver();                   // tirage sans issue
  }

  function cellAt(pt){
    const { pad, cell } = layout;
    const c = Math.floor((pt.x - pad)/cell), r = Math.floor((pt.y - pad)/cell);
    return (r>=0 && r<N && c>=0 && c<N) ? { r, c } : null;
  }

  // Tap sur le plateau, booster armé : c'est LE geste de confirmation.
  function aimBooster(pt){
    const at = cellAt(pt);
    if(!at){ disarm(); return; }                           // hors plateau -> on range
    if(armed === 'bomb'){
      if(!grid[at.r][at.c]){ haptic([20,60,20]); return; } // case vide : rien à faire sauter
      fireBooster('bomb', () => {
        const cells = bombCells(grid, at); grid = applyBomb(grid, at); return cells;
      });
      return;
    }
    if(armed === 'removeLine'){
      const target = { type:lineAxis, index: lineAxis === 'row' ? at.r : at.c };
      fireBooster('removeLine', () => {
        const cells = lineCells(grid, target); grid = applyRemoveLine(grid, target); return cells;
      });
    }
  }

  // Consomme d'abord (le stock fait foi), puis applique et fête l'effet.
  function fireBooster(id, effect){
    if(!boosters.use(id).ok){ disarm(); return; }
    const cleared = effect();
    armed = null; drag = null;
    paintBoosters();
    if(cleared.length) burst(cleared);                     // particules + flash
    sfxClear(2); haptic([14,30,14]);
    draw();
    if(!isAlive(grid, tray)) gameOver();
  }

  // Surbrillance des cibles valides (appelée par draw()).
  function drawAim(){
    if(!armed || armed === 'refresh') return;
    const { pad, cell } = layout;
    ctx.fillStyle = THEME.accent;
    if(armed === 'removeLine'){
      // bandes alternées le long de l'axe courant : le sens du balayage se lit.
      for(let i=0;i<N;i++){
        ctx.globalAlpha = i % 2 ? 0.10 : 0.18;
        if(lineAxis === 'row') ctx.fillRect(pad, pad + i*cell, N*cell, cell);
        else                   ctx.fillRect(pad + i*cell, pad, cell, N*cell);
      }
    } else {                                               // bomb : cases pleines
      ctx.globalAlpha = 0.24;
      for(let r=0;r<N;r++) for(let c=0;c<N;c++){
        if(!grid[r][c]) continue;
        const [x,y,s] = cellRect(r,c);
        rr(x+1,y+1,s-2,s-2,Math.max(4,s*0.16)); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- Stock épuisé : pièces / pub récompensée / pack IAP ------------------
  function openOffer(id){
    const b = boosterById(id); if(!b) return;
    $('offer-title').textContent = `${b.icon} ${b.name}`;
    $('offer-desc').textContent  = b.desc;
    $('offer-coins').textContent = meta.coins;

    const coinsBtn = $('btn-offer-coins');
    coinsBtn.textContent = `Acheter — ${b.price} 🪙`;
    coinsBtn.disabled = meta.coins < b.price;
    coinsBtn.onclick = () => {                             // achat : débite meta.coins
      const res = boosters.buy(b.id, meta.coins);
      if(!res.ok){ pulse($('coins-chip')); haptic([20,60,20]); return; }
      meta = { ...meta, coins:res.coins }; saveMeta(); paintHud();
      afterOffer(b.id);
    };

    const adBtn = $('btn-offer-ad');                       // +1 si la pub est vue
    adBtn.disabled = false;
    adBtn.onclick = () => {
      adBtn.disabled = true;
      boosters.watchAd(b.id).then(({ ok }) => {
        adBtn.disabled = false;
        if(ok) afterOffer(b.id);
      }, () => { adBtn.disabled = false; });
    };

    const packBtn = $('btn-offer-pack'), pack = mon.iap.product(IAP_PACK);
    packBtn.textContent = pack ? `${pack.title} — ${pack.price}` : 'Pack de boosters';
    packBtn.onclick = () => {
      busy(packBtn, true, '…');
      mon.iap.purchase(IAP_PACK).then(res => {
        busy(packBtn, false);
        if(!res.ok) return;
        boosters.grantPack(mon.iap.product(IAP_PACK).boosters);
        afterOffer(b.id);
      }, () => busy(packBtn, false));
    };

    $('booster-offer').classList.add('show');
  }
  // Stock reconstitué : on referme et on enchaîne sur le booster demandé.
  function afterOffer(id){
    paintBoosters(); sfxClear(4); haptic([12,30,12]);
    $('booster-offer').classList.remove('show');
    if(boosters.has(id)) onBoosterTap(id);
  }
  $('btn-offer-close').onclick = () => $('booster-offer').classList.remove('show');

  // ---- Fin de partie + coffre à récompense variable ------------------------
  let loot = null;                                  // butin de la partie en cours
  let freshScore = -1;                              // score tout juste classé (surligné)

  function gameOver(){
    mon.endGame();                                  // partie close -> interstitiel possible
    // classement local : top 10 + meilleur du jour (remis à zéro à minuit)
    const today = dayKey();
    freshScore = isHighScore(scores, score) ? score : -1;
    scores  = insertScore(scores, score, today);
    dayBest = updateDailyBest(dayBest, score, today);
    writeJson(K.scores, scores);
    writeJson(K.dayBest, dayBest);

    $('over-score').textContent = score;
    $('over-sub').textContent = 'Record : ' + best +
      (freshScore >= 0 ? ` · top ${scores.findIndex(e => e.score === score) + 1} !` : '');
    // coffre remis à l'état fermé
    loot = null;
    $('chest').textContent = '🎁';
    $('chest').classList.remove('opened');
    $('loot').textContent = '';
    $('btn-chest').hidden = false; $('btn-chest').disabled = false;
    $('btn-double').hidden = true; $('btn-double').disabled = false;
    $over.classList.add('show');
    haptic(30);
  }

  function grantLoot(r){
    if(r.coins) addCoins(r.coins);
    if(r.bonus) addBonus(r.bonus);
    if(r.skin){ meta = grantSkin(meta, r.skin); saveMeta(); setSkin(r.skin); }
  }
  function lootText(r){
    const bits = [];
    if(r.coins) bits.push(`+${r.coins} 🪙`);
    if(r.bonus) bits.push(`+${r.bonus} pièce${r.bonus>1?'s':''} bonus ✨`);
    if(r.skin)  bits.push('skin NÉON débloqué 🎨');
    return `${r.label} — <span class="gain">${bits.join(' · ')}</span>`;
  }

  $('btn-chest').onclick = () => {
    loot = rollChest();
    grantLoot(loot);
    $('chest').textContent = '🎉';
    $('chest').classList.add('opened');
    $('loot').innerHTML = lootText(loot);
    $('btn-chest').hidden = true;
    $('btn-double').hidden = false;
    sfxClear(4); haptic([12,30,12,30,24]);
  };

  // "Doubler (pub)" -> pub récompensée, placement 'double'.
  $('btn-double').onclick = () => {
    const btn = $('btn-double'); btn.disabled = true;
    mon.ads.showRewarded('double').then(ok => {
      if(!ok){ btn.disabled = false; return; }
      const d = doubleReward(loot);
      grantLoot({ coins:(d.coins||0)-(loot.coins||0), bonus:(d.bonus||0)-(loot.bonus||0) });
      loot = d;
      $('loot').innerHTML = lootText(d) + ' <b>x2 !</b>';
      btn.hidden = true;
      sfxClear(7); haptic([16,40,16,40,32]);
    }, () => { btn.disabled = false; });
  };

  // revive = pub récompensée : libère les 2 lignes du bas et redonne 3 pièces.
  // mon.revive() n'accorde la reprise que si la pub a bien été vue (ok===true).
  $('btn-revive').onclick = () => {
    const btn = $('btn-revive'); btn.disabled = true;
    mon.revive().then(({ ok }) => {
      btn.disabled = false;
      if(!ok){ $('over-sub').textContent = 'Pub indisponible — réessaie'; return; }
      for(let r=N-2;r<N;r++) for(let c=0;c<N;c++) grid[r][c]=null;
      refillTray(); combo = 0; $over.classList.remove('show'); draw();
    }, () => { btn.disabled = false; });
  };

  // Interstitiel : entre deux parties seulement, toutes N parties, coupé par 'noads'.
  $('btn-again').onclick = () => {
    mon.maybeShowInterstitial().then(startGame, startGame);
  };
  $('btn-menu').onclick = () => { $over.classList.remove('show'); showHome(); };

  // ---- Écran d'accueil -----------------------------------------------------
  function paintLeaderboard(){
    const el = $('home-lb');
    el.innerHTML = '';
    if(!scores.length){
      el.innerHTML = '<div class="empty">Aucun score : lance ta première partie.</div>';
      return;
    }
    scores.slice(0, LEADERBOARD_MAX).forEach((e, i) => {
      const li = document.createElement('li');
      if(e.score === freshScore){ li.className = 'fresh'; }
      li.innerHTML = `<span class="rank">${i+1}</span><span class="pts">${e.score}</span>` +
                     `<span class="day">${e.day || ''}</span>`;
      el.appendChild(li);
    });
  }
  function showHome(){
    dayBest = readDailyBest(dayBest, dayKey());     // minuit passé -> remis à zéro
    $('home-best').textContent   = Math.max(best, bestScore(scores));
    $('home-today').textContent  = dayBest.score;
    $('home-streak').textContent = streakDays + ' j';
    paintLeaderboard();
    $('home').classList.add('show');
  }
  function startGame(){
    freshScore = -1;
    $('home').classList.remove('show');
    reset();
  }
  $('btn-play').onclick = startGame;

  // ---- Boutique : skins + achats in-app -------------------------------------
  function busy(btn, on, label){
    btn.disabled = on;
    if(on){ btn._label = btn.innerHTML; btn.textContent = label; }
    else if(btn._label){ btn.innerHTML = btn._label; }
  }
  function paintShop(){
    const el = $('skin-list');
    el.innerHTML = '';
    SKINS.forEach(sk => {
      const owned = isOwned(meta, sk.id), on = meta.skin === sk.id;
      const b = document.createElement('button');
      b.className = 'skin' + (on ? ' on' : '') + (owned ? '' : ' locked');
      b.innerHTML = `<span class="swatch">${sk.blocks.slice(0,5).map(c =>
                        `<i style="background:${c}"></i>`).join('')}</span>` +
                    `<span class="nm">${sk.name}</span><span class="tag">${skinTag(sk, owned, on)}</span>`;
      b.onclick = () => onSkinTap(sk);
      el.appendChild(b);
    });
    const pack = $('btn-skinpack');
    pack.hidden = SKINS.filter(s => s.unlock.type === 'iap').every(s => isOwned(meta, s.id));
    paintProducts();
    paintHud();
  }
  /* Achats in-app hors skins ('noads', sac de pièces) : le catalogue vient de
     mon.iap, et le jeu credite lui-meme les pieces des consommables pour garder
     un seul porte-monnaie (celui de meta). */
  async function paintProducts(){
    const el = $('shop-list');
    el.innerHTML = '<div class="muted">Chargement…</div>';
    const products = await mon.getProducts();
    el.innerHTML = '';
    products.filter(p => p.sku !== 'skinpack').forEach(p => {   // le pack a son propre bouton
      const row = document.createElement('div');
      row.className = 'shop-row';
      row.innerHTML = `<div class="shop-info"><b>${p.title}</b><small>${p.desc}</small></div>`;
      const btn = document.createElement('button');
      btn.className = p.owned ? 'btn-ghost' : 'btn-primary';
      btn.textContent = p.owned ? 'Acheté' : p.price;
      btn.disabled = !!p.owned;
      btn.onclick = () => buy(p, btn);
      row.appendChild(btn);
      el.appendChild(row);
    });
  }
  async function buy(p, btn){
    busy(btn, true, '…');
    const res = await mon.iap.purchase(p.sku);
    busy(btn, false);
    if(!res.ok) return;
    const grant = mon.iap.product(p.sku);
    if(grant && grant.coins) addCoins(grant.coins);
    if(grant && grant.boosters){ boosters.grantPack(grant.boosters); paintBoosters(); }
    sfxClear(5); haptic([12,30,12]);
    paintShop();
  }
  function skinTag(sk, owned, on){
    if(on)    return 'Équipé';
    if(owned) return 'Choisir';
    if(sk.unlock.type === 'coins') return `${sk.unlock.price} 🪙`;
    if(sk.unlock.type === 'iap')   return 'Pack premium';
    return 'Au coffre 🎁';
  }
  function onSkinTap(sk){
    if(isOwned(meta, sk.id)){ setSkin(sk.id); paintShop(); haptic(10); return; }
    if(sk.unlock.type === 'coins'){
      const res = unlockSkin(meta, sk.id);
      if(!res.ok){ pulse($('coins-chip')); haptic([20,60,20]); return; }
      meta = res.state; saveMeta(); setSkin(sk.id); paintShop();
      sfxClear(4); haptic([12,30,12]);
      return;
    }
    if(sk.unlock.type === 'iap'){ buyPack(sk.unlock.pack); return; }
    pulse($('coins-chip'));                          // skin de coffre : rien à acheter
  }
  // Achat IAP (window.IAP -> src/iap.js) : le pack débloque tous ses skins d'un coup.
  function buyPack(pack){
    const btn = $('btn-skinpack'); btn.disabled = true;
    window.IAP.purchase(pack).then(ok => {
      btn.disabled = false;
      if(!ok) return;
      meta = grantPack(meta, pack); saveMeta(); paintShop();
      sfxClear(6); haptic([12,30,12,30,24]);
    }, () => { btn.disabled = false; });
  }
  $('btn-skinpack').onclick = () => buyPack('skinpack');
  const openShop = () => { paintShop(); $('shop').classList.add('show'); };
  $('btn-shop').onclick = openShop;
  $('btn-shop-hud').onclick = openShop;
  $('btn-shop-close').onclick = () => $('shop').classList.remove('show');
  // Restauration : les non-consommables déjà payés reviennent (changement d'appareil).
  $('btn-restore').onclick = async () => {
    const btn = $('btn-restore');
    busy(btn, true, 'Restauration…');
    const { owned } = await mon.restore();
    busy(btn, false);
    const packs = new Set(SKINS.filter(s => s.unlock.type === 'iap').map(s => s.unlock.pack));
    owned.filter(sku => packs.has(sku))                        // packs de skins re-débloqués
         .forEach(sku => { meta = grantPack(meta, sku); });
    saveMeta(); paintShop();
  };

  // ---- Daily streak --------------------------------------------------------
  function readStreak(){
    try { return JSON.parse(localStorage.getItem(K.streak)) || null; } catch(_){ return null; }
  }
  function paintDots(streak){
    const el = $('daily-dots'); el.innerHTML = '';
    for(let i=1;i<=7;i++){
      const d = document.createElement('div');
      d.className = 'dot' + (i <= Math.min(streak,7) ? ' on' : '');
      d.textContent = i;
      el.appendChild(d);
    }
  }
  /* Dose de boosters offerte : même clé datée que le streak, mais comptée à
     part (src/boosters.js) — elle est acquise dès l'ouverture, sans bouton, et
     ne remonte qu'au plancher : pas de stock gratuit qui s'empile. */
  function refillFreeBoosters(){
    const { gained } = boosters.refill(dayKey());
    paintBoosters();
    const bits = Object.entries(gained)
      .map(([id, n]) => `${boosterById(id).icon} +${n}`);
    const el = $('daily-boosters');
    el.hidden = !bits.length;
    if(bits.length) el.textContent = 'Boosters du jour : ' + bits.join(' · ');
  }

  function checkDaily(){
    refillFreeBoosters();                          // indépendant du bouton Récupérer
    const st = updateStreak(readStreak(), dayKey());
    streakDays = st.streak;
    $('streak').textContent = st.streak;
    $('home-streak').textContent = st.streak + ' j';
    if(!st.claimed) return;                        // déjà réclamé aujourd'hui
    paintDots(st.streak);
    $('daily-sub').textContent = `Jour ${st.streak} d'affilée`;
    $('daily-gain').textContent = '+' + st.reward;
    $('daily').classList.add('show');
    $('btn-daily').onclick = () => {
      localStorage.setItem(K.streak, JSON.stringify({ streak:st.streak, lastDay:st.lastDay }));
      addCoins(st.reward);
      $('daily').classList.remove('show');
      sfxClear(3); haptic([12,30,20]);
    };
  }

  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  cv.addEventListener('touchstart', onDown, {passive:false});
  cv.addEventListener('touchmove', onMove, {passive:false});
  window.addEventListener('touchend', onUp, {passive:false});
  window.addEventListener('resize', () => { resize(); draw(); });

  // La partie ne démarre plus toute seule : l'accueil est la porte d'entrée.
  buildBoosters();
  reset();
  checkDaily();
  showHome();
})();
