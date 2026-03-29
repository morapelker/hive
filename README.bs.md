<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Open source AI agent orkestrator za paralelno kodiranje kroz projekte.</strong></p>
  <p>Pokrenite Claude Code, OpenCode i Codex sesije paralelno. Jedan prozor. Izolirani branchevi. Nula tab haosa.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md"><strong>Bosanski</strong></a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## Sadržaj

- [Šta je Hive?](#šta-je-hive)
- [Funkcionalnosti](#funkcionalnosti)
- [Zašto Hive?](#zašto-hive)
- [Instalacija](#instalacija)
- [Brzi početak](#brzi-početak)
- [Konekcije - Pravi game changer](#-konekcije---pravi-game-changer)
- [Snimci ekrana](#snimci-ekrana)
- [Zajednica i podrška](#zajednica-i-podrška)
- [Plan razvoja](#plan-razvoja)
- [Razvoj](#razvoj)
- [Doprinos](#doprinos)
- [Licenca](#licenca)

## Šta je Hive?

Ako pokrećete više AI coding agenata na različitim projektima i branchevima, znate tu bol -- šest terminal tabova otvoreno, ne sjećate se koji agent radi na čemu, i brinete da dva od njih uređuju iste fajlove.

Hive je AI agent orkestrator. Vidite sve pokrenute agente u jednom sidebaru, kliknite za prebacivanje između njih, i svaki radi na izoliranom git worktree branchu tako da ne mogu doći u konflikt. Povežite više repozitorija zajedno tako da jedna agent sesija ima kontekst kroz cijeli vaš stack.

## Funkcionalnosti

### 🌳 **Worktree-First Radni Tok**
Radite na više brancheva istovremeno bez stashiranja ili prebacivanja. Kreirajte, arhivirajte i organizirajte worktreeje jednim klikom. Svaki worktree dobija jedinstveno ime bazirano na gradovima za lakšu identifikaciju.

### 🤖 **Ugrađene AI Coding Sesije**
Pokrenite AI coding agente direktno u Hive sa podrškom za **OpenCode** i **Claude Code**. Pratite odgovore u realnom vremenu, gledajte izvršavanje tool poziva i odobravajte dozvole po potrebi. Puna undo/redo podrška vas drži u kontroli.

### 📁 **Pametni File Explorer**
Vidite šta se promijenilo na prvi pogled sa live git status indikatorima. Pregledajte diffove inline, pretražite historiju fajlova i navigirajte kroz codebase bez napuštanja aplikacije. Integrirani Monaco editor pruža potpuni VS Code doživljaj.

### 🔧 **Kompletna Git Integracija**
Commitujte, pushajte, pullajte i upravljajte branchevima vizuelno. Nije potreban terminal za uobičajene git operacije. Vidite promjene na čekanju, stage-ovane fajlove i historiju commitova sve na jednom mjestu.

### 📦 **Spaces za Organizaciju**
Grupirajte povezane projekte i worktreeje u logičke radne prostore. Prikačite favorite za brz pristup. Održavajte razvojno okruženje organiziranim kako rastete.

### ⚡ **Command Palette**
Navigirajte i djelujte brzo sa prečicama na tastaturi. Pritisnite `Cmd+K` za pristup bilo kojoj funkcionalnosti trenutno. Pretražujte sesije, prebacujte worktreeje ili pokrenite komande bez dodirivanja miša.

### 🎨 **Lijepe Teme**
Birajte između 10 pažljivo dizajniranih tema — 6 tamnih i 4 svijetle. Prebacujte se trenutno da odgovaraju vašim preferencijama ili dobu dana. Automatski prati sistemsku temu ako želite.

### 🖥️ **Language Server Protocol**
Puna LSP integracija sa language serverima po worktreeu. Dobijte inteligentnu dopunu koda, idi-na-definiciju, hover tooltipove i dijagnostiku u realnom vremenu za TypeScript, Python, Go, Rust i još mnogo toga.

### 🔌 **Worktree Konekcije**
Povežite dva worktreea zajedno za dijeljenje konteksta, poređenje implementacija ili saradnju u realnom vremenu. Savršeno za pregled promjena između brancheva, dijeljenje AI sesija kroz worktreeje ili održavanje konzistentnosti pri radu na povezanim funkcionalnostima. Pratite live ažuriranja kada se povezani worktreevi mijenjaju.

## Zašto Hive?

Pogledajte kako Hive transformiše vaš git radni tok:

| Zadatak | Tradicionalni radni tok | Sa Hive |
|------|---------------------|-----------|
| **Prebaci branch** | `git stash` → `git checkout` → `git stash pop` | Klik na worktree → Gotovo |
| **Rad na više funkcionalnosti** | Konstantno stashiranje i prebacivanje konteksta | Otvorite više worktreeja uporedo |
| **Kreiraj worktree** | `git worktree add ../project-feature origin/feature` | Klik "Novi Worktree" → Izaberite branch |
| **AI coding pomoć** | Terminal + poseban AI alat + copy/paste | Integrirane AI sesije sa punim kontekstom |
| **Pregledaj promjene fajlova** | `git status` → `git diff file.ts` | Vizuelno stablo sa inline diffovima |
| **Uporedi brancheve** | Više terminal tabova, copy/paste između | Povežite worktreeje za dijeljenje konteksta |
| **Nađi worktree** | `cd ~/projects/...` → sjeti se imena direktorija | Svi worktreevi u jednom sidebaru |
| **Očisti worktreeje** | `git worktree remove` → `rm -rf directory` | Klik "Arhiviraj" → Upravlja svime |

## Instalacija

> 🍎 **Samo macOS** — Windows i Linux podrška uskoro.

### Preko Homebrew (Preporučeno)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Direktno preuzimanje

Preuzmite najnoviji `.dmg` sa [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

To je to! Otvorite Hive iz Applications foldera i usmjerite ga na git repo.

## Brzi početak

Po��nite za manje od 2 minute:

### 1️⃣ **Dodajte svoj prvi projekat**
Otvorite Hive → Kliknite **"Dodaj Projekat"** → Izaberite bilo koji git repozitorij na vašem računaru

### 2️⃣ **Kreirajte Worktree**
Izaberite projekat → Kliknite **"Novi Worktree"** → Izaberite branch (ili kreirajte novi)

### 3️⃣ **Počnite kodirati sa AI**
Otvorite worktree → Kliknite **"Nova Sesija"** → Počnite kodirati sa OpenCode ili Claude

> 💡 **Pro savjet**: Pritisnite `Cmd+K` bilo kada za otvaranje command palete i brzu navigaciju!

📖 [Pročitajte kompletan vodič](docs/GUIDE.md) | ⌨️ [Prečice na tastaturi](docs/SHORTCUTS.md)

## 🔌 Worktree Konekcije - Pravi game changer

Hive-ova funkcionalnost **Worktree Konekcija** vam omogućava da povežete dva worktreea zajedno, kreirajući most između različitih brancheva ili funkcionalnosti. Ovo je nevjerovatno moćno za razvojne radne tokove koji zahtijevaju svijest o više brancheva.

### Šta su Worktree Konekcije?

Povežite bilo koja dva worktreea za:
- **🔄 Dijeljenje konteksta** - Pristupite fajlovima i promjenama iz drugog brancha trenutno
- **🤝 Saradnju** - Radite na povezanim funkcionalnostima sa live ažuriranjima između worktreeja
- **📊 Poređenje** - Vidite razlike između implementacija uporedo
- **🎯 Referencu** - Držite main branch vidljivim dok radite na funkcionalnostima
- **🔗 Povezivanje funkcionalnosti** - Povežite frontend i backend brancheve za full-stack razvoj
- **💬 Dijeljenje AI sesija** - Nastavite AI razgovore kroz različite worktreeje

### Kako funkcioniše

1. **Izaberite izvorni Worktree** - Izaberite worktree u kojem radite
2. **Povežite se sa ciljem** - Kliknite ikonu konekcije i izaberite drugi worktree
3. **Dvosmjerna veza** - Oba worktreea postaju svjesna jedan drugog
4. **Ažuriranja u realnom vremenu** - Vidite promjene u povezanim worktreejima dok se dešavaju

### Funkcionalnosti konekcije

- ✅ **Live sinhronizacija** - Promjene fajlova u jednom worktreeu pojavljuju se u panelu konekcije
- ✅ **Brzo prebacivanje** - Skočite između povezanih worktreeja jednim klikom
- ✅ **Diff pregled** - Uporedite fajlove između povezanih worktreeja
- ✅ **Dijeljeni terminal** - Pokrenite komande koje utiču na oba worktreea
- ✅ **Dijeljenje AI konteksta** - AI sesije mogu referencirati kod povezanog worktreea
- ✅ **Status indikatori** - Vidite build status, testove i promjene u povezanim worktreejima
- ✅ **Historija konekcija** - Pratite koji worktreevi su bili povezani i kada
- ✅ **Pametni prijedlozi** - Hive predlaže relevantne worktreeje za povezivanje na osnovu vašeg radnog toka

### Primjeri korištenja

**Razvoj funkcionalnosti**: Povežite feature branch sa main da osigurate kompatibilnost i vidite kako se vaše promjene integriraju.

**Ispravke grešaka**: Povežite bugfix worktree sa production branchom da verificirate da ispravka radi u kontekstu.

**Pregled koda**: Povežite worktreeje recenzenta i autora da diskutirate o promjenama sa punim kontekstom s obje strane.

**Full-Stack razvoj**: Povežite frontend i backend worktreeje da radite na API-ju i UI-ju istovremeno uz savršenu koordinaciju.

**Refaktoriranje**: Povežite stare i nove implementacije da osigurate paritet funkcionalnosti tokom velikih refaktoriranja.

## Pogledajte u akciji

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive demo — orkestrijte AI agente kroz projekte" width="900" />
</div>

<details>
<summary><strong>Više snimaka ekrana</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI coding sesija sa git worktreejima" width="900" />
  <sub>AI coding sesije sa integriranim git worktree upravljanjem</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Kreiranje novog worktreea" width="900" />
  <sub>Kreirajte i upravljajte worktreejima vizuelno</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Stablo fajlova sa git statusom" width="900" />
  <sub>File explorer sa live git status indikatorima</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Prikaz tema" width="900" />
  <sub>Lijepe teme za svaku preferenciju</sub>
</div>

</details>

## Zajednica i podrška

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Dokumentacija-Čitaj-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Problemi-Prijavi-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Diskusije-Pridruži_se-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Doprinos-Smjernice-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Sigurnost-Politika-orange?style=for-the-badge)](SECURITY.md)

</div>

### Dobijte pomoć

- 📖 Pročitajte [dokumentaciju](docs/) za detaljne vodiče
- 🐛 [Prijavite greške](https://github.com/morapelker/hive/issues/new?template=bug_report.md) sa koracima za reprodukciju
- 💡 [Zatražite funkcionalnosti](https://github.com/morapelker/hive/issues/new?template=feature_request.md) koje želite vidjeti
- 💬 [Pridružite se diskusijama](https://github.com/morapelker/hive/discussions) da se povežete sa zajednicom
- 🔒 [Prijavite sigurnosne ranjivosti](SECURITY.md) odgovorno

### Resursi

- [Korisnički vodič](docs/GUIDE.md) — Početak i tutorijali
- [FAQ](docs/FAQ.md) — Česta pitanja i rješavanje problema
- [Prečice na tastaturi](docs/SHORTCUTS.md) — Kompletna referenca prečica

## Plan razvoja

### 🚀 Uskoro

- **Cross-platform podrška** — Windows i Linux buildovi
- **Plugin sistem** — Proširite Hive prilagođenim integracijama
- **Cloud sinhronizacija** — Sinhronizujte postavke, sesije i šablone konekcija na svim uređajima
- **Timske funkcionalnosti** — Dijelite worktreeje i surađujte u realnom vremenu
- **Git graf vizualizacija** — Vizuelna historija brancheva i mergeova
- **Profiliranje performansi** — Ugrađeni alati za optimizaciju

### 🎯 Vizija budućnosti

- **Udaljeni razvoj** — SSH i container-bazirani razvoj
- **Trosmjerne konekcije** — Povežite i mergujte više brancheva vizuelno
- **CI/CD integracija** — Praćenje GitHub Actions, GitLab CI, Jenkins
- **Automatizacija konekcija** — Auto-povezivanje srodnih brancheva na osnovu obrazaca
- **Režim pregleda koda** — Poseban tip konekcije optimiziran za preglede
- **Praćenje vremena** — Analitika aktivnosti po worktreeu i konekciji

Želite uticati na plan razvoja? [Pridružite se diskusiji](https://github.com/morapelker/hive/discussions/categories/ideas) ili [doprinesite](CONTRIBUTING.md)!

---

<details>
<summary><strong>Razvoj</strong></summary>

### Preduslovi

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree podrška)

### Postavljanje

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (Opciono)

Hive uključuje opcionalni nativni terminal pokretan [Ghostty](https://ghostty.org/)-jevim `libghostty`. Ovo je potrebno samo ako želite raditi na ugrađenoj terminal funkcionalnosti.

**Postavljanje:**

1. Buildajte `libghostty` iz Ghostty izvora ([instrukcije za build](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Ovo proizvodi `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Ako je vaš Ghostty repo na `~/Documents/dev/ghostty/`, build će ga pronaći automatski. Inače, postavite putanju:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Rebuildajte nativni addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Ako `libghostty` nije dostupan, Hive se i dalje builda i pokreće -- Ghostty terminal funkcionalnost će samo biti onemogućena.

### Komande

| Komanda           | Opis           |
| ----------------- | --------------------- |
| `pnpm dev`        | Pokreni sa hot reload |
| `pnpm build`      | Production build      |
| `pnpm lint`       | ESLint provjera          |
| `pnpm lint:fix`   | ESLint auto-fix       |
| `pnpm format`     | Prettier formatiranje       |
| `pnpm test`       | Pokreni sve testove         |
| `pnpm test:watch` | Watch režim            |
| `pnpm test:e2e`   | Playwright E2E testovi  |
| `pnpm build:mac`  | Pakuj za macOS     |

### Arhitektura

Hive koristi Electron-ov model sa tri procesa uz strogi sandboxing:

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

### Struktura projekta

```
src/
├── main/                  # Electron glavni proces (Node.js)
│   ├── db/                # SQLite baza podataka + šema + migracije
│   ├── ipc/               # IPC handler moduli
│   └── services/          # Git, OpenCode, logger, file servisi
├── preload/               # Bridge sloj (tipizirani window.* API-ji)
└── renderer/src/          # React SPA
    ├── components/        # UI organiziran po domenu
    ├── hooks/             # Prilagođeni React hookovi
    ├── lib/               # Utility, teme, helperi
    └── stores/            # Zustand state management
```

### Tech Stack

| Sloj     | Tehnologija                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Jezik  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Baza podataka  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL režim)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Dokumentacija

Detaljna dokumentacija se nalazi u [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Zahtjevi proizvoda
- **[Implementacija](docs/implementation/)** -- Tehnički vodiči
- **[Specifikacije](docs/specs/)** -- Specifikacije funkcionalnosti
- **[Planovi](docs/plans/)** -- Aktivni planovi implementacije

</details>

## Doprinos

Volimo doprinose! Hive je napravljen od developera, za developere, i dobrodošla su poboljšanja svih vrsta.

### Načini doprinosa

- 🐛 **Prijavite greške** sa jasnim koracima za reprodukciju
- 💡 **Predložite funkcionalnosti** koje bi poboljšale vaš radni tok
- 📝 **Poboljšajte dokumentaciju** da pomognete drugima da počnu
- 🎨 **Pošaljite UI/UX poboljšanja** za bolju upotrebljivost
- 🔧 **Ispravite greške** iz našeg issue trackera
- ⚡ **Optimizujte performanse** na kritičnim putanjama
- 🧪 **Dodajte testove** za poboljšanje pokrivenosti
- 🌐 **Prevedite** aplikaciju na svoj jezik

Prije doprinosa, molimo pročitajte naše [Smjernice za doprinos](CONTRIBUTING.md) i [Kodeks ponašanja](CODE_OF_CONDUCT.md).

### Vodič za brzi doprinos

1. Forkajte repozitorij
2. Kreirajte feature branch (`git checkout -b feature/amazing-feature`)
3. Napravite svoje promjene
4. Pokrenite testove (`pnpm test`) i linting (`pnpm lint`)
5. Commitujte sa opisnom porukom
6. Pushajte na svoj fork
7. Otvorite Pull Request

Pogledajte [CONTRIBUTING.md](CONTRIBUTING.md) za detaljne smjernice.

## Licenca

[MIT](LICENSE) © 2024 morapelker

Hive je open source softver licenciran pod MIT licencom. Pogledajte [LICENSE](LICENSE) fajl za potpune detalje.
