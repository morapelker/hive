<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>프로젝트 전반에 걸친 병렬 코딩을 위한 오픈소스 AI 에이전트 오케스트레이터</strong></p>
  <p>Claude Code, OpenCode, Codex 세션을 병렬로 실행. 하나의 창. 격리된 브랜치. 탭 혼란 제로.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md"><strong>한국어</strong></a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="최신 릴리스" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="다운로드" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="빌드 상태" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="라이선스" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR 환영" /></a>
  </p>
</div>

---

## 목차

- [Hive란?](#hive란)
- [기능](#기능)
- [왜 Hive인가?](#왜-hive인가)
- [설치](#설치)
- [빠른 시작](#빠른-시작)
- [커넥션 — 게임 체인저](#-커넥션---게임-체인저)
- [스크린샷](#스크린샷)
- [커뮤니티 & 지원](#커뮤니티--지원)
- [로드맵](#로드맵)
- [개발](#개발)
  - [사전 요구사항](#사전-요구사항)
  - [설정](#설정)
  - [명령어](#명령어)
  - [아키텍처](#아키텍처)
  - [프로젝트 구조](#프로젝트-구조)
  - [기술 스택](#기술-스택)
  - [문서](#문서)
- [기여하기](#기여하기)
- [라이선스](#라이선스)

## Hive란?

여러 프로젝트와 브랜치에서 AI 코딩 에이전트를 여러 개 실행해 본 적이 있다면, 그 고통을 알 것입니다 — 터미널 탭이 6개 열려 있고, 어떤 에이전트가 무엇을 하고 있는지 기억할 수 없으며, 두 에이전트가 같은 파일을 편집하고 있지 않은지 걱정됩니다.

Hive는 AI 에이전트 오케스트레이터입니다. 실행 중인 모든 에이전트를 하나의 사이드바에서 확인하고, 클릭으로 전환하며, 각 에이전트는 격리된 git worktree 브랜치에서 실행되어 충돌할 수 없습니다. 여러 리포지토리를 연결하여 하나의 에이전트 세션이 전체 스택의 컨텍스트를 가질 수 있습니다.

## 기능

### 🌳 **Worktree 우선 워크플로우**
스태시나 브랜치 전환 없이 여러 브랜치에서 동시에 작업하세요. 원클릭으로 Worktree를 생성, 아카이브, 정리. 각 Worktree는 쉽게 식별할 수 있도록 도시 이름 기반의 고유한 이름을 받습니다.

### 🤖 **내장 AI 코딩 세션**
**OpenCode**, **Claude Code**, **Codex**를 지원하여 Hive 내에서 직접 AI 코딩 에이전트를 실행. 실시간으로 응답을 스트리밍하고, 도구 호출 실행을 관찰하며, 필요에 따라 권한을 승인. 완전한 undo/redo 지원으로 항상 제어할 수 있습니다.

### 📁 **스마트 파일 탐색기**
라이브 git 상태 표시기로 변경 사항을 한눈에 확인. 인라인 diff 보기, 파일 히스토리 탐색, 앱을 떠나지 않고 코드베이스 탐색. 통합된 Monaco 에디터가 VS Code 수준의 경험을 제공합니다.

### 🔧 **완전한 Git 통합**
커밋, 푸시, 풀, 브랜치 관리를 시각적으로. 일반적인 git 작업에 터미널이 필요 없습니다. 보류 중인 변경, 스테이징된 파일, 커밋 히스토리를 한 곳에서 확인.

### 📦 **스페이스로 정리**
관련 프로젝트와 Worktree를 논리적 워크스페이스로 그룹화. 즐겨찾기를 고정하여 빠르게 접근. 규모가 커져도 개발 환경을 깔끔하게 유지.

### ⚡ **커맨드 팔레트**
키보드 단축키로 빠르게 탐색하고 실행. `Cmd+K`를 눌러 모든 기능에 즉시 접근. 마우스 없이 세션 검색, Worktree 전환, 명령 실행.

### 🎨 **아름다운 테마**
10가지 정성스럽게 제작된 테마 중 선택 — 다크 6종, 라이트 4종. 취향이나 시간대에 맞게 즉시 전환. 원하면 시스템 테마를 자동으로 따라갑니다.

### 🖥️ **Language Server Protocol**
Worktree별 언어 서버를 통한 완전한 LSP 통합. TypeScript, Python, Go, Rust 등에서 지능적인 코드 완성, 정의로 이동, 호버 툴팁, 실시간 진단을 이용할 수 있습니다.

### 🔌 **Worktree 커넥션**
두 Worktree를 연결하여 컨텍스트를 공유하고, 구현을 비교하거나, 실시간으로 협업. 브랜치 간 변경 리뷰, Worktree 간 AI 세션 공유, 관련 기능 작업 시 일관성 유지에 완벽합니다. 연결된 Worktree의 변경 사항을 라이브로 확인.

## 왜 Hive인가?

Hive가 git 워크플로우를 어떻게 변화시키는지 확인하세요:

| 작업 | 기존 워크플로우 | Hive 사용 시 |
|------|---------------------|-----------|
| **브랜치 전환** | `git stash` → `git checkout` → `git stash pop` | Worktree 클릭 → 완료 |
| **여러 기능 동시 작업** | 끊임없는 스태시와 컨텍스트 전환 | 여러 Worktree를 나란히 열기 |
| **Worktree 생성** | `git worktree add ../project-feature origin/feature` | "새 Worktree" 클릭 → 브랜치 선택 |
| **AI 코딩 지원** | 터미널 + 별도 AI 도구 + 복사/붙여넣기 | 완전한 컨텍스트의 통합 AI 세션 |
| **파일 변경 확인** | `git status` → `git diff file.ts` | 인라인 diff가 있는 비주얼 트리 |
| **브랜치 비교** | 여러 터미널 탭, 복사/붙여넣기 반복 | Worktree를 연결하여 컨텍스트 공유 |
| **Worktree 찾기** | `cd ~/projects/...` → 디렉토리 이름 기억하기 | 모든 Worktree가 하나의 사���드바에 |
| **Worktree 정리** | `git worktree remove` → `rm -rf directory` | "아카이브" 클릭 → 모든 것을 자동 처리 |

## 설치

> 🍎 **macOS 전용** — Windows와 Linux 지원은 곧 제공 예정입니다.

### Homebrew (권장)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### 직접 다운로드

최신 `.dmg`를 [GitHub Releases](https://github.com/morapelker/hive/releases/latest)에서 다운로드하세요.

끝입니다! 응용 프로그램 폴더에서 Hive를 열고 git 리포지토리를 지정하세요.

## 빠른 시작

2분 이내에 시작하세요:

### 1️⃣ **첫 번째 프로젝트 추가**
Hive 열기 → **"Add Project"** 클릭 → 컴퓨터의 아무 git 리포지토리 선택

### 2️⃣ **Worktree 생성**
프로젝트 선택 → **"New Worktree"** 클릭 → 브랜치 선택 (또는 새로 만들기)

### 3️⃣ **AI로 코딩 시작**
Worktree 열기 → **"New Session"** 클릭 → OpenCode, Claude, 또는 Codex로 코딩 시작

> 💡 **프로 팁**: 언제든 `Cmd+K`를 눌러 커맨드 팔레트를 열고 빠르게 탐색하세요!

📖 [전체 가이드 읽기](docs/GUIDE.md) | ⌨️ [키보드 단축키](docs/SHORTCUTS.md)

## 🔌 Worktree 커넥션 — 게임 체인저

Hive의 **Worktree 커넥션** 기능은 두 Worktree를 연결하여 서로 다른 브랜치나 기능 사이에 브리지를 만듭니다. 크로스 브랜치 인식이 필요한 개발 워크플로우에 매우 강력합니다.

### Worktree 커넥션이란?

아무 두 Worktree를 연결하여:
- **🔄 컨텍스트 공유** - 다른 브랜치의 파일과 변경에 즉시 접근
- **🤝 협업** - Worktree 간 라이브 업데이트로 관련 기능 작업
- **📊 비교** - 구현 차이를 나란히 보기
- **🎯 참조** - 기능 작업 중 메인 브랜치를 항상 볼 수 있게
- **🔗 기능 연결** - 풀스택 개발을 위해 프론트엔드와 백엔드 브랜치 연결
- **💬 AI 세션 공유** - 서로 다른 Worktree에서 AI 대화 계속

### 작동 방식

1. **소스 Worktree 선택** - 작업 중인 Worktree를 선택
2. **대상에 연결** - 연결 아이콘을 클릭하고 다른 Worktree 선택
3. **양방향 링크** - 두 Worktree가 서로를 인식
4. **실시간 업데이트** - 연결된 Worktree의 변경을 실시간으로 확인

### 커넥션 기능

- ✅ **라이브 동기화** - 한쪽 Worktree의 파일 변경이 커넥션 패널에 표시
- ✅ **빠른 전환** - 연결된 Worktree 간 원클릭으로 이동
- ✅ **차이 보기** - 연결된 Worktree 간 파일 비교
- ✅ **공유 터미널** - 두 Worktree에 영향을 주는 명령 실행
- ✅ **AI 컨텍스트 공유** - AI 세션이 연결된 Worktree의 코드를 참조 가능
- ✅ **상태 표시기** - 연결된 Worktree의 빌드 상태, 테스트, 변경 확인
- ✅ **커넥션 히스토리** - 어떤 Worktree가 언제 연결되었는지 추적
- ✅ **스마트 제안** - 워크플로우에 기반하여 관련 Worktree 연결 제안

### 사용 사례

**기능 개발**: 기능 브랜치를 main에 연결하여 호환성을 확인하고 변경 사항이 어떻게 통합되는지 확인.

**버그 수정**: 버그 수정 Worktree를 프로덕션 브랜치에 연결하여 수정이 컨텍스트에서 작동하는지 확인.

**코드 리뷰**: 리뷰어와 작성자의 Worktree를 연결하여 양쪽의 전체 컨텍스트로 변경 사항을 논의.

**풀스택 개발**: 프론트엔드와 백엔드 Worktree를 연결하여 완벽한 조율로 API와 UI를 동시에 작업.

**리팩토링**: 이전 구현과 새 구현을 연결하여 대규모 리팩토링 중 기능 동등성 확인.

## 직접 확인하기

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive 데모 — 프로젝트 전반의 AI 에이전트 오케스트레이션" width="900" />
</div>

<details>
<summary><strong>더 많은 스크린샷</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — git worktree와 AI 코딩 세션" width="900" />
  <sub>통합 git worktree 관리가 포함된 AI 기반 코딩 세션</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="새 Worktree 생성" width="900" />
  <sub>Worktree를 시각적으로 생성 및 관리</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="git 상태가 있는 파일 트리" width="900" />
  <sub>라이브 git 상태 표시기가 있는 파일 탐색기</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="테마 쇼케이스" width="900" />
  <sub>모든 취향에 맞는 아름다운 테마</sub>
</div>

</details>

## 커뮤니티 & 지원

<div align="center">

[![문서](https://img.shields.io/badge/📖_문서-읽기-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-보고하기-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Discussions-참여하기-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![기여하기](https://img.shields.io/badge/🤝_기여하기-가이드라인-green?style=for-the-badge)](CONTRIBUTING.md)
[![보안](https://img.shields.io/badge/🔒_보안-정책-orange?style=for-the-badge)](SECURITY.md)

</div>

### 도움 받기

- 📖 [문서](docs/)에서 자세한 가이드 읽기
- 🐛 재현 단계와 함께 [버그 보고](https://github.com/morapelker/hive/issues/new?template=bug_report.md)
- 💡 보고 싶은 [기능 요청](https://github.com/morapelker/hive/issues/new?template=feature_request.md)
- 💬 [Discussions 참여](https://github.com/morapelker/hive/discussions)로 커뮤니티와 연결
- 🔒 [보안 취약점 보고](SECURITY.md) (책임 있는 공개)

### 리소스

- [사용자 가이드](docs/GUIDE.md) — 시작하기와 튜토리얼
- [FAQ](docs/FAQ.md) — 자주 묻는 질문과 문제 해결
- [키보드 단축키](docs/SHORTCUTS.md) — 전체 단축키 참조

## 로드맵

### 🚀 곧 출시

- **크로스 플랫폼 지원** — Windows와 Linux 빌드
- **플러그인 시스템** — 커스텀 통합으로 Hive 확장
- **클라우드 동기화** — 설정, 세션, 연결 템플릿을 기기 간 동기화
- **팀 기능** — Worktree를 공유하고 실시간으로 협업
- **Git 그래프 시각화** — 비주얼 브랜치 히스토리와 머지
- **성능 프로파일링** — 최적화를 위한 내장 도구

### 🎯 미래 비전

- **원격 개발** — SSH 및 컨테이너 기반 개발
- **3자간 연결** — 여러 브랜치를 시각적으로 연결하고 머지
- **CI/CD 통합** — GitHub Actions, GitLab CI, Jenkins 모니터링
- **커넥션 자동화** — 패턴 기반 관련 브랜치 자동 연결
- **코드 리뷰 모드** — 리뷰에 최적화된 특별한 연결 타입
- **시간 추적** — Worktree별, 커넥션별 활동 분석

로드맵에 영향을 주고 싶으신가요? [토론에 참여](https://github.com/morapelker/hive/discussions/categories/ideas)하거나 [기여](CONTRIBUTING.md)하세요!

---

<details>
<summary><strong>개발</strong></summary>

### 사전 요구사항

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree 지원)

### 설정

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty 터미널 (선택사항)

Hive에는 [Ghostty](https://ghostty.org/)의 `libghostty`를 사용한 선택적 네이티브 터미널이 포함되어 있습니다. 내장 터미널 기능을 작업하려는 경우에만 필요합니다.

**설정:**

1. Ghostty 소스에서 `libghostty` 빌드 ([빌드 안내](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`가 생성됩니다.

2. Ghostty 리포지토리가 `~/Documents/dev/ghostty/`에 있으면 자동으로 찾습니다. 그렇지 않으면 경로를 설정:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. 네이티브 애드온 리빌드:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

`libghostty`를 사용할 수 없어도 Hive는 정상적으로 빌드되고 실행됩니다 — Ghostty 터미널 기능만 비활성화됩니다.

### 명령어

| 명령어           | 설명           |
| ----------------- | --------------------- |
| `pnpm dev`        | 핫 리로드로 시작 |
| `pnpm build`      | 프로덕션 빌드      |
| `pnpm lint`       | ESLint 검사          |
| `pnpm lint:fix`   | ESLint 자동 수정       |
| `pnpm format`     | Prettier 포맷       |
| `pnpm test`       | 전체 테스트 실행         |
| `pnpm test:watch` | 감시 모드            |
| `pnpm test:e2e`   | Playwright E2E 테스트  |
| `pnpm build:mac`  | macOS용 패키지     |

### 아키텍처

Hive는 엄격한 샌드박싱을 갖춘 Electron의 3프로세스 모델을 사용합니다:

```
┌─────────────────────────────────────────────────────┐
│                    메인 프로세스                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AI 세션)        │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPC 핸들러   │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ 타입드 IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │   Preload     │                       │
│              │   (브리지)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* API
┌──────────────────────┼──────────────────────────────┐
│                렌더러 프로세스                        │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │    컴포넌트        │   │
│  │ Stores    │ │ ui       │ │  (14개 도메인)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 프로젝트 구조

```
src/
├── main/                  # Electron 메인 프로세스 (Node.js)
│   ├── db/                # SQLite 데이터베이스 + 스키마 + 마이그레이션
│   ├── ipc/               # IPC 핸들러 모듈
│   └── services/          # Git, AI agents, 로거, 파일 서비스
├── preload/               # 브리지 레이어 (타입드 window.* API)
└── renderer/src/          # React SPA
    ├── components/        # 도메인별 UI 컴포넌트
    ├── hooks/             # 커스텀 React hooks
    ├── lib/               # 유틸리티, 테마, 헬퍼
    └── stores/            # Zustand 상태 관리
```

### 기술 스택

| 레이어     | 기술                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| 프레임워크 | [Electron 33](https://www.electronjs.org/)                                       |
| 프론트엔드  | [React 19](https://react.dev/)                                                   |
| 언어  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| 스타일링   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| 상태 관리     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| 데이터베이스  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL 모드)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| 빌드     | [electron-vite](https://electron-vite.org/)                                      |

### 문서

자세한 문서는 [`docs/`](docs/)에 있습니다:

- **[PRD](docs/prd/)** -- 제품 요구사항
- **[구현](docs/implementation/)** -- 기술 가이드
- **[스펙](docs/specs/)** -- 기능 명세
- **[계획](docs/plans/)** -- 활성 구현 계획

</details>

## 기여하기

기여를 환영합니다! Hive는 개발자에 의해, 개발자를 위해 만들어졌으며, 모든 종류의 개선을 환영합니다.

### 기여 방법

- 🐛 **버그 보고** — 명확한 재현 단계와 함께
- 💡 **기능 제안** — 워크플로우를 개선하는 것
- 📝 **문서 개선** — 다른 사람들이 시작하기 쉽도록
- 🎨 **UI/UX 개선** — 더 나은 사용성을 위해
- 🔧 **버그 수정** — 이슈 트래커에서
- ⚡ **성능 최적화** — 중요 경로 개선
- 🧪 **테스트 추가** — 커버리지 향상
- 🌐 **번역** — 앱을 당신의 언어로

기여하기 전에 [기여 가이드라인](CONTRIBUTING.md)과 [행동 강령](CODE_OF_CONDUCT.md)을 읽어주세요.

### 빠른 기여 가이드

1. 리포지토리 포크
2. 기능 브랜치 생성 (`git checkout -b feature/amazing-feature`)
3. 변경 사항 작성
4. 테스트 (`pnpm test`)와 린트 (`pnpm lint`) 실행
5. 설명이 포함된 메시지로 커밋
6. 포크에 푸시
7. Pull Request 열기

자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

## 라이선스

[MIT](LICENSE) © 2024 morapelker

Hive는 MIT 라이선스 하에 배포되는 오픈소스 소프트웨어입니다. 자세한 내용은 [LICENSE](LICENSE) 파일을 참조하세요.
