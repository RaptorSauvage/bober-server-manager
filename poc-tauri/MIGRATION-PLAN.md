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
