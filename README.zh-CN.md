<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>一个开源的 AI Agent 编排器，用来在多个项目和多个分支之间并行编码。</strong></p>
  <p>在一个窗口里同时运行 Claude Code、OpenCode 和 Codex。每个会话都绑定独立的 git worktree，减少分支切换和上下文混乱。</p>
  <p><a href="README.md"><strong>English</strong></a> | <a href="README.zh-CN.md"><strong>简体中文</strong></a></p>

  <p>
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

## 安装

> 当前以 macOS 为主，Windows 和 Linux 支持仍在演进中。

### Homebrew

```bash
brew tap morapelker/hive
brew install --cask hive
```

### 直接下载

从 [GitHub Releases](https://github.com/morapelker/hive/releases/latest) 下载最新 `.dmg`。

## Hive 是什么

如果你经常同时开多个 AI 编码代理，很容易遇到这些问题：

- 终端标签页越开越多，忘了哪个代理在做什么
- 不同任务共用一个分支，改动互相污染
- 前后端或多个仓库之间需要来回切换上下文
- 想同时推进多个功能，但不想一直 `git stash`

Hive 的目标就是把这些问题收拢到一个桌面应用里：

- 在一个侧边栏里看到所有项目、worktree 和 AI 会话
- 每个会话绑定独立 worktree，降低冲突风险
- 直接在应用里查看文件、diff、git 状态和会话流
- 连接多个 worktree，让同一个任务拥有跨仓库上下文

## 核心特性

### Worktree 优先

- 可视化创建、归档和管理 git worktree
- 多分支并行开发，不需要频繁切换和 stash
- worktree 会自动生成易识别的名称

### 内置 AI 编码会话

- 直接在 Hive 里启动 OpenCode、Claude Code 和 Codex
- 实时查看流式回复、工具调用、权限审批和问题输入
- 支持 undo / redo、模型切换和会话恢复

### 文件与代码视图

- 文件树里带 git 状态提示
- 内联 diff、Monaco diff、图片 diff
- 集成代码查看和编辑能力

### Git 工作流

- 常见 git 操作直接在界面里完成
- 查看变更、提交、push / pull、分支状态
- 面向 worktree 的日常开发比命令行更顺手

### Connections

- 把两个或多个 worktree 连接起来共享上下文
- 适合前后端联动、分支对照、重构对比、代码评审
- 对 AI 会话尤其有价值，可以在一个任务里看到相关实现

### 终端与开发运行

- 内置终端和运行面板
- 可以跑 setup / run 脚本
- 支持 Ghostty / xterm 等后端能力

## 快速开始

### 1. 添加项目

打开 Hive，点击 `Add Project`，选择本地任意一个 git 仓库。

### 2. 创建 worktree

选中项目，点击 `New Worktree`，选择已有分支或创建新分支。

### 3. 启动 AI 会话

打开某个 worktree，点击 `New Session`，选择要使用的 AI provider。

### 4. 开始并行开发

你可以同时打开多个 worktree、多个会话，分别推进不同任务。

## 为什么这个项目值得看

Hive 不只是一个 Electron UI，它更像一个共享核心、双入口的桌面工作台：

- GUI 模式下，渲染层通过 preload 暴露的 `window.*` API 与 Electron 主进程通信
- Headless 模式下，同一套数据库和服务通过 GraphQL + WebSocket 暴露给外部客户端
- AI provider 已经抽象成统一接口，支持 OpenCode、Claude Code、Codex 三种后端

如果你关心的不是“又一个 AI 编辑器”，而是：

- 多 agent 协同
- worktree 工作流
- Electron + React + SQLite 架构
- 本地优先的 AI 工具集成

那这个仓库很值得研究和贡献。

## 开发

### 前置要求

- Node.js 20+
- pnpm 9+
- Git 2.20+

### 安装依赖

```bash
pnpm install
```

### 启动开发环境

```bash
pnpm dev
```

### 常用命令

```bash
pnpm build
pnpm test
pnpm lint
pnpm test:e2e
```

### 项目结构

```text
src/
├── main/          # Electron 主进程、数据库、服务、IPC
├── preload/       # 渲染层和主进程之间的安全桥接
├── renderer/src/  # React UI、hooks、stores、组件
├── server/        # headless / remote GraphQL server
└── shared/        # 共享类型与协议
```

### 技术栈

- Electron 33
- React 19
- TypeScript 5.7
- Tailwind CSS 4
- Zustand
- better-sqlite3
- GraphQL Yoga
- simple-git
- electron-vite

## 文档

详细文档主要仍以英文为主，集中在：

- [`docs/`](./docs/)
- [`CLAUDE.md`](./CLAUDE.md)
- [`IMPLEMENTATION_CODEX.md`](./IMPLEMENTATION_CODEX.md)

后续如果逐步补齐中文文档，建议优先从：

- 用户入门指南
- 架构说明
- 贡献流程

开始。

## 贡献

欢迎贡献，尤其适合这些方向：

- i18n / 本地化
- UI/UX 细节打磨
- Windows / Linux 支持
- 测试与 CI 补强
- 文档完善

如果你要提 PR，一个比较顺手的流程是：

1. fork 仓库
2. 把官方仓库设为 `upstream`
3. 在自己的 fork 上开功能分支
4. 完成改动并跑测试
5. 从 fork 向上游仓库提 PR

## 许可

本项目基于 [MIT License](./LICENSE) 开源。
