<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Оркестратор AI-агентів з відкритим кодом для паралельного програмування між проєктами.</strong></p>
  <p>Запускайте сесії Claude Code, OpenCode та Codex паралельно. Одне вікно. Ізольовані гілки. Жодного хаосу вкладок.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md"><strong>Українська</strong></a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Останній реліз" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Завантаження" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Статус збірки" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Ліцензія" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR вітаються" /></a>
  </p>
</div>

---

## Зміст

- [Що таке Hive?](#що-таке-hive)
- [Можливості](#можливості)
- [Чому Hive?](#чому-hive)
- [Встановлення](#встановлення)
- [Швидкий старт](#швидкий-старт)
- [З'єднання — Революція](#-зєднання---революція)
- [Скріншоти](#скріншоти)
- [Спільнота та підтримка](#спільнота-та-підтримка)
- [Дорожня карта](#дорожня-карта)
- [Розробка](#розробка)
- [Внесок](#внесок)
- [Ліцензія](#ліцензія)

## Що таке Hive?

Якщо ви запускаєте кількох AI-агентів для кодування в різних проєктах і гілках, ви знаєте цей біль — шість відкритих вкладок терміналу, ви не пам'ятаєте, який агент над чим працює, і хвилюєтесь, що двоє з них редагують ті самі файли.

Hive — це оркестратор AI-агентів. Бачите всіх запущених агентів в одній бічній панелі, клацаєте для перемикання між ними, і кожен працює в ізольованій гілці git worktree, тому вони не можуть конфліктувати. Підключайте кілька репозиторіїв, щоб одна сесія агента мала контекст усього вашого стеку.

## Можливості

### 🌳 **Workflow на основі Worktree**
Працюйте одночасно в кількох гілках без stash або перемикання. Створюйте, архівуйте та організовуйте worktree одним клацанням. Кожен worktree отримує унікальне ім'я на основі міста для легкої ідентифікації.

### 🤖 **Вбудовані сесії AI-кодування**
Запускайте AI-агентів для кодування прямо в Hive з підтримкою **OpenCode**, **Claude Code** та **Codex**. Стрімте відповіді в реальному часі, спостерігайте за викликами інструментів та затверджуйте дозволи за потреби. Повна підтримка скасування/повтору тримає вас під контролем.

### 📁 **Розумний файловий менеджер**
Бачте зміни з першого погляду завдяки індикаторам статусу git в реальному часі. Переглядайте diff прямо в дереві, вивчайте історію файлів та навігуйте кодовою базою, не залишаючи додатка. Вбудований редактор Monaco забезпечує повноцінний досвід рівня VS Code.

### 🔧 **Повна інтеграція з Git**
Комміти, push, pull та керування гілками візуально. Термінал не потрібен для звичайних git-операцій. Дивіться очікувані зміни, підготовлені файли та історію комітів в одному місці.

### 📦 **Простори для організації**
Групуйте пов'язані проєкти та worktree в логічні робочі простори. Закріплюйте обрані для швидкого доступу. Підтримуйте порядок у середовищі розробки зі зростанням.

### ⚡ **Палітра команд**
Швидка навігація та дії за допомогою гарячих клавіш. Натисніть `Cmd+K`, щоб миттєво отримати доступ до будь-якої функції. Шукайте сесії, перемикайте worktree або виконуйте команди без миші.

### 🎨 **Гарні теми**
Обирайте з 10 ретельно розроблених тем — 6 темних і 4 світлі. Миттєве перемикання під ваші вподобання або час доби. Автоматичне слідування системній темі за бажанням.

### 🖥️ **Language Server Protocol**
Повна інтеграція LSP з мовними сер��ерами для кожного worktree. Інтелектуальне автодоповнення коду, перехід до визначення, підказки при наведенні та діагностика в реальному часі для TypeScript, Python, Go, Rust та інших.

### 🔌 **З'єднання Worktree**
З'єднайте два worktree для спільного використання контексту, порівняння реалізацій або співпраці в реальному часі. Ідеально для ревю змін між гілками, обміну AI-сесіями між worktree або підтримки узгодженості при роботі над пов'язаними функціями. Бачте оновлення в реальному часі при зміні з'єднаних worktree.

## Чому Hive?

Подивіться, як Hive перетворює ваш git-workflow:

| Завдання | Традиційний workflow | З Hive |
|------|---------------------|-----------|
| **Змінити гілку** | `git stash` → `git checkout` → `git stash pop` | Клік по worktree → Готово |
| **Робота над кількома фічами** | Постійний stash і перемикання контексту | Відкрийте кілька worktree поруч |
| **Створити worktree** | `git worktree add ../project-feature origin/feature` | Клік «Новий Worktree» → Оберіть гілку |
| **AI-допомога в кодуванні** | Термінал + окремий AI-інструмент + копіювати/вставити | Вбудовані AI-сесії з повним контекстом |
| **Перегляд змін файлів** | `git status` → `git diff file.ts` | Візуальне дерево з інлайн-diff |
| **Порівняння гілок** | Кілька вкладок терміналу, копіювати/вставити | З'єднайте worktree для спільного контексту |
| **Знайти worktree** | `cd ~/projects/...` → пам'ятати імена директорій | Усі worktree в одній бічній панелі |
| **Очищення worktree** | `git worktree remove` → `rm -rf directory` | Клік «Архівувати» → Все робиться автоматично |

## Встановлення

> 🍎 **Тільки macOS** — Підтримка Windows та Linux незабаром.

### Через Homebrew (рекомендовано)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Пряме завантаження

Завантажте останній `.dmg` з [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

Ось і все! Відкрийте Hive з папки «Програми» та вкажіть на git-репозиторій.

## Швидкий старт

Почніть роботу менш ніж за 2 хвилини:

### 1️⃣ **Додайте перший проєкт**
Відкрийте Hive → Натисніть **«Add Project»** → Оберіть будь-який git-репозиторій на вашому комп'ютері

### 2️⃣ **Створіть Worktree**
Оберіть проєкт → Натисніть **«New Worktree»** → Оберіть гілку (або створіть нову)

### 3️⃣ **Почніть кодувати з AI**
Відкрийте worktree → Натисніть **«New Session»** → Почніть кодувати з OpenCode, Claude або Codex

> 💡 **Порада**: Натисніть `Cmd+K` будь-коли, щоб відкрити палітру команд і швидко навігувати!

📖 [Читати повний посібник](docs/GUIDE.md) | ⌨️ [Гарячі клавіші](docs/SHORTCUTS.md)

## 🔌 З'єднання Worktree — Революція

Функція **З'єднань Worktree** в Hive дозволяє зв'язати два worktree, створюючи міст між різними гілками або функціями. Неймовірно потужний інструмент для workflow, що потребують міжгілкової обізнаності.

### Що таке З'єднання Worktree?

З'єднайте будь-які два worktree для:
- **🔄 Спільний контекст** - Миттєвий доступ до файлів та змін іншої гілки
- **🤝 Співпраця** - Робота над пов'язаними функціями з оновленнями в реальному часі
- **📊 Порівняння** - Перегляд відмінностей між реалізаціями пліч-о-пліч
- **🎯 Довідка** - Тримайте основну гілку на виду під час роботи над функціями
- **🔗 Зв'язування функцій** - З'єднайте фронтенд та бекенд гілки для full-stack розробки
- **💬 Спільні AI-сесії** - Продовжуйте AI-розмови між різними worktree

### Як це працює

1. **Оберіть вихідний Worktree** - Оберіть worktree, в якому працюєте
2. **Підключіться до цілі** - Клацніть на іконку з'єднання та оберіть інший worktree
3. **Двонаправлений зв'язок** - Обидва worktree дізнаються один про одного
4. **Оновлення в реальному часі** - Бачте зміни в з'єднаних worktree в міру їх виникнення

### Можливості з'єднань

- ✅ **Жива синхронізація** - Зміни файлів в одному worktree відображаються в панелі з'єднань
- ✅ **Швидке перемикання** - Перехід між з'єднаними worktree одним клацанням
- ✅ **Перегляд відмінностей** - Порівняння файлів між з'єднаними worktree
- ✅ **Спільний термінал** - Виконання команд, що впливають на обидва worktree
- ✅ **Спільний AI-контекст** - AI-сесії можуть посилатися на код з'єднаного worktree
- ✅ **Індикатори статусу** - Перегляд статусу збірки, тестів та змін у з'єднаних worktree
- ✅ **Історія з'єднань** - Відстеження, які worktree були з'єднані і коли
- ✅ **Розумні пропозиції** - Hive пропонує релевантні worktree для з'єднання на основі вашого workflow

### Приклади використання

**Розробка функцій**: З'єднайте гілку функції з main для перевірки сумісності та перегляду інтеграції змін.

**Виправлення помилок**: З'єднайте worktree виправлення з продакшен-гілкою для перевірки працездатності в контексті.

**Ревю коду**: З'єднайте worktree рев'юера та автора для обговорення змін з повним контекстом з обох сторін.

**Full-stack розробка**: З'єднайте фронтенд та бекенд worktree для одночасної роботи над API та інтерфейсом з ідеальною координацією.

**Рефакторинг**: З'єднайте стару та нову реалізації для забезпечення паритету функцій при великому рефакторингу.

## Дивіться в дії

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Демо Hive — оркестрація AI-агентів між проєктами" width="900" />
</div>

<details>
<summary><strong>Більше скріншотів</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI-сесія кодування з git worktree" width="900" />
  <sub>AI-сесії кодування з інтегрованим керуванням git worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Створення нового worktree" width="900" />
  <sub>Візуальне створення та керування worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Дерево файлів зі статусом git" width="900" />
  <sub>Файловий менеджер з індикаторами статусу git в реальному часі</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Вітрина тем" width="900" />
  <sub>Гарні теми на будь-який смак</sub>
</div>

</details>

## Спільнота та підтримка

<div align="center">

[![Документація](https://img.shields.io/badge/📖_Документація-Читати-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Повідомити-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Обговорення](https://img.shields.io/badge/💬_Обговорення-Приєднатися-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Внесок](https://img.shields.io/badge/🤝_Внесок-Настанови-green?style=for-the-badge)](CONTRIBUTING.md)
[![Безпека](https://img.shields.io/badge/🔒_Безпека-Політика-orange?style=for-the-badge)](SECURITY.md)

</div>

### Отримати допомогу

- 📖 Читайте [документацію](docs/) для детальних посібників
- 🐛 [Повідомляйте про помилки](https://github.com/morapelker/hive/issues/new?template=bug_report.md) з кроками відтворення
- 💡 [Запитуйте функції](https://github.com/morapelker/hive/issues/new?template=feature_request.md), які хотіли б бачити
- 💬 [Приєднуйтесь до обговорень](https://github.com/morapelker/hive/discussions) для зв'язку зі спільнотою
- 🔒 [Повідомляйте про вразливості безпеки](SECURITY.md) відповідально

### Ресурси

- [Посібник користувача](docs/GUIDE.md) — Початок роботи та навчальні матеріали
- [FAQ](docs/FAQ.md) — Часті запитання та вирішення проблем
- [Гарячі клавіші](docs/SHORTCUTS.md) — Повний довідник по клавішах

## Дорожня карта

### 🚀 Незабаром

- **Кросплатформна підтримка** — Збірки для Windows та Linux
- **Система плагінів** — Розширюйте Hive власними інтеграціями
- **Хмарна синхронізація** — Синхронізація налаштувань, сесій та шаблонів з'єднань між пристроями
- **Командні функції** — Діліться worktree та співпрацюйте в реальному часі
- **Візуалізація графу Git** — Візуальна історія гілок та злиттів
- **Профілювання продуктивності** — Вбудовані інструменти оптимізації

### 🎯 Бачення майбутнього

- **Віддалена розробка** — Розробка через SSH та контейнери
- **Тристоронні з'єднання** — Візуальне з'єднання та злиття кількох гілок
- **Інтеграція CI/CD** — Моніторинг GitHub Actions, GitLab CI, Jenkins
- **Автоматизація з'єднань** — Автоз'єднання пов'язаних гілок на основі патернів
- **Режим ревю коду** — Спеціальний тип з'єднання, оптимізований для ревю
- **Відстеження часу** — Аналітика активності по worktree та з'єднаннях

Хочете вплинути на дорожню карту? [Приєднуйтесь до обговорення](https://github.com/morapelker/hive/discussions/categories/ideas) або [зробіть внесок](CONTRIBUTING.md)!

---

<details>
<summary><strong>Розробка</strong></summary>

### Вимоги

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (підтримка worktree)

### Налаштування

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Термінал Ghostty (опціонально)

Hive включає опціональний нативний термінал на основі `libghostty` від [Ghostty](https://ghostty.org/). Потрібен лише для роботи над вбудованою функцією терміналу.

**Налаштування:**

1. Зберіть `libghostty` з вихідного коду Ghostty ([інструкції зі збірки](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Це створює `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Якщо ваш репозиторій Ghostty знаходиться в `~/Documents/dev/ghostty/`, збірка знайде його автоматично. Інакше вкажіть шлях:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Перезберіть нативний аддон:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Якщо `libghostty` недоступний, Hive все одно збирається та запускається — функція терміналу Ghostty просто буде вимкнена.

### Команди

| Команда           | Опис           |
| ----------------- | --------------------- |
| `pnpm dev`        | Запуск з hot reload |
| `pnpm build`      | Продакшен-збірка      |
| `pnpm lint`       | Перевірка ESLint          |
| `pnpm lint:fix`   | Автовиправлення ESLint       |
| `pnpm format`     | Форматування Prettier       |
| `pnpm test`       | Запуск усіх тестів         |
| `pnpm test:watch` | Режим спостереження            |
| `pnpm test:e2e`   | E2E-тести Playwright  |
| `pnpm build:mac`  | Пакет для macOS     |

### Архітектура

Hive використовує трипроцесну модель Electron зі суворою пісочницею:

```
┌─────────────────────────────────────────────────────┐
│                  Головний процес                     │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AI-сесії)       │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Обробники IPC │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Типізований IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │    (Міст)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ API window.*
┌──────────────────────┼──────────────────────────────┐
│               Процес рендерингу                      │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Компоненти      │   │
│  │ Stores    │ │ ui       │ │  (14 доменів)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Структура проєкту

```
src/
├── main/                  # Головний процес Electron (Node.js)
│   ├── db/                # База даних SQLite + схема + міграції
│   ├── ipc/               # Модулі обробників IPC
│   └── services/          # Git, AI agents, логер, файлові сервіси
├── preload/               # Містковий шар (типізовані API window.*)
└── renderer/src/          # React SPA
    ├── components/        # UI по доменах
    ├── hooks/             # Користувацькі React hooks
    ├── lib/               # Утиліти, теми, помічники
    └── stores/            # Керування станом Zustand
```

### Технологічний стек

| Шар     | Технологія                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Фреймворк | [Electron 33](https://www.electronjs.org/)                                       |
| Фронтенд  | [React 19](https://react.dev/)                                                   |
| Мова  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Стилі   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Стан     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| БД  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (режим WAL)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Збірка     | [electron-vite](https://electron-vite.org/)                                      |

### Документація

Детальна документація в [`docs/`](docs/):

- **[PRD](docs/prd/)** -- Вимоги до продукту
- **[Реалізація](docs/implementation/)** -- Технічні посібники
- **[Специфікації](docs/specs/)** -- Специфікації функцій
- **[Плани](docs/plans/)** -- Активні плани реалізації

</details>

## Внесок

Ми раді внескам! Hive створений розробниками для розробників, і ми вітаємо покращення будь-якого роду.

### Способи внеску

- 🐛 **Повідомляйте про помилки** з чіткими кроками відтворення
- 💡 **Пропонуйте функції**, що покращать ваш workflow
- 📝 **Покращуйте документацію**, допомагаючи іншим розпочати
- 🎨 **Надсилайте покращення UI/UX** для кращої зручності
- 🔧 **Виправляйте помилки** з нашого трекера
- ⚡ **Оптимізуйте продуктивність** критичних шляхів
- 🧪 **Додавайте тести** для покращення покриття
- 🌐 **Перекладайте** додаток вашою мовою

Перед внеском прочитайте наші [Настанови щодо внеску](CONTRIBUTING.md) та [Кодекс поведінки](CODE_OF_CONDUCT.md).

### Короткий посібник з внеску

1. Форкніть репозиторій
2. Створіть гілку функції (`git checkout -b feature/amazing-feature`)
3. Внесіть зміни
4. Запустіть тести (`pnpm test`) та лінтинг (`pnpm lint`)
5. Закомітьте з описовим повідомленням
6. Запуште до свого форку
7. Відкрийте Pull Request

Детальніше в [CONTRIBUTING.md](CONTRIBUTING.md).

## Ліцензія

[MIT](LICENSE) © 2024 morapelker

Hive — це програмне забезпечення з відкритим кодом, ліцензоване за ліцензією MIT. Повні деталі у файлі [LICENSE](LICENSE).
