# Plan de migration : du PoC Tauri vers une vraie appli livrée (Windows en priorité)

Ce document part du principe que le PoC (`poc-tauri/`, voir `README.md` pour le détail de
chaque page portée) a répondu à la question qu'il posait : oui, l'architecture
Rust/Tauri + sidecar Node peut faire tourner tout le code métier réel de l'appli, sans
Electron - et depuis, le vrai `App.tsx` (le shell applicatif complet, pas une page de test de
plus) tourne lui aussi, avec navigation réelle confirmée. Ce document liste, honnêtement, ce
qu'il reste à faire pour passer de là à "une appli livrable qui remplace Electron en
production", avec Windows comme cible prioritaire puisque c'est la plateforme de la majorité
des utilisateurs de ce manager.

## Ce qui est déjà acquis (ne pas refaire)

- **Zéro couplage Electron bloquant.** Tout `src/main/lib/*.ts` et tout `src/main/ipc/*.ts`
  tourne tel quel dans un sidecar Node sans `app`/`BrowserWindow`/`contextBridge` - seuls
  `dataDir.ts` (`app.getPath('documents')`) et le défaut interne d'`electron-store`
  (`app.getPath('userData')`) ont besoin d'un stand-in (`sidecar/electronShim.ts`, 2 lignes).
- **Les 36 vraies pages** (23 ARK + les onglets `ServerDetail/`/`MinecraftServerDetail/`, plus
  `MinecraftDashboard.tsx`) rendent et fonctionnent sans modification contre un shim
  `window.api` backé par `invoke`/`listen` au lieu de `contextBridge`.
- **Le bug `confirmAction()`/`window.confirm()` est corrigé** (voir README, "Closing the
  confirmAction()/window.confirm() bug for real") - `tauri-plugin-dialog` a été retiré au
  profit d'appels directs à `rfd`, ce qui restaure le `window.confirm()` natif et synchrone.
  C'est un vrai fix de code, pas juste une note dans le README - il tient déjà sur la branche.
- **Packaging de base prouvé** : sidecar en binaire SEA autonome (pas de dépendance à un
  `node` système), spawné via le vrai mécanisme `externalBin`/sidecar de Tauri,
  `cargo tauri build --bundles deb` produit un `.deb` réellement installable. Les cibles
  `msi`/`nsis` sont maintenant dans `tauri.conf.json` (confirmé sans effet de bord sur le
  build Linux), prêtes à produire un vrai installeur une fois buildées sur Windows.
- **Un build Windows réel a déjà tourné une fois** (voir "Result" dans le README) : fenêtre
  WebView2, lecture/écriture de profil, push temps réel, tous confirmés visuellement sur une
  vraie machine Windows.
- **Premier outil de migration de données réel, pas juste planifié** (voir section 2
  ci-dessous) - `legacyImport.ts` détecte/prévisualise/importe les vraies données ARK/Minecraft
  d'une installation Electron existante, et le `package.json` racine de l'appli réelle a été
  renommé `ark-server-manager` → `bober-server-manager` sans casser les installations
  existantes (`src/main/legacyUserDataCompat.ts` repointe explicitement vers l'ancien dossier -
  confirmé par un build complet et les 1358 tests, tous verts, après le rename).
- **Le vrai `App.tsx` tourne, pas une 37e page de démo** (voir section 1 ci-dessous) - le vrai
  shell applicatif, avec le vrai `app.css`, un unique pont `window.api` complet
  (`frontend/lib/windowApi.ts`), navigation sidebar/onglets réelle confirmée via l'app compilée.
- **Le pont `window.api` a été audité en entier contre le vrai `Api` de `shared/types.ts`**
  (voir README, "The IPC-surface audit") - diff exhaustif (namespaces + noms de méthodes) plutôt
  qu'un échantillon, croisé avec le vrai preload et les vrais handlers IPC. Quatre écarts réels
  trouvés et corrigés (`profiles.copyConfigFrom`, `statsHistory.getForGroup`, tout le namespace
  `officialServerStatus`, et un type de callback erroné sur `steamcmd.onUpdateLogChanged`),
  chacun testé contre le vrai sidecar avant commit. Fait explicitement avant la session de test
  de l'utilisateur, pour éviter un troisième crash du même genre que `windowControls.isMaximized`
  et `systemStats.get` (déjà rencontrés et corrigés pendant le portage d'App.tsx).

## Ce qui n'existe pas encore et qui est le vrai travail

### 1. L'appli elle-même, pas 37 pages de test séparées

**Fait, pas juste planifié - voir README, "The real App.tsx shell, not one more per-page
wrapper".** Le vrai, unmodifié `App.tsx` (609 lignes) tourne maintenant directement dans ce
PoC (`poc-tauri/frontend/app-entry.tsx` + `app.html`), avec le vrai `app.css`
(`styles.css`, copié tel quel), pas une page "unstyled but functional" de plus. Il s'est avéré
n'avoir besoin d'aucun router ni Context provider : juste un gros composant à état local
(`useState`) qui bascule entre les pages déjà prouvées une par une - confirmé en lisant le vrai
`src/renderer/src/main.tsx` que ce PoC imite trait pour trait
(`ReactDOM.createRoot(...).render(<App />)` dans `React.StrictMode`, rien d'autre).

Le **vrai fix** que cette section appelait de ses vœux existe maintenant :
`poc-tauri/frontend/lib/windowApi.ts`, un **unique** pont `window.api` complet, construit en
fusionnant mécaniquement les ~36 unions partielles par page déjà écrites dans ce PoC - pas une
réécriture depuis zéro. `installWindowApi()` s'appelle une fois, au montage, et c'est tout.

En montant la vraie appli pour de vrai (pas une page isolée), plusieurs vrais trous dans la
surface `window.api` sont apparus - aucun n'avait jamais été exercé par aucune des 36 pages
individuelles, puisque c'est `App.tsx` lui-même (ou des composants qu'il rend inconditionnellement
comme `TitleBar.tsx`, jamais monté seul avant) qui les appelle :
- `server.isInstalled`, `appStartup.isComplete`/`.onComplete` - `App.tsx` les appelle
  directement. Le sidecar n'a pas de vraie séquence de boot multi-étapes à répliquer comme le
  vrai `main/index.ts` (ré-attacher les process, démarrer le web dashboard, armer le
  scheduler...) - il marque son propre démarrage terminé juste après sa propre init, un
  stand-in honnête plutôt qu'une réplique de chaque étape réelle.
- `windowControls.{minimize,toggleMaximize,close,isMaximized,onMaximizedChange}`,
  `system.{quit,openDevTools}` - le vrai `TitleBar.tsx` (jamais monté avant, aucune des 36
  pages ne rend sa propre barre de titre) attend ces commandes. Même classe que `window_focus`
  (aucune implication du sidecar, juste l'API fenêtre de Tauri) - cinq nouvelles commandes Rust
  sans sidecar, plus la première émission Rust→webview *directement* depuis `main.rs`
  (`window-maximized-changed`), pas relayée depuis le sidecar comme tous les autres push events
  jusqu'ici.
- `dialog.selectProfileFile`, `profiles.importFromFile` - le bouton "Import from file..." du
  vrai assistant "+ Add Profile" de `Dashboard.tsx`, explicitement laissé hors-scope lors du
  round `dashboard-entry.tsx` d'origine ("needs the native folder/file picker"). Réutilise le
  vrai `parseImportedProfile()` (`lib/profileExport.ts`), jamais appelé avant dans ce PoC.

Confirmé par la vraie app compilée, pas juste par la compilation : navigation sidebar
ARK/Minecraft en direct (vrai `MinecraftDashboard.tsx` affiché, vraies stats réseau live qui
changent), clic sur le menu "..." d'une carte serveur → les 8 vrais onglets listés
(Analytics/Settings/Mods/Map Management/Backups/Update Log/Server Management/Files), navigation
réelle dans `ServerDetail` (vraies données du profil affichées), changement d'onglet interne
sans rechargement de page, retour en arrière vers le Dashboard - tout cela est la vraie
composition `App.tsx` d'état interne, pas un rechargement de page comme le ferait un lien
`<a>`. Seul vrai trou restant : l'état minimize/maximize de la fenêtre ne peut pas être
confirmé visuellement dans ce sandbox Xvfb headless (aucun gestionnaire de fenêtres réel pour
faire suivre l'état) - même catégorie que les sélecteurs natifs, l'appel RPC lui-même
fonctionne sans erreur.

Ce qui reste : auditer les 39 modules `src/main/ipc/*.ts` un par un contre `main.rs` pour
trouver d'éventuels endpoints jamais exercés même par cette surface désormais complète
(aucun trou connu à ce jour, mais pas formellement vérifié module par module).

### 2. Migration des données de l'ancien manager Electron

**Mis en chantier et testé de bout en bout, pas juste planifié** - voir `poc-tauri/sidecar/
legacyImport.ts` et la nouvelle section "Legacy data import" de `index.html`.

Le vrai problème, découvert en creusant plutôt que supposé : on ne peut pas se contenter de
pointer `electronShim.ts` vers le même chemin que l'appli Electron réelle, parce que ce chemin
n'est pas garanti. `app.getPath('userData')` d'Electron dérive de `app.getName()`, qui lit par
défaut le champ `name` de `package.json` (`"ark-server-manager"`) - mais `productName`
("Bober Server Manager", utilisé par electron-builder pour le nom de l'installeur) est souvent
ce qui apparaît réellement dans le nom du dossier selon la configuration exacte d'electron-
builder. Parier sur un seul nom au hasard, c'est risquer de rater silencieusement les vraies
données d'un utilisateur.

Solution retenue : un vrai outil d'import plutôt qu'une correspondance de chemin fragile.
Trois méthodes RPC (`legacyImport.detect`/`.preview`/`.run`) :
- **detect** vérifie les deux dossiers candidats (par OS : `%APPDATA%` sur Windows,
  `~/Library/Application Support` sur macOS, `~/.config` sur Linux, avec les deux noms
  possibles) et rapporte honnêtement ce qui existe, sans rien écrire.
- **preview** fait la même chose pour un dossier choisi à la main (sélecteur natif déjà
  fonctionnel depuis le fix confirm() de cette session).
- **run** importe réellement : chaque profil ARK/Minecraft passe par les vraies
  `migrateProfile()`/`migrateMinecraftProfile()` puis les vraies `saveProfile()`/
  `saveMinecraftProfile()` - les mêmes fonctions que tout le reste de ce PoC utilise déjà pour
  écrire - et les ids déjà présents sont ignorés, jamais écrasés (testé : lancer l'import deux
  fois de suite ne duplique rien).

**Un vrai bug trouvé en testant, pas en lisant le code** : un profil legacy minimal (sans
`backupDir` ni `clusterDirOverride`, des champs qui n'existaient pas dans d'anciens schémas)
faisait planter `saveProfile()` (`Cannot read properties of undefined (reading 'trim')`) parce
que `migrateProfile()` ne défaultise pas tous les champs que l'étape de sanitization de
`saveProfile()` suppose présents - dans l'appli réelle ce n'est jamais un problème puisque le
formulaire React initialise toujours ces champs à `''` avant d'appeler `saveProfile()`, une
garantie qu'un fichier JSON importé brut n'a pas. Corrigé côté importeur (defaulting explicite
de ces trois champs avant l'écriture), pas en touchant le vrai code de l'appli.

**L'ambiguïté de nom elle-même est maintenant réglée à la source, dans la vraie appli.** Le
`package.json` racine a été renommé `ark-server-manager` → `bober-server-manager` (pour
correspondre au vrai nom affiché, "Bober Server Manager") - mais comme `app.getPath('userData')`
dérive de ce nom, renommer le champ seul aurait silencieusement fait pointer la prochaine mise
à jour de chaque installation réelle vers un dossier neuf et vide, sans rien migrer. Fixé avec
`src/main/legacyUserDataCompat.ts` (nouveau, dans l'appli réelle) : un `app.setPath('userData',
...)` explicite, importé en tout premier dans `index.ts` - avant que `store.ts` ne résolve son
propre chemin par défaut - qui repointe vers le dossier historique `ark-server-manager` quoi
qu'il arrive. Confirmé par un vrai build complet (`npm run build`) et la suite de tests
(1358 tests, tous verts) après le rename. Conséquence concrète pour cet import tool : le
candidat `ark-server-manager` restera le bon pour toujours, pour toute installation passée ou
future - celui-ci peut donc être traité comme la réponse de confiance plutôt qu'une simple
hypothèse parmi deux, même si les deux restent vérifiés par prudence (une installation très
ancienne et jamais mise à jour depuis avant ce fix, ou une config electron-builder différente,
reste théoriquement possible).

**Étendu depuis** : profils ARK/Minecraft, bans, whitelist, watchlist (alertes Discord "joueur
connecté") et tokens d'accès web dashboard sont maintenant tous importés, chacun avec le même
principe "jamais écraser un id déjà présent". Les bans/whitelist ont une subtilité propre : ils
sont stockés par id de joueur avec un tableau `profileIds` (un id peut être banni sur plusieurs
serveurs réels à la fois), donc l'import boucle une fois par `profileId` legacy à travers les
vraies `recordPlayerBan()`/`recordWhitelistedPlayer()` - qui recalculent `bannedAt`/`addedAt` à
l'instant présent plutôt que de préserver l'horodatage historique du fichier legacy (comportement
réel de ces fonctions, pas un bug de l'import : elles sont conçues pour "cet id vient d'être
banni maintenant", pas pour une restauration d'archive). Les tokens d'accès importent le vrai
`secretHash` tel quel (pas de régénération) : un token qu'un utilisateur a déjà distribué continue
à authentifier contre la nouvelle appli sans rien reconfigurer. Testé de bout en bout (standalone
et via l'app compilée réelle), y compris l'idempotence sur les six types de données à la fois.

**Ce qu'il reste** : une copie best-effort de `customMaps.json` (dossier Documents) existe déjà ;
l'historique d'événements de mods et les clés API CurseForge/web dashboard restantes sont
mécaniquement identiques à porter - même mécanisme exactement, juste pas encore fait. Le bouton
natif de sélection manuelle n'a pas été testé avec un vrai clic humain (même gap que les autres
sélecteurs natifs de ce PoC, voir section suivante).

### 3. Le flux de mise à jour automatique n'est pas porté du tout

Le vrai code utilise `electron-updater` (`src/main/lib/appUpdater.ts`), spécifique à
Electron - rien de commun avec Tauri. Il faut :
- Adopter `tauri-plugin-updater` (le plugin officiel Tauri 2 pour l'auto-update).
- Héberger un manifeste de mise à jour (JSON signé) quelque part (GitHub Releases convient,
  Tauri sait le lire directement).
- Signer les mises à jour avec une clé dédiée à l'auto-update (différente de la signature de
  code Authenticode ci-dessous).
- Porter la UI qui affiche l'état ("checking"/"downloading"/"ready") - `AnalyticsTab.tsx` et la
  Settings screen en dépendent déjà côté affichage, mais la mécanique réelle derrière
  (`checkForUpdate()`) doit être réécrite, pas juste re-brillée.

### 4. Signature de code (bloquant pour une diffusion publique sur Windows)

Sans certificat Authenticode, l'installeur `.msi`/`.exe` déclenchera l'avertissement
SmartScreen "Windows a protégé votre PC" à chaque installation - acceptable pour des tests
internes, pas pour des utilisateurs grand public. Il faut :
- Un certificat de signature de code (OV ou EV - EV évite l'avertissement dès le premier
  téléchargement, OV demande une période de réputation).
- Intégrer la signature dans le pipeline de build (`tauri.conf.json`'s `bundle.windows.certificateThumbprint`
  ou signature externe post-build).

### 5. Les happy paths natifs jamais cliqués pour de vrai

Le PoC a prouvé l'architecture des dialogues natifs (le code compile, s'invoque, se comporte
correctement en cas d'échec) mais jamais le cas "l'utilisateur choisit réellement un
dossier/fichier" - ce sandbox headless ne peut pas fournir de clic humain sur un vrai sélecteur
de fichiers. Même chose pour `window.confirm()` : le mécanisme est maintenant prouvé correct
(voir le fix ci-dessus), mais chaque bouton `confirmAction()`-gated individuel (il y en a une
bonne douzaine à travers l'appli) n'a pas forcément été recliqué un par un. Peu de risque réel
vu que le bug était central et commun à tous, mais une passe de QA manuelle sur Windows reste
la bonne façon de clore ce point avant diffusion.

### 6. Jamais testé contre un vrai serveur ARK/Minecraft

Toute la logique de spawn/lifecycle/log-watching a été prouvée avec des scripts stand-in
(`server.installTestExecutable`, l'équivalent Minecraft) qui imitent fidèlement le
comportement réel (même ligne de "ready", même séquence SIGTERM) - mais jamais avec le vrai
binaire ARK: Survival Ascended (`.exe`, lancement spécifique Windows) ni un vrai serveur
Minecraft. Avant tout déploiement en remplacement d'Electron, il faut une vraie passe de
validation : lancer, arrêter, killer, crash-reconnect, RCON, SteamCMD update, sur de vrais
serveurs, sur une vraie machine Windows.

### 7. Pipeline de build CI

Rien n'existe aujourd'hui pour builder automatiquement : sidecar SEA (`build.mjs` +
`build-sea.mjs`), bot SEA (`build-bot.mjs` + `build-bot-sea.mjs`), bundle React
(`build-react.mjs` - mais ce script liste les pages une par une, à remplacer par le vrai build
Vite de `src/renderer` une fois l'App.tsx porté), puis `cargo tauri build` sur Windows/macOS/
Linux en matrice. Un pipeline GitHub Actions (ou équivalent) multi-OS est un prérequis pour
livrer des releases de façon fiable et reproductible, pas quelque chose à faire à la main à
chaque version.

### 8. Taille et temps de démarrage du binaire

Le `.deb` buildé pèse 93,65 Mio (deux runtimes Node embarqués : sidecar principal + bot
Discord en SEA). Pas mesuré : le temps de démarrage réel sur une machine Windows grand public
(disque plus lent qu'ici, antivirus qui scanne un nouvel exécutable au premier lancement -
scénario classique de lenteur au premier démarrage avec Windows Defender). À profiler avant de
promettre un temps de démarrage à l'utilisateur final.

## Phasage recommandé

1. ~~App shell + pont `window.api` unifié~~ **(section 1) - fait.** Le vrai `App.tsx` tourne,
   navigation confirmée via l'app compilée.
2. **Finir la migration de données** (section 2 - profils, bans, whitelist, watchlist et tokens
   sont déjà importés) - reste l'historique d'événements de mods et les clés API restantes, plus
   confirmer sur une vraie machine Windows quel nom de dossier (`name` vs `productName`, réglé
   pour tout build futur par `legacyUserDataCompat.ts` mais pas vérifié sur une install déjà
   existante) l'appli Electron réelle utilise effectivement.
3. **Audit module par module** des 39 fichiers `src/main/ipc/*.ts` contre les commandes
   `main.rs` existantes - combler les trous avant de considérer la surface "complète" (aucun
   trou connu à ce jour, mais pas formellement vérifié module par module).
4. **QA manuelle sur Windows** : vrais dialogues natifs, chaque bouton de confirmation, vrai
   serveur ARK/Minecraft si possible, et l'état minimize/maximize de la fenêtre (non vérifiable
   dans ce sandbox Xvfb headless, qui n'a pas de vrai gestionnaire de fenêtres).
5. **Auto-update** (`tauri-plugin-updater`) - nécessaire avant toute diffusion au-delà d'un
   cercle de testeurs, puisque sans lui il n'y a aucune façon de pousser le prochain correctif.
6. **Pipeline CI multi-OS**, en parallèle de 2-4 maintenant que l'App shell est stable.
7. **Signature de code Windows** - dernière étape avant diffusion publique, une fois le reste
   stabilisé (signer un binaire qui va encore beaucoup bouger n'apporte rien).

Ordre délibérément Windows-first comme demandé : macOS/Linux reprennent la même séquence une
fois ce chemin validé, avec leurs propres équivalents (notarization Apple au lieu
d'Authenticode, `.dmg`/`.AppImage` au lieu de `.msi`).

## Ce que ce plan ne couvre pas

Les gaps déjà listés dans le "What this doesn't prove yet" du README (identifiants API
tierces jamais configurés dans ce sandbox - CurseForge, Steam - , comportement réel de
`SteamCMD`, parité macOS) restent les mêmes gaps ici : ce ne sont pas des éléments de ce plan
de migration, ce sont des prérequis externes à obtenir (clé API, accès réseau de test, machine
macOS) indépendamment de l'avancement du code.
