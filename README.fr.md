<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Un orchestrateur d'agents IA open-source pour le codage en parallèle entre projets.</strong></p>
  <p>Exécutez des sessions Claude Code, OpenCode et Codex en parallèle. Une seule fenêtre. Des branches isolées. Zéro chaos d'onglets.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md"><strong>Français</strong></a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Dernière version" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Téléchargements" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Statut du build" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licence" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs bienvenues" /></a>
  </p>
</div>

---

## Table des matières

- [Qu'est-ce que Hive ?](#quest-ce-que-hive-)
- [Fonctionnalités](#fonctionnalités)
- [Pourquoi Hive ?](#pourquoi-hive-)
- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Connexions — Le changement radical](#-connexions---le-changement-radical)
- [Captures d'écran](#captures-décran)
- [Communauté & Support](#communauté--support)
- [Feuille de route](#feuille-de-route)
- [Développement](#développement)
  - [Prérequis](#prérequis)
  - [Configuration](#configuration)
  - [Commandes](#commandes)
  - [Architecture](#architecture)
  - [Structure du projet](#structure-du-projet)
  - [Stack technique](#stack-technique)
  - [Documentation](#documentation)
- [Contribuer](#contribuer)
- [Licence](#licence)

## Qu'est-ce que Hive ?

Si vous exécutez plusieurs agents de codage IA sur différents projets et branches, vous connaissez la douleur — six onglets de terminal ouverts, vous ne vous souvenez plus quel agent travaille sur quoi, et vous craignez que deux d'entre eux modifient les mêmes fichiers.

Hive est un orchestrateur d'agents IA. Voyez tous vos agents en cours d'exécution dans une barre latérale, cliquez pour basculer entre eux, et chacun s'exécute sur une branche git worktree isolée pour éviter tout conflit. Connectez plusieurs dépôts ensemble pour qu'une seule session d'agent ait le contexte de toute votre stack.

## Fonctionnalités

### 🌳 **Workflow orienté Worktree**
Travaillez sur plusieurs branches simultanément sans stash ni changement de branche. Créez, archivez et organisez des worktrees en un clic. Chaque worktree reçoit un nom unique basé sur une ville pour une identification facile.

### 🤖 **Sessions de codage IA intégrées**
Exécutez des agents de codage IA directement dans Hive avec le support de **OpenCode**, **Claude Code** et **Codex**. Diffusez les réponses en temps réel, observez l'exécution des appels d'outils et approuvez les permissions si nécessaire. Le support complet annuler/rétablir vous garde en contrôle.

### 📁 **Explorateur de fichiers intelligent**
Voyez ce qui a changé d'un coup d'œil avec les indicateurs de statut git en direct. Affichez les diffs en ligne, parcourez l'historique des fichiers et naviguez dans votre code sans quitter l'application. L'éditeur Monaco intégré offre une expérience complète façon VS Code.

### 🔧 **Intégration Git complète**
Committez, poussez, tirez et gérez les branches visuellement. Pas besoin de terminal pour les opérations git courantes. Voyez les modifications en attente, les fichiers en staging et l'historique des commits, le tout au même endroit.

### 📦 **Espaces pour l'organisation**
Regroupez les projets et worktrees liés en espaces de travail logiques. Épinglez vos favoris pour un accès rapide. Gardez votre environnement de développement organisé à mesure que vous évoluez.

### ⚡ **Palette de commandes**
Naviguez et agissez rapidement avec les raccourcis clavier. Appuyez sur `Cmd+K` pour accéder instantanément à n'importe quelle fonctionnalité. Recherchez des sessions, changez de worktree ou exécutez des commandes sans toucher la souris.

### 🎨 **Thèmes magnifiques**
Choisissez parmi 10 thèmes soigneusement conçus — 6 sombres et 4 clairs. Changez instantanément selon votre préférence ou l'heure de la journée. Suit automatiquement le thème du système si désiré.

### 🖥️ **Language Server Protocol**
Intégration LSP complète avec des serveurs de langage par worktree. Profitez de la complétion intelligente, de la navigation vers la définition, des infobulles au survol et des diagnostics en temps réel pour TypeScript, Python, Go, Rust et bien plus.

### 🔌 **Connexions de Worktree**
Connectez deux worktrees pour partager le contexte, comparer les implémentations ou collaborer en temps réel. Parfait pour revoir les changements entre branches, partager des sessions IA entre worktrees ou maintenir la cohérence lors du travail sur des fonctionnalités liées. Voyez les mises à jour en direct lorsque les worktrees connectés changent.

## Pourquoi Hive ?

Découvrez comment Hive transforme votre workflow git :

| Tâche | Workflow traditionnel | Avec Hive |
|------|---------------------|-----------|
| **Changer de branche** | `git stash` → `git checkout` → `git stash pop` | Cliquez sur le worktree → Terminé |
| **Travailler sur plusieurs fonctionnalités** | Stash constant et changement de contexte | Ouvrez plusieurs worktrees côte à côte |
| **Créer un worktree** | `git worktree add ../project-feature origin/feature` | Cliquez « Nouveau Worktree » → Sélectionnez une branche |
| **Assistance IA pour coder** | Terminal + outil IA séparé + copier/coller | Sessions IA intégrées avec contexte complet |
| **Voir les modifications** | `git status` → `git diff file.ts` | Arborescence visuelle avec diffs en ligne |
| **Comparer des branches** | Multiples onglets de terminal, copier/coller | Connectez des worktrees pour partager le contexte |
| **Trouver un worktree** | `cd ~/projects/...` → se rappeler des noms de répertoires | Tous les worktrees dans une barre latérale |
| **Nettoyer les worktrees** | `git worktree remove` → `rm -rf directory` | Cliquez « Archiver » → Tout est géré |

## Installation

> 🍎 **macOS uniquement** — Support Windows et Linux à venir prochainement.

### Via Homebrew (recommandé)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Téléchargement direct

Téléchargez le dernier `.dmg` depuis [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

C'est tout ! Ouvrez Hive depuis votre dossier Applications et pointez-le vers un dépôt git.

## Démarrage rapide

Soyez opérationnel en moins de 2 minutes :

### 1️⃣ **Ajoutez votre premier projet**
Ouvrez Hive → Cliquez **« Add Project »** → Sélectionnez n'importe quel dépôt git sur votre machine

### 2️⃣ **Créez un Worktree**
Sélectionnez votre projet → Cliquez **« New Worktree »** → Choisissez une branche (ou créez-en une nouvelle)

### 3️⃣ **Commencez à coder avec l'IA**
Ouvrez un worktree → Cliquez **« New Session »** → Commencez à coder avec OpenCode, Claude, ou Codex

> 💡 **Astuce pro** : Appuyez sur `Cmd+K` à tout moment pour ouvrir la palette de commandes et naviguer rapidement !

📖 [Lire le guide complet](docs/GUIDE.md) | ⌨️ [Raccourcis clavier](docs/SHORTCUTS.md)

## 🔌 Connexions de Worktree — Le changement radical

La fonctionnalité **Connexions de Worktree** de Hive vous permet de lier deux worktrees ensemble, créant un pont entre différentes branches ou fonctionnalités. C'est incroyablement puissant pour les workflows de développement nécessitant une conscience inter-branches.

### Que sont les Connexions de Worktree ?

Connectez n'importe quelle paire de worktrees pour :
- **🔄 Partager le contexte** - Accédez aux fichiers et modifications d'une autre branche instantanément
- **🤝 Collaborer** - Travaillez sur des fonctionnalités liées avec des mises à jour en direct entre worktrees
- **📊 Comparer** - Voyez les différences entre implémentations côte à côte
- **🎯 Référencer** - Gardez votre branche principale visible pendant que vous travaillez sur des fonctionnalités
- **🔗 Lier des fonctionnalités** - Connectez les branches frontend et backend pour le développement full-stack
- **💬 Partager des sessions IA** - Continuez les conversations IA entre différents worktrees

### Comment ça marche

1. **Sélectionnez le Worktree source** - Choisissez le worktree dans lequel vous travaillez
2. **Connectez à la cible** - Cliquez sur l'icône de connexion et sélectionnez un autre worktree
3. **Lien bidirectionnel** - Les deux worktrees deviennent conscients l'un de l'autre
4. **Mises à jour en temps réel** - Voyez les changements dans les worktrees connectés en temps réel

### Fonctionnalités de connexion

- ✅ **Synchronisation en direct** - Les modifications de fichiers d'un worktree apparaissent dans le panneau de connexion
- ✅ **Changement rapide** - Basculez entre worktrees connectés en un clic
- ✅ **Vue des différences** - Comparez les fichiers entre worktrees connectés
- ✅ **Terminal partagé** - Exécutez des commandes affectant les deux worktrees
- ✅ **Contexte IA partagé** - Les sessions IA peuvent référencer le code du worktree connecté
- ✅ **Indicateurs de statut** - Voyez le statut du build, les tests et les changements dans les worktrees connectés
- ✅ **Historique des connexions** - Suivez quels worktrees étaient connectés et quand
- ✅ **Suggestions intelligentes** - Hive suggère des worktrees pertinents à connecter selon votre workflow

### Cas d'utilisation

**Développement de fonctionnalités** : Connectez votre branche de fonctionnalité à main pour assurer la compatibilité et voir comment vos changements s'intègrent.

**Correction de bugs** : Connectez le worktree de correction à la branche de production pour vérifier que la correction fonctionne en contexte.

**Revues de code** : Connectez les worktrees du relecteur et de l'auteur pour discuter des changements avec un contexte complet des deux côtés.

**Développement full-stack** : Connectez les worktrees frontend et backend pour travailler simultanément sur l'API et l'interface avec une coordination parfaite.

**Refactorisation** : Connectez l'ancienne et la nouvelle implémentation pour assurer la parité fonctionnelle lors de grands refactorings.

## Voir en action

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Démo Hive — orchestrez des agents IA entre projets" width="900" />
</div>

<details>
<summary><strong>Plus de captures d'écran</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — session de codage IA avec git worktrees" width="900" />
  <sub>Sessions de codage propulsées par l'IA avec gestion intégrée des git worktrees</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Création d'un nouveau worktree" width="900" />
  <sub>Créez et gérez les worktrees visuellement</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Arborescence de fichiers avec statut git" width="900" />
  <sub>Explorateur de fichiers avec indicateurs de statut git en direct</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Présentation des thèmes" width="900" />
  <sub>De beaux thèmes pour toutes les préférences</sub>
</div>

</details>

## Communauté & Support

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Documentation-Lire-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Signaler-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Discussions-Rejoindre-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contribuer](https://img.shields.io/badge/🤝_Contribuer-Directives-green?style=for-the-badge)](CONTRIBUTING.md)
[![Sécurité](https://img.shields.io/badge/🔒_Sécurité-Politique-orange?style=for-the-badge)](SECURITY.md)

</div>

### Obtenir de l'aide

- 📖 Lisez la [documentation](docs/) pour des guides détaillés
- 🐛 [Signalez des bugs](https://github.com/morapelker/hive/issues/new?template=bug_report.md) avec des étapes de reproduction
- 💡 [Demandez des fonctionnalités](https://github.com/morapelker/hive/issues/new?template=feature_request.md) que vous aimeriez voir
- 💬 [Rejoignez les discussions](https://github.com/morapelker/hive/discussions) pour vous connecter à la communauté
- 🔒 [Signalez des vulnérabilités de sécurité](SECURITY.md) de manière responsable

### Ressources

- [Guide utilisateur](docs/GUIDE.md) — Démarrage et tutoriels
- [FAQ](docs/FAQ.md) — Questions fréquentes et dépannage
- [Raccourcis clavier](docs/SHORTCUTS.md) — Référence complète des raccourcis

## Feuille de route

### 🚀 Bientôt disponible

- **Support multi-plateforme** — Builds Windows et Linux
- **Système de plugins** — Étendez Hive avec des intégrations personnalisées
- **Synchronisation cloud** — Synchronisez paramètres, sessions et modèles de connexion entre appareils
- **Fonctionnalités d'équipe** — Partagez des worktrees et collaborez en temps réel
- **Visualisation du graphe Git** — Historique visuel des branches et merges
- **Profilage de performance** — Outils intégrés pour l'optimisation

### 🎯 Vision future

- **Développement distant** — Développement basé sur SSH et conteneurs
- **Connexions trilatérales** — Connectez et fusionnez plusieurs branches visuellement
- **Intégration CI/CD** — Surveillance GitHub Actions, GitLab CI, Jenkins
- **Automatisation des connexions** — Auto-connexion de branches liées basée sur des patterns
- **Mode revue de code** — Type de connexion spécial optimisé pour les revues
- **Suivi du temps** — Analytique d'activité par worktree et par connexion

Vous voulez influencer la feuille de route ? [Rejoignez la discussion](https://github.com/morapelker/hive/discussions/categories/ideas) ou [contribuez](CONTRIBUTING.md) !

---

<details>
<summary><strong>Développement</strong></summary>

### Prérequis

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (support worktree)

### Configuration

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminal Ghostty (optionnel)

Hive inclut un terminal natif optionnel propulsé par `libghostty` de [Ghostty](https://ghostty.org/). Nécessaire uniquement si vous souhaitez travailler sur la fonctionnalité de terminal intégré.

**Configuration :**

1. Compilez `libghostty` depuis le code source de Ghostty ([instructions de compilation](https://ghostty.org/docs/install/build)) :
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Cela produit `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Si votre dépôt Ghostty est dans `~/Documents/dev/ghostty/`, le build le trouvera automatiquement. Sinon, configurez le chemin :
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Recompilez l'addon natif :
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Si `libghostty` n'est pas disponible, Hive compile et fonctionne quand même — la fonctionnalité de terminal Ghostty sera simplement désactivée.

### Commandes

| Commande           | Description           |
| ----------------- | --------------------- |
| `pnpm dev`        | Démarrage avec hot reload |
| `pnpm build`      | Build de production      |
| `pnpm lint`       | Vérification ESLint          |
| `pnpm lint:fix`   | Auto-correction ESLint       |
| `pnpm format`     | Formatage Prettier       |
| `pnpm test`       | Exécuter tous les tests         |
| `pnpm test:watch` | Mode surveillance            |
| `pnpm test:e2e`   | Tests E2E Playwright  |
| `pnpm build:mac`  | Packaging pour macOS     |

### Architecture

Hive utilise le modèle à trois processus d'Electron avec un sandboxing strict :

```
┌─────────────────────────────────────────────────────┐
│                  Processus principal                  │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (Sessions IA)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Gestionnaires │                       │
│              │     IPC       │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ IPC typé
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │    (Pont)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ APIs window.*
┌──────────────────────┼──────────────────────────────┐
│                Processus de rendu                    │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Composants      │   │
│  │ Stores    │ │ ui       │ │  (14 domaines)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Structure du projet

```
src/
├── main/                  # Processus principal Electron (Node.js)
│   ├── db/                # Base de données SQLite + schéma + migrations
│   ├── ipc/               # Modules de gestionnaires IPC
│   └── services/          # Git, AI agents, logger, services de fichiers
├── preload/               # Couche pont (APIs window.* typées)
└── renderer/src/          # React SPA
    ├── components/        # UI organisée par domaine
    ├── hooks/             # Hooks React personnalisés
    ├── lib/               # Utilitaires, thèmes, helpers
    └── stores/            # Gestion d'état Zustand
```

### Stack technique

| Couche     | Technologie                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Langage  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styles   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| État     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Base de données  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (mode WAL)          |
| IA        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentation

La documentation détaillée est dans [`docs/`](docs/) :

- **[PRDs](docs/prd/)** -- Exigences produit
- **[Implémentation](docs/implementation/)** -- Guides techniques
- **[Spécifications](docs/specs/)** -- Spécifications des fonctionnalités
- **[Plans](docs/plans/)** -- Plans d'implémentation actifs

</details>

## Contribuer

Nous adorons les contributions ! Hive est fait par des développeurs, pour des développeurs, et nous accueillons toutes sortes d'améliorations.

### Façons de contribuer

- 🐛 **Signaler des bugs** avec des étapes de reproduction claires
- 💡 **Suggérer des fonctionnalités** qui amélioreraient votre workflow
- 📝 **Améliorer la documentation** pour aider les autres à démarrer
- 🎨 **Soumettre des améliorations UI/UX** pour une meilleure ergonomie
- 🔧 **Corriger des bugs** depuis notre suivi d'issues
- ⚡ **Optimiser les performances** dans les chemins critiques
- 🧪 **Ajouter des tests** pour améliorer la couverture
- 🌐 **Traduire** l'application dans votre langue

Avant de contribuer, veuillez lire nos [Directives de contribution](CONTRIBUTING.md) et notre [Code de conduite](CODE_OF_CONDUCT.md).

### Guide rapide de contribution

1. Forkez le dépôt
2. Créez une branche de fonctionnalité (`git checkout -b feature/amazing-feature`)
3. Effectuez vos modifications
4. Exécutez les tests (`pnpm test`) et le linting (`pnpm lint`)
5. Committez avec un message descriptif
6. Poussez vers votre fork
7. Ouvrez une Pull Request

Consultez [CONTRIBUTING.md](CONTRIBUTING.md) pour des directives détaillées.

## Licence

[MIT](LICENSE) © 2024 morapelker

Hive est un logiciel open source sous licence MIT. Consultez le fichier [LICENSE](LICENSE) pour tous les détails.
