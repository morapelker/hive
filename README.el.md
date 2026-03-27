<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Ένας ενορχηστρωτής AI agent ανοιχτού κώδικα για παράλληλη κωδικοποίηση σε πολλαπλά έργα.</strong></p>
  <p>Εκτελέστε συνεδρίες Claude Code, OpenCode και Codex παράλληλα. Ένα παράθυρο. Απομονωμένα branches. Μηδενικό χάος καρτελών.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md"><strong>Ελληνικά</strong></a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## Πίνακας Περιεχομένων

- [Τι είναι το Hive;](#τι-είναι-το-hive)
- [Χαρακτηριστικά](#χαρακτηριστικά)
- [Γιατί Hive;](#γιατί-hive)
- [Εγκατάσταση](#εγκατάσταση)
- [Γρήγορη εκκίνηση](#γρήγορη-εκκίνηση)
- [Συνδέσεις - Το μεγάλο πλεονέκτημα](#-συνδέσεις---το-μεγάλο-πλεονέκτημα)
- [Στιγμιότυπα οθόνης](#στιγμιότυπα-οθόνης)
- [Κοινότητα & Υποστήριξη](#κοινότητα--υποστήριξη)
- [Οδικός χάρτης](#οδικός-χάρτης)
- [Ανάπτυξη](#ανάπτυξη)
- [Συνεισφορά](#συνεισφορά)
- [Άδεια χρήσης](#άδεια-χρήσης)

## Τι είναι το Hive;

Αν εκτελείτε πολλαπλούς AI coding agents σε διαφορετικά έργα και branches, γνωρίζετε τον πόνο -- έξι καρτέλες τερματικού ανοιχτές, δεν θυμάστε ποιος agent δουλεύει σε τι, και ανησυχείτε ότι δύο από αυτούς επεξεργάζονται τα ίδια αρχεία.

Το Hive είναι ένας ενορχηστρωτής AI agent. Δείτε όλους τους τρέχοντες agents σε μία πλαϊνή μπάρα, κάντε κλικ για εναλλαγή μεταξύ τους, και ο καθένας εκτελείται σε ένα απομονωμένο git worktree branch ώστε να μην μπορούν να συγκρουστούν. Συνδέστε πολλαπλά repositories μαζί ώστε μία μόνο agent session να έχει context σε ολόκληρο το stack σας.

## Χαρακτηριστικά

### 🌳 **Worktree-First Ροή Εργασίας**
Εργαστείτε σε πολλαπλά branches ταυτόχρονα χωρίς stashing ή switching. Δημιουργήστε, αρχειοθετήστε και οργανώστε worktrees με ένα κλικ. Κάθε worktree παίρνει ένα μοναδικό όνομα βασισμένο σε πόλεις για εύκολη αναγνώριση.

### 🤖 **Ενσωματωμένες AI Coding Συνεδρίες**
Εκτελέστε AI coding agents απευθείας μέσα στο Hive με υποστήριξη τόσο για **OpenCode** όσο και για **Claude Code**. Παρακολουθήστε απαντήσεις σε πραγματικό χρόνο, δείτε tool calls να εκτελούνται, και εγκρίνετε δικαιώματα όπως χρειάζεται. Πλήρης υποστήριξη undo/redo σας κρατά στον έλεγχο.

### 📁 **Έξυπνος Εξερευνητής Αρχείων**
Δείτε τι άλλαξε με μια ματιά με live δείκτες κατάστασης git. Δείτε diffs inline, περιηγηθείτε στο ιστορικό αρχείων, και πλοηγηθείτε στον κώδικά σας χωρίς να φύγετε από την εφαρμογή. Ο ενσωματωμένος Monaco editor παρέχει πλήρη εμπειρία VS Code.

### 🔧 **Πλήρης Ενσωμάτωση Git**
Commit, push, pull και διαχείριση branches οπτικά. Δεν χρειάζεται τερματικό για κοινές git λειτουργίες. Δείτε εκκρεμείς αλλαγές, staged αρχεία και ιστορικό commits όλα σε ένα μέρος.

### 📦 **Spaces για Οργάνωση**
Ομαδοποιήστε σχετικά έργα και worktrees σε λογικούς χώρους εργασίας. Καρφιτσώστε τα αγαπημένα σας για γρήγορη πρόσβαση. Διατηρήστε το περιβάλλον ανάπτυξής σας οργανωμένο καθώς αναπτύσσεστε.

### ⚡ **Παλέτα Εντολών**
Πλοηγηθείτε και δράστε γρήγορα με συντομεύσεις πληκτρολογίου. Πατήστε `Cmd+K` για πρόσβαση σε οποιαδήποτε λειτουργία αμέσως. Αναζητήστε συνεδρίες, αλλάξτε worktrees, ή εκτελέστε εντολές χωρίς να αγγίξετε το ποντίκι.

### 🎨 **Όμορφα Θέματα**
Επιλέξτε από 10 προσεκτικά σχεδιασμένα θέματα — 6 σκούρα και 4 φωτεινά. Αλλάξτε αμέσως για να ταιριάξετε με τις προτιμήσει�� σας ή την ώρα της ημέρας. Ακολουθεί αυτόματα το θέμα του συστήματος αν το επιθυμείτε.

### 🖥️ **Language Server Protocol**
Πλήρης ενσωμάτωση LSP με language servers ανά worktree. Αποκτήστε έξυπνη συμπλήρωση κώδικα, go-to-definition, hover tooltips, και διαγνωστικά σε πραγματικό χρόνο για TypeScript, Python, Go, Rust και πολλά άλλα.

### 🔌 **Συνδέσεις Worktree**
Συνδέστε δύο worktrees μαζί για να μοιραστείτε context, να συγκρίνετε υλοποιήσεις, ή να συνεργαστείτε σε πραγματικό χρόνο. Ιδανικό για αναθεώρηση αλλαγών μεταξύ branches, κοινή χρήση AI συνεδριών σε worktrees, ή διατήρηση συνέπειας κατά την εργασία σε σχετικά χαρακτηριστικά. Δείτε ζωντανές ενημερώσεις όταν αλλάζουν τα συνδεδεμένα worktrees.

## Γιατί Hive;

Δείτε πώς το Hive μεταμορφώνει τη ροή εργασίας σας στο git:

| Εργασία | Παραδοσιακή ροή εργασίας | Με το Hive |
|------|---------------------|-----------|
| **Αλλαγή branch** | `git stash` → `git checkout` → `git stash pop` | Κλικ στο worktree → Έτοιμο |
| **Εργασία σε πολλά features** | Συνεχές stashing και αλλαγή context | Ανοίξτε πολλαπλά worktrees δίπλα-δίπλα |
| **Δημιουργία worktree** | `git worktree add ../project-feature origin/feature` | Κλικ "Νέο Worktree" → Επιλογή branch |
| **AI coding βοήθεια** | Τερματικό + ξεχωριστό AI εργαλείο + copy/paste | Ενσωματωμένες AI συνεδρίες με πλήρες context |
| **Προβολή αλλαγών αρχείων** | `git status` → `git diff file.ts` | Οπτικό δέντρο με inline diffs |
| **Σύγκριση branches** | Πολλαπλές καρτέλες τερματικού, copy/paste μεταξύ τους | Σύνδεση worktrees για κοινή χρήση context |
| **Εύρεση worktree** | `cd ~/projects/...` → θυμηθείτε ονόματα φακέλων | Όλα τα worktrees σε μία πλαϊνή μπάρα |
| **Καθαρισμός worktrees** | `git worktree remove` → `rm -rf directory` | Κλικ "Αρχειοθέτηση" → Χειρίζεται τα πάντα |

## Εγκατάσταση

> 🍎 **Μόνο macOS** — Υποστήριξη Windows και Linux σύντομα.

### Μέσω Homebrew (Συνιστάται)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Απευθείας Λήψη

Κατεβάστε το τελευταίο `.dmg` από τα [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

Αυτό ήταν! Ανοίξτε το Hive από τον φάκελο Εφαρμογών και κατευθύνετέ το σε ένα git repo.

## Γρήγορη εκκίνηση

Ξεκινήστε σε λιγότερο από 2 λεπτά:

### 1️⃣ **Προσθέστε το πρώτο σας έργο**
Ανοίξτε το Hive → Κλικ **"Προσθήκη Έργου"** → Επιλέξτε οποιοδήποτε git repository στον υπολογιστή σας

### 2️⃣ **Δημιουργήστε ένα Worktree**
Επιλέξτε το έργο σας → Κλικ **"Νέο Worktree"** → Επιλέξτε branch (ή δημιουργήστε νέο)

### 3️⃣ **Ξεκινήστε να κωδικοποιείτε με AI**
Ανοίξτε ένα worktree → Κλικ **"Νέα Συνεδρία"** → Ξεκινήστε να κωδικοποιείτε με OpenCode ή Claude

> 💡 **Συμβουλή**: Πατήστε `Cmd+K` οποτεδήποτε για να ανοίξετε την παλέτα εντολών και να πλοηγηθείτε γρήγορα!

📖 [Διαβάστε τον πλήρη οδηγό](docs/GUIDE.md) | ⌨️ [Συντομεύσεις πληκτρολογίου](docs/SHORTCUTS.md)

## 🔌 Συνδέσεις Worktree - Το μεγάλο πλεονέκτημα

Η λειτουργία **Συνδέσεων Worktree** του Hive σας επιτρέπει να συνδέσετε δύο worktrees μαζί, δημιουργώντας μια γέφυρα μεταξύ διαφορετικών branches ή features. Αυτό είναι απίστευτα ισχυρό για ροές ανάπτυξης που απαιτούν επίγνωση μεταξύ branches.

### Τι είναι οι Συνδέσεις Worktree;

Συνδέστε οποιαδήποτε δύο worktrees για:
- **🔄 Κοινή χρήση Context** - Πρόσβαση σε αρχεία και αλλαγές από άλλο branch αμέσως
- **🤝 Συνεργασία** - Εργαστείτε σε σχετικά features με ζωντανές ενημερώσεις μεταξύ worktrees
- **📊 Σύγκριση** - Δείτε διαφορές μεταξύ υλοποιήσεων δίπλα-δίπλα
- **🎯 Αναφορά** - Κρατήστε το main branch ορατό ενώ εργάζεστε σε features
- **🔗 Σύνδεση Features** - Συνδέστε frontend και backend branches για full-stack ανάπτυξη
- **💬 Κοινή χρήση AI Συνεδριών** - Συνεχίστε AI συνομιλίες σε διαφορετικά worktrees

### Πώς λειτουργεί

1. **Επιλέξτε το πηγαίο Worktree** - Επιλέξτε το worktree στο οποίο εργάζεστε
2. **Συνδεθείτε με τον στόχο** - Κλικ στο εικονίδιο σύνδεσης και επιλέξτε άλλο worktree
3. **Αμφίδρομη σύνδεση** - Και τα δύο worktrees γίνονται ενήμερα το ένα για το άλλο
4. **Ενημερώσεις σε πραγματικό χρόνο** - Δείτε αλλαγές σε συνδεδεμένα worktrees καθώς συμβαίνουν

### Χαρακτηριστικά Σύνδεσης

- ✅ **Ζωντανός συγχρονισμός** - Αλλαγές αρχείων σε ένα worktree εμφανίζονται στο πάνελ σύνδεσης
- ✅ **Γρήγορη εναλλαγή** - Μεταπηδήστε μεταξύ συνδεδεμένων worktrees με ένα κλικ
- ✅ **Προβολή Diff** - Συγκρίνετε αρχεία μεταξύ συνδεδεμένων worktrees
- ✅ **Κοινό τερματικό** - Εκτελέστε εντολές που επηρεάζουν και τα δύο worktrees
- ✅ **Κοινή χρήση AI Context** - Οι AI συνεδρίες μπορούν να αναφέρονται σε κώδικα συνδεδεμένου worktree
- ✅ **Δείκτες κατάστασης** - Δείτε κατάσταση build, tests και αλλαγές σε συνδεδεμένα worktrees
- ✅ **Ιστορικό συνδέσεων** - Παρακολουθήστε ποια worktrees ήταν συνδεδεμένα και πότε
- ✅ **Έξυπνες προτάσεις** - Το Hive προτείνει σχετικά worktrees για σύνδεση βάσει της ροής εργασίας σας

### Παραδείγματα Χρήσης

**Ανάπτυξη Features**: Συνδέστε το feature branch με το main για να εξασφαλίσετε συμβατότητα και να δείτε πώς ενσωματώνονται οι αλλαγές σας.

**Διορθώσεις Σφαλμάτων**: Συνδέστε το bugfix worktree με το production branch για να επαληθεύσετε ότι η διόρθωση λειτουργεί σε context.

**Αναθεώρηση Κώδικα**: Συνδέστε τα worktrees αναθεωρητή και συγγραφέα για να συζητήσετε αλλαγές με πλήρες context και από τις δύο πλευρές.

**Full-Stack Ανάπτυξη**: Συνδέστε frontend και backend worktrees για εργασία σε API και UI ταυτόχρονα με τέλειο συντονισμό.

**Αναδιάρθρωση**: Συνδέστε παλιές και νέες υλοποιήσεις για εξασφάλιση ισοτιμίας χαρακτηριστικών κατά τις μεγάλες αναδιαρθρώσεις.

## Δείτε το σε Δράση

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo Hive — ενορχηστρώστε AI agents σε πολλαπλά έργα" width="900" />
</div>

<details>
<summary><strong>Περισσότερα στιγμιότυπα</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI coding συνεδρία με git worktrees" width="900" />
  <sub>AI coding συνεδρίες με ενσωματωμένη διαχείριση git worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Δημιουργία νέου worktree" width="900" />
  <sub>Δημιουργήστε και διαχειριστείτε worktrees οπτικά</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Δέντρο αρχείων με git status" width="900" />
  <sub>Εξερευνητής αρχείων με ζωντανούς δείκτες κατάστασης git</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Επίδειξη θεμάτων" width="900" />
  <sub>Όμορφα θέματα για κάθε προτίμηση</sub>
</div>

</details>

## Κοινότητα & Υποστήριξη

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Τεκμηρίωση-Διαβάστε-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Ζητήματα-Αναφέρετε-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Συζητήσεις-Συμμετέχετε-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Συνεισφορά-Οδηγίες-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Ασφάλεια-Πολιτική-orange?style=for-the-badge)](SECURITY.md)

</div>

### Λάβετε Βοήθεια

- 📖 Διαβάστε την [τεκμηρίωση](docs/) για λεπτομερείς οδηγούς
- 🐛 [Αναφέρετε σφάλματα](https://github.com/morapelker/hive/issues/new?template=bug_report.md) με βήματα αναπαραγωγής
- 💡 [Ζητήστε χαρακτηριστικά](https://github.com/morapelker/hive/issues/new?template=feature_request.md) που θα θέλατε να δείτε
- 💬 [Συμμετέχετε στις συζητήσεις](https://github.com/morapelker/hive/discussions) για σύνδεση με την κοινότητα
- 🔒 [Αναφέρετε ευπάθειες ασφαλείας](SECURITY.md) υπεύθυνα

### Πόροι

- [Οδηγός χρήστη](docs/GUIDE.md) — Ξεκινώντας και εκπαιδευτικά
- [FAQ](docs/FAQ.md) — Συχνές ερωτήσεις και αντιμετώπιση προβλημάτων
- [Συντομεύσεις πληκτρολογίου](docs/SHORTCUTS.md) — Πλήρης αναφορά συντομεύσεων

## Οδικός Χάρτης

### 🚀 Έρχεται Σύντομα

- **Cross-platform υποστήριξη** — Windows και Linux builds
- **Σύστημα plugins** — Επεκτείνετε το Hive με προσαρμοσμένες ενσωματώσεις
- **Cloud συγχρονισμός** — Συγχρονίστε ρυθμίσεις, συνεδρίες και πρότυπα σύνδεσης σε όλες τις συσκευές
- **Χαρακτηριστικά ομάδας** — Μοιραστείτε worktrees και συνεργαστείτε σε πραγματικό χρόνο
- **Οπτικοποίηση γραφήματος Git** — Οπτικό ιστορικό branches και merges
- **Profiling απόδοσης** — Ενσωματωμένα εργαλεία βελτιστοποίησης

### 🎯 Μελλοντικό Όραμα

- **Απομακρυσμένη ανάπτυξη** — SSH και container-based ανάπτυξη
- **Τριπλές συνδέσεις** — Συνδέστε και συγχωνεύστε πολλαπλά branches οπτικά
- **Ενσωμάτωση CI/CD** — Παρακολούθηση GitHub Actions, GitLab CI, Jenkins
- **Αυτοματοποίηση συνδέσεων** — Αυτόματη σύνδεση σχετικών branches βάσει μοτίβων
- **Λειτουργία αναθεώρησης κώδικα** — Ειδικός τύπος σύνδεσης βελτιστοποιημένος για αναθεωρήσεις
- **Παρακολούθηση χρόνου** — Αναλυτικά δεδομένα δραστηριότητας ανά worktree και σύνδεση

Θέλετε να επηρεάσετε τον οδικό χάρτη; [Συμμετέχετε στη συζήτηση](https://github.com/morapelker/hive/discussions/categories/ideas) ή [συνεισφέρετε](CONTRIBUTING.md)!

---

<details>
<summary><strong>Ανάπτυξη</strong></summary>

### Προαπαιτούμενα

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (υποστήριξη worktree)

### Εγκατάσταση

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Τερματικό (Προαιρετικό)

Το Hive περιλαμβάνει ένα προαιρετικό native τερματικό που τροφοδοτείται από το `libghostty` του [Ghostty](https://ghostty.org/). Χρειάζεται μόνο αν θέλετε να εργαστείτε στη λειτουργία ενσωματωμένου τερματικού.

**Εγκατάσταση:**

1. Κάντε build το `libghostty` από τον πηγαίο κώδικα Ghostty ([οδηγίες build](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Αυτό παράγει `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Αν το Ghostty repo σας είναι στο `~/Documents/dev/ghostty/`, το build θα το βρει αυτόματα. Διαφορετικά, ορίστε τη διαδρομή:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Κάντε rebuild το native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Αν το `libghostty` δεν είναι διαθέσιμο, το Hive εξακολουθεί να κάνει build και να εκτελείται -- η λειτουργία τερματικού Ghostty απλώς θα είναι απενεργοποιημένη.

### Εντολές

| Εντολή           | Περιγραφή           |
| ----------------- | --------------------- |
| `pnpm dev`        | Εκκίνηση με hot reload |
| `pnpm build`      | Production build      |
| `pnpm lint`       | Έλεγχος ESLint          |
| `pnpm lint:fix`   | Αυτόματη διόρθωση ESLint       |
| `pnpm format`     | Μορφοποίηση Prettier       |
| `pnpm test`       | Εκτέλεση όλων των tests         |
| `pnpm test:watch` | Λειτουργία watch            |
| `pnpm test:e2e`   | Playwright E2E tests  |
| `pnpm build:mac`  | Πακετάρισμα για macOS     |

### Αρχιτεκτονική

Το Hive χρησιμοποιεί το μοντέλο τριών διεργασιών του Electron με αυστηρό sandboxing:

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

### Δομή Έργου

```
src/
├── main/                  # Κύρια διεργασία Electron (Node.js)
│   ├── db/                # Βάση δεδομένων SQLite + σχήμα + μεταναστεύσεις
│   ├── ipc/               # Modules χειρισμού IPC
│   └── services/          # Υπηρεσίες Git, OpenCode, logger, αρχείων
├── preload/               # Επίπεδο γέφυρας (τυποποιημένα window.* APIs)
└── renderer/src/          # React SPA
    ├── components/        # UI οργανωμένο ανά τομέα
    ├── hooks/             # Προσαρμοσμένα React hooks
    ├── lib/               # Βοηθητικά, θέματα, helpers
    └── stores/            # Zustand state management
```

### Tech Stack

| Επίπεδο     | Τεχνολογία                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Γλώσσα  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Βάση Δεδομένων  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (λειτουργία WAL)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Τεκμηρίωση

Λεπτομερής τεκμηρίωση στο [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Απαιτήσεις προϊόντος
- **[Υλοποίηση](docs/implementation/)** -- Τεχνικοί οδηγοί
- **[Προδιαγραφές](docs/specs/)** -- Προδιαγραφές χαρακτηριστικών
- **[Σχέδια](docs/plans/)** -- Ενεργά σχέδια υλοποίησης

</details>

## Συνεισφορά

Αγαπάμε τις συνεισφορές! Το Hive είναι φτιαγμένο από developers, για developers, και καλωσορίζουμε βελτιώσεις κάθε είδους.

### Τρόποι Συνεισφοράς

- 🐛 **Αναφέρετε σφάλματα** με σαφή βήματα αναπαραγωγής
- 💡 **Προτείνετε χαρακτηριστικά** που θα βελτιώσουν τη ροή εργασίας σας
- 📝 **Βελτιώστε την τεκμηρίωση** για να βοηθήσετε άλλους να ξεκινήσουν
- 🎨 **Υποβάλετε βελτιώσεις UI/UX** για καλύτερη χρηστικότητα
- 🔧 **Διορθώστε σφάλματα** από τον issue tracker μας
- ⚡ **Βελτιστοποιήστε την απόδοση** σε κρίσιμα σημεία
- 🧪 **Προσθέστε tests** για βελτίωση κάλυψης
- 🌐 **Μεταφράστε** την εφαρμογή στη γλώσσα σας

Πριν συνεισφέρετε, διαβάστε τις [Οδηγίες Συνεισφοράς](CONTRIBUTING.md) και τον [Κώδικα Δεοντολογίας](CODE_OF_CONDUCT.md).

### Γρήγορος Οδηγός Συνεισφοράς

1. Κάντε Fork το repository
2. Δημιουργήστε ένα feature branch (`git checkout -b feature/amazing-feature`)
3. Κάντε τις αλλαγές σας
4. Εκτελέστε tests (`pnpm test`) και linting (`pnpm lint`)
5. Κάντε commit με περιγραφικό μήνυμα
6. Κάντε push στο fork σας
7. Ανοίξτε ένα Pull Request

Δείτε [CONTRIBUTING.md](CONTRIBUTING.md) για λεπτομερείς οδηγίες.

## Άδεια ��ρήσης

[MIT](LICENSE) © 2024 morapelker

Το Hive είναι λογισμικό ανοιχτού κώδικα αδειοδοτημένο υπό την Άδεια MIT. Δείτε το αρχείο [LICENSE](LICENSE) για πλήρεις λεπτομέρειες.
