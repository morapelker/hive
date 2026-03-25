<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>En open source AI-agent orkestrator til parallel kodning på tværs af projekter.</strong></p>
  <p>Kør Claude Code, OpenCode og Codex sessioner parallelt. Ét vindue. Isolerede branches. Nul tab-kaos.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md"><strong>Dansk</strong></a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Latest Release" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
  </p>
</div>

---

## Indholdsfortegnelse

- [Hvad er Hive?](#hvad-er-hive)
- [Funktioner](#funktioner)
- [Hvorfor Hive?](#hvorfor-hive)
- [Installation](#installation)
- [Hurtig start](#hurtig-start)
- [Forbindelser - Den store game changer](#-forbindelser---den-store-game-changer)
- [Skærmbilleder](#skærmbilleder)
- [Fællesskab & Support](#fællesskab--support)
- [Køreplan](#køreplan)
- [Udvikling](#udvikling)
- [Bidrag](#bidrag)
- [Licens](#licens)

## Hvad er Hive?

Hvis du kører flere AI-kodningsagenter på tværs af forskellige projekter og branches, kender du smerten -- seks terminal-faner åbne, du kan ikke huske hvilken agent der arbejder på hvad, og du er bekymret for at to af dem redigerer de samme filer.

Hive er en AI-agent orkestrator. Se alle dine kørende agenter i én sidebar, klik for at skifte mellem dem, og hver enkelt kører på en isoleret git worktree-branch, så de ikke kan konflikte. Forbind flere repositories sammen, så en enkelt agent-session har kontekst på tværs af hele din stack.

## Funktioner

### 🌳 **Worktree-First Arbejdsgang**
Arbejd på flere branches samtidigt uden stashing eller switching. Opret, arkivér og organisér worktrees med ét klik. Hver worktree får et unikt bybaseret navn for nem identifikation.

### 🤖 **Indbyggede AI-kodningssessioner**
Kør AI-kodningsagenter direkte i Hive med både **OpenCode** og **Claude Code** support. Stream svar i realtid, se tool calls blive udført, og godkend tilladelser efter behov. Fuld undo/redo support holder dig i kontrol.

### 📁 **Smart Filstifinder**
Se hvad der er ændret med et blik med live git-statusindikatorer. Se diffs inline, gennemse filhistorik og navigér i din kodebase uden at forlade appen. Integreret Monaco-editor giver en fuld VS Code-oplevelse.

### 🔧 **Komplet Git-integration**
Commit, push, pull og administrér branches visuelt. Ingen terminal nødvendig for almindelige git-operationer. Se ventende ændringer, stagede filer og commit-historik alt på ét sted.

### 📦 **Spaces til organisering**
Gruppér relaterede projekter og worktrees i logiske workspaces. Fastgør favoritter for hurtig adgang. Hold dit udviklingsmiljø organiseret, efterhånden som du skalerer.

### ⚡ **Kommandopalette**
Navigér og handl hurtigt med tastaturgenveje. Tryk `Cmd+K` for at tilgå enhver funktion øjeblikkeligt. Søg sessioner, skift worktrees eller kør kommandoer uden at røre musen.

### 🎨 **Smukke temaer**
Vælg mellem 10 omhyggeligt designede temaer — 6 mørke og 4 lyse. Skift øjeblikkeligt for at matche din præference eller tidspunkt på dagen. Følger systemtema automatisk, hvis ønsket.

### 🖥️ **Language Server Protocol**
Fuld LSP-integration med per-worktree sprogservere. Få intelligent kodefuldførelse, go-to-definition, hover tooltips og realtidsdiagnostik for TypeScript, Python, Go, Rust og mere.

### 🔌 **Worktree-forbindelser**
Forbind to worktrees sammen for at dele kontekst, sammenligne implementeringer eller samarbejde i realtid. Perfekt til at gennemgå ændringer mellem branches, dele AI-sessioner på tværs af worktrees eller opretholde konsistens, når du arbejder på relaterede funktioner. Se live-opdateringer, når forbundne worktrees ændres.

## Hvorfor Hive?

Se hvordan Hive transformerer din git-arbejdsgang:

| Opgave | Traditionel arbejdsgang | Med Hive |
|------|---------------------|-----------|
| **Skift branch** | `git stash` → `git checkout` → `git stash pop` | Klik på worktree → Færdig |
| **Arbejd på flere funktioner** | Konstant stashing og kontekstskift | Åbn flere worktrees side om side |
| **Opret worktree** | `git worktree add ../project-feature origin/feature` | Klik "Ny Worktree" → Vælg branch |
| **AI-kodningshjælp** | Terminal + separat AI-værktøj + kopiér/indsæt | Integrerede AI-sessioner med fuld kontekst |
| **Se filændringer** | `git status` → `git diff file.ts` | Visuelt træ med inline diffs |
| **Sammenlign branches** | Flere terminal-faner, kopiér/indsæt mellem dem | Forbind worktrees for at dele kontekst |
| **Find en worktree** | `cd ~/projects/...` → husk mappenavne | Alle worktrees i én sidebar |
| **Ryd op i worktrees** | `git worktree remove` → `rm -rf directory` | Klik "Arkivér" → Klarer alt |

## Installation

> 🍎 **Kun macOS** — Windows og Linux support kommer snart.

### Via Homebrew (Anbefalet)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Direkte download

Download den seneste `.dmg` fra [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

Det er det! Åbn Hive fra din Programmer-mappe og peg den mod et git-repo.

## Hurtig start

Kom i gang på under 2 minutter:

### 1️⃣ **Tilføj dit første projekt**
Åbn Hive → Klik **"Tilføj Projekt"** → Vælg et vilkårligt git-repository på din maskine

### 2️⃣ **Opret en Worktree**
Vælg dit projekt → Klik **"Ny Worktree"** → Vælg en branch (eller opret en ny)

### 3️⃣ **Begynd at kode med AI**
Åbn en worktree → Klik **"Ny Session"** → Begynd at kode med OpenCode eller Claude

> 💡 **Pro tip**: Tryk `Cmd+K` når som helst for at åbne kommandopaletten og navigere hurtigt!

📖 [Læs den fulde guide](docs/GUIDE.md) | ⌨️ [Tastaturgenveje](docs/SHORTCUTS.md)

## 🔌 Worktree-forbindelser - Den store game changer

Hives **Worktree-forbindelser** funktion lader dig linke to worktrees sammen og skabe en bro mellem forskellige branches eller funktioner. Dette er utroligt kraftfuldt for udviklingsarbejdsgange, der kræver bevidsthed på tværs af branches.

### Hvad er Worktree-forbindelser?

Forbind to vilkårlige worktrees for at:
- **🔄 Dele kontekst** - Tilgå filer og ændringer fra en anden branch øjeblikkeligt
- **🤝 Samarbejde** - Arbejd på relaterede funktioner med live-opdateringer mellem worktrees
- **📊 Sammenligne** - Se forskelle mellem implementeringer side om side
- **🎯 Referere** - Hold din main branch synlig, mens du arbejder på funktioner
- **🔗 Linke funktioner** - Forbind frontend og backend branches til full-stack udvikling
- **💬 Dele AI-sessioner** - Fortsæt AI-samtaler på tværs af forskellige worktrees

### Sådan fungerer det

1. **Vælg kilde-Worktree** - Vælg den worktree, du arbejder i
2. **Forbind til mål** - Klik forbindelsesikonet og vælg en anden worktree
3. **Tovejs-link** - Begge worktrees bliver bevidste om hinanden
4. **Realtidsopdateringer** - Se ændringer i forbundne worktrees, når de sker

### Forbindelsesfunktioner

- ✅ **Live synkronisering** - Filændringer i én worktree vises i forbindelsespanelet
- ✅ **Hurtigt skift** - Hop mellem forbundne worktrees med ét klik
- ✅ **Diff-visning** - Sammenlign filer mellem forbundne worktrees
- ✅ **Delt terminal** - Kør kommandoer, der påvirker begge worktrees
- ✅ **AI-kontekstdeling** - AI-sessioner kan referere til kode i forbundne worktrees
- ✅ **Statusindikatorer** - Se build-status, tests og ændringer i forbundne worktrees
- ✅ **Forbindelseshistorik** - Spor hvilke worktrees der var forbundne og hvornår
- ✅ **Smarte forslag** - Hive foreslår relevante worktrees at forbinde baseret på din arbejdsgang

### Eksempler på brug

**Funktionsudvikling**: Forbind din feature-branch til main for at sikre kompatibilitet og se, hvordan dine ændringer integreres.

**Fejlrettelser**: Forbind bugfix-worktree til produktionsbranchen for at verificere, at rettelsen virker i kontekst.

**Kodegennemgang**: Forbind reviewer og forfatter worktrees for at diskutere ændringer med fuld kontekst på begge sider.

**Full-Stack udvikling**: Forbind frontend og backend worktrees for at arbejde på API og UI samtidigt med perfekt koordination.

**Refaktorering**: Forbind gamle og nye implementeringer for at sikre funktionsparitet under store refaktoreringer.

## Se det i aktion

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive demo — orkestrér AI-agenter på tværs af projekter" width="900" />
</div>

<details>
<summary><strong>Flere skærmbilleder</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI-kodningssession med git worktrees" width="900" />
  <sub>AI-drevne kodningssessioner med integreret git worktree-styring</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Oprettelse af ny worktree" width="900" />
  <sub>Opret og administrér worktrees visuelt</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Filtræ med git-status" width="900" />
  <sub>Filstifinder med live git-statusindikatorer</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Tema-showcase" width="900" />
  <sub>Smukke temaer til enhver præference</sub>
</div>

</details>

## Fællesskab & Support

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Dokumentation-Læs-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Problemer-Rapportér-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Diskussioner-Deltag-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Bidrag-Retningslinjer-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Sikkerhed-Politik-orange?style=for-the-badge)](SECURITY.md)

</div>

### Få hjælp

- 📖 Læs [dokumentationen](docs/) for detaljerede guider
- 🐛 [Rapportér fejl](https://github.com/morapelker/hive/issues/new?template=bug_report.md) med reproduktionstrin
- 💡 [Anmod om funktioner](https://github.com/morapelker/hive/issues/new?template=feature_request.md) du gerne vil se
- 💬 [Deltag i diskussioner](https://github.com/morapelker/hive/discussions) for at forbinde med fællesskabet
- 🔒 [Rapportér sikkerhedssårbarheder](SECURITY.md) ansvarligt

### Ressourcer

- [Brugervejledning](docs/GUIDE.md) — Kom i gang og tutorials
- [FAQ](docs/FAQ.md) — Almindelige spørgsmål og fejlfinding
- [Tastaturgenveje](docs/SHORTCUTS.md) — Komplet genvejsreference

## Køreplan

### 🚀 Kommer snart

- **Tværplatform-support** — Windows og Linux builds
- **Plugin-system** — Udvid Hive med tilpassede integrationer
- **Forbedrede forbindelser** — Flervejsforbindelser, forbindelsesgrupper, smarte forslag
- **Cloud-synkronisering** — Synkronisér indstillinger, sessioner og forbindelsesskabeloner på tværs af enheder
- **Teamfunktioner** — Del worktrees og samarbejd i realtid
- **Tilpassede AI-modeller** — Brug dine egne OpenAI/Anthropic API-nøgler
- **Terminal-faner** — Flere terminal-sessioner per worktree
- **Git graf-visualisering** — Visuel branch-historik og merges
- **Ydelsesprofilering** — Indbyggede værktøjer til optimering

### 🎯 Fremtidsvision

- **Forbindelsesintelligens** — AI-drevne forbindelsesforslag baseret på git-historik
- **Forbindelsesmarkedsplads** — Del og opdag forbindelsesskabeloner
- **Fjernudvikling** — SSH og container-baseret udvikling
- **Trevejsforbindelser** — Forbind og flet flere branches visuelt
- **CI/CD-integration** — GitHub Actions, GitLab CI, Jenkins overvågning
- **Forbindelsesautomatisering** — Auto-forbind relaterede branches baseret på mønstre
- **Kodegennemgangstilstand** — Speciel forbindelsestype optimeret til gennemgange
- **Tidssporing** — Per-worktree og per-forbindelse aktivitetsanalyse

Vil du påvirke køreplanen? [Deltag i diskussionen](https://github.com/morapelker/hive/discussions/categories/ideas) eller [bidrag](CONTRIBUTING.md)!

---

<details>
<summary><strong>Udvikling</strong></summary>

### Forudsætninger

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree support)

### Opsætning

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (Valgfri)

Hive inkluderer en valgfri native terminal drevet af [Ghostty](https://ghostty.org/)s `libghostty`. Dette er kun nødvendigt, hvis du vil arbejde på den integrerede terminal-funktion.

**Opsætning:**

1. Byg `libghostty` fra Ghostty-kildekoden ([byggevejledning](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Dette producerer `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Hvis dit Ghostty-repo er på `~/Documents/dev/ghostty/`, finder buildet det automatisk. Ellers, sæt stien:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Genbyg den native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Hvis `libghostty` ikke er tilgængelig, bygger og kører Hive stadig -- Ghostty terminal-funktionen vil bare være deaktiveret.

### Kommandoer

| Kommando           | Beskrivelse           |
| ----------------- | --------------------- |
| `pnpm dev`        | Start med hot reload |
| `pnpm build`      | Produktionsbuild      |
| `pnpm lint`       | ESLint-kontrol          |
| `pnpm lint:fix`   | ESLint auto-fix       |
| `pnpm format`     | Prettier-formatering       |
| `pnpm test`       | Kør alle tests         |
| `pnpm test:watch` | Watch-tilstand            |
| `pnpm test:e2e`   | Playwright E2E-tests  |
| `pnpm build:mac`  | Pakke til macOS     |

### Arkitektur

Hive bruger Electrons tre-procesmodel med streng sandboxing:

```
┌─────────────────────────────────────────────────────┐
│                    Main Process                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
│  │ Service   │ │ Service  │ │  (AI Sessions)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPC Handlers │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Typed IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Bridge)    │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* APIs
┌──────────────────────┼──────────────────────────────┐
│                 Renderer Process                     │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │    Components     │   │
│  │ Stores    │ │ ui       │ │  (14 domains)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Projektstruktur

```
src/
├── main/                  # Electron hovedproces (Node.js)
│   ├── db/                # SQLite database + skema + migrationer
│   ├── ipc/               # IPC handler-moduler
│   └── services/          # Git, OpenCode, logger, fil-services
├── preload/               # Bro-lag (typede window.* API'er)
└── renderer/src/          # React SPA
    ├── components/        # UI organiseret efter domæne
    ├── hooks/             # Tilpassede React hooks
    ├── lib/               # Værktøjer, temaer, hjælpere
    └── stores/            # Zustand state management
```

### Tech Stack

| Lag     | Teknologi                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Sprog  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL-tilstand)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Dokumentation

Detaljeret dokumentation findes i [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Produktkrav
- **[Implementation](docs/implementation/)** -- Tekniske guider
- **[Specs](docs/specs/)** -- Funktionsspecifikationer
- **[Planer](docs/plans/)** -- Aktive implementeringsplaner

</details>

## Bidrag

Vi elsker bidrag! Hive er bygget af udviklere, til udviklere, og vi byder forbedringer af alle slags velkomne.

### Måder at bidrage

- 🐛 **Rapportér fejl** med klare reproduktionstrin
- 💡 **Foreslå funktioner** der vil forbedre din arbejdsgang
- 📝 **Forbedr dokumentation** for at hjælpe andre i gang
- 🎨 **Indsend UI/UX-forbedringer** for bedre brugervenlighed
- 🔧 **Ret fejl** fra vores issue tracker
- ⚡ **Optimér ydeevne** i kritiske stier
- 🧪 **Tilføj tests** for at forbedre dækning
- 🌐 **Oversæt** appen til dit sprog

Før du bidrager, læs venligst vores [Retningslinjer for bidrag](CONTRIBUTING.md) og [Adfærdskodeks](CODE_OF_CONDUCT.md).

### Hurtig bidragsguide

1. Fork repositoriet
2. Opret en feature-branch (`git checkout -b feature/amazing-feature`)
3. Foretag dine ændringer
4. Kør tests (`pnpm test`) og linting (`pnpm lint`)
5. Commit med en beskrivende besked
6. Push til din fork
7. Åbn en Pull Request

Se [CONTRIBUTING.md](CONTRIBUTING.md) for detaljerede retningslinjer.

## Licens

[MIT](LICENSE) © 2024 morapelker

Hive er open source software licenseret under MIT-licensen. Se [LICENSE](LICENSE) filen for fulde detaljer.
