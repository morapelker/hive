<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Un orchestratore di agenti IA open-source per la programmazione in parallelo tra progetti.</strong></p>
  <p>Esegui sessioni di Claude Code, OpenCode e Codex in parallelo. Una finestra. Branch isolati. Zero caos di schede.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md"><strong>Italiano</strong></a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Ultima versione" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Download" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Stato build" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licenza" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR benvenute" /></a>
  </p>
</div>

---

## Indice

- [Cos'è Hive?](#cosè-hive)
- [Funzionalità](#funzionalità)
- [Perché Hive?](#perché-hive)
- [Installazione](#installazione)
- [Avvio rapido](#avvio-rapido)
- [Connessioni — La svolta](#-connessioni---la-svolta)
- [Screenshot](#screenshot)
- [Comunità e supporto](#comunità-e-supporto)
- [Roadmap](#roadmap)
- [Sviluppo](#sviluppo)
  - [Prerequisiti](#prerequisiti)
  - [Configurazione](#configurazione)
  - [Comandi](#comandi)
  - [Architettura](#architettura)
  - [Struttura del progetto](#struttura-del-progetto)
  - [Stack tecnologico](#stack-tecnologico)
  - [Documentazione](#documentazione)
- [Contribuire](#contribuire)
- [Licenza](#licenza)

## Cos'è Hive?

Se esegui più agenti di codifica IA su diversi progetti e branch, conosci il problema — sei schede di terminale aperte, non ricordi quale agente sta lavorando su cosa, e ti preoccupi che due di loro stiano modificando gli stessi file.

Hive è un orchestratore di agenti IA. Vedi tutti i tuoi agenti in esecuzione in una barra laterale, clicca per passare dall'uno all'altro, e ognuno funziona su un branch git worktree isolato così non possono entrare in conflitto. Collega più repository insieme in modo che una singola sessione dell'agente abbia contesto su tutto il tuo stack.

## Funzionalità

### 🌳 **Workflow orientato ai Worktree**
Lavora su più branch simultaneamente senza stash o cambio di branch. Crea, archivia e organizza worktree con un clic. Ogni worktree riceve un nome unico basato su una città per una facile identificazione.

### 🤖 **Sessioni di codifica IA integrate**
Esegui agenti di codifica IA direttamente dentro Hive con supporto per **OpenCode** e **Claude Code**. Trasmetti risposte in tempo reale, osserva l'esecuzione delle chiamate agli strumenti e approva i permessi secondo necessità. Il supporto completo annulla/ripristina ti mantiene al controllo.

### 📁 **Esplora file intelligente**
Vedi cosa è cambiato a colpo d'occhio con indicatori di stato git in tempo reale. Visualizza le diff in linea, naviga la cronologia dei file ed esplora il tuo codice senza uscire dall'app. L'editor Monaco integrato offre un'esperienza completa stile VS Code.

### 🔧 **Integrazione Git completa**
Commit, push, pull e gestisci i branch visivamente. Nessun terminale necessario per le operazioni git comuni. Vedi le modifiche in sospeso, i file in staging e la cronologia dei commit tutto in un unico posto.

### 📦 **Spazi per l'organizzazione**
Raggruppa progetti e worktree correlati in spazi di lavoro logici. Fissa i tuoi preferiti per un accesso rapido. Mantieni il tuo ambiente di sviluppo organizzato mentre cresci.

### ⚡ **Palette dei comandi**
Naviga e agisci velocemente con le scorciatoie da tastiera. Premi `Cmd+K` per accedere a qualsiasi funzionalità istantaneamente. Cerca sessioni, cambia worktree o esegui comandi senza toccare il mouse.

### 🎨 **Temi splendidi**
Scegli tra 10 temi accuratamente realizzati — 6 scuri e 4 chiari. Cambia istantaneamente in base alle tue preferenze o all'ora del giorno. Segue automaticamente il tema di sistema se desiderato.

### 🖥️ **Language Server Protocol**
Integrazione LSP completa con server di linguaggio per worktree. Ottieni completamento intelligente del codice, vai alla definizione, tooltip al passaggio del mouse e diagnostica in tempo reale per TypeScript, Python, Go, Rust e altro.

### 🔌 **Connessioni Worktree**
Collega due worktree per condividere il contesto, confrontare implementazioni o collaborare in tempo reale. Perfetto per rivedere le modifiche tra branch, condividere sessioni IA tra worktree o mantenere la coerenza lavorando su funzionalità correlate. Vedi aggiornamenti in tempo reale quando i worktree collegati cambiano.

## Perché Hive?

Scopri come Hive trasforma il tuo workflow git:

| Compito | Workflow tradizionale | Con Hive |
|------|---------------------|-----------|
| **Cambiare branch** | `git stash` → `git checkout` → `git stash pop` | Clic sul worktree → Fatto |
| **Lavorare su più funzionalità** | Stash costante e cambio di contesto | Apri più worktree affiancati |
| **Creare worktree** | `git worktree add ../project-feature origin/feature` | Clic "Nuovo Worktree" → Seleziona branch |
| **Assistenza IA per codificare** | Terminale + strumento IA separato + copia/incolla | Sessioni IA integrate con contesto completo |
| **Vedere le modifiche ai file** | `git status` → `git diff file.ts` | Albero visuale con diff in linea |
| **Confrontare branch** | Più schede terminale, copia/incolla | Collega worktree per condividere contesto |
| **Trovare un worktree** | `cd ~/projects/...` → ricordare nomi di directory | Tutti i worktree in una barra laterale |
| **Pulizia worktree** | `git worktree remove` → `rm -rf directory` | Clic "Archivia" ��� Gestisce tutto |

## Installazione

> 🍎 **Solo macOS** — Supporto Windows e Linux in arrivo.

### Via Homebrew (consigliato)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Download diretto

Scarica l'ultimo `.dmg` da [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

Tutto qui! Apri Hive dalla cartella Applicazioni e indirizzalo a un repository git.

## Avvio rapido

Inizia in meno di 2 minuti:

### 1️⃣ **Aggiungi il tuo primo progetto**
Apri Hive → Clic **"Add Project"** → Seleziona qualsiasi repository git sul tuo computer

### 2️⃣ **Crea un Worktree**
Seleziona il tuo progetto → Clic **"New Worktree"** → Scegli un branch (o creane uno nuovo)

### 3️⃣ **Inizia a codificare con l'IA**
Apri un worktree → Clic **"New Session"** → Inizia a codificare con OpenCode o Claude

> 💡 **Consiglio pro**: Premi `Cmd+K` in qualsiasi momento per aprire la palette dei comandi e navigare velocemente!

📖 [Leggi la guida completa](docs/GUIDE.md) | ⌨️ [Scorciatoie da tastiera](docs/SHORTCUTS.md)

## 🔌 Connessioni Worktree — La svolta

La funzionalità **Connessioni Worktree** di Hive ti permette di collegare due worktree insieme, creando un ponte tra branch o funzionalità diverse. È incredibilmente potente per workflow di sviluppo che richiedono consapevolezza tra branch.

### Cosa sono le Connessioni Worktree?

Collega qualsiasi coppia di worktree per:
- **🔄 Condividere il contesto** - Accedi a file e modifiche di un altro branch istantaneamente
- **🤝 Collaborare** - Lavora su funzionalità correlate con aggiornamenti in tempo reale tra worktree
- **📊 Confrontare** - Vedi le differenze tra implementazioni affiancate
- **🎯 Referenziare** - Mantieni visibile il branch principale mentre lavori sulle funzionalità
- **🔗 Collegare funzionalità** - Collega branch frontend e backend per lo sviluppo full-stack
- **💬 Condividere sessioni IA** - Continua le conversazioni IA tra worktree diversi

### Come funziona

1. **Seleziona il Worktree sorgente** - Scegli il worktree in cui stai lavorando
2. **Collega alla destinazione** - Clicca l'icona di connessione e seleziona un altro worktree
3. **Collegamento bidirezionale** - Entrambi i worktree diventano consapevoli l'uno dell'altro
4. **Aggiornamenti in tempo reale** - Vedi le modifiche nei worktree collegati man mano che avvengono

### Funzionalità di connessione

- ✅ **Sincronizzazione in tempo reale** - Le modifiche ai file in un worktree appaiono nel pannello di connessione
- ✅ **Cambio rapido** - Passa tra worktree collegati con un clic
- ✅ **Vista differenze** - Confronta file tra worktree collegati
- ✅ **Terminale condiviso** - Esegui comandi che interessano entrambi i worktree
- ✅ **Contesto IA condiviso** - Le sessioni IA possono referenziare il codice del worktree collegato
- ✅ **Indicatori di stato** - Vedi lo stato della build, test e modifiche nei worktree collegati
- ✅ **Cronologia connessioni** - Traccia quali worktree erano collegati e quando
- ✅ **Suggerimenti intelligenti** - Hive suggerisce worktree rilevanti da collegare in base al tuo workflow

### Casi d'uso

**Sviluppo funzionalità**: Collega il tuo branch di funzionalità a main per garantire la compatibilità e vedere come si integrano le tue modifiche.

**Correzione bug**: Collega il worktree di correzione al branch di produzione per verificare che la correzione funzioni nel contesto.

**Revisioni del codice**: Collega i worktree del revisore e dell'autore per discutere le modifiche con contesto completo da entrambi i lati.

**Sviluppo full-stack**: Collega worktree frontend e backend per lavorare su API e interfaccia contemporaneamente con coordinazione perfetta.

**Refactoring**: Collega la vecchia e la nuova implementazione per garantire la parità delle funzionalità durante grandi refactoring.

## Guardalo in azione

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo Hive — orchestra agenti IA tra progetti" width="900" />
</div>

<details>
<summary><strong>Altri screenshot</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — sessione di codifica IA con git worktree" width="900" />
  <sub>Sessioni di codifica potenziate dall'IA con gestione integrata dei git worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Creazione di un nuovo worktree" width="900" />
  <sub>Crea e gestisci worktree visivamente</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Albero file con stato git" width="900" />
  <sub>Esplora file con indicatori di stato git in tempo reale</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Vetrina temi" width="900" />
  <sub>Temi splendidi per ogni preferenza</sub>
</div>

</details>

## Comunità e supporto

<div align="center">

[![Documentazione](https://img.shields.io/badge/📖_Documentazione-Leggi-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Segnala-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussioni](https://img.shields.io/badge/💬_Discussioni-Partecipa-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contribuire](https://img.shields.io/badge/🤝_Contribuire-Linee_guida-green?style=for-the-badge)](CONTRIBUTING.md)
[![Sicurezza](https://img.shields.io/badge/🔒_Sicurezza-Policy-orange?style=for-the-badge)](SECURITY.md)

</div>

### Ottieni aiuto

- 📖 Leggi la [documentazione](docs/) per guide dettagliate
- 🐛 [Segnala bug](https://github.com/morapelker/hive/issues/new?template=bug_report.md) con passaggi di riproduzione
- 💡 [Richiedi funzionalità](https://github.com/morapelker/hive/issues/new?template=feature_request.md) che vorresti vedere
- 💬 [Partecipa alle discussioni](https://github.com/morapelker/hive/discussions) per connetterti con la comunità
- 🔒 [Segnala vulnerabilità di sicurezza](SECURITY.md) in modo responsabile

### Risorse

- [Guida utente](docs/GUIDE.md) — Primi passi e tutorial
- [FAQ](docs/FAQ.md) — Domande frequenti e risoluzione problemi
- [Scorciatoie da tastiera](docs/SHORTCUTS.md) — Riferimento completo delle scorciatoie

## Roadmap

### 🚀 In arrivo

- **Supporto multipiattaforma** — Build per Windows e Linux
- **Sistema di plugin** — Estendi Hive con integrazioni personalizzate
- **Sincronizzazione cloud** — Sincronizza impostazioni, sessioni e modelli di connessione tra dispositivi
- **Funzionalità per team** — Condividi worktree e collabora in tempo reale
- **Visualizzazione grafo Git** — Cronologia visuale dei branch e merge
- **Profilazione prestazioni** — Strumenti integrati per l'ottimizzazione

### 🎯 Visione futura

- **Sviluppo remoto** — Sviluppo basato su SSH e container
- **Connessioni trilaterali** — Collega e unisci più branch visivamente
- **Integrazione CI/CD** — Monitoraggio GitHub Actions, GitLab CI, Jenkins
- **Automazione connessioni** — Auto-connessione di branch correlati basata su pattern
- **Modalità revisione codice** — Tipo di connessione speciale ottimizzato per le revisioni
- **Tracciamento tempo** — Analisi attività per worktree e per connessione

Vuoi influenzare la roadmap? [Partecipa alla discussione](https://github.com/morapelker/hive/discussions/categories/ideas) o [contribuisci](CONTRIBUTING.md)!

---

<details>
<summary><strong>Sviluppo</strong></summary>

### Prerequisiti

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (supporto worktree)

### Configurazione

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminale Ghostty (opzionale)

Hive include un terminale nativo opzionale alimentato da `libghostty` di [Ghostty](https://ghostty.org/). Necessario solo se vuoi lavorare sulla funzionalità del terminale integrato.

**Configurazione:**

1. Compila `libghostty` dal codice sorgente di Ghostty ([istruzioni di compilazione](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Questo produce `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Se il tuo repository Ghostty è in `~/Documents/dev/ghostty/`, la build lo troverà automaticamente. Altrimenti, imposta il percorso:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Ricompila l'addon nativo:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Se `libghostty` non è disponibile, Hive si compila e funziona ugualmente — la funzionalità del terminale Ghostty sarà semplicemente disabilitata.

### Comandi

| Comando           | Descrizione           |
| ----------------- | --------------------- |
| `pnpm dev`        | Avvio con hot reload |
| `pnpm build`      | Build di produzione      |
| `pnpm lint`       | Controllo ESLint          |
| `pnpm lint:fix`   | Auto-correzione ESLint       |
| `pnpm format`     | Formattazione Prettier       |
| `pnpm test`       | Esegui tutti i test         |
| `pnpm test:watch` | Modalità osservazione            |
| `pnpm test:e2e`   | Test E2E Playwright  |
| `pnpm build:mac`  | Pacchetto per macOS     |

### Architettura

Hive usa il modello a tre processi di Electron con sandboxing rigoroso:

```
┌─────────────────────────────────────────────────────┐
│                  Processo principale                  │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
│  │ Service   │ │ Service  │ │  (Sessioni IA)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  Gestori IPC  │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ IPC tipizzato
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Ponte)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ API window.*
┌──────────────────────┼──────────────────────────────┐
│                Processo di rendering                  │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Componenti      │   │
│  │ Stores    │ │ ui       │ │  (14 domini)      │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Struttura del progetto

```
src/
├── main/                  # Processo principale Electron (Node.js)
│   ├── db/                # Database SQLite + schema + migrazioni
│   ├── ipc/               # Moduli gestori IPC
│   └── services/          # Git, OpenCode, logger, servizi file
├── preload/               # Livello ponte (API window.* tipizzate)
└── renderer/src/          # React SPA
    ├── components/        # UI organizzata per dominio
    ├── hooks/             # Hook React personalizzati
    ├── lib/               # Utilità, temi, helper
    └── stores/            # Gestione dello stato Zustand
```

### Stack tecnologico

| Livello     | Tecnologia                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Linguaggio  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Stile   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Stato     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (modalità WAL)          |
| IA        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentazione

La documentazione dettagliata si trova in [`docs/`](docs/):

- **[PRD](docs/prd/)** -- Requisiti di prodotto
- **[Implementazione](docs/implementation/)** -- Guide tecniche
- **[Specifiche](docs/specs/)** -- Specifiche delle funzionalità
- **[Piani](docs/plans/)** -- Piani di implementazione attivi

</details>

## Contribuire

Adoriamo i contributi! Hive è fatto da sviluppatori, per sviluppatori, e accogliamo miglioramenti di ogni tipo.

### Modi per contribuire

- 🐛 **Segnala bug** con passaggi di riproduzione chiari
- 💡 **Suggerisci funzionalità** che migliorerebbero il tuo workflow
- 📝 **Migliora la documentazione** per aiutare gli altri a iniziare
- 🎨 **Invia miglioramenti UI/UX** per una migliore usabilità
- 🔧 **Correggi bug** dal nostro issue tracker
- ⚡ **Ottimizza le prestazioni** nei percorsi critici
- 🧪 **Aggiungi test** per migliorare la copertura
- 🌐 **Traduci** l'app nella tua lingua

Prima di contribuire, leggi le nostre [Linee guida per contribuire](CONTRIBUTING.md) e il [Codice di condotta](CODE_OF_CONDUCT.md).

### Guida rapida alla contribuzione

1. Fai fork del repository
2. Crea un branch per la funzionalità (`git checkout -b feature/amazing-feature`)
3. Apporta le tue modifiche
4. Esegui i test (`pnpm test`) e il linting (`pnpm lint`)
5. Fai commit con un messaggio descrittivo
6. Fai push al tuo fork
7. Apri una Pull Request

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) per linee guida dettagliate.

## Licenza

[MIT](LICENSE) © 2024 morapelker

Hive è software open source con licenza MIT. Consulta il file [LICENSE](LICENSE) per i dettagli completi.
