/* ============================================================================
   POPLYN — configuration publicitaire, UN SEUL endroit. Passer des blocs de
   TEST Google aux vrais blocs = renseigner des variables d'environnement au
   build, jamais éditer une ligne de code ni committer un identifiant.

   Comment ça marche :

   1. Les valeurs de `INJECTED` ci-dessous sont des JETONS (nom encadré de deux
      tirets bas), pas des identifiants.
   2. `tools/build-web.mjs` les remplace au moment d'assembler `www/` par la
      variable d'environnement du même nom, ou par l'ID de TEST si elle est
      absente (`npm run build`, donc aussi `npx cap sync` et la CI Codemagic).
   3. Si le fichier est servi SANS build (dev : `npx serve .`), les jetons sont
      toujours là : `resolve()` le voit et retombe sur les IDs de TEST.

   Autrement dit : jamais d'identifiant réel dans le repo, et jamais d'écran
   cassé faute d'identifiant. Le porteur ne touche qu'aux variables listées dans
   `docs/SECRETS.md` (groupe Codemagic `poplyn_admob`).

   Les deux IDs d'APPLICATION (format `~`) ne sont pas lus par ce fichier au
   runtime — ils vivent dans AndroidManifest.xml (placeholder Gradle) et
   Info.plist (réécrit par le CI) — mais ils sont déclarés ici pour que la liste
   des variables soit complète et vérifiable en un coup d'œil (test/release).
   ========================================================================== */

/* Blocs de TEST officiels Google : ils servent une vraie pub de démo sans
   risquer la suspension du compte. Ce sont les valeurs de repli — voir
   `isTestingUnits()` dans `src/ads.js`, qui met le SDK en mode test tant
   qu'elles sont en place. */
export const TEST_IDS = {
  ADMOB_APP_ID_ANDROID:      'ca-app-pub-3940256099942544~3347511713',
  ADMOB_APP_ID_IOS:          'ca-app-pub-3940256099942544~1458002511',
  ADMOB_INTERSTITIAL_ANDROID:'ca-app-pub-3940256099942544/1033173712',
  ADMOB_INTERSTITIAL_IOS:    'ca-app-pub-3940256099942544/4411468910',
  ADMOB_REWARDED_ANDROID:    'ca-app-pub-3940256099942544/5224354917',
  ADMOB_REWARDED_IOS:        'ca-app-pub-3940256099942544/1712485313',
};

/* Jetons substitués au build. NE PAS remplacer à la main : c'est l'env qui
   décide (cf. `BUILD_TOKENS` dans tools/build-web.mjs). */
const INJECTED = {
  ADMOB_APP_ID_ANDROID:      'ca-app-pub-3940256099942544~3347511713',
  ADMOB_APP_ID_IOS:          'ca-app-pub-3940256099942544~1458002511',
  ADMOB_INTERSTITIAL_ANDROID:'ca-app-pub-3940256099942544/1033173712',
  ADMOB_INTERSTITIAL_IOS:    'ca-app-pub-3940256099942544/4411468910',
  ADMOB_REWARDED_ANDROID:    'ca-app-pub-3940256099942544/5224354917',
  ADMOB_REWARDED_IOS:        'ca-app-pub-3940256099942544/1712485313',
};

/* Un jeton encore présent (build non joué, ou variable non fournie) = repli. */
export const resolve = (key, injected = INJECTED, fallback = TEST_IDS) => {
  const value = injected[key];
  return !value || value.startsWith('__') ? fallback[key] : value;
};

/* La config vue par `src/ads.js`. Même forme que l'ancien `AD_UNITS` pour que
   le reste du jeu ne bouge pas. */
export const AD_CONFIG = {
  appId: {
    android: resolve('ADMOB_APP_ID_ANDROID'),
    ios:     resolve('ADMOB_APP_ID_IOS'),
  },
  units: {
    android: {
      rewarded:     resolve('ADMOB_REWARDED_ANDROID'),
      interstitial: resolve('ADMOB_INTERSTITIAL_ANDROID'),
    },
    ios: {
      rewarded:     resolve('ADMOB_REWARDED_IOS'),
      interstitial: resolve('ADMOB_INTERSTITIAL_IOS'),
    },
  },
};
