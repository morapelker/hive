<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>一款開源的 AI 代理協調器，實現跨專案的並行編碼。</strong></p>
  <p>平行執行 Claude Code、OpenCode 和 Codex 工作階段。單一視窗。隔離分支。零標籤頁混亂。</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md"><strong>繁體中文</strong></a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="最新版本" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="下載次數" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="建置狀態" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="授權" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="歡迎 PR" /></a>
  </p>
</div>

---

## 目錄

- [什麼是 Hive？](#什麼是-hive)
- [功能](#功能)
- [為什麼選擇 Hive？](#為什麼選擇-hive)
- [安裝](#安裝)
- [快速開始](#快速開始)
- [連接 — 革命性功能](#-連接---革命性功能)
- [截圖](#截圖)
- [社群與支援](#社群與支援)
- [路線圖](#路線圖)
- [開發](#開發)
- [貢獻](#貢獻)
- [授權](#授權)

## 什麼是 Hive？

如果你在不同的專案和分支上同時執行多個 AI 編碼代理，你一定知道那種痛苦 — 六個終端機標籤頁同時開著，記不住哪個代理在做什麼，還擔心其中兩個正在編輯同一個檔案。

Hive 是一個 AI 代理協調器。在一個側邊欄中看到所有正在執行的代理，點擊切換，每個代理都在隔離的 git worktree 分支上運行，因此不會發生衝突。連接多個儲存庫，讓單一代理工作階段擁有整個技術棧的上下文。

## 功能

### 🌳 **Worktree 優先工作流程**
同時在多個分支上工作，無需 stash 或切換。一鍵建立、封存和整理 worktree。每個 worktree 自動獲得基於城市的獨特名稱，方便辨識。

### 🤖 **內建 AI 編碼工作階段**
在 Hive 中直接執行 AI 編碼代理，支援 **OpenCode**、**Claude Code** 和 **Codex**。即時串流回應、觀察工具呼叫執行、按需核准權限。完整的復原/重做支援讓你始終掌握控制權。

### 📁 **智慧檔案總管**
透過即時 git 狀態指示器一目瞭然地看到變更。內嵌檢視差異、瀏覽檔案歷史、在不離開應用程式的情況下瀏覽程式碼庫。整合的 Monaco 編輯器提供完整的 VS Code 體驗。

### 🔧 **完整 Git 整合**
視覺化地提交、推送、拉取和管理分支。常見 git 操作無需終端機。在同一個地方查看待處理的變更、暫存的檔案和提交歷史。

### 📦 **空間組織**
將相關專案和 worktree 分組到邏輯工作區。釘選常用項目以快速存取。隨著規模增長保持開發環境整潔有序。

### ⚡ **命令面板**
使用鍵盤快捷鍵快速導覽和操作。按 `Cmd+K` 即可存取任何功能。搜尋工作階段、切換 worktree 或執行命令，無需觸碰滑鼠。

### 🎨 **精美主題**
從 10 個精心設計的主題中選擇 — 6 個深色和 4 個淺色。根據偏好或時段即時切換。可選擇自動跟隨系統主題。

### 🖥️ **Language Server Protocol**
完整的 LSP 整合，每個 worktree 配備專屬語言伺服器。為 TypeScript、Python、Go、Rust 等提供智慧程式碼補全、跳轉定義、懸停提示和即時診斷。

### 🔌 **Worktree 連接**
連接兩個 worktree 以共享上下文、比較實作或即時協作。非常適合檢視分支之間的變更、在 worktree 之間共享 AI 工作階段，或在處理相關功能時保持一致性。即時查看已連接 worktree 的變更。

## 為什麼選擇 Hive？

看看 Hive 如何改變你的 git 工作流程：

| 任務 | 傳統工作流程 | 使用 Hive |
|------|---------------------|-----------|
| **切換分支** | `git stash` → `git checkout` → `git stash pop` | 點擊 worktree → 完成 |
| **同時開發多個功能** | 不斷 stash 和切換上下文 | 並排開啟多個 worktree |
| **建立 worktree** | `git worktree add ../project-feature origin/feature` | 點擊「新 Worktree」→ 選擇分支 |
| **AI 編碼輔助** | 終端機 + 另外的 AI 工具 + 複製貼上 | 具備完整上下文的整合 AI 工作階段 |
| **查看檔案變更** | `git status` → `git diff file.ts` | 帶內嵌差異的視覺化樹狀結構 |
| **比較分支** | 多個終端機標籤頁、來回複製貼上 | 連接 worktree 共享上下文 |
| **尋找 worktree** | `cd ~/projects/...` → 記住目錄名稱 | 所有 worktree 集中在一個側邊欄 |
| **清理 worktree** | `git worktree remove` → `rm -rf directory` | 點擊「封存」→ 全部自動處理 |

## 安裝

> 🍎 **僅支援 macOS** — Windows 和 Linux 支援即將推出。

### 透過 Homebrew（推薦）

```bash
brew tap morapelker/hive
brew install --cask hive
```

### 直接下載

從 [GitHub Releases](https://github.com/morapelker/hive/releases/latest) 下載最新的 `.dmg`。

就是這樣！從「應用程式」資料夾開啟 Hive，指向一個 git 儲存庫即可。

## 快速開始

不到 2 分鐘即可上手：

### 1️⃣ **新增你的第一個專案**
開啟 Hive → 點擊 **「Add Project」** → 選擇電腦上的任何 git 儲存庫

### 2️⃣ **建立 Worktree**
選擇你的專案 → 點擊 **「New Worktree」** → 選擇一個分支（或建立新分支）

### 3️⃣ **用 AI 開始編碼**
開啟一個 worktree → 點擊 **「New Session」** → 使用 OpenCode、Claude 或 Codex 開始編碼

> 💡 **進階技巧**：隨時按 `Cmd+K` 開啟命令面板快速導覽！

📖 [閱讀完整指南](docs/GUIDE.md) | ⌨️ [鍵盤快捷鍵](docs/SHORTCUTS.md)

## 🔌 Worktree 連接 — 革命性功能

Hive 的 **Worktree 連接**功能讓你將兩個 worktree 連結在一起，在不同的分支或功能之間建立橋樑。對於需要跨分支感知的開發工作流程來說極為強大。

### 什麼是 Worktree 連接？

連接任意兩個 worktree 以：
- **🔄 共享上下文** - 即時存取另一個分支的檔案和變更
- **🤝 協作** - 在 worktree 之間即時更新，處理相關功能
- **📊 比較** - 並排查看實作之間的差異
- **🎯 參考** - 開發功能時保持主分支可見
- **🔗 連結功能** - 連接前端和後端分支進行全端開發
- **💬 共享 AI 工作階段** - 在不同 worktree 之間延續 AI 對話

### 運作方式

1. **選擇來源 Worktree** - 選擇你正在工作的 worktree
2. **連接到目標** - 點擊連接圖示並選擇另一個 worktree
3. **雙向連結** - 兩個 worktree 相互感知
4. **即時更新** - 即時看到已連接 worktree 的變更

### 連接功能

- ✅ **即時同步** - 一個 worktree 中的檔案變更會出現在連接面板中
- ✅ **快速切換** - 一鍵在已連接的 worktree 之間跳轉
- ✅ **差異檢視** - 比較已連接 worktree 之間的檔案
- ✅ **共享終端機** - 執行影響兩個 worktree 的命令
- ✅ **AI 上下文共享** - AI 工作階段可以參考已連接 worktree 的程式碼
- ✅ **狀態指示器** - 查看已連接 worktree 的建置狀態、測試和變更
- ✅ **連接歷史** - 追蹤哪些 worktree 曾經連接以及何時連接
- ✅ **智慧建議** - Hive 根據你的工作流程建議相關的 worktree 進行連接

### 使用案例

**功能開發**：將功能分支連接到 main 以確保相容性，查看變更如何整合。

**錯誤修復**：將錯誤修復 worktree 連接到生產分支，驗證修復在上下文中有效。

**程式碼審查**：連接審查者和作者的 worktree，雙方都能在完整上下文下討論變更。

**全端開發**：連接前端和後端 worktree，同時處理 API 和 UI，完美協調。

**重構**：連接新舊實作，在大規模重構期間確保功能一致性。

## 實際操作

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive 展示 — 跨專案協調 AI 代理" width="900" />
</div>

<details>
<summary><strong>更多截圖</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — AI 編碼工作階段與 git worktree" width="900" />
  <sub>AI 驅動的編碼工作階段，整合 git worktree 管理</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="建立新的 worktree" width="900" />
  <sub>視覺化建立和管理 worktree</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="帶 git 狀態的檔案樹" width="900" />
  <sub>帶有即時 git 狀態指示器的檔案總管</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="主題展示" width="900" />
  <sub>適合各種偏好的精美主題</sub>
</div>

</details>

## 社群與支援

<div align="center">

[![文件](https://img.shields.io/badge/📖_文件-閱讀-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-回報-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![討論](https://img.shields.io/badge/💬_討論-加入-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![貢獻](https://img.shields.io/badge/🤝_貢獻-指南-green?style=for-the-badge)](CONTRIBUTING.md)
[![安全性](https://img.shields.io/badge/🔒_安全性-政策-orange?style=for-the-badge)](SECURITY.md)

</div>

### 取得幫助

- 📖 閱讀[文件](docs/)取得詳細指南
- 🐛 附帶重現步驟[回報錯誤](https://github.com/morapelker/hive/issues/new?template=bug_report.md)
- 💡 [請求功能](https://github.com/morapelker/hive/issues/new?template=feature_request.md)你想要的功能
- 💬 [加入討論](https://github.com/morapelker/hive/discussions)與社群交流
- 🔒 負責任地[回報安全漏洞](SECURITY.md)

### 資源

- [使用者指南](docs/GUIDE.md) — 入門與教學
- [常見問題](docs/FAQ.md) — 常見問題與疑難排解
- [鍵盤快捷鍵](docs/SHORTCUTS.md) — 完整的快捷鍵參考

## 路線圖

### 🚀 即將推出

- **跨平台支援** — Windows 和 Linux 建置
- **外掛系統** — 使用自訂整合擴展 Hive
- **雲端同步** — 跨裝置同步設定、工作階段和連接範本
- **團隊功能** — 共享 worktree 並即時協作
- **Git 圖形視覺化** — 視覺化分支歷史和合併
- **效能分析** — 內建最佳化工具

### 🎯 未來願景

- **遠端開發** — 基於 SSH 和容器的開發
- **三方連接** — 視覺化連接和合併多個分支
- **CI/CD 整合** — GitHub Actions、GitLab CI、Jenkins 監控
- **連接自動化** — 基於模式自動連接相關分支
- **程式碼審查模式** — 為審查最佳化的特殊連接類型
- **時間追蹤** — 按 worktree 和連接的活動分析

想影響路線圖？[加入討論](https://github.com/morapelker/hive/discussions/categories/ideas)或[貢獻](CONTRIBUTING.md)！

---

<details>
<summary><strong>開發</strong></summary>

### 先決條件

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+（worktree 支援）

### 設定

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty 終端機（選用）

Hive 包含一個選用的原生終端機，由 [Ghostty](https://ghostty.org/) 的 `libghostty` 驅動。僅在需要開發內嵌終端機功能時才需要。

**設定：**

1. 從 Ghostty 原始碼建置 `libghostty`（[建置說明](https://ghostty.org/docs/install/build)）：
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   這會產生 `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`。

2. 如果你的 Ghostty 儲存庫位於 `~/Documents/dev/ghostty/`，建置會自動找到它。否則，設定路徑：
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. 重建原生附加元件：
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

如果 `libghostty` 不可用，Hive 仍然可以建置和執行 — Ghostty 終端機功能只是會被停用。

### 命令

| 命令           | 說明           |
| ----------------- | --------------------- |
| `pnpm dev`        | 以熱重載啟動 |
| `pnpm build`      | 正式環境建置      |
| `pnpm lint`       | ESLint 檢查          |
| `pnpm lint:fix`   | ESLint 自動修復       |
| `pnpm format`     | Prettier 格式化       |
| `pnpm test`       | 執行所有測試         |
| `pnpm test:watch` | 監視模式            |
| `pnpm test:e2e`   | Playwright E2E 測試  |
| `pnpm build:mac`  | macOS 打包     |

### 架構

Hive 使用 Electron 的三程序模型搭配嚴格沙箱：

```
┌─────────────────────────────────────────────────────┐
│                     主程序                            │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────���───────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AI 工作階段)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPC 處理器   │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ 型別化 IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │    (橋接)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* API
┌──────────────────────┼──────────────────────────────┐
│                  渲染程序                              │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │     元件           │   │
│  │ Stores    │ │ ui       │ │  (14 個領域)       │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 專案結構

```
src/
├── main/                  # Electron 主程序 (Node.js)
│   ├── db/                # SQLite 資料庫 + 結構描述 + 遷移
│   ├── ipc/               # IPC 處理器模組
│   └── services/          # Git、AI agents、日誌、檔案服務
├── preload/               # 橋接層（型別化 window.* API）
└── renderer/src/          # React SPA
    ├── components/        # 按領域組織的 UI
    ├── hooks/             # 自訂 React hooks
    ├── lib/               # 工具、主題、輔助函式
    └── stores/            # Zustand 狀態管理
```

### 技術棧

| 層級     | 技術                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| 框架 | [Electron 33](https://www.electronjs.org/)                                       |
| 前端  | [React 19](https://react.dev/)                                                   |
| 語言  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| 樣式   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| 狀態     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| 資料庫  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)（WAL 模式）          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| 建置     | [electron-vite](https://electron-vite.org/)                                      |

### 文件

詳細文件位於 [`docs/`](docs/)：

- **[PRD](docs/prd/)** -- 產品需求
- **[實作](docs/implementation/)** -- 技術指南
- **[規格](docs/specs/)** -- 功能規格
- **[計畫](docs/plans/)** -- 進行中的實作計畫

</details>

## 貢獻

我們歡迎貢獻！Hive 由開發者為開發者打造，我們歡迎各種改進。

### 貢獻方式

- 🐛 **回報錯誤** 附帶清晰的重現步驟
- 💡 **建議功能** 改善你的工作流程
- 📝 **改進文件** 幫助他人入門
- 🎨 **提交 UI/UX 改進** 提升可用性
- 🔧 **修復錯誤** 從我們的 issue 追蹤器
- ⚡ **效能最佳化** 關鍵路徑
- 🧪 **新增測試** 提升覆蓋率
- 🌐 **翻譯** 應用程式到你的語言

貢獻前，請閱讀我們的[貢獻指南](CONTRIBUTING.md)和[行為準則](CODE_OF_CONDUCT.md)。

### 快速貢獻指南

1. Fork 儲存庫
2. 建立功能分支 (`git checkout -b feature/amazing-feature`)
3. 進行你的變更
4. 執行測試 (`pnpm test`) 和程式碼檢查 (`pnpm lint`)
5. 以描述性訊息提交
6. 推送到你的 fork
7. 開啟 Pull Request

詳細指南請參閱 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 授權

[MIT](LICENSE) © 2024 morapelker

Hive 是根據 MIT 授權的開源軟體。完整詳情請參閱 [LICENSE](LICENSE) 檔案。
