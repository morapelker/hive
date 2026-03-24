<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Orkiestrator agentów AI o otwartym kodzie źródłowym do równoległego programowania między projektami.</strong></p>
  <p>Uruchamiaj sesje Claude Code, OpenCode i Codex równolegle. Jedno okno. Izolowane gałęzie. Zero chaosu zakładek.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md"><strong>Polski</strong></a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Najnowsza wersja" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Pobrania" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Status builda" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licencja" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR mile widziane" /></a>
  </p>
</div>

---

## Spis treści

- [Czym jest Hive?](#czym-jest-hive)
- [Funkcje](#funkcje)
- [Dlaczego Hive?](#dlaczego-hive)
- [Instalacja](#instalacja)
- [Szybki start](#szybki-start)
- [Połączenia — Przełom](#-połączenia---przełom)
- [Zrzuty ekranu](#zrzuty-ekranu)
- [Społeczność i wsparcie](#społeczność-i-wsparcie)
- [Mapa drogowa](#mapa-drogowa)
- [Rozwój](#rozwój)
- [Wkład](#wkład)
- [Licencja](#licencja)

## Czym jest Hive?

Jeśli uruchamiasz wielu agentów AI do kodowania w różnych projektach i gałęziach, znasz ten ból — sześć otwartych zakładek terminala, nie pamiętasz, który agent pracuje nad czym, i martwisz się, że dwóch z nich edytuje te same pliki.

Hive to orkiestrator agentów AI. Zobacz wszystkich działających agentów w jednym panelu bocznym, kliknij, aby przełączać się między nimi, a każdy działa na izolowanej gałęzi git worktree, więc nie mogą kolidować. Połącz wiele repozytoriów, aby pojedyncza sesja agenta miała kontekst całego stosu.

## Funkcje

### 🌳 **Workflow oparty na Worktree**
Pracuj jednocześnie na wielu gałęziach bez stashowania i przełączania. Twórz, archiwizuj i organizuj worktree jednym kliknięciem. Każdy worktree otrzymuje unikatową nazwę opartą na mieście dla łatwej identyfikacji.

### 🤖 **Wbudowane sesje kodowania AI**
Uruchamiaj agentów AI do kodowania bezpośrednio w Hive ze wsparciem **OpenCode** i **Claude Code**. Streamuj odpowiedzi w czasie rzeczywistym, obserwuj wykonywanie wywołań narzędzi i zatwierdzaj uprawnienia w razie potrzeby. Pełna obsługa cofnij/ponów utrzymuje kontrolę.

### 📁 **Inteligentny eksplorator plików**
Zobacz co się zmieniło na pierwszy rzut oka dzięki wskaźnikom statusu git na żywo. Przeglądaj diffy inline, historię plików i nawiguj po kodzie bez opuszczania aplikacji. Zintegrowany edytor Monaco zapewnia pełne doświadczenie jak w VS Code.

### 🔧 **Pełna integracja z Git**
Commituj, pushuj, pulluj i zarządzaj gałęziami wizualnie. Terminal niepotrzebny do typowych operacji git. Zobacz oczekujące zmiany, przygotowane pliki i historię commitów w jednym miejscu.

### 📦 **Przestrzenie do organizacji**
Grupuj powiązane projekty i worktree w logiczne przestrzenie robocze. Przypinaj ulubione dla szybkiego dostępu. Utrzymuj porządek w środowisku deweloperskim w miarę rozwoju.

### ⚡ **Paleta poleceń**
Nawiguj i działaj szybko za pomocą skrótów klawiszowych. Naciśnij `Cmd+K`, aby uzyskać natychmiastowy dostęp do dowolnej funkcji. Szukaj sesji, przełączaj worktree lub wykonuj polecenia bez dotykania myszy.

### 🎨 **Piękne motywy**
Wybierz spośród 10 starannie zaprojektowanych motywów — 6 ciemnych i 4 jasne. Przełączaj natychmiastowo według preferencji lub pory dnia. Automatycznie podąża za motywem systemowym.

### 🖥️ **Language Server Protocol**
Pełna integracja LSP z serwerami językowymi per worktree. Inteligentne uzupełnianie kodu, przejdź do definicji, podpowiedzi po najechaniu i diagnostyka w czasie rzeczywistym dla TypeScript, Python, Go, Rust i więcej.

### 🔌 **Połączenia Worktree**
Połącz dwa worktree, aby dzielić kontekst, porównywać implementacje lub współpracować w czasie rzeczywistym. Idealne do przeglądania zmian między gałęziami, udostępniania sesji AI między worktree lub utrzymywania spójności przy powiązanych funkcjach. Zobacz aktualizacje na żywo, gdy połączone worktree się zmieniają.

## Dlaczego Hive?

Zobacz jak Hive przekształca twój workflow git:

| Zadanie | Tradycyjny workflow | Z Hive |
|------|---------------------|-----------|
| **Zmiana gałęzi** | `git stash` → `git checkout` → `git stash pop` | Klik na worktree → Gotowe |
| **Praca nad wieloma funkcjami** | Ciągłe stashowanie i zmiana kontekstu | Otwórz wiele worktree obok siebie |
| **Tworzenie worktree** | `git worktree add ../project-feature origin/feature` | Klik „Nowy Worktree" → Wybierz gałąź |
| **Pomoc AI w kodowaniu** | Terminal + osobne narzędzie AI + kopiuj/wklej | Zintegrowane sesje AI z pełnym kontekstem |
| **Przeglądanie zmian w plikach** | `git status` → `git diff file.ts` | Wizualne drzevo z diffami inline |
| **Porównywanie gałęzi** | Wiele zakładek terminala, kopiuj/wklej | Połącz worktree, aby dzielić kontekst |
| **Szukanie worktree** | `cd ~/projects/...` → pamiętaj nazwy katalogów | Wszystkie worktree w jednym panelu |
| **Czyszczenie worktree** | `git worktree remove` → `rm -rf directory` | Klik „Archiwizuj" → Zajmuje się wszystkim |

## Instalacja

> 🍎 **Tylko macOS** — Wsparcie Windows i Linux wkrótce.

### Przez Homebrew (zalecane)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Bezpośrednie pobranie

Pobierz najnowszy `.dmg` z [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

To wszystko! Otwórz Hive z folderu Aplikacje i wskaż repozytorium git.

## Szybki start

Zacznij w mniej niż 2 minuty:

### 1️⃣ **Dodaj pierwszy projekt**
Otwórz Hive → Kliknij **„Add Project"** → Wybierz dowolne repozytorium git na swoim komputerze

### 2️⃣ **Utwórz Worktree**
Wybierz projekt → Kliknij **„New Worktree"** → Wybierz gałąź (lub utwórz nową)

### 3️⃣ **Zacznij kodować z AI**
Otwórz worktree → Kliknij **„New Session"** → Zacznij kodować z OpenCode lub Claude

> 💡 **Pro tip**: Naciśnij `Cmd+K` w dowolnym momencie, aby otworzyć paletę poleceń i szybko nawigować!

📖 [Przeczytaj pełny przewodnik](docs/GUIDE.md) | ⌨️ [Skróty klawiszowe](docs/SHORTCUTS.md)

## 🔌 Połączenia Worktree — Przełom

Funkcja **Połączeń Worktree** w Hive pozwala połączyć dwa worktree, tworząc most między różnymi gałęziami lub funkcjami. Jest niezwykle potężna dla workflow wymagających świadomości między gałęziami.

### Czym są Połączenia Worktree?

Połącz dowolne dwa worktree, aby:
- **🔄 Dzielić kontekst** - Dostęp do plików i zmian z innej gałęzi natychmiast
- **🤝 Współpracować** - Pracuj nad powiązanymi funkcjami z aktualizacjami na żywo między worktree
- **📊 Porównywać** - Zobacz różnice między implementacjami obok siebie
- **🎯 Mieć referencję** - Utrzymuj główną gałąź widoczną podczas pracy nad funkcjami
- **🔗 Łączyć funkcje** - Połącz gałęzie frontend i backend do rozwoju full-stack
- **💬 Dzielić sesje AI** - Kontynuuj rozmowy AI między różnymi worktree

### Jak to działa

1. **Wybierz źródłowy Worktree** - Wybierz worktree, w którym pracujesz
2. **Połącz z celem** - Kliknij ikonę połączenia i wybierz inny worktree
3. **Dwukierunkowe połączenie** - Oba worktree stają się świadome siebie nawzajem
4. **Aktualizacje w czasie rzeczywistym** - Zobacz zmiany w połączonych worktree w miarę ich powstawania

### Funkcje połączeń

- ✅ **Synchronizacja na żywo** - Zmiany plików w jednym worktree pojawiają się w panelu połączeń
- ✅ **Szybkie przełączanie** - Skacz między połączonymi worktree jednym kliknięciem
- ✅ **Widok różnic** - Porównuj pliki między połączonymi worktree
- ✅ **Współdzielony terminal** - Wykonuj polecenia wpływające na oba worktree
- ✅ **Współdzielony kontekst AI** - Sesje AI mogą odwoływać się do kodu połączonego worktree
- ✅ **Wskaźniki statusu** - Zobacz status builda, testy i zmiany w połączonych worktree
- ✅ **Historia połączeń** - Śledź, które worktree były połączone i kiedy
- ✅ **Inteligentne sugestie** - Hive sugeruje odpowiednie worktree do połączenia na podstawie workflow

### Przypadki użycia

**Rozwój funkcji**: Połącz gałąź funkcji z main, aby zapewnić kompatybilność i zobaczyć, jak zmiany się integrują.

**Poprawki błędów**: Połącz worktree poprawki z gałęzią produkcyjną, aby zweryfikować, że poprawka działa w kontekście.

**Przeglądy kodu**: Połącz worktree recenzenta i autora, aby omawiać zmiany z pełnym kontekstem po obu stronach.

**Rozwój full-stack**: Połącz worktree frontend i backend, aby pracować jednocześnie nad API i UI z idealną koordynacją.

**Refaktoryzacja**: Połącz starą i nową implementację, aby zapewnić parytet funkcji podczas dużych refaktoryzacji.

## Zobacz w akcji

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo Hive — orkiestracja agentów AI między projektami" width="900" />
</div>

<details>
<summary><strong>Więcej zrzutów ekranu</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — sesja kodowania AI z git worktree" width="900" />
  <sub>Sesje kodowania wspomagane AI ze zintegrowanym zarządzaniem git worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Tworzenie nowego worktree" width="900" />
  <sub>Twórz i zarządzaj worktree wizualnie</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Drzewo plików ze statusem git" width="900" />
  <sub>Eksplorator plików ze wskaźnikami statusu git na żywo</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Prezentacja motywów" width="900" />
  <sub>Piękne motywy dla każdej preferencji</sub>
</div>

</details>

## Społeczność i wsparcie

<div align="center">

[![Dokumentacja](https://img.shields.io/badge/📖_Dokumentacja-Czytaj-blue?style=for-the-badge)](docs/)
[![Zgłoszenia](https://img.shields.io/badge/🐛_Zgłoszenia-Raportuj-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Dyskusje](https://img.shields.io/badge/💬_Dyskusje-Dołącz-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Wkład](https://img.shields.io/badge/🤝_Wkład-Zasady-green?style=for-the-badge)](CONTRIBUTING.md)
[![Bezpieczeństwo](https://img.shields.io/badge/🔒_Bezpieczeństwo-Polityka-orange?style=for-the-badge)](SECURITY.md)

</div>

### Uzyskaj pomoc

- 📖 Przeczytaj [dokumentację](docs/) dla szczegółowych przewodników
- 🐛 [Zgłoś błędy](https://github.com/morapelker/hive/issues/new?template=bug_report.md) z krokami reprodukcji
- 💡 [Zaproponuj funkcje](https://github.com/morapelker/hive/issues/new?template=feature_request.md), które chciałbyś zobaczyć
- 💬 [Dołącz do dyskusji](https://github.com/morapelker/hive/discussions), aby połączyć się ze społecznością
- 🔒 [Zgłoś luki bezpieczeństwa](SECURITY.md) odpowiedzialnie

### Zasoby

- [Przewodnik użytkownika](docs/GUIDE.md) — Rozpoczęcie i samouczki
- [FAQ](docs/FAQ.md) — Częste pytania i rozwiązywanie problemów
- [Skróty klawiszowe](docs/SHORTCUTS.md) — Pełna referencja skrótów

## Mapa drogowa

### 🚀 Wkrótce

- **Wsparcie wieloplatformowe** — Buildy Windows i Linux
- **System wtyczek** — Rozszerzaj Hive własnymi integracjami
- **Ulepszone połączenia** — Połączenia wielokierunkowe, grupy połączeń, inteligentne sugestie
- **Synchronizacja w chmurze** — Synchronizuj ustawienia, sesje i szablony połączeń między urządzeniami
- **Funkcje zespołowe** — Udostępniaj worktree i współpracuj w czasie rzeczywistym
- **Własne modele AI** — Używaj własnych kluczy API OpenAI/Anthropic
- **Zakładki terminala** — Wiele sesji terminala na worktree
- **Wizualizacja grafu Git** — Wizualna historia gałęzi i merge'ów
- **Profilowanie wydajności** — Wbudowane narzędzia optymalizacji

### 🎯 Wizja przyszłości

- **Inteligencja połączeń** — Sugestie połączeń AI na podstawie historii git
- **Marketplace połączeń** — Udostępniaj i odkrywaj szablony połączeń
- **Rozwój zdalny** — Rozwój oparty na SSH i kontenerach
- **Połączenia trójstronne** — Wizualne łączenie i merge wielu gałęzi
- **Integracja CI/CD** — Monitorowanie GitHub Actions, GitLab CI, Jenkins
- **Automatyzacja połączeń** — Automatyczne łączenie powiązanych gałęzi na podstawie wzorców
- **Tryb przeglądu kodu** — Specjalny typ połączenia zoptymalizowany do przeglądów
- **Śledzenie czasu** — Analityka aktywności per worktree i per połączenie

Chcesz wpłynąć na mapę drogową? [Dołącz do dyskusji](https://github.com/morapelker/hive/discussions/categories/ideas) lub [wnieś wkład](CONTRIBUTING.md)!

---

<details>
<summary><strong>Rozwój</strong></summary>

### Wymagania wstępne

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (wsparcie worktree)

### Konfiguracja

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminal Ghostty (opcjonalny)

Hive zawiera opcjonalny natywny terminal oparty na `libghostty` z [Ghostty](https://ghostty.org/). Potrzebny tylko, jeśli chcesz pracować nad wbudowaną funkcją terminala.

**Konfiguracja:**

1. Skompiluj `libghostty` ze źródła Ghostty ([instrukcje kompilacji](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   To tworzy `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Jeśli repozytorium Ghostty jest w `~/Documents/dev/ghostty/`, build znajdzie je automatycznie. W przeciwnym razie ustaw ścieżkę:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Przebuduj natywny addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Jeśli `libghostty` nie jest dostępne, Hive nadal się kompiluje i działa — funkcja terminala Ghostty będzie po prostu wyłączona.

### Polecenia

| Polecenie           | Opis           |
| ----------------- | --------------------- |
| `pnpm dev`        | Start z hot reload |
| `pnpm build`      | Build produkcyjny      |
| `pnpm lint`       | Sprawdzenie ESLint          |
| `pnpm lint:fix`   | Auto-naprawa ESLint       |
| `pnpm format`     | Formatowanie Prettier       |
| `pnpm test`       | Uruchom wszystkie testy         |
| `pnpm test:watch` | Tryb obserwacji            |
| `pnpm test:e2e`   | Testy E2E Playwright  |
| `pnpm build:mac`  | Pakiet dla macOS     |

### Architektura

Hive używa trójprocesowego modelu Electron ze ścisłym sandboxingiem:

```
┌─────────────────────────────────────────────────────┐
│                   Proces główny                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
│  │ Service   │ │ Service  │ │  (Sesje AI)       │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Obsługa IPC   │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Typowane IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │    (Most)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ API window.*
┌──────────────────────┼──────────────────────────────┐
│               Proces renderera                       │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Komponenty      │   │
│  │ Stores    │ │ ui       │ │  (14 domen)       │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Struktura projektu

```
src/
├── main/                  # Proces główny Electron (Node.js)
│   ├── db/                # Baza danych SQLite + schemat + migracje
│   ├── ipc/               # Moduły obsługi IPC
│   └── services/          # Git, OpenCode, logger, usługi plików
├── preload/               # Warstwa mostowa (typowane API window.*)
└── renderer/src/          # React SPA
    ├── components/        # UI zorganizowane domenowo
    ├── hooks/             # Własne React hooks
    ├── lib/               # Narzędzia, motywy, helpery
    └── stores/            # Zarządzanie stanem Zustand
```

### Stack technologiczny

| Warstwa     | Technologia                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Język  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Style   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Stan     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Baza danych  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (tryb WAL)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Dokumentacja

Szczegółowa dokumentacja w [`docs/`](docs/):

- **[PRD](docs/prd/)** -- Wymagania produktowe
- **[Implementacja](docs/implementation/)** -- Przewodniki techniczne
- **[Specyfikacje](docs/specs/)** -- Specyfikacje funkcji
- **[Plany](docs/plans/)** -- Aktywne plany implementacji

</details>

## Wkład

Kochamy kontrybucje! Hive jest tworzony przez deweloperów, dla deweloperów, i witamy ulepszenia wszelkiego rodzaju.

### Sposoby na wkład

- 🐛 **Zgłaszaj błędy** z jasnymi krokami reprodukcji
- 💡 **Sugeruj funkcje**, które usprawnią twój workflow
- 📝 **Ulepszaj dokumentację**, pomagając innym zacząć
- 🎨 **Przesyłaj ulepszenia UI/UX** dla lepszej użyteczności
- 🔧 **Naprawiaj błędy** z naszego trackera
- ⚡ **Optymalizuj wydajność** na krytycznych ścieżkach
- 🧪 **Dodawaj testy** dla lepszego pokrycia
- 🌐 **Tłumacz** aplikację na swój język

Przed kontrybucją przeczytaj nasze [Zasady kontrybucji](CONTRIBUTING.md) i [Kodeks postępowania](CODE_OF_CONDUCT.md).

### Szybki przewodnik kontrybucji

1. Sforkuj repozytorium
2. Utwórz gałąź funkcji (`git checkout -b feature/amazing-feature`)
3. Wprowadź zmiany
4. Uruchom testy (`pnpm test`) i linting (`pnpm lint`)
5. Commituj z opisowym komunikatem
6. Pushuj do swojego forka
7. Otwórz Pull Request

Szczegółowe zasady w [CONTRIBUTING.md](CONTRIBUTING.md).

## Licencja

[MIT](LICENSE) © 2024 morapelker

Hive to oprogramowanie open source na licencji MIT. Pełne szczegóły w pliku [LICENSE](LICENSE).
