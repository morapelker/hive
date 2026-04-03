<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Bộ điều phối AI agent mã nguồn mở cho lập trình song song trên nhiều dự án.</strong></p>
  <p>Chạy các phiên Claude Code, OpenCode và Codex song song. Một cửa sổ. Nhánh cô lập. Không hỗn loạn tab.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md"><strong>Tiếng Việt</strong></a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## Mục Lục

- [Hive là gì?](#hive-là-gì)
- [Tính năng](#tính-năng)
- [Tại sao chọn Hive?](#tại-sao-chọn-hive)
- [Cài đặt](#cài-đặt)
- [Khởi động nhanh](#khởi-động-nhanh)
- [Kết nối - Bước ngoặt](#-kết-nối---bước-ngoặt)
- [Ảnh chụp màn hình](#ảnh-chụp-màn-hình)
- [Cộng đồng & Hỗ trợ](#cộng-đồng--hỗ-trợ)
- [Lộ trình](#lộ-trình)
- [Phát triển](#phát-triển)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)

## Hive là gì?

Nếu bạn chạy nhiều AI coding agent trên các dự án và nhánh khác nhau, bạn hiểu nỗi khổ -- sáu tab terminal mở, không nhớ agent nào đang làm việc gì, và lo lắng hai trong số chúng đang sửa cùng một file.

Hive là bộ điều phối AI agent. Xem tất cả agent đang chạy trong một thanh bên, click để chuyển đổi giữa chúng, và mỗi agent chạy trên một nhánh worktree git cô lập nên không thể xung đột. Kết nối nhiều repository lại để một phiên agent duy nhất có ngữ cảnh trên toàn bộ stack công nghệ của bạn.

## Tính năng

### 🌳 **Quy trình làm việc Worktree-First**
Làm việc trên nhiều nhánh đồng thời mà không cần stash hay switch. Tạo, lưu trữ và tổ chức worktree chỉ bằng một click. Mỗi worktree được đặt tên thành phố duy nhất để dễ nhận biết.

### 🤖 **Phiên lập trình AI tích hợp**
Chạy AI coding agent trực tiếp trong Hive với hỗ trợ **OpenCode**, **Claude Code** và **Codex**. Xem phản hồi theo thời gian thực, theo dõi tool call thực thi, và phê duyệt quyền khi cần. Hỗ trợ undo/redo đầy đủ giúp bạn luôn kiểm soát.

### 📁 **Trình duyệt file thông minh**
Xem thay đổi tức thì với chỉ báo trạng thái git trực tiếp. Xem diff inline, duyệt lịch sử file, và điều hướng codebase mà không rời ứng dụng. Trình soạn thảo Monaco tích hợp cung cấp trải nghiệm VS Code đầy đủ.

### 🔧 **Tích hợp Git hoàn chỉnh**
Commit, push, pull và quản lý nhánh trực quan. Không cần terminal cho các thao tác git thông thường. Xem thay đổi đang chờ, file đã stage và lịch sử commit tất cả trong một nơi.

### 📦 **Space để tổ chức**
Nhóm các dự án và worktree liên quan vào workspace logic. Ghim mục yêu thích để truy cập nhanh. Giữ môi trường phát triển gọn gàng khi bạn mở rộng.

### ⚡ **Bảng lệnh**
Điều hướng và hành động nhanh với phím tắt. Nhấn `Cmd+K` để truy cập bất kỳ tính năng nào ngay lập tức. Tìm kiếm phiên, chuyển worktree, hoặc chạy lệnh mà không cần chuột.

### 🎨 **Giao diện đẹp**
Chọn từ 10 theme được thiết kế cẩn thận — 6 tối và 4 sáng. Chuyển đổi ngay lập tức phù hợp với sở thích hoặc thời điểm trong ngày. Tự động theo theme hệ thống nếu muốn.

### 🖥️ **Language Server Protocol**
Tích hợp LSP đầy đủ với language server cho từng worktree. Nhận code completion thông minh, go-to-definition, hover tooltip và diagnostics thời gian thực cho TypeScript, Python, Go, Rust và nhiều hơn nữa.

### 🔌 **Kết nối Worktree**
Kết nối hai worktree lại để chia sẻ ngữ cảnh, so sánh implementation, hoặc cộng tác thời gian thực. Hoàn hảo cho việc review thay đổi giữa các nhánh, chia sẻ phiên AI giữa worktree, hoặc duy trì tính nhất quán khi làm việc trên các tính năng liên quan. Xem cập nhật trực tiếp khi worktree được kết nối thay đổi.

## Tại sao chọn Hive?

Xem cách Hive biến đổi quy trình git của bạn:

| Tác vụ | Quy trình truyền thống | Với Hive |
|------|---------------------|-----------|
| **Chuyển nhánh** | `git stash` → `git checkout` → `git stash pop` | Click vào worktree → Xong |
| **Làm nhiều tính năng** | Stash liên tục và chuyển ngữ cảnh | Mở nhiều worktree cạnh nhau |
| **Tạo worktree** | `git worktree add ../project-feature origin/feature` | Click "Worktree Mới" → Chọn nhánh |
| **Hỗ trợ AI coding** | Terminal + công cụ AI riêng + copy/paste | Phiên AI tích hợp với đầy đủ ngữ cảnh |
| **Xem thay đổi file** | `git status` → `git diff file.ts` | Cây trực quan với diff inline |
| **So sánh nhánh** | Nhiều tab terminal, copy/paste qua lại | Kết nối worktree để chia sẻ ngữ cảnh |
| **Tìm worktree** | `cd ~/projects/...` → nhớ tên thư mục | Tất cả worktree trong một thanh bên |
| **Dọn d���p worktree** | `git worktree remove` → `rm -rf directory` | Click "Lưu trữ" → Xử lý mọi thứ |

## Cài đặt

> 🍎 **Chỉ macOS** — Hỗ trợ Windows và Linux sắp ra mắt.

### Qua Homebrew (Khuyến nghị)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Tải trực tiếp

Tải file `.dmg` mới nhất từ [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

Vậy thôi! Mở Hive từ thư mục Applications và trỏ đến git repo.

## Khởi động nhanh

Bắt đầu trong dưới 2 phút:

### 1️⃣ **Thêm dự án đầu tiên**
Mở Hive → Click **"Thêm Dự Án"** → Chọn bất kỳ git repository nào trên máy

### 2️⃣ **Tạo Worktree**
Chọn dự án → Click **"Worktree Mới"** → Chọn nhánh (hoặc tạo mới)

### 3️⃣ **Bắt đầu lập trình với AI**
Mở worktree → Click **"Phiên Mới"** → Bắt đầu lập trình với OpenCode, Claude hoặc Codex

> 💡 **Mẹo chuyên gia**: Nhấn `Cmd+K` bất cứ lúc nào để mở bảng lệnh và điều hướng nhanh!

📖 [Đọc hướng dẫn đầy đủ](docs/GUIDE.md) | ⌨️ [Phím tắt](docs/SHORTCUTS.md)

## 🔌 Kết nối Worktree - Bước ngoặt

Tính năng **Kết nối Worktree** của Hive cho phép bạn liên kết hai worktree lại với nhau, tạo cầu nối giữa các nhánh hoặc tính năng khác nhau. Điều này cực kỳ mạnh mẽ cho quy trình phát triển cần nhận biết giữa các nhánh.

### Kết nối Worktree là gì?

Kết nối bất kỳ hai worktree nào để:
- **🔄 Chia sẻ ngữ cảnh** - Truy cập file và thay đổi từ nhánh khác ngay lập tức
- **🤝 Cộng tác** - Làm việc trên tính năng liên quan với cập nhật trực tiếp giữa các worktree
- **📊 So sánh** - Xem khác biệt giữa các implementation cạnh nhau
- **🎯 Tham chiếu** - Giữ nhánh chính hiển thị trong khi làm việc trên tính năng
- **🔗 Liên kết tính năng** - Kết nối nhánh frontend và backend cho phát triển full-stack
- **💬 Chia sẻ phiên AI** - Tiếp tục cuộc trò chuyện AI giữa các worktree khác nhau

### Cách hoạt động

1. **Chọn Worktree nguồn** - Chọn worktree bạn đang làm việc
2. **Kết nối đến đích** - Click biểu tượng kết nối và chọn worktree khác
3. **Liên kết hai chiều** - Cả hai worktree đều nhận biết lẫn nhau
4. **Cập nhật thời gian thực** - Xem thay đổi trong worktree được kết nối khi chúng xảy ra

### Tính năng kết nối

- ✅ **Đồng bộ trực tiếp** - Thay đổi file trong một worktree xuất hiện trong bảng kết nối
- ✅ **Chuyển nhanh** - Nhảy giữa worktree được kết nối chỉ một click
- ✅ **Xem Diff** - So sánh file giữa các worktree được kết nối
- ✅ **Terminal chia sẻ** - Chạy lệnh ảnh hưởng cả hai worktree
- ✅ **Chia sẻ ngữ cảnh AI** - Phiên AI có thể tham chiếu code worktree được kết nối
- ✅ **Chỉ báo trạng thái** - Xem trạng thái build, test và thay đổi trong worktree kết nối
- ✅ **Lịch sử kết nối** - Theo dõi worktree nào được kết nối và khi nào
- ✅ **Gợi ý thông minh** - Hive gợi ý worktree liên quan để kết nối dựa trên quy trình của bạn

### Ví dụ sử dụng

**Phát triển tính năng**: Kết nối nhánh tính năng với main để đảm bảo tương thích và xem thay đổi của bạn tích hợp thế nào.

**Sửa lỗi**: Kết nối worktree sửa lỗi với nhánh production để xác minh bản sửa hoạt động đúng ngữ cảnh.

**Review code**: Kết nối worktree của reviewer và author để thảo luận thay đổi với đầy đủ ngữ cảnh từ cả hai phía.

**Phát triển Full-Stack**: Kết nối worktree frontend và backend để làm việc trên API và UI đồng thời với phối hợp hoàn hảo.

**Tái cấu trúc**: Kết nối implementation cũ và mới để đảm bảo tương đồng tính năng trong quá trình refactor lớn.

## Xem Hive hoạt động

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo Hive — điều phối AI agent trên nhiều dự án" width="900" />
</div>

<details>
<summary><strong>Thêm ảnh chụp màn hình</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — phiên lập trình AI với git worktree" width="900" />
  <sub>Phiên lập trình AI với quản lý git worktree tích hợp</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Tạo worktree mới" width="900" />
  <sub>Tạo và quản lý worktree trực quan</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Cây file với trạng thái git" width="900" />
  <sub>Trình duyệt file với chỉ báo trạng thái git trực tiếp</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Trưng bày theme" width="900" />
  <sub>Giao diện đẹp cho mọi sở thích</sub>
</div>

</details>

## Cộng đồng & Hỗ trợ

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_Tài_liệu-Đọc-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Lỗi-Báo_cáo-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Thảo_luận-Tham_gia-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_Đóng_góp-Hướng_dẫn-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_Bảo_mật-Chính_sách-orange?style=for-the-badge)](SECURITY.md)

</div>

### Nhận trợ giúp

- 📖 Đọc [tài liệu](docs/) để xem hướng dẫn chi tiết
- 🐛 [Báo cáo lỗi](https://github.com/morapelker/hive/issues/new?template=bug_report.md) với các bước tái tạo
- 💡 [Yêu cầu tính năng](https://github.com/morapelker/hive/issues/new?template=feature_request.md) bạn muốn thấy
- 💬 [Tham gia thảo luận](https://github.com/morapelker/hive/discussions) để kết nối với cộng đồng
- 🔒 [Báo cáo lỗ hổng bảo mật](SECURITY.md) một cách có trách nhiệm

### Tài nguyên

- [Hướng dẫn sử dụng](docs/GUIDE.md) — Bắt đầu và hướng dẫn
- [FAQ](docs/FAQ.md) — Câu hỏi thường gặp và khắc phục sự cố
- [Phím tắt](docs/SHORTCUTS.md) — Tham chiếu phím tắt đầy đủ

## Lộ trình

### 🚀 Sắp ra mắt

- **Hỗ trợ đa nền tảng** — Build cho Windows và Linux
- **Hệ thống plugin** — Mở rộng Hive với tích hợp tùy chỉnh
- **Đồng bộ đám mây** — Đồng bộ cài đặt, phiên và mẫu kết nối giữa các thiết bị
- **Tính năng nhóm** — Chia sẻ worktree và cộng tác thời gian thực
- **Trực quan hóa đồ thị Git** — Lịch sử nhánh và merge trực quan
- **Profiling hiệu năng** — Công cụ tích hợp để tối ưu hóa

### 🎯 Tầm nhìn tương lai

- **Phát triển từ xa** — Phát triển dựa trên SSH và container
- **Kết nối ba chiều** — Kết nối và merge nhiều nhánh trực quan
- **Tích hợp CI/CD** — Giám sát GitHub Actions, GitLab CI, Jenkins
- **Tự động kết n��i** — Tự động kết nối nhánh liên quan theo mẫu
- **Chế độ review code** — Loại kết nối đặc biệt tối ưu cho review
- **Theo dõi thời gian** — Phân tích hoạt động cho từng worktree và kết nối

Muốn ảnh hưởng lộ trình? [Tham gia thảo luận](https://github.com/morapelker/hive/discussions/categories/ideas) hoặc [đóng góp](CONTRIBUTING.md)!

---

<details>
<summary><strong>Phát triển</strong></summary>

### Yêu cầu

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (hỗ trợ worktree)

### Cài đặt

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminal Ghostty (Tùy chọn)

Hive bao gồm terminal native tùy chọn được hỗ trợ bởi `libghostty` của [Ghostty](https://ghostty.org/). Chỉ cần thiết nếu bạn muốn làm việc trên tính năng terminal nhúng.

**Cài đặt:**

1. Build `libghostty` từ mã nguồn Ghostty ([hướng dẫn build](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Tạo ra `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Nếu repo Ghostty của bạn ở `~/Documents/dev/ghostty/`, build sẽ tìm tự động. Nếu không, đặt đường dẫn:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Rebuild native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Nếu `libghostty` không có sẵn, Hive vẫn build và chạy -- tính năng terminal Ghostty sẽ bị vô hiệu hóa.

### Lệnh

| Lệnh           | Mô tả           |
| ----------------- | --------------------- |
| `pnpm dev`        | Khởi chạy với hot reload |
| `pnpm build`      | Build production      |
| `pnpm lint`       | Kiểm tra ESLint          |
| `pnpm lint:fix`   | Tự động sửa ESLint       |
| `pnpm format`     | Format Prettier       |
| `pnpm test`       | Chạy tất cả test         |
| `pnpm test:watch` | Chế độ watch            |
| `pnpm test:e2e`   | Test Playwright E2E  |
| `pnpm build:mac`  | Đóng gói cho macOS     |

### Kiến trúc

Hive sử dụng mô hình ba tiến trình của Electron với sandbox nghiêm ngặt:

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

### Cấu trúc dự án

```
src/
├── main/                  # Tiến trình Electron chính (Node.js)
│   ├── db/                # Cơ sở dữ liệu SQLite + schema + migration
│   ├── ipc/               # Module xử lý IPC
│   └── services/          # Dịch vụ Git, AI agents, logger, file
├── preload/               # Lớp cầu nối (API window.* có kiểu)
└── renderer/src/          # Ứng dụng React SPA
    ├── components/        # UI tổ chức theo domain
    ├── hooks/             # React hook tùy chỉnh
    ├── lib/               # Tiện ích, theme, helper
    └── stores/            # Quản lý state Zustand
```

### Stack công nghệ

| Lớp     | Công nghệ                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Ngôn ngữ  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (chế độ WAL)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Tài liệu

Tài liệu chi tiết trong [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Yêu cầu sản phẩm
- **[Implementation](docs/implementation/)** -- Hướng dẫn kỹ thuật
- **[Specs](docs/specs/)** -- Đặc tả tính năng
- **[Plans](docs/plans/)** -- Kế hoạch triển khai đang hoạt động

</details>

## Đóng góp

Chúng tôi yêu thích đóng góp! Hive được xây dựng bởi developer, cho developer, và chúng tôi chào đón mọi cải tiến.

### Cách đóng góp

- 🐛 **Báo cáo lỗi** với các bước tái tạo rõ ràng
- 💡 **Đề xuất tính năng** cải thiện quy trình làm việc của bạn
- 📝 **Cải thiện tài liệu** để giúp người khác bắt đầu
- 🎨 **Gửi cải tiến UI/UX** cho khả năng sử dụng tốt hơn
- 🔧 **Sửa lỗi** từ issue tracker của chúng tôi
- ⚡ **T���i ưu hiệu năng** ở các đường dẫn quan trọng
- 🧪 **Thêm test** để cải thiện coverage
- 🌐 **Dịch** ứng dụng sang ngôn ngữ của bạn

Trước khi đóng góp, vui lòng đọc [Hướng dẫn đóng góp](CONTRIBUTING.md) và [Quy tắc ứng xử](CODE_OF_CONDUCT.md).

### Hướng dẫn đóng góp nhanh

1. Fork repository
2. Tạo nhánh tính năng (`git checkout -b feature/amazing-feature`)
3. Thực hiện thay đổi
4. Chạy test (`pnpm test`) và linting (`pnpm lint`)
5. Commit với thông điệp mô tả
6. Push lên fork của bạn
7. Mở Pull Request

Xem [CONTRIBUTING.md](CONTRIBUTING.md) để biết hướng dẫn chi tiết.

## Giấy phép

[MIT](LICENSE) © 2024 morapelker

Hive là phần mềm mã nguồn mở được cấp phép theo Giấy phép MIT. Xem file [LICENSE](LICENSE) để biết chi tiết đầy đủ.
