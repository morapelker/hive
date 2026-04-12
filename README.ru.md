<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Оркестратор ИИ-агентов с открытым исходным кодом для параллельной разработки между проектами.</strong></p>
  <p>Запускайте сессии Claude Code, OpenCode и Codex параллельно. Одно окно. Изолированные ветки. Никакого хаоса вкладок.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md"><strong>Русский</strong></a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Последний релиз" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Загрузки" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Статус сборки" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-supported-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-41-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Лицензия" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR приветствуются" /></a>
  </p>
</div>

---

## Содержание

- [Установка](#установка)
- [Что такое Hive?](#что-такое-hive)
- [Возможности](#возможности)
- [Почему Hive?](#почему-hive)
- [Быстрый старт](#быстрый-старт)
- [Соединения — Революция](#-соединения---революция)
- [Скриншоты](#скриншоты)
- [Сообщество и поддержка](#сообщество-и-поддержка)
- [Дорожная карта](#дорожная-карта)
- [Разработка](#разработка)
- [Участие](#участие)
- [Лицензия](#лицензия)

## Установка

Hive поддерживает macOS, Windows и Linux.

### macOS

#### Homebrew (рекомендуется)

```bash
brew install --cask hive-app
```

#### Прямая загрузка

Скачайте последний `.dmg` с [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

### Windows

Скачайте последний `.exe` с [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

### Linux

Скачайте последний `.AppImage` или `.deb` с [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

---

Вот и всё! Откройте Hive и укажите на git-репозиторий.

## Что такое Hive?

Если вы запускаете несколько ИИ-агентов для кодирования в разных проектах и ветках, вы знаете эту боль — шесть открытых вкладок терминала, вы не помните, какой агент над чем работает, и беспокоитесь, что два из них редактируют одни и те же файлы.

Hive — это оркестратор ИИ-агентов. Все запущенные агенты видны в одной боковой панели, переключение между ними одним кликом, и каждый работает в изолированной ветке git worktree, поэтому конфликты исключены. Подключайте несколько репозиториев, чтобы одна сессия агента имела контекст всего вашего стека.

## Возможности

### 🌳 **Workflow на основе Worktree**
Работайте одновременно в нескольких ветках без stash или переключения. Создавайте, архивируйте и организуйте worktree одним кликом. Каждый worktree получает уникальное имя на основе города для лёгкой идентификации.

### 🤖 **Встроенные сессии ИИ-кодирования**
Запускайте ИИ-агентов для кодирования прямо внутри Hive с поддержкой **OpenCode**, **Claude Code** и **Codex**. Стримьте ответы в реальном времени, наблюдайте за вызовами инструментов и одобряйте разрешения по мере необходимости. Полная поддержка отмены/повтора даёт вам контроль.

### 📁 **Умный файловый менеджер**
Видите изменения с первого взгляда благодаря индикаторам статуса git в реальном времени. Просматривайте diff прямо в дереве, изучайте историю файлов и навигируйте по кодовой базе, не покидая приложения. Встроенный редактор Monaco обеспечивает полноценный опыт уровня VS Code.

### 🔧 **Полная интеграция с Git**
Коммиты, push, pull и управление ветками визуально. Терминал не нужен для обычных git-операций. Смотрите ожидающие изменения, подготовленные файлы и историю коммитов в одном месте.

### 📦 **Пространства для организации**
Группируйте связанные проекты и worktree в логические рабочие пространства. Закрепляйте избранное для быстрого доступа. Поддерживайте порядок в среде разработки по мере роста.

### ⚡ **Палитра команд**
Быстрая навигация и действия с помощью горячих клавиш. Нажмите `Cmd+K`, чтобы мгновенно получить доступ к любой функции. Ищите сессии, переключайте worktree или выполняйте команды без мыши.

### 🎨 **Красивые темы**
Выбирайте из 10 тщательно проработанных тем — 6 тёмных и 4 светлые. Мгновенное переключение под ваши предпочтения или время суток. Автоматическое следование системной теме по желанию.

### 🔌 **Соединения Worktree**
Соедините два worktree для совместного использования контекста, сравнения реализаций или совместной работы в реальном времени. Идеально для ревью изменений между ветками, обмена ИИ-сессиями между worktree или поддержания согласованности при работе над связанными функциями. Видите обновления в реальном времени при изменении соединённых worktree.

## Почему Hive?

Посмотрите, как Hive преображает ваш git-workflow:

| Задача | Традиционный workflow | С Hive |
|------|---------------------|-----------|
| **Сменить ветку** | `git stash` → `git checkout` → `git stash pop` | Клик по worktree → Готово |
| **Работа над несколькими фичами** | Постоянный stash и переключение контекста | Откройте несколько worktree рядом |
| **Создать worktree** | `git worktree add ../project-feature origin/feature` | Клик «Новый Worktree» → Выберите ветку |
| **ИИ-помощь в кодировании** | Терминал + отдельный ИИ-инструмент + копировать/вставить | Встроенные ИИ-сессии с полным контекстом |
| **Просмотр изменений файлов** | `git status` → `git diff file.ts` | Визуальное дерево с инлайн-diff |
| **Сравнение веток** | Несколько вкладок терминала, копировать/вставить | Соедините worktree для общего контекста |
| **Найти worktree** | `cd ~/projects/...` → помнить имена директорий | Все worktree в одной боковой панели |
| **Очистка worktree** | `git worktree remove` → `rm -rf directory` | Клик «Архивировать» → Всё делается автоматически |

## Быстрый старт

Начните работу менее чем за 2 минуты:

### 1️⃣ **Добавьте первый проект**
Откройте Hive → Нажмите **«Add Project»** → Выберите любой git-репозиторий на вашем компьютере

### 2️⃣ **Создайте Worktree**
Выберите проект → Нажмите **«New Worktree»** → Выберите ветку (или создайте новую)

### 3️⃣ **Начните кодировать с ИИ**
Откройте worktree → Нажмите **«New Session»** → Начните кодировать с OpenCode, Claude или Codex

> 💡 **Совет профи**: Нажмите `Cmd+K` в любой момент, чтобы открыть палитру команд и быстро навигировать!

📖 [Читать полное руководство](docs/GUIDE.md) | ⌨️ [Горячие клавиши](docs/SHORTCUTS.md)

## 🔌 Соединения Worktree — Революция

Функция **Соединений Worktree** в Hive позволяет связать два worktree, создавая мост между разными ветками или функциями. Невероятно мощный инструмент для workflow, требующих межветочного осознания.

### Что такое Соединения Worktree?

Соедините любые два worktree для:
- **🔄 Совместный контекст** - Мгновенный доступ к файлам и изменениям другой ветки
- **🤝 Совместная работа** - Работа над связанными функциями с обновлениями в реальном времени
- **📊 Сравнение** - Просмотр различий между реализациями бок о бок
- **🎯 Справка** - Держите основную ветку на виду во время работы над функциями
- **🔗 Связывание функций** - Соедините фронтенд и бэкенд ветки для full-stack разработки
- **💬 Общие ИИ-сессии** - Продолжайте ИИ-разговоры между разными worktree

### Как это работает

1. **Выберите исходный Worktree** - Выберите worktree, в котором работаете
2. **Подключитесь к цели** - Кликните на иконку соединения и выберите другой worktree
3. **Двунаправленная связь** - Оба worktree узнают друг о друге
4. **Обновления в реальном времени** - Видите изменения в соединённых worktree по мере их возникновения

### Возможности соединений

- ✅ **Живая синхронизация** - Изменения файлов в одном worktree отображаются в панели соединений
- ✅ **Быстрое переключение** - Переход между соединёнными worktree одним кликом
- ✅ **Просмотр различий** - Сравнение файлов между соединёнными worktree
- ✅ **Общий терминал** - Выполнение команд, затрагивающих оба worktree
- ✅ **Общий ИИ-контекст** - ИИ-сессии могут ссылаться на код соединённого worktree
- ✅ **Индикаторы статуса** - Просмотр статуса сборки, тестов и изменений в соединённых worktree
- ✅ **История соединений** - Отслеживание, какие worktree были соединены и когда
- ✅ **Умные предложения** - Hive предлагает релевантные worktree для соединения на основе вашего workflow

### Примеры использования

**Разработка функций**: Соедините ветку функции с main для проверки совместимости и просмотра интеграции изменений.

**Исправление ошибок**: Соедините worktree исправления с продакшен-веткой для проверки работоспособности в контексте.

**Ревью кода**: Соедините worktree ревьюера и автора для обсуждения изменений с полным контекстом с обеих сторон.

**Full-stack разработка**: Соедините фронтенд и бэкенд worktree для одновременной работы над API и интерфейсом с идеальной координацией.

**Рефакторинг**: Соедините старую и новую реализации для обеспечения паритета функций при крупном рефакторинге.

## Смотрите в действии

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Демо Hive — оркестрация ИИ-агентов между проектами" width="900" />
</div>

<details>
<summary><strong>Больше скриншотов</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — ИИ-сессия кодирования с git worktree" width="900" />
  <sub>ИИ-сессии кодирования с интегрированным управлением git worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Создание нового worktree" width="900" />
  <sub>Визуальное создание и управление worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Дерево файлов со статусом git" width="900" />
  <sub>Файловый менеджер с индикаторами статуса git в реальном времени</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Витрина тем" width="900" />
  <sub>Красивые темы на любой вкус</sub>
</div>

</details>

## Сообщество и поддержка

<div align="center">

[![Документация](https://img.shields.io/badge/📖_Документация-Читать-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Сообщить-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Обсуждения](https://img.shields.io/badge/💬_Обсуждения-Присоединиться-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Участие](https://img.shields.io/badge/🤝_Участие-Руководство-green?style=for-the-badge)](CONTRIBUTING.md)
[![Безопасность](https://img.shields.io/badge/🔒_Безопасность-Политика-orange?style=for-the-badge)](SECURITY.md)

</div>

### Получить помощь

- 📖 Читайте [документацию](docs/) для подробных руководств
- 🐛 [Сообщайте об ошибках](https://github.com/morapelker/hive/issues/new?template=bug_report.md) с шагами воспроизведения
- 💡 [Запрашивайте функции](https://github.com/morapelker/hive/issues/new?template=feature_request.md), которые хотели бы видеть
- 💬 [Присоединяйтесь к обсуждениям](https://github.com/morapelker/hive/discussions) для связи с сообществом
- 🔒 [Сообщайте об уязвимостях безопасности](SECURITY.md) ответственно

### Ресурсы

- [Руководство пользователя](docs/GUIDE.md) — Начало работы и учебники
- [FAQ](docs/FAQ.md) — Частые вопросы и устранение проблем
- [Горячие клавиши](docs/SHORTCUTS.md) — Полный справочник по клавишам

## Дорожная карта

### 🚀 Скоро

- **Система плагинов** — Расширяйте Hive собственными интеграциями
- **Облачная синхронизация** — Синхронизация настроек, сессий и шаблонов соединений между устройствами
- **Командные функции** — Делитесь worktree и сотрудничайте в реальном времени
- **Визуализация графа Git** — Визуальная история веток и слияний
- **Профилирование производительности** — Встроенные инструменты оптимизации

### 🎯 Видение будущего

- **Удалённая разработка** — Разработка через SSH и контейнеры
- **Трёхсторонние соединения** — Визуальное соединение и слияние нескольких веток
- **Интеграция CI/CD** — Мониторинг GitHub Actions, GitLab CI, Jenkins
- **Автоматизация соединений** — Автосоединение связанных веток на основе паттернов
- **Режим ревью кода** — Специальный тип соединения, оптимизированный для ревью
- **Отслеживание времени** — Аналитика активности по worktree и соединениям

Хотите повлиять на дорожную карту? [Присоединяйтесь к обсуждению](https://github.com/morapelker/hive/discussions/categories/ideas) или [внесите вклад](CONTRIBUTING.md)!

---

<details>
<summary><strong>Разработка</strong></summary>

### Требования

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (поддержка worktree)

### Настройка

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Терминал Ghostty (опционально)

Hive включает опциональный нативный терминал на основе `libghostty` от [Ghostty](https://ghostty.org/). Требуется только для работы над встроенной функцией терминала.

**Настройка:**

1. Соберите `libghostty` из исходного кода Ghostty ([инструкции по сборке](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Это создаёт `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Если ваш репозиторий Ghostty находится в `~/Documents/dev/ghostty/`, сборка найдёт его автоматически. Иначе укажите путь:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Пересоберите нативный аддон:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Если `libghostty` недоступен, Hive всё равно собирается и запускается — функция терминала Ghostty просто будет отключена.

### Команды

| Команда           | Описание           |
| ----------------- | --------------------- |
| `pnpm dev`        | Запуск с hot reload |
| `pnpm build`      | Продакшен-сборка      |
| `pnpm lint`       | Проверка ESLint          |
| `pnpm lint:fix`   | Автоисправление ESLint       |
| `pnpm format`     | Форматирование Prettier       |
| `pnpm test`       | Запуск всех тестов         |
| `pnpm test:watch` | Режим наблюдения            |
| `pnpm test:e2e`   | E2E-тесты Playwright  |
| `pnpm build:mac`  | Пакет для macOS     |

### Архитектура

Hive использует трёхпроцессную модель Electron со строгой песочницей:

```
┌─────────────────────────────────────────────────────┐
│                  Главный процесс                     │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (ИИ-сессии)      │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Обработчики   │                       │
│              │     IPC       │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Типизированный IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │    (Мост)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ API window.*
┌──────────────────────┼──────────────────────────────┐
│               Процесс рендеринга                     │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Компоненты      │   │
│  │ Stores    │ │ ui       │ │  (14 доменов)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Структура проекта

```
src/
├── main/                  # Главный процесс Electron (Node.js)
│   ├── db/                # База данных SQLite + схема + миграции
│   ├── ipc/               # Модули обработчиков IPC
│   └── services/          # Git, AI agents, логгер, файловые сервисы
├── preload/               # Мостовой слой (типизированные API window.*)
└── renderer/src/          # React SPA
    ├── components/        # UI по доменам
    ├── hooks/             # Пользовательские React hooks
    ├── lib/               # Утилиты, темы, помощники
    └── stores/            # Управление состоянием Zustand
```

### Технологический стек

| Слой     | Технология                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Фреймворк | [Electron 41](https://www.electronjs.org/)                                       |
| Фронтенд  | [React 19](https://react.dev/)                                                   |
| Язык  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Стили   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Состояние     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| БД  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (режим WAL)          |
| ИИ        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Сборка     | [electron-vite](https://electron-vite.org/)                                      |

### Документация

Подробная документация в [`docs/`](docs/):

- **[PRD](docs/prd/)** -- Требования к продукту
- **[Реализация](docs/implementation/)** -- Технические руководства
- **[Спецификации](docs/specs/)** -- Спецификации функций
- **[Планы](docs/plans/)** -- Активные планы реализации

</details>

## Участие

Мы рады вкладам! Hive создан разработчиками для разработчиков, и мы приветствуем улучшения любого рода.

### Способы участия

- 🐛 **Сообщайте об ошибках** с чёткими шагами воспроизведения
- 💡 **Предлагайте функции**, которые улучшат ваш workflow
- 📝 **Улучшайте документацию**, помогая другим начать
- 🎨 **Присылайте улучшения UI/UX** для лучшей юзабилити
- 🔧 **Исправляйте ошибки** из нашего трекера
- ⚡ **Оптимизируйте производительность** критических путей
- 🧪 **Добавляйте тесты** для улучшения покрытия
- 🌐 **Переводите** приложение на ваш язык

Перед участием прочитайте наши [Руководство по участию](CONTRIBUTING.md) и [Кодекс поведения](CODE_OF_CONDUCT.md).

### Краткое руководство по участию

1. Форкните репозиторий
2. Создайте ветку функции (`git checkout -b feature/amazing-feature`)
3. Внесите изменения
4. Запустите тесты (`pnpm test`) и линтинг (`pnpm lint`)
5. Закоммитьте с описательным сообщением
6. Запушьте в свой форк
7. Откройте Pull Request

Подробнее в [CONTRIBUTING.md](CONTRIBUTING.md).

## Лицензия

[MIT](LICENSE) © 2024 morapelker

Hive — это программное обеспечение с открытым исходным кодом, лицензированное по лицензии MIT. Подробности в файле [LICENSE](LICENSE).
