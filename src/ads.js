/* ============================================================================
   POPLYN — régie publicitaire. Un seul contrat, deux fournisseurs.

   Contrat (celui que `game.js` connaît, via `window.Ads`) :
       showRewarded()     -> Promise<boolean>   true = récompense méritée
       showInterstitial() -> Promise<void>      résout toujours (jamais bloquant)

   Fournisseurs :
       'mock'  — web / dev : la pub est instantanée et toujours "vue".
       'admob' — natif : @capacitor-community/admob, via le pont Capacitor
                 (`window.Capacitor.Plugins.AdMob`), donc sans bundler : le
                 plugin natif expose ses méthodes au WebView tout seul.

   Sélection : natif -> 'admob', sinon 'mock'. Forçable pour tester :
       ?ads=mock  dans l'URL, ou localStorage.poplyn_ads = 'mock' | 'admob'.

   Politique d'échec (décidée ici, pas dans le jeu) : si la pub récompensée ne
   charge pas (pas de remplissage, réseau coupé, SDK absent), on accorde quand
   même la récompense — le joueur ne doit jamais être puni pour notre tuyauterie.
   S'il ferme la pub volontairement, pas de récompense. L'interstitiel, lui,
   est silencieux : toute erreur est avalée, la partie suivante démarre.

   Clés AdMob réelles : voir docs/ADMOB.md. Elles ne sont PAS dans ce fichier —
   `src/ad-config.js` les reçoit au build depuis l'environnement (docs/SECRETS.md),
   avec repli sur les blocs de TEST officiels Google.

   Le bas du fichier porte l'interface `AdProvider` + le provider MOCK à
   compteurs : c'est ce que `src/monetization.js` manipule pour décider QUAND
   une pub a le droit de s'afficher, et ce que les tests injectent.
   ========================================================================== */

import { AD_CONFIG } from './ad-config.js';

/* ---- Blocs publicitaires ---------------------------------------------------
   Un seul endroit à renseigner, et ce n'est pas ici : `src/ad-config.js` reçoit
   les vrais blocs au build depuis les variables d'environnement (ADMOB_*), avec
   repli sur les blocs de TEST Google. Cf. docs/SECRETS.md. */
export const AD_UNITS = AD_CONFIG.units;

/* `true` tant que AD_UNITS porte les blocs de test : le SDK est alors lancé en
   mode test (obligatoire pendant le dev, sinon Google suspend le compte). */
export const isTestingUnits = (units = AD_UNITS) =>
  JSON.stringify(units).includes('ca-app-pub-3940256099942544');

// ---- Fournisseur 'mock' (web, dev, tests) ----------------------------------
/* La pub est simulée : un délai court pour que l'UI se comporte comme en vrai
   (bouton désactivé le temps de la "vidéo"), puis récompense accordée. */
export const createMockProvider = ({ delay = 300, wait = ms =>
  new Promise(r => setTimeout(r, ms)) } = {}) => ({
  name: 'mock',
  init: () => Promise.resolve(),
  showRewarded: () => wait(delay).then(() => true),
  showInterstitial: () => wait(delay),
});

// ---- Fournisseur 'admob' (natif) -------------------------------------------
/* Le plugin est joint par le pont Capacitor : `Capacitor.Plugins.AdMob`. Les
   méthodes utilisées viennent de @capacitor-community/admob :
       requestConsentInfo() / showConsentForm()    — UMP (consentement RGPD)
       initialize({ initializeForTesting, requestTrackingAuthorization })
       prepareRewardVideoAd({ adId, isTesting })  puis  showRewardVideoAd()
       prepareInterstitial({ adId, isTesting })   puis  showInterstitial()
   `showRewardVideoAd()` résout avec l'objet récompense quand elle est méritée
   et rejette si le joueur ferme la vidéo avant la fin. */
export const createAdMobProvider = ({ plugin, platform = 'android', units = AD_UNITS } = {}) => {
  const ids = units[platform] || units.android;
  const isTesting = isTestingUnits(units);
  let ready = null;                                  // init lancée une seule fois

  /* Consentement UMP (User Messaging Platform) — obligatoire en Europe avant
     toute requête publicitaire. Le formulaire lui-même se dessine côté console
     AdMob (Confidentialité et messages) ; ici on ne fait que le demander puis
     l'afficher s'il est requis. Une panne du CMP ne doit pas bloquer le jeu :
     l'erreur est avalée et le SDK démarrera en pub non personnalisée. */
  const consent = async () => {
    if (!plugin.requestConsentInfo) return;          // plugin plus ancien : on saute
    const info = await plugin.requestConsentInfo();
    if (info?.status === 'REQUIRED' && info?.isConsentFormAvailable) {
      await plugin.showConsentForm();
    }
  };

  const init = () => (ready ||= consent()
    .catch(err => console.warn('[ads] consentement UMP indisponible :', err))
    .then(() => plugin.initialize({
      // Mode test tant qu'on tourne sur les blocs de démo Google.
      initializeForTesting: isTesting,
      // iOS : déclenche l'invite ATT (App Tracking Transparency) avant la 1re pub.
      // Le texte de l'invite est NSUserTrackingUsageDescription (Info.plist).
      // ATT vient APRÈS l'UMP : c'est l'ordre imposé par Apple et Google.
      requestTrackingAuthorization: true,
    }))
    .catch(err => {
      ready = null;                                  // on réessaiera au prochain appel
      throw err;
    }));

  return {
    name: 'admob',
    init,

    /* Récompensée : préparer puis montrer. Une erreur de chargement accorde la
       récompense (fail-open), une fermeture volontaire ne l'accorde pas. */
    showRewarded: async () => {
      try {
        await init();
        await plugin.prepareRewardVideoAd({ adId: ids.rewarded, isTesting });
      } catch (err) {
        console.warn('[ads] pub récompensée indisponible, récompense accordée :', err);
        return true;
      }
      try {
        await plugin.showRewardVideoAd();
        return true;
      } catch (err) {
        console.warn('[ads] pub récompensée non terminée :', err);
        return false;                                // fermée avant la fin
      }
    },

    /* Interstitiel : jamais bloquant, toute erreur est avalée. */
    showInterstitial: async () => {
      try {
        await init();
        await plugin.prepareInterstitial({ adId: ids.interstitial, isTesting });
        await plugin.showInterstitial();
      } catch (err) {
        console.warn('[ads] interstitiel ignoré :', err);
      }
    },
  };
};

// ---- Sélection du fournisseur ----------------------------------------------
/* `env` isole tout ce qui vient du navigateur pour que ce module reste testable
   en Node : { capacitor, forced }. */
export const readEnv = (global = globalThis) => {
  const cap = global.Capacitor;
  let forced = null;
  try {
    forced = new URL(global.location?.href || '').searchParams.get('ads')
      || global.localStorage?.getItem('poplyn_ads');
  } catch (_) { /* URL invalide ou localStorage bloqué : on ignore */ }
  return {
    capacitor: cap,
    platform: cap?.getPlatform?.() || 'web',
    native: !!cap?.isNativePlatform?.(),
    forced,
  };
};

/* Renvoie le fournisseur à utiliser. Natif + plugin présent -> 'admob'.
   Sinon 'mock' : le web, et le natif si le plugin n'est pas encore installé
   (le jeu tourne, les pubs sont simulées — jamais d'écran bloqué). */
export const pickProvider = (env = readEnv()) => {
  const plugin = env.capacitor?.Plugins?.AdMob;
  const want = env.forced || (env.native ? 'admob' : 'mock');
  if (want === 'admob' && plugin) {
    return createAdMobProvider({ plugin, platform: env.platform });
  }
  if (want === 'admob') console.warn('[ads] plugin AdMob absent — repli sur le mock');
  return createMockProvider();
};

/* Branchement sur `window.Ads` : `game.js` ne connaît que ce contrat, il ne
   sait rien du fournisseur choisi. */
if (typeof window !== 'undefined') {
  const provider = pickProvider();
  window.Ads = {
    provider: provider.name,
    // Le placement ('revive' / 'double') est transmis : les fournisseurs actuels
    // l'ignorent, un futur SDK y branchera un bloc par emplacement.
    showRewarded:     placement => provider.showRewarded(placement),
    showInterstitial: () => provider.showInterstitial(),
  };
  // Préchauffage : l'init AdMob (consentement + ATT) coûte du temps, on la
  // lance dès le chargement pour que la 1re pub soit immédiate.
  provider.init().catch(err => console.warn('[ads] init :', err));
}

/* ============================================================================
   Interface testable (`AdProvider`) + provider MOCK a compteurs.
   `src/monetization.js` ne manipule que cette forme : isReady(placement),
   showRewarded(placement) -> booleen, showInterstitial(). En navigateur, c'est
   `window.Ads` ci-dessus qui joue les pubs ; ici, on peut tout piloter en test
   (latence nulle, refus simule, no-fill) et compter les impressions.
   ========================================================================== */

const wait = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());

/* Interface. showRewarded resout un BOOLEEN : true = récompense méritée
   (pub vue jusqu'au bout), false = pas de pub / abandon / no-fill.
   Toute recompense DOIT etre conditionnee a ce booleen. */
export class AdProvider {
  isReady(/* placement */){ return false; }
  async showRewarded(/* placement */){ return false; }
  async showInterstitial(){ /* no-op */ }
}

// ---- Provider MOCK : pilotable en test, jouable en dev sans clé SDK ----
export class MockAdProvider extends AdProvider {
  /**
   * @param {object} opts
   *  - latencyMs      : délai simulé d'ouverture de la pub (0 en test)
   *  - rewardedSuccess: bool | (placement)=>bool  (utilisateur regarde jusqu'au bout ?)
   *  - available      : bool | (placement)=>bool  (inventaire dispo / no-fill)
   */
  constructor(opts = {}){
    super();
    this.latencyMs       = opts.latencyMs       ?? 600;
    this.rewardedSuccess = opts.rewardedSuccess ?? true;
    this.available       = opts.available       ?? true;
    this.reset();
  }

  reset(){
    this.calls       = { rewarded:0, interstitial:0 };   // demandes faites au provider
    this.impressions = { rewarded:0, interstitial:0 };   // pubs réellement affichées
    this.byPlacement = {};                               // { revive:2, double:1, ... }
    this.log         = [];
  }

  _flag(v, placement){ return typeof v === 'function' ? !!v(placement) : !!v; }

  isReady(placement = 'default'){ return this._flag(this.available, placement); }

  async showRewarded(placement = 'default'){
    this.calls.rewarded++;
    if(!this.isReady(placement)){ this.log.push({type:'rewarded', placement, ok:false, reason:'no-fill'}); return false; }
    await wait(this.latencyMs);
    if(!this._flag(this.rewardedSuccess, placement)){
      this.log.push({type:'rewarded', placement, ok:false, reason:'skipped'});
      return false;
    }
    this.impressions.rewarded++;
    this.byPlacement[placement] = (this.byPlacement[placement] || 0) + 1;
    this.log.push({type:'rewarded', placement, ok:true});
    return true;
  }

  async showInterstitial(){
    this.calls.interstitial++;
    if(!this.isReady('interstitial')){ this.log.push({type:'interstitial', ok:false, reason:'no-fill'}); return; }
    await wait(this.latencyMs);
    this.impressions.interstitial++;
    this.log.push({type:'interstitial', ok:true});
  }
}

/* Provider par defaut hors navigateur (tests, Node) : le MOCK. Dans le jeu,
   `game.js` injecte un pont sur `window.Ads`, donc sur le fournisseur choisi
   plus haut ('admob' en natif) — les vraies cles se remplacent dans AD_UNITS,
   aucune autre ligne du jeu ne bouge (cf. docs/ADMOB.md). */
export function createAdProvider(opts = {}){
  return new MockAdProvider(opts);
}
