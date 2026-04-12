<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>En åpen kildekode AI-agent orkestrator for parallell koding på tvers av prosjekter.</strong></p>
  <p>Kjør Claude Code, OpenCode og Codex økter parallelt. Ett vindu. Isolerte grener. Null fane-kaos.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md"><strong>Norsk</strong></a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Latest Release" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Status" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-supported-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-41-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs Welcome" /></a>
  </p>
</div>

---

## Innholdsfortegnelse

- [Installasjon](#installasjon)
- [Hva er Hive?](#hva-er-hive)
- [Funksjoner](#funksjoner)
- [Hvorfor Hive?](#hvorfor-hive)
- [Hurtigstart](#hurtigstart)
- [Tilkoblinger - Den store game changeren](#-tilkoblinger---den-store-game-changeren)
- [Skjermbilder](#skjermbilder)
- [Fellesskap & Støtte](#fellesskap--støtte)
- [Veikart](#veikart)
- [Utvikling](#utvikling)
- [Bidra](#bidra)
- [Lisens](#lisens)

## Installasjon

Hive støtter macOS, Windows og Linux.

### macOS

#### Homebrew (Anbefalt)

```bash
brew install --cask hive-app
```

#### Direkte nedlasting

Last ned den nyeste `.dmg` fra [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

### Windows

Last ned den nyeste `.exe` fra [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

### Linux

Last ned den nyeste `.AppImage` eller `.deb` fra [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

---

Det er det! Åpne Hive og pek den mot et git-repo.

## Hva er Hive?

Hvis du kjører flere AI-kodingsagenter på tvers av forskjellige prosjekter og grener, kjenner du smerten -- seks terminalfaner åpne, du husker ikke hvilken agent som jobber med hva, og du er bekymret for at to av dem redigerer de samme filene.

Hive er en AI-agent orkestrator. Se alle kjørende agenter i én sidepanel, klikk for å bytte mellom dem, og hver enkelt kjører på en isolert git worktree-gren slik at de ikke kan komme i konflikt. Koble sammen flere repositories slik at én enkelt agent-økt har kontekst på tvers av hele stacken din.

## Funksjoner

### 🌳 **Worktree-First Arbeidsflyt**
Jobb på flere grener samtidig uten stashing eller switching. Opprett, arkivér og organiser worktrees med ett klikk. Hver worktree får et unikt bybasert navn for enkel identifikasjon.

### 🤖 **Innebygde AI-kodingsøkter**
Kjør AI-kodingsagenter direkte i Hive med **OpenCode**, **Claude Code**, og **Codex** støtte. Strøm svar i sanntid, se verktøykall utføres, og godkjenn tillatelser etter behov. Full undo/redo-støtte holder deg i kontroll.

### 📁 **Smart Filutforsker**
Se hva som er endret med et blikk med live git-statusindikatorer. Se diffs inline, bla gjennom filhistorikk og naviger i kodebasen uten å forlate appen. Integrert Monaco-editor gir en full VS Code-opplevelse.

### 🔧 **Komplett Git-integrasjon**
Commit, push, pull og administrer grener visuelt. Ingen terminal nødvendig for vanlige git-operasjoner. Se ventende endringer, stagede filer og commit-historikk alt på ett sted.

### 📦 **Spaces for organisering**
Grupper relaterte prosjekter og worktrees i logiske arbeidsområder. Fest favoritter for rask tilgang. Hold utviklingsmiljøet organisert etter hvert som du skalerer.

### ⚡ **Kommandopalett**
Naviger og handle raskt med hurtigtaster. Trykk `Cmd+K` for å få tilgang til enhver funksjon øyeblikkelig. Søk i økter, bytt worktrees eller kjør kommandoer uten å berøre musen.

### 🎨 **Vakre temaer**
Velg blant 10 nøye utformede temaer — 6 mørke og 4 lyse. Bytt øyeblikkelig for å matche preferansen din eller tiden på dagen. Følger systemtema automatisk om ønsket.

### 🔌 **Worktree-tilkoblinger**
Koble to worktrees sammen for å dele kontekst, sammenligne implementeringer eller samarbeide i sanntid. Perfekt for å gjennomgå endringer mellom grener, dele AI-økter på tvers av worktrees, eller opprettholde konsistens når du jobber med relaterte funksjoner. Se live oppdateringer når tilkoblede worktrees endres.

## Hvorfor Hive?

Se hvordan Hive transformerer git-arbeidsflyten din:

| Oppgave | Tradisjonell arbeidsflyt | Med Hive |
|------|---------------------|-----------|
| **Bytt gren** | `git stash` → `git checkout` → `git stash pop` | Klikk på worktree → Ferdig |
| **Jobb på flere funksjoner** | Konstant stashing og kontekstbytte | Åpne flere worktrees side ved side |
| **Opprett worktree** | `git worktree add ../project-feature origin/feature` | Klikk "Ny Worktree" → Velg gren |
| **AI-kodingshjelp** | Terminal + separat AI-verktøy + kopier/lim | Integrerte AI-økter med full kontekst |
| **Se filendringer** | `git status` → `git diff file.ts` | Visuelt tre med inline diffs |
| **Sammenlign grener** | Flere terminalfaner, kopier/lim mellom dem | Koble worktrees for å dele kontekst |
| **Finn en worktree** | `cd ~/projects/...` → husk mappenavn | Alle worktrees i ett sidepanel |
| **Rydd opp worktrees** | `git worktree remove` → `rm -rf directory` | Klikk "Arkivér" → Håndterer alt |

## Hurtigstart

Kom i gang på under 2 minutter:

### 1️⃣ **Legg til ditt første prosjekt**
Åpne Hive → Klikk **"Legg til Prosjekt"** → Velg et vilkårlig git-repository på maskinen din

### 2️⃣ **Opprett en Worktree**
Velg prosjektet ditt → Klikk **"Ny Worktree"** → Velg en gren (eller opprett en ny)

### 3️⃣ **Begynn å kode med AI**
Åpne en worktree → Klikk **"Ny Økt"** → Begynn å kode med OpenCode, Claude, eller Codex

> 💡 **Profftips**: Trykk `Cmd+K` når som helst for å åpne kommandopaletten og navigere raskt!

📖 [Les den fullstendige guiden](docs/GUIDE.md) | ⌨️ [Hurtigtaster](docs/SHORTCUTS.md)

## 🔌 Worktree-tilkoblinger - Den store game changeren

Hives **Worktree-tilkoblinger** funksjon lar deg koble to worktrees sammen, og skaper en bro mellom forskjellige grener eller funksjoner. Dette er utrolig kraftig for utviklingsarbeidsflyter som krever bevissthet på tvers av grener.

### Hva er Worktree-tilkoblinger?

Koble to vilkårlige worktrees for å:
- **🔄 Dele kontekst** - Få tilgang til filer og endringer fra en annen gren øyeblikkelig
- **🤝 Samarbeide** - Jobb på relaterte funksjoner med live oppdateringer mellom worktrees
- **📊 Sammenligne** - Se forskjeller mellom implementeringer side ved side
- **🎯 Referere** - Hold hovedgrenen synlig mens du jobber med funksjoner
- **🔗 Koble funksjoner** - Koble frontend og backend grener for full-stack utvikling
- **💬 Dele AI-økter** - Fortsett AI-samtaler på tvers av forskjellige worktrees

### Slik fungerer det

1. **Velg kilde-Worktree** - Velg worktreen du jobber i
2. **Koble til mål** - Klikk tilkoblingsikonet og velg en annen worktree
3. **Toveis-kobling** - Begge worktrees blir bevisste på hverandre
4. **Sanntidsoppdateringer** - Se endringer i tilkoblede worktrees når de skjer

### Tilkoblingsfunksjoner

- ✅ **Live synkronisering** - Filendringer i én worktree vises i tilkoblingspanelet
- ✅ **Raskt bytte** - Hopp mellom tilkoblede worktrees med ett klikk
- ✅ **Diff-visning** - Sammenlign filer mellom tilkoblede worktrees
- ✅ **Delt terminal** - Kjør kommandoer som påvirker begge worktrees
- ✅ **AI-kontekstdeling** - AI-økter kan referere til kode i tilkoblede worktrees
- ✅ **Statusindikatorer** - Se build-status, tester og endringer i tilkoblede worktrees
- ✅ **Tilkoblingshistorikk** - Spor hvilke worktrees som var tilkoblet og når
- ✅ **Smarte forslag** - Hive foreslår relevante worktrees å koble til basert på arbeidsflyten din

### Eksempler på bruk

**Funksjonsutvikling**: Koble feature-grenen din til main for å sikre kompatibilitet og se hvordan endringene dine integreres.

**Feilrettinger**: Koble bugfix-worktree til produksjonsgrenen for å verifisere at rettelsen fungerer i kontekst.

**Kodegjennomgang**: Koble reviewer og forfatter worktrees for å diskutere endringer med full kontekst på begge sider.

**Full-Stack utvikling**: Koble frontend og backend worktrees for å jobbe med API og UI samtidig med perfekt koordinasjon.

**Refaktorering**: Koble gamle og nye implementeringer for å sikre funksjonsparitet under store refaktoreringer.

## Se det i aksjon

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive demo — orkestrér AI-agenter på tvers av prosjekter" width="900" />
</div>

<details>
<summary><strong>Flere skjermbilder</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI-kodingsøkt med git worktrees" width="900" />
  <sub>AI-drevne kodingsøkter med integrert git worktree-styring</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Oppretting av ny worktree" width="900" />
  <sub>Opprett og administrer worktrees visuelt</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Filtre med git-status" width="900" />
  <sub>Filutforsker med live git-statusindikatorer</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Tema-utstilling" width="900" />
  <sub>Vakre temaer for enhver preferanse</sub>
</div>

</details>

## Fellesskap & Støtte

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Dokumentasjon-Les-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Problemer-Rapporter-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Diskusjoner-Delta-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Bidrag-Retningslinjer-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Sikkerhet-Policy-orange?style=for-the-badge)](SECURITY.md)

</div>

### Få hjelp

- 📖 Les [dokumentasjonen](docs/) for detaljerte guider
- 🐛 [Rapporter feil](https://github.com/morapelker/hive/issues/new?template=bug_report.md) med reproduksjonssteg
- 💡 [Be om funksjoner](https://github.com/morapelker/hive/issues/new?template=feature_request.md) du ønsker å se
- 💬 [Delta i diskusjoner](https://github.com/morapelker/hive/discussions) for å knytte kontakt med fellesskapet
- 🔒 [Rapporter sikkerhetssårbarheter](SECURITY.md) ansvarlig

### Ressurser

- [Brukerveiledning](docs/GUIDE.md) — Kom i gang og veiledninger
- [FAQ](docs/FAQ.md) — Vanlige spørsmål og feilsøking
- [Hurtigtaster](docs/SHORTCUTS.md) — Komplett hurtigtastreferanse

## Veikart

### 🚀 Kommer snart

- **Plugin-system** — Utvid Hive med tilpassede integrasjoner
- **Skysynkronisering** — Synkroniser innstillinger, økter og tilkoblingsmaler på tvers av enheter
- **Teamfunksjoner** — Del worktrees og samarbeid i sanntid
- **Git graf-visualisering** — Visuell grenhistorikk og sammenslåinger
- **Ytelsesprofilering** — Innebygde verktøy for optimalisering

### 🎯 Fremtidsvisjon

- **Fjernutvikling** — SSH og container-basert utvikling
- **Treveis-tilkoblinger** — Koble og slå sammen flere grener visuelt
- **CI/CD-integrasjon** — GitHub Actions, GitLab CI, Jenkins overvåking
- **Tilkoblingsautomatisering** — Auto-koble relaterte grener basert på mønstre
- **Kodegjennomgangsmodus** — Spesiell tilkoblingstype optimalisert for gjennomganger
- **Tidssporing** — Per-worktree og per-tilkobling aktivitetsanalyse

Vil du påvirke veikartet? [Delta i diskusjonen](https://github.com/morapelker/hive/discussions/categories/ideas) eller [bidra](CONTRIBUTING.md)!

---

<details>
<summary><strong>Utvikling</strong></summary>

### Forutsetninger

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree-støtte)

### Oppsett

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (Valgfri)

Hive inkluderer en valgfri native terminal drevet av [Ghostty](https://ghostty.org/)s `libghostty`. Dette er bare nødvendig hvis du vil jobbe med den innebygde terminalfunksjonen.

**Oppsett:**

1. Bygg `libghostty` fra Ghostty-kildekoden ([byggeveiledning](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Dette produserer `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Hvis Ghostty-repoet ditt er på `~/Documents/dev/ghostty/`, finner bygget det automatisk. Ellers, sett stien:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Gjenoppbygg den native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Hvis `libghostty` ikke er tilgjengelig, bygger og kjører Hive fremdeles -- Ghostty terminalfunksjonen vil bare være deaktivert.

### Kommandoer

| Kommando           | Beskrivelse           |
| ----------------- | --------------------- |
| `pnpm dev`        | Start med hot reload |
| `pnpm build`      | Produksjonsbygg      |
| `pnpm lint`       | ESLint-sjekk          |
| `pnpm lint:fix`   | ESLint auto-fix       |
| `pnpm format`     | Prettier-formatering       |
| `pnpm test`       | Kjør alle tester         |
| `pnpm test:watch` | Watch-modus            |
| `pnpm test:e2e`   | Playwright E2E-tester  |
| `pnpm build:mac`  | Pakke for macOS     |

### Arkitektur

Hive bruker Electrons tre-prosessmodell med streng sandboxing:

```
┌─────────────────────────────────────────────────────┐
│                    Main Process                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
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

### Prosjektstruktur

```
src/
├── main/                  # Electron hovedprosess (Node.js)
│   ├── db/                # SQLite database + skjema + migrasjoner
│   ├── ipc/               # IPC handler-moduler
│   └── services/          # Git, AI agents, logger, fil-tjenester
├── preload/               # Bro-lag (typede window.* API-er)
└── renderer/src/          # React SPA
    ├── components/        # UI organisert etter domene
    ├── hooks/             # Tilpassede React hooks
    ├── lib/               # Verktøy, temaer, hjelpere
    └── stores/            # Zustand state management
```

### Tech Stack

| Lag     | Teknologi                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Rammeverk | [Electron 41](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Språk  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL-modus)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Bygg     | [electron-vite](https://electron-vite.org/)                                      |

### Dokumentasjon

Detaljert dokumentasjon finnes i [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Produktkrav
- **[Implementering](docs/implementation/)** -- Tekniske guider
- **[Spesifikasjoner](docs/specs/)** -- Funksjonsspesifikasjoner
- **[Planer](docs/plans/)** -- Aktive implementeringsplaner

</details>

## Bidra

Vi elsker bidrag! Hive er bygget av utviklere, for utviklere, og vi ønsker forbedringer av alle slag velkommen.

### Måter å bidra

- 🐛 **Rapporter feil** med klare reproduksjonssteg
- 💡 **Foreslå funksjoner** som vil forbedre arbeidsflyten din
- 📝 **Forbedre dokumentasjon** for å hjelpe andre i gang
- 🎨 **Send inn UI/UX-forbedringer** for bedre brukervennlighet
- 🔧 **Fiks feil** fra vår issue tracker
- ⚡ **Optimaliser ytelse** i kritiske stier
- 🧪 **Legg til tester** for å forbedre dekning
- 🌐 **Oversett** appen til ditt språk

Før du bidrar, les vennligst våre [Retningslinjer for bidrag](CONTRIBUTING.md) og [Adferdskodeks](CODE_OF_CONDUCT.md).

### Hurtig bidragsguide

1. Fork repositoriet
2. Opprett en feature-gren (`git checkout -b feature/amazing-feature`)
3. Gjør endringene dine
4. Kjør tester (`pnpm test`) og linting (`pnpm lint`)
5. Commit med en beskrivende melding
6. Push til din fork
7. Åpne en Pull Request

Se [CONTRIBUTING.md](CONTRIBUTING.md) for detaljerte retningslinjer.

## Lisens

[MIT](LICENSE) © 2024 morapelker

Hive er åpen kildekode programvare lisensiert under MIT-lisensen. Se [LICENSE](LICENSE) filen for fullstendige detaljer.
