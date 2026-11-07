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
- **Un vrai bug de freeze multi-minute trouvé et corrigé dans le code source réel** (voir README,
  "A real freeze bug, found only by a real user with real data") - `isValidArkInstall()`
  (`src/main/lib/detect.ts`) utilisait `fs.existsSync()` (bloquant) et tournait une fois par
  profil via `Promise.all` au chargement d'`App.tsx`. Avec 3 profils de sandbox ça ne se voyait
  jamais ; avec les 6-20+ vrais profils de l'utilisateur sur une vraie machine Windows, ça gelait
  tout le process (Node est mono-thread) plusieurs minutes, sur n'importe quelle page - jamais vu
  avant parce qu'aucun test précédent n'avait tourné avec autant de vrais profils. Corrigé dans
  le fichier réel (passage en `fs/promises.access()` async), pas contourné côté PoC - bénéficie
  donc à l'appli Electron réelle aussi, pas juste au portage. Les 1358 tests + `tsc --noEmit`
  restent verts après le fix.
- **Un vrai bug "serveur bloqué sur Starting" trouvé et corrigé, via le premier vrai démarrage
  de serveur de ce projet** (voir README, "A real server stuck on Starting") - une fois les
  vraies données importées, démarrer un vrai serveur ARK restait sur "Starting" les 5 minutes
  complètes avant de passer à "Running" (le filet de sécurité `STARTUP_FALLBACK_MS`, pas la
  vraie détection). La ligne de log attendue était bien présente dans le vrai `ShooterGame.log`
  - le vrai bug était dans `watchLogFileForMarker()` (`src/main/lib/serverProcess.ts`) : sa
  première lecture ne fait que fixer une référence de taille, sans jamais vérifier le contenu
  déjà présent (volontaire, pour ne pas re-détecter une ancienne ligne au réouverture de la
  Console d'un serveur déjà en marche) - donc si tout le log de démarrage (marqueur inclus)
  s'écrit avant le tout premier sondage, ce n'est jamais vu. Plus probable à travers ce portage
  qu'en Electron direct, à cause de l'aller-retour IPC supplémentaire avant que la surveillance
  ne démarre. Corrigé dans le fichier réel : vérifie maintenant aussi le contenu actuel
  immédiatement, mais seulement si la date de modification du fichier est postérieure au moment
  où ce démarrage précis a été demandé - ce qui distingue correctement "le marqueur de cette
  session" de "un marqueur périmé d'une session précédente". Un seul appelant
  (`doStartServer`), donc aucun risque pour les 5 autres usages de la fonction partagée
  sous-jacente. Les 1359 tests (dont un nouveau) + `tsc --noEmit` restent verts.
- **Le system tray est porté** (voir README, "The system tray - the one deliberately-out-of-scope
  piece that got ported after all") - jusque-là explicitement hors scope depuis le tout premier
  commit de ce PoC, ajouté une fois qu'un vrai utilisateur en QA production a remarqué son
  absence. Même forme que le vrai `createTray`/`buildTrayMenu`/`stopAllServers` (`src/main/
  index.ts`) : icône + tooltip, menu reconstruit toutes les 5s (ARK/Minecraft en cours, joueurs,
  CPU/RAM), "Ouvrir"/clic gauche, "Tout arrêter" (confirmation native `rfd` puisqu'aucune fenêtre
  n'est impliquée ici), "Quitter", et "close to tray" sur le bouton de fermeture de la fenêtre -
  via les mêmes endpoints sidecar que le reste de ce PoC utilise déjà (`profiles.list`,
  `server.status`, `server.stop`, leurs équivalents Minecraft, `settings.get`), aucun nouveau
  endpoint créé. Vérifié par `cargo build` natif + boot Xvfb (le tray lui-même ne peut pas
  s'enregistrer dans ce sandbox sans bus D-Bus, dégrade proprement sans planter l'appli) et par
  `cargo check --target x86_64-pc-windows-gnu`, qui recompile spécifiquement le backend Windows
  réel de `tray-icon` (`Shell_NotifyIcon`), pas seulement le backend Linux que le sandbox prouve
  déjà - reste un vrai test humain sur Windows à faire pour confirmer le rendu/comportement réel.

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

**Fait depuis** : l'audit complet de la surface `window.api`, pas module par module mais par
diff mécanique du vrai `src/preload/index.ts` contre `poc-tauri/frontend/lib/windowApi.ts` -
plus fiable qu'une relecture des 39 fichiers `src/main/ipc/*.ts` un par un, puisque le preload
*est* exactement l'union de tout ce que ces modules exposent réellement au renderer (un handler
jamais exposé via le preload ne peut de toute façon jamais être appelé par la vraie UI). Script
jetable (parcours des deux fichiers, comparaison des chemins `domaine.méthode`) : 181 méthodes
réelles, 2 trous trouvés, 1 faux positif (alias interne déjà documenté, sans équivalent réel).

Les deux vrais trous, chacun un cas de "jamais appelé par aucune des 36 pages de test isolées,
seulement par le vrai `App.tsx`/`Dashboard.tsx` monté pour de vrai" :
- `profiles.importFromInstall` - le bouton "+ Add Profile" du vrai Dashboard, chemin "importer
  depuis un dossier d'installation" (différent de `importFromFile`, l'import d'un `.json`
  exporté). Totalement absent à tous les étages (sidecar, `main.rs`, `windowApi.ts`) alors que
  l'équivalent Minecraft (`minecraft.profiles.importFromInstall`) existait déjà. Porté en
  réutilisant telles quelles les vraies `detectGameFromInstall()`/`detectProfileFields()`/
  `uniqueProfileName()` (`lib/detect.ts`), même construction d'objet `ServerProfile` complet que
  le vrai `ipc/profiles.ts`, pas une version simplifiée.
- `minecraft.backup.getScheduleStatus` - le pendant Minecraft de `backup.getScheduleStatus`
  (déjà porté côté ARK), pour le panneau Backup Status d'AnalyticsTab. Même pattern, réutilise
  la vraie `getMinecraftBackupScheduleStatus()`.

Vérifié : `cargo build` + `cargo check --target x86_64-pc-windows-gnu` propres, bundles sidecar/
frontend ré-générés sans erreur, re-exécution du script d'audit après le fix - 0 trou restant.

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

**Fait depuis** : l'historique d'événements de mods (`modEventHistory`) et les clés API web
dashboard/CurseForge restantes (`webDashboardApiKeys`) sont maintenant importés aussi, même
principe "jamais écraser un id déjà présent" que les six autres types de données. Un détail à
nommer plutôt qu'à ignorer : `recordModEventHistory()` n'a pas de notion d'upsert à elle (c'est
un journal purement additif, pas une collection indexée comme tout le reste) - la garantie
"jamais toucher un id déjà présent" est donc appliquée manuellement ici, en filtrant les ids déjà
connus avant d'appeler la fonction. Une vraie bizarrerie assumée plutôt que cachée : les entrées
importées atterrissent à la fin du journal borné (donc "plus récentes" que des entrées réellement
plus récentes déjà présentes) - sans conséquence sur une installation neuve jamais touchée (le
cas d'usage réel de cet import), un vrai défaut d'ordre si importé dans un store qui a déjà son
propre historique. Testé de bout en bout avec un faux `config.json` synthétique (1 clé API, 2
entrées d'historique) : preview, import, ré-import idempotent (tout skip la deuxième fois) -
confirmé via les vraies fonctions `store.ts`, pas une simulation.

**Ce qu'il reste** : une copie best-effort de `customMaps.json` (dossier Documents) existe déjà.
Le bouton natif de sélection manuelle n'a pas été testé avec un vrai clic humain (même gap que
les autres sélecteurs natifs de ce PoC, voir section suivante).

### 3. Le flux de mise à jour automatique

**Fait, pas juste planifié.** Le vrai code utilisait `electron-updater`
(`src/main/lib/appUpdater.ts`), spécifique à Electron - rien de commun avec Tauri, et de toute
façon un no-op dans ce PoC (`checkForUpdate()` est gated sur le vrai `app.isPackaged`, toujours
`false` via electronShim). Les rounds précédents routaient quand même les 4 commandes
`appUpdate.*` à travers le sidecar jusqu'à ce code réel-mais-inerte, uniquement pour prouver la
forme des 4 commandes IPC de bout en bout - ce round remplace ça par le vrai mécanisme :
`tauri-plugin-updater`, piloté entièrement depuis Rust (`main.rs`), sans passer par le sidecar
du tout (il n'y a rien côté Node à faire pour une vérification de mise à jour).

- `tauri-plugin-updater` adopté (`UpdaterExt::updater()`/`check()`/`download()`/`install()`),
  pas juste ajouté en dépendance - les 4 commandes `app_update_*` l'utilisent directement.
- `tauri.conf.json` configure `bundle.createUpdaterArtifacts: true` (produit les artefacts
  signés au build) et `plugins.updater.endpoints` pointant sur la convention GitHub Releases
  (`.../releases/latest/download/latest.json`, le format que `tauri-action`/`cargo tauri build
  --sign` produisent).
- Signature : une vraie paire de clés Ed25519 a été générée (`cargo tauri signer generate`) pour
  prouver le mécanisme de bout en bout - clé publique dans `tauri.conf.json`, clé privée
  **jamais committée** (gardée hors du repo). **Une vraie diffusion a besoin de sa propre paire
  fraîchement générée**, clé privée gardée en secret CI, jamais celle-ci.
- L'UI (`DataSettingsView.tsx`'s "Manager updates") n'a pas eu besoin d'être retouchée : même
  forme `AppUpdateStatus` (state/version/percent/error), même nom d'événement
  (`app-update-status-changed`), même logique "le bouton Installer n'apparaît qu'une fois
  `state === 'downloaded'`" déjà câblée par le round `app.html` plus haut dans ce document.
- `app_update_check` reproduit le choix déjà documenté du vrai `appUpdater.ts` : un `check()`
  télécharge automatiquement dès qu'une mise à jour est trouvée (un seul bouton couvre
  check-et-download), mais n'installe jamais automatiquement - `app_update_install` reste un
  appel explicite séparé, déclenché par ce bouton "Restart & install now" qui n'apparaît qu'une
  fois l'état "downloaded" atteint.
- `app_update_install`, une fois l'installation faite, appelle `AppHandle::request_restart()`
  (API `tauri` directe, aucun plugin `process` nécessaire) - ce qui déclenche le même
  `RunEvent::Exit` que le fix "processus pas coupés à la fermeture" plus haut dans ce document,
  donc un redémarrage pour appliquer une mise à jour nettoie proprement le sidecar/bot au passage,
  pas seulement une fermeture normale.

**Vérifié en conditions réelles, pas juste à la compilation** : `cargo build` et le cross-check
Windows compilent tous les deux proprement (y compris les chemins NSIS/MSI spécifiques Windows
de `tauri-plugin-updater`). Sous Xvfb, `v0.1.0` (la vraie version lue depuis `tauri.conf.json`,
pas une valeur statique) s'affiche en direct dans la barre de titre - confirme `app_update_get_
version` de bout en bout. Les DevTools ouvertes, un vrai `window.api.appUpdate.check()` lancé
depuis la console a produit la séquence d'événements réelle `{"state":"checking"}` puis (aucune
vraie release publiée à ce jour sur ce dépôt) `{"state":"error","error":"Could not fetch a valid
release JSON from the remote"}` - une vraie tentative réseau du plugin, un vrai échec géré
proprement, pas un crash ni un stub silencieux. `getStatus()` répond `{"state":"idle"}` comme
prévu en dehors de toute vérification en cours.

**Ce qu'il reste** : publier une vraie release (via le pipeline CI du point 7 ci-dessous, une
fois qu'il existe) pour vérifier le chemin "une mise à jour existe vraiment" - check trouve une
version, télécharge, le bouton Installer apparaît, installe, redémarre sur la nouvelle version.
Rien de ça n'est vérifiable sans une vraie release GitHub à pointer dessus.

**Chasse au faux bug "sidecar-bin.exe/bot-bin.exe jamais mis à jour" (v0.1.1 à v0.1.6) :** après
plusieurs updates réelles sur machine Windows, `sidecar-bin.exe`/`bot-bin.exe` semblaient garder
une date de modification "ancienne" alors que l'exe principal et `uninstall.exe` se mettaient à
jour à chaque fois - laissant penser qu'un processus verrouillé empêchait l'installeur de les
écraser. Plusieurs correctifs défensifs ont été ajoutés en retraçant la piste (tous gardés,
inoffensifs) : `shutdown_sidecar()` appelé explicitement avant `update.install()` (pas seulement
sur `RunEvent::Exit`), un backstop `taskkill /F /T` ciblé sur ces deux binaires, et
`wait_until_unlocked()` qui vérifie activement (retry jusqu'à 5s) que le fichier est ouvrable en
écriture exclusive avant de lancer l'installeur - plus un log de diagnostic
(`shutdown-debug.log`, à côté de l'exe) ajouté pour tracer chaque étape.

**Conclusion, confirmée en extrayant un installeur NSIS réel (`7z x`) et en comparant son contenu
embarqué** : il n'y a jamais eu de bug de verrouillage. L'installeur contient bien, à chaque
build, les binaires fraîchement compilés (contenu source confirmé dedans), et les écrase
correctement à chaque install - mais NSIS, par défaut, **préserve la date de modification
d'origine du fichier source** plutôt que de la tamponner à l'heure de l'installation. Chaque
nouveau build CI compile `sidecar-bin.exe`/`bot-bin.exe` à un instant légèrement antérieur à la
fin de compilation de l'exe principal (pipeline séquentiel : sidecar/bot d'abord, Rust ensuite),
donc leur date semblait "ancienne" par comparaison alors qu'elle correspondait en fait au build
en cours - un faux signal, pas un vrai problème. Un Explorateur de fichiers resté ouvert depuis
le début des tests (vue non rafraîchie) a aussi contribué à la confusion sur plusieurs rounds.

**Branding `rcedit` - abandonné (v0.1.7)** : le package npm `rcedit` n'a jamais eu de binaire CLI
- c'est une librairie JS pure (`import { rcedit } from 'rcedit'`). L'appel
`npx -y rcedit@latest <fichier> --set-version-string ...` échouait silencieusement à chaque build
depuis v0.1.3 ("could not determine executable to run"), sans jamais faire échouer le step CI ni
patcher quoi que ce soit - root cause confirmée en reproduisant localement (binaire PE factice
compilé avec mingw, testé via Wine). Le switch vers la vraie API programmatique a bien fonctionné
en local (`FileDescription`/`ProductName` atterrissent dans le binaire), **mais sur le vrai
runner `windows-latest` de CI, cet appel reste bloqué indéfiniment** (job resté coincé 1h+, sans
aucune sortie, forcé à être annulé manuellement) - cause non identifiée (peut-être lié au
wrapper interne `cross-spawn-windows-exe` du package). Vu que c'est purement cosmétique (juste le
libellé affiché dans le Gestionnaire des tâches), le code a été entièrement retiré plutôt que de
risquer de bloquer chaque future release. Pas de meilleure piste pour l'instant sans réécrire ça
en appelant directement un `rcedit.exe` vendu, en contournant le package npm entièrement.

**Bascule des utilisateurs Electron existants vers Tauri (décidé, pas encore implémenté) :**
`electron-updater` (le vrai `appUpdater.ts`) et `tauri-plugin-updater` sont deux mécanismes
totalement étanches - feeds différents (`latest.yml` vs `latest.json`), formats de signature
différents, et surtout les deux apps ont des identifiants différents (`appId` Electron vs
`com.bober.tauripoc`), donc Windows les traite comme deux applications distinctes. Sans rien
faire de spécial, un utilisateur Electron existant ne verrait jamais passer la release Tauri, et
installer celle-ci à côté laisserait les deux apps cohabiter plutôt que de remplacer l'ancienne.

Approche retenue : une dernière release Electron "pont" - au démarrage (ou au prochain check
d'update normal), elle détecte qu'une version Tauri existe, prévient l'utilisateur, télécharge
et lance l'installeur Tauri (`.msi`/`.exe`) à sa place. Pas un vrai auto-update `electron-updater`
au sens strict (le nouveau binaire n'est pas un fichier `latest.yml`-compatible), mais une
expérience équivalente côté utilisateur. Reste à écrire côté `src/main/lib/appUpdater.ts` (app
Electron), une fois le cycle de test/patch Tauri terminé et la version v7.0.0 prête à publier -
pas avant, puisque ça suppose une release Tauri stable et taguée vers laquelle pointer.

### 4. Signature de code (bloquant pour une diffusion publique sur Windows)

Sans certificat Authenticode, l'installeur `.msi`/`.exe` déclenchera l'avertissement
SmartScreen "Windows a protégé votre PC" à chaque installation - acceptable pour des tests
internes, pas pour des utilisateurs grand public. **Confirmé réel, pas juste théorique** : le
premier test sur une vraie machine Windows (voir README, "A real freeze bug..." et le freeze
"aléatoire" qui a suivi) a fait réagir Malwarebytes sur le binaire Rust fraîchement compilé en
mode debug (non signé) - heuristique de scan temps réel déclenchée par un exécutable inconnu qui
fait beaucoup de petits accès disque (sidecar Node, lecture/écriture de profils), ralentissant
l'appli de façon imprévisible jusqu'à ce que le dossier projet soit mis en exclusion. Pour une
diffusion publique, ce ne sera pas juste un avertissement SmartScreen à l'installation : un
binaire non signé peut continuer à se faire activement ralentir/mettre en quarantaine par
n'importe quel antivirus tiers chez l'utilisateur final, bien après l'installation. Il faut :
- Un certificat de signature de code (OV ou EV - EV évite l'avertissement dès le premier
  téléchargement, OV demande une période de réputation ; EV réduit aussi, sans l'éliminer,
  le risque de faux positif heuristique côté antivirus tiers).
- Intégrer la signature dans le pipeline de build (`tauri.conf.json`'s `bundle.windows.certificateThumbprint`
  ou signature externe post-build) - et signer un build `release` (optimisé), pas seulement le
  binaire `debug` utilisé pendant ce PoC.

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

**Mise à jour : cette vraie passe a eu lieu** (voir README, "Four more real findings..." et "The
Stop freeze, actually fixed this time") - un vrai serveur ARK importé via "Legacy data import",
démarré/arrêté/killé pour de vrai depuis le PoC compilé. A confirmé l'essentiel (spawn, détection
de démarrage une fois le bug async corrigé, RCON SaveWorld) mais a aussi révélé un vrai problème
d'architecture en deux temps : `SidecarHandle::call` dans `main.rs` est un appel bloquant avec
timeout fixe (5s par défaut) - correct pour la quasi-totalité des ~180 commandes, mais
Stop/Restart/Kill/Update (et leurs équivalents Minecraft) peuvent légitimement prendre de 30s à
plusieurs minutes. Un timeout plus généreux par commande (`call_with_timeout`) a d'abord semblé
suffire, mais a en fait révélé un second bug, plus sérieux : ce timeout bloquant tournait sur le
thread dont dépend la boucle d'événements de la fenêtre elle-même, donc le rallonger a transformé
une erreur rapide (5s) en un vrai gel de toute l'app (jusqu'à 90s), pas juste une carte. Corrigé
pour de vrai en rendant les 9 commandes lentes `async fn` avec un nouveau `call_async`
(`spawn_blocking` + `.await`, sans toucher aux ~170 autres) - vérifié empiriquement, pas juste à
la lecture du code : clic sur Stop puis clic immédiat (~110ms après, horodaté) sur le menu Tools,
qui s'est ouvert normalement pendant que la carte affichait encore "STOPPING".

Ceci dit, **rester sur un appel bloquant-mais-maintenant-async reste un correctif, pas la vraie
architecture.** La vraie bonne approche pour une appli livrée serait que ces commandes soient
réellement "fire-and-forget" côté Rust (la commande Tauri retourne immédiatement, la
progression/complétion arrive uniquement via l'événement `server-status` déjà poussé) plutôt
qu'un appel qui attend *un* timeout, aussi généreux et non-bloquant soit-il désormais - à faire
pour de vrai avant une diffusion publique.

### 7. Pipeline de build CI

**Fait, pas juste planifié** - `.github/workflows/release.yml`. Déclenché sur un tag `v*` (ou à
la main via `workflow_dispatch`), construit les mêmes étapes qu'un build local (`build.mjs` +
`build-sea.mjs` pour le sidecar, `build-bot.mjs` + `build-bot-sea.mjs` pour le bot,
`build-react.mjs` pour les bundles React - toujours la liste page par page, à remplacer par le
vrai build Vite de `src/renderer` une fois l'App.tsx porté, comme déjà noté), puis laisse la
vraie action officielle du projet Tauri (`tauri-apps/tauri-action`) lancer `cargo tauri build`,
signer les artefacts de mise à jour et publier une Release GitHub (en brouillon - relue avant
publication, pas publique instantanément) avec le `latest.json` que l'auto-update (section 3
plus haut) lit déjà.

**Matrice volontairement à deux OS, pas trois** : Linux + Windows, exactement ce que
`tauri.conf.json` configure déjà (`bundle.targets: ["deb", "msi", "nsis"]` - aucune cible macOS
dedans). macOS reste une étape ultérieure déjà identifiée dans le phasage ("Windows-first comme
demandé") plutôt qu'oublié - s'ajoute en deux endroits le jour venu : `"app"`/`"dmg"` dans
`bundle.targets`, et une entrée `macos-latest` dans la matrice du workflow.

**Gratuit de bout en bout** : ce dépôt est public, donc minutes GitHub Actions illimitées sur
tous les runners hébergés (Windows compris), aucun runner self-hosted ni palier payant. Seule la
vraie signature de code Windows (section 4 plus bas) coûte réellement quelque chose, et c'est
une étape entièrement séparée du pipeline CI lui-même.

**Vérifié en conditions réelles, pas juste la syntaxe YAML** : les 5 étapes de build (sidecar
bundle + SEA, bot bundle + SEA, bundles React) tournent avec succès depuis la racine du dépôt -
exactement comme le workflow les invoque, pas depuis `poc-tauri/sidecar/` comme pendant le
développement habituel de ce PoC. Un vrai `cargo tauri build` complet (profil release, pas juste
`cargo build`/`check`) avec la clé de signature jetable de ce PoC exportée en variables
d'environnement (`TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD`, la même convention que lit
`tauri-action`) a produit un vrai `.deb` de 96,70 Mio **et** sa signature de mise à jour
(`.sig`) à côté - confirme que `bundle.createUpdaterArtifacts: true` et le mécanisme de
signature fonctionnent vraiment ensemble, pas juste séparément. Ce que ça ne peut pas prouver
depuis ce sandbox Linux : le `cargo tauri build` complet tournant pour de vrai sur
`windows-latest` (seul `cargo check --target x86_64-pc-windows-gnu`, correction de code sans
lien final ni bundling MSI/NSIS réels, est vérifiable ici) - nécessite un vrai run du workflow.

**Ce qu'il reste avant la première vraie release** : générer une vraie paire de clés dédiée
(`cargo tauri signer generate`, PAS la clé jetable de ce PoC) et stocker sa moitié privée comme
secrets de dépôt GitHub (`TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`,
Settings > Secrets and variables > Actions), remplacer la clé publique jetable dans
`tauri.conf.json` par celle de cette vraie paire, puis pousser un premier tag `v*` pour de vrai.

### 8. Taille et temps de démarrage du binaire

Le `.deb` buildé pèse 93,65 Mio (deux runtimes Node embarqués : sidecar principal + bot
Discord en SEA). Pas mesuré : le temps de démarrage réel sur une machine Windows grand public
(disque plus lent qu'ici, antivirus qui scanne un nouvel exécutable au premier lancement -
scénario classique de lenteur au premier démarrage avec Windows Defender). À profiler avant de
promettre un temps de démarrage à l'utilisateur final.

## Phasage recommandé

1. ~~App shell + pont `window.api` unifié~~ **(section 1) - fait.** Le vrai `App.tsx` tourne,
   navigation confirmée via l'app compilée.
2. ~~Finir la migration de données~~ **(section 2) - fait.** Les sept types de données (profils,
   bans, whitelist, watchlist, tokens, clés API, historique d'événements de mods) sont tous
   importés. Reste seulement : confirmer sur une vraie machine Windows quel nom de dossier
   (`name` vs `productName`, réglé pour tout build futur par `legacyUserDataCompat.ts` mais pas
   vérifié sur une install déjà existante) l'appli Electron réelle utilise effectivement.
3. ~~Audit de la surface IPC~~ **(section 1, suite) - fait.** Diff mécanique du vrai preload
   contre `windowApi.ts` plutôt qu'une relecture des 39 fichiers `src/main/ipc/*.ts` un par un -
   2 trous trouvés et comblés (`profiles.importFromInstall`,
   `minecraft.backup.getScheduleStatus`), 0 restant.
4. ~~Auto-update~~ **(section 3) - fait.** `tauri-plugin-updater` branché pour de vrai, vérifié
   en conditions réelles (voir cette section) - nécessaire avant toute diffusion au-delà d'un
   cercle de testeurs, puisque sans lui il n'y avait aucune façon de pousser le prochain correctif.
5. **QA manuelle sur Windows** : vrais dialogues natifs, chaque bouton de confirmation, vrai
   serveur ARK/Minecraft si possible, l'état minimize/maximize de la fenêtre, et maintenant le
   chemin "une vraie mise à jour existe" de l'auto-update - rien de tout ça n'est vérifiable
   dans ce sandbox Xvfb headless, qui n'a ni vrai gestionnaire de fenêtres ni release GitHub
   publiée à pointer.
6. ~~Pipeline CI multi-OS~~ **(section 7) - fait.** `.github/workflows/release.yml`, gratuit
   (dépôt public), vérifié en conditions réelles (voir cette section). Reste seulement une vraie
   paire de clés updater et un premier tag `v*` poussé pour de vrai - ce qui déverrouille aussi
   la dernière étape de QA de l'auto-update au point 5 ci-dessus.
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
