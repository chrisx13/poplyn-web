/* ============================================================================
   POPLYN — persistance minimale (localStorage cote navigateur, memoire ailleurs).
   Sert aux modules monetisation qui doivent tourner AUSSI sous Node (tests).
   ========================================================================== */

// Backend memoire : meme API que localStorage, utilise en test / SSR / privacy mode.
export function memoryBackend(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k,v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}

function pickBackend(){
  try {
    const ls = globalThis.localStorage;
    const probe = '__poplyn_probe__';
    ls.setItem(probe,'1'); ls.removeItem(probe);   // Safari privé lève ici
    return ls;
  } catch { return memoryBackend(); }
}

// createStorage() -> { get, set, del } prefixé, avec (dé)serialisation JSON.
export function createStorage(prefix = 'poplyn_', backend = null){
  const be = backend || pickBackend();
  return {
    get(key, fallback = null){
      const raw = be.getItem(prefix + key);
      if(raw == null) return fallback;
      try { return JSON.parse(raw); } catch { return raw; }
    },
    set(key, value){ be.setItem(prefix + key, JSON.stringify(value)); return value; },
    del(key){ be.removeItem(prefix + key); },
  };
}
