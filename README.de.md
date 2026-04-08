<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Ein Open-Source KI-Agent-Orchestrator für paralleles Programmieren über Projekte hinweg.</strong></p>
  <p>Führe Claude Code, OpenCode und Codex Sessions parallel aus. Ein Fenster. Isolierte Branches. Kein Tab-Chaos.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md"><strong>Deutsch</strong></a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Neueste Version" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build-Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Lizenz" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs willkommen" /></a>
  </p>
</div>

---

## Inhaltsverzeichnis

- [Installation](#installation)
- [Was ist Hive?](#was-ist-hive)
- [Funktionen](#funktionen)
- [Warum Hive?](#warum-hive)
- [Schnellstart](#schnellstart)
- [Verbindungen — Der Gamechanger](#-verbindungen---der-gamechanger)
- [Screenshots](#screenshots)
- [Community & Support](#community--support)
- [Roadmap](#roadmap)
- [Entwicklung](#entwicklung)
  - [Voraussetzungen](#voraussetzungen)
  - [Einrichtung](#einrichtung)
  - [Befehle](#befehle)
  - [Architektur](#architektur)
  - [Projektstruktur](#projektstruktur)
  - [Technologie-Stack](#technologie-stack)
  - [Dokumentation](#dokumentation)
- [Mitwirken](#mitwirken)
- [Lizenz](#lizenz)

## Installation

> 🍎 **Nur macOS** — Windows- und Linux-Support kommt bald.

### Über Homebrew (empfohlen)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Direkter Download

Lade die neueste `.dmg` von [GitHub Releases](https://github.com/morapelker/hive/releases/latest) herunter.

Das war's! Öffne Hive aus deinem Programme-Ordner und richte es auf ein Git-Repository.

## Was ist Hive?

Wenn du mehrere KI-Coding-Agenten über verschiedene Projekte und Branches hinweg ausführst, kennst du den Schmerz — sechs Terminal-Tabs offen, du erinnerst dich nicht mehr, welcher Agent woran arbeitet, und du machst dir Sorgen, dass zwei davon dieselben Dateien bearbeiten.

Hive ist ein KI-Agent-Orchestrator. Sieh alle laufenden Agenten in einer Seitenleiste, klicke zum Wechseln zwischen ihnen, und jeder läuft auf einem isolierten Git-Worktree-Branch, sodass sie nicht in Konflikt geraten können. Verbinde mehrere Repositories miteinander, damit eine einzelne Agenten-Session Kontext über deinen gesamten Stack hat.

## Funktionen

### 🌳 **Worktree-First Workflow**
Arbeite gleichzeitig an mehreren Branches ohne Stashing oder Wechseln. Erstelle, archiviere und organisiere Worktrees mit einem Klick. Jeder Worktree erhält einen einzigartigen stadtbasierten Namen zur leichten Identifikation.

### 🤖 **Integrierte KI-Coding-Sessions**
Führe KI-Coding-Agenten direkt in Hive aus mit **OpenCode**, **Claude Code** und **Codex** Unterstützung. Streame Antworten in Echtzeit, beobachte Tool-Aufrufe und genehmige Berechtigungen nach Bedarf. Vollständige Rückgängig/Wiederherstellen-Unterstützung behält die Kontrolle.

### 📁 **Intelligenter Datei-Explorer**
Sieh auf einen Blick, was sich geändert hat, mit Live-Git-Status-Indikatoren. Zeige Diffs inline an, durchsuche die Datei-Historie und navigiere durch deine Codebasis, ohne die App zu verlassen. Der integrierte Monaco-Editor bietet ein vollständiges VS Code Erlebnis.

### 🔧 **Vollständige Git-Integration**
Committe, pushe, pulle und verwalte Branches visuell. Kein Terminal nötig für gängige Git-Operationen. Sieh ausstehende Änderungen, gestagete Dateien und Commit-Historie an einem Ort.

### 📦 **Spaces zur Organisation**
Gruppiere verwandte Projekte und Worktrees in logische Arbeitsbereiche. Pinne deine Favoriten für schnellen Zugriff. Halte deine Entwicklungsumgebung organisiert, während du skalierst.

### ⚡ **Befehlspalette**
Navigiere und handle schnell mit Tastenkombinationen. Drücke `Cmd+K` um sofort auf jede Funktion zuzugreifen. Suche Sessions, wechsle Worktrees oder führe Befehle aus, ohne die Maus zu berühren.

### 🎨 **Wunderschöne Themes**
Wähle aus 10 sorgfältig gestalteten Themes — 6 dunkle und 4 helle. Wechsle sofort je nach Vorliebe oder Tageszeit. Folgt automatisch dem System-Theme, wenn gewünscht.

### 🔌 **Worktree-Verbindungen**
Verbinde zwei Worktrees, um Kontext zu teilen, Implementierungen zu vergleichen oder in Echtzeit zusammenzuarbeiten. Perfekt für das Überprüfen von Änderungen zwischen Branches, das Teilen von KI-Sessions über Worktrees oder das Wahren der Konsistenz bei verwandten Features. Sieh Live-Updates, wenn verbundene Worktrees sich ändern.

## Warum Hive?

Sieh, wie Hive deinen Git-Workflow transformiert:

| Aufgabe | Traditioneller Workflow | Mit Hive |
|------|---------------------|-----------|
| **Branch wechseln** | `git stash` → `git checkout` → `git stash pop` | Klick auf Worktree → Fertig |
| **An mehreren Features arbeiten** | Ständiges Stashing und Kontextwechsel | Mehrere Worktrees nebeneinander öffnen |
| **Worktree erstellen** | `git worktree add ../project-feature origin/feature` | Klick „Neuer Worktree" → Branch wählen |
| **KI-Coding-Hilfe** | Terminal + separates KI-Tool + Kopieren/Einfügen | Integrierte KI-Sessions mit vollem Kontext |
| **Dateiänderungen anzeigen** | `git status` → `git diff file.ts` | Visueller Baum mit Inline-Diffs |
| **Branches vergleichen** | Mehrere Terminal-Tabs, Kopieren/Einfügen | Worktrees verbinden um Kontext zu teilen |
| **Worktree finden** | `cd ~/projects/...` → Verzeichnisnamen merken | Alle Worktrees in einer Seitenleiste |
| **Worktrees aufräumen** | `git worktree remove` → `rm -rf directory` | Klick „Archivieren" → Erledigt alles |

## Schnellstart

In unter 2 Minuten startklar:

### 1️⃣ **Füge dein erstes Projekt hinzu**
Öffne Hive → Klicke **„Add Project"** → Wähle ein beliebiges Git-Repository auf deinem Rechner

### 2️⃣ **Erstelle einen Worktree**
Wähle dein Projekt → Klicke **„New Worktree"** → Wähle einen Branch (oder erstelle einen neuen)

### 3️⃣ **Beginne mit KI zu coden**
Öffne einen Worktree → Klicke **„New Session"** → Beginne mit OpenCode, Claude, oder Codex zu coden

> 💡 **Profi-Tipp**: Drücke jederzeit `Cmd+K` um die Befehlspalette zu öffnen und schnell zu navigieren!

📖 [Vollständigen Guide lesen](docs/GUIDE.md) | ⌨️ [Tastenkombinationen](docs/SHORTCUTS.md)

## 🔌 Worktree-Verbindungen — Der Gamechanger

Hives **Worktree-Verbindungen**-Funktion ermöglicht es dir, zwei Worktrees miteinander zu verknüpfen und eine Brücke zwischen verschiedenen Branches oder Features zu schaffen. Das ist unglaublich mächtig für Entwicklungs-Workflows, die Branch-übergreifendes Bewusstsein erfordern.

### Was sind Worktree-Verbindungen?

Verbinde beliebige zwei Worktrees um:
- **🔄 Kontext teilen** - Greife sofort auf Dateien und Änderungen eines anderen Branches zu
- **🤝 Zusammenarbeiten** - Arbeite an verwandten Features mit Live-Updates zwischen Worktrees
- **📊 Vergleichen** - Sieh Unterschiede zwischen Implementierungen nebeneinander
- **🎯 Referenzieren** - Behalte deinen Haupt-Branch sichtbar während du an Features arbeitest
- **🔗 Features verknüpfen** - Verbinde Frontend- und Backend-Branches für Full-Stack-Entwicklung
- **💬 KI-Sessions teilen** - Führe KI-Gespräche über verschiedene Worktrees fort

### Wie es funktioniert

1. **Wähle den Quell-Worktree** - Wähle den Worktree, in dem du arbeitest
2. **Mit Ziel verbinden** - Klicke auf das Verbindungssymbol und wähle einen anderen Worktree
3. **Bidirektionale Verknüpfung** - Beide Worktrees werden sich gegenseitig bewusst
4. **Echtzeit-Updates** - Sieh Änderungen in verbundenen Worktrees, sobald sie passieren

### Verbindungs-Funktionen

- ✅ **Live-Synchronisation** - Dateiänderungen in einem Worktree erscheinen im Verbindungspanel
- ✅ **Schnelles Wechseln** - Spring mit einem Klick zwischen verbundenen Worktrees
- ✅ **Diff-Ansicht** - Vergleiche Dateien zwischen verbundenen Worktrees
- ✅ **Geteiltes Terminal** - Führe Befehle aus, die beide Worktrees betreffen
- ✅ **Geteilter KI-Kontext** - KI-Sessions können auf den Code des verbundenen Worktrees verweisen
- ✅ **Status-Indikatoren** - Sieh Build-Status, Tests und Änderungen in verbundenen Worktrees
- ✅ **Verbindungshistorie** - Verfolge, welche Worktrees wann verbunden waren
- ✅ **Intelligente Vorschläge** - Hive schlägt relevante Worktrees zum Verbinden basierend auf deinem Workflow vor

### Anwendungsfälle

**Feature-Entwicklung**: Verbinde deinen Feature-Branch mit main, um Kompatibilität sicherzustellen und zu sehen, wie sich deine Änderungen integrieren.

**Bugfixes**: Verbinde den Bugfix-Worktree mit dem Produktions-Branch, um zu verifizieren, dass der Fix im Kontext funktioniert.

**Code Reviews**: Verbinde Reviewer- und Autor-Worktrees, um Änderungen mit vollem Kontext auf beiden Seiten zu besprechen.

**Full-Stack-Entwicklung**: Verbinde Frontend- und Backend-Worktrees, um gleichzeitig an API und UI mit perfekter Koordination zu arbeiten.

**Refactoring**: Verbinde alte und neue Implementierungen, um Feature-Parität bei großen Refactorings sicherzustellen.

## In Aktion sehen

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive Demo — KI-Agenten über Projekte orchestrieren" width="900" />
</div>

<details>
<summary><strong>Weitere Screenshots</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — KI-Coding-Session mit Git Worktrees" width="900" />
  <sub>KI-gestützte Coding-Sessions mit integriertem Git-Worktree-Management</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Neuen Worktree erstellen" width="900" />
  <sub>Worktrees visuell erstellen und verwalten</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Dateibaum mit Git-Status" width="900" />
  <sub>Datei-Explorer mit Live-Git-Status-Indikatoren</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Theme-Showcase" width="900" />
  <sub>Wunderschöne Themes für jeden Geschmack</sub>
</div>

</details>

## Community & Support

<div align="center">

[![Dokumentation](https://img.shields.io/badge/📖_Dokumentation-Lesen-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Melden-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Diskussionen](https://img.shields.io/badge/💬_Diskussionen-Beitreten-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Mitwirken](https://img.shields.io/badge/🤝_Mitwirken-Richtlinien-green?style=for-the-badge)](CONTRIBUTING.md)
[![Sicherheit](https://img.shields.io/badge/🔒_Sicherheit-Richtlinie-orange?style=for-the-badge)](SECURITY.md)

</div>

### Hilfe erhalten

- 📖 Lies die [Dokumentation](docs/) für detaillierte Anleitungen
- 🐛 [Melde Bugs](https://github.com/morapelker/hive/issues/new?template=bug_report.md) mit Reproduktionsschritten
- 💡 [Schlage Features vor](https://github.com/morapelker/hive/issues/new?template=feature_request.md), die du dir wünschst
- 💬 [Tritt den Diskussionen bei](https://github.com/morapelker/hive/discussions) um dich mit der Community zu verbinden
- 🔒 [Melde Sicherheitslücken](SECURITY.md) verantwortungsvoll

### Ressourcen

- [Benutzerhandbuch](docs/GUIDE.md) — Erste Schritte und Tutorials
- [FAQ](docs/FAQ.md) — Häufige Fragen und Fehlerbehebung
- [Tastenkombinationen](docs/SHORTCUTS.md) — Vollständige Kurzbefehl-Referenz

## Roadmap

### 🚀 Demnächst

- **Plattformübergreifende Unterstützung** — Windows- und Linux-Builds
- **Plugin-System** — Erweitere Hive mit eigenen Integrationen
- **Cloud-Synchronisation** — Synchronisiere Einstellungen, Sessions und Verbindungsvorlagen über Geräte
- **Team-Funktionen** — Teile Worktrees und arbeite in Echtzeit zusammen
- **Git-Graph-Visualisierung** — Visuelle Branch-Historie und Merges
- **Performance-Profiling** — Eingebaute Tools zur Optimierung

### 🎯 Zukunftsvision

- **Remote-Entwicklung** — SSH- und Container-basierte Entwicklung
- **Dreiwege-Verbindungen** — Mehrere Branches visuell verbinden und mergen
- **CI/CD-Integration** — GitHub Actions, GitLab CI, Jenkins Monitoring
- **Verbindungsautomatisierung** — Verwandte Branches automatisch basierend auf Mustern verbinden
- **Code-Review-Modus** — Spezieller Verbindungstyp optimiert für Reviews
- **Zeiterfassung** — Pro-Worktree und Pro-Verbindung Aktivitätsanalysen

Willst du die Roadmap beeinflussen? [Tritt der Diskussion bei](https://github.com/morapelker/hive/discussions/categories/ideas) oder [wirke mit](CONTRIBUTING.md)!

---

<details>
<summary><strong>Entwicklung</strong></summary>

### Voraussetzungen

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (Worktree-Unterstützung)

### Einrichtung

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (optional)

Hive enthält ein optionales natives Terminal, das auf [Ghostty](https://ghostty.org/)s `libghostty` basiert. Dies wird nur benötigt, wenn du an der eingebetteten Terminal-Funktion arbeiten möchtest.

**Einrichtung:**

1. Baue `libghostty` aus dem Ghostty-Quellcode ([Build-Anleitung](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Dies erzeugt `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Wenn dein Ghostty-Repo unter `~/Documents/dev/ghostty/` liegt, findet der Build es automatisch. Andernfalls setze den Pfad:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Baue das native Addon neu:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Wenn `libghostty` nicht verfügbar ist, baut und läuft Hive trotzdem — die Ghostty-Terminal-Funktion ist dann einfach deaktiviert.

### Befehle

| Befehl           | Beschreibung           |
| ----------------- | --------------------- |
| `pnpm dev`        | Start mit Hot Reload |
| `pnpm build`      | Produktions-Build      |
| `pnpm lint`       | ESLint-Prüfung          |
| `pnpm lint:fix`   | ESLint Auto-Fix       |
| `pnpm format`     | Prettier-Formatierung       |
| `pnpm test`       | Alle Tests ausführen         |
| `pnpm test:watch` | Watch-Modus            |
| `pnpm test:e2e`   | Playwright E2E-Tests  |
| `pnpm build:mac`  | Paket für macOS     |

### Architektur

Hive verwendet Electrons Drei-Prozesse-Modell mit striktem Sandboxing:

```
┌─────────────────────────────────────────────────────┐
│                    Hauptprozess                       │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (KI-Sessions)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPC-Handler  │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Typisiertes IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Brücke)    │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* APIs
┌──────────────────────┼──────────────────────────────┐
│                 Renderer-Prozess                     │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Komponenten     │   │
│  │ Stores    │ │ ui       │ │  (14 Domänen)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Projektstruktur

```
src/
├── main/                  # Electron Hauptprozess (Node.js)
│   ├── db/                # SQLite-Datenbank + Schema + Migrationen
│   ├── ipc/               # IPC-Handler-Module
│   └── services/          # Git, AI agents, Logger, Dateidienste
├── preload/               # Brücken-Schicht (typisierte window.* APIs)
└── renderer/src/          # React SPA
    ├── components/        # UI nach Domänen organisiert
    ├── hooks/             # Eigene React Hooks
    ├── lib/               # Werkzeuge, Themes, Helfer
    └── stores/            # Zustand Zustandsverwaltung
```

### Technologie-Stack

| Schicht     | Technologie                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Sprache  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Zustand     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Datenbank  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL-Modus)          |
| KI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Dokumentation

Detaillierte Dokumentation befindet sich in [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Produktanforderungen
- **[Implementierung](docs/implementation/)** -- Technische Leitfäden
- **[Spezifikationen](docs/specs/)** -- Feature-Spezifikationen
- **[Pläne](docs/plans/)** -- Aktive Implementierungspläne

</details>

## Mitwirken

Wir freuen uns über Beiträge! Hive wird von Entwicklern für Entwickler gebaut, und wir begrüßen Verbesserungen jeder Art.

### Möglichkeiten mitzuwirken

- 🐛 **Bugs melden** mit klaren Reproduktionsschritten
- 💡 **Features vorschlagen**, die deinen Workflow verbessern
- 📝 **Dokumentation verbessern**, um anderen den Einstieg zu erleichtern
- 🎨 **UI/UX-Verbesserungen einreichen** für bessere Benutzerfreundlichkeit
- 🔧 **Bugs beheben** aus unserem Issue-Tracker
- ⚡ **Performance optimieren** in kritischen Pfaden
- 🧪 **Tests hinzufügen** um die Abdeckung zu verbessern
- 🌐 **Übersetzen** der App in deine Sprache

Bitte lies vor dem Mitwirken unsere [Richtlinien zum Mitwirken](CONTRIBUTING.md) und den [Verhaltenskodex](CODE_OF_CONDUCT.md).

### Kurzanleitung zum Mitwirken

1. Forke das Repository
2. Erstelle einen Feature-Branch (`git checkout -b feature/amazing-feature`)
3. Nimm deine Änderungen vor
4. Führe Tests (`pnpm test`) und Linting (`pnpm lint`) aus
5. Committe mit einer aussagekräftigen Nachricht
6. Pushe zu deinem Fork
7. Öffne einen Pull Request

Siehe [CONTRIBUTING.md](CONTRIBUTING.md) für detaillierte Richtlinien.

## Lizenz

[MIT](LICENSE) © 2024 morapelker

Hive ist Open-Source-Software lizenziert unter der MIT-Lizenz. Siehe die [LICENSE](LICENSE) Datei für vollständige Details.
