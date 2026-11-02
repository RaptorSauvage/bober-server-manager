# Plan de migration : du PoC Tauri vers une vraie appli livrée (Windows en priorité)

Ce document part du principe que le PoC (`poc-tauri/`, voir `README.md` pour le détail de
chaque page portée) a répondu à la question qu'il posait : oui, l'architecture
Rust/Tauri + sidecar Node peut faire tourner tout le code métier réel de l'appli, sans
Electron. Ce que le PoC n'a jamais été, c'est l'appli elle-même. Ce document liste, honnêtement,
ce qu'il reste à faire pour passer de "36 pages prouvées une par une dans un harnais de test"
à "une seule appli livrable qui remplace Electron en production", avec Windows comme cible
prioritaire puisque c'est la plateforme de la majorité des utilisateurs de ce manager.

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

## Ce qui n'existe pas encore et qui est le vrai travail

### 1. L'appli elle-même, pas 37 pages de test séparées (le plus gros chantier)

Le PoC a une page HTML + un point d'entrée `.tsx` par composant réel testé, chacun avec sa
propre union partielle de `window.api` recopiée à la main. C'est volontaire pour un PoC
(isoler chaque page pour la tester une par une) mais ce n'est pas une architecture d'appli :
il n'y a ni vrai router, ni `App.tsx` (609 lignes dans le vrai code, avec sa navigation par
onglets groupés, sa gestion de rôles, ses Context providers), ni état partagé entre pages.

Travail réel : porter `App.tsx` lui-même (son vrai routing/layout, pas une des 37 pages qu'il
compose), avec un **unique** pont `window.api` complet remplaçant le vrai `src/preload/index.ts`
(377 lignes, `contextBridge.exposeInMainWorld`) par son équivalent Tauri
(`invoke`/`listen`) - pas une union ad hoc par page comme le PoC, mais la vraie surface
complète une bonne fois pour toutes. Les ~162 commandes Tauri déjà écrites dans `main.rs`
couvrent déjà la bonne partie de cette surface ; il s'agit surtout de les assembler
correctement dans un seul fichier de pont, plus les éventuelles commandes jamais exercées par
le PoC (certains des 39 modules `src/main/ipc/*.ts` n'ont peut-être pas tous leurs endpoints
couverts un par un - à auditer module par module contre `main.rs`).

### 2. Le flux de mise à jour automatique n'est pas porté du tout

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

### 3. Signature de code (bloquant pour une diffusion publique sur Windows)

Sans certificat Authenticode, l'installeur `.msi`/`.exe` déclenchera l'avertissement
SmartScreen "Windows a protégé votre PC" à chaque installation - acceptable pour des tests
internes, pas pour des utilisateurs grand public. Il faut :
- Un certificat de signature de code (OV ou EV - EV évite l'avertissement dès le premier
  téléchargement, OV demande une période de réputation).
- Intégrer la signature dans le pipeline de build (`tauri.conf.json`'s `bundle.windows.certificateThumbprint`
  ou signature externe post-build).

### 4. Les happy paths natifs jamais cliqués pour de vrai

Le PoC a prouvé l'architecture des dialogues natifs (le code compile, s'invoque, se comporte
correctement en cas d'échec) mais jamais le cas "l'utilisateur choisit réellement un
dossier/fichier" - ce sandbox headless ne peut pas fournir de clic humain sur un vrai sélecteur
de fichiers. Même chose pour `window.confirm()` : le mécanisme est maintenant prouvé correct
(voir le fix ci-dessus), mais chaque bouton `confirmAction()`-gated individuel (il y en a une
bonne douzaine à travers l'appli) n'a pas forcément été recliqué un par un. Peu de risque réel
vu que le bug était central et commun à tous, mais une passe de QA manuelle sur Windows reste
la bonne façon de clore ce point avant diffusion.

### 5. Jamais testé contre un vrai serveur ARK/Minecraft

Toute la logique de spawn/lifecycle/log-watching a été prouvée avec des scripts stand-in
(`server.installTestExecutable`, l'équivalent Minecraft) qui imitent fidèlement le
comportement réel (même ligne de "ready", même séquence SIGTERM) - mais jamais avec le vrai
binaire ARK: Survival Ascended (`.exe`, lancement spécifique Windows) ni un vrai serveur
Minecraft. Avant tout déploiement en remplacement d'Electron, il faut une vraie passe de
validation : lancer, arrêter, killer, crash-reconnect, RCON, SteamCMD update, sur de vrais
serveurs, sur une vraie machine Windows.

### 6. Pipeline de build CI

Rien n'existe aujourd'hui pour builder automatiquement : sidecar SEA (`build.mjs` +
`build-sea.mjs`), bot SEA (`build-bot.mjs` + `build-bot-sea.mjs`), bundle React
(`build-react.mjs` - mais ce script liste les pages une par une, à remplacer par le vrai build
Vite de `src/renderer` une fois l'App.tsx porté), puis `cargo tauri build` sur Windows/macOS/
Linux en matrice. Un pipeline GitHub Actions (ou équivalent) multi-OS est un prérequis pour
livrer des releases de façon fiable et reproductible, pas quelque chose à faire à la main à
chaque version.

### 7. Taille et temps de démarrage du binaire

Le `.deb` buildé pèse 93,65 Mio (deux runtimes Node embarqués : sidecar principal + bot
Discord en SEA). Pas mesuré : le temps de démarrage réel sur une machine Windows grand public
(disque plus lent qu'ici, antivirus qui scanne un nouvel exécutable au premier lancement -
scénario classique de lenteur au premier démarrage avec Windows Defender). À profiler avant de
promettre un temps de démarrage à l'utilisateur final.

## Phasage recommandé

1. **App shell + pont `window.api` unifié** (section 1) - le vrai bloqueur structurel, tout le
   reste en dépend pour devenir une appli plutôt qu'une collection de démos.
2. **Audit module par module** des 39 fichiers `src/main/ipc/*.ts` contre les commandes
   `main.rs` existantes - combler les trous avant de considérer la surface "complète".
3. **QA manuelle sur Windows** : vrais dialogues natifs, chaque bouton de confirmation, vrai
   serveur ARK/Minecraft si possible.
4. **Auto-update** (`tauri-plugin-updater`) - nécessaire avant toute diffusion au-delà d'un
   cercle de testeurs, puisque sans lui il n'y a aucune façon de pousser le prochain correctif.
5. **Pipeline CI multi-OS**, en parallèle de 3-4 une fois l'App shell stable.
6. **Signature de code Windows** - dernière étape avant diffusion publique, une fois le reste
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
