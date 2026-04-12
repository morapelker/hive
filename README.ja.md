<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>プロジェクト横断の並列コーディングを実現するオープンソースAIエージェントオーケストレーター</strong></p>
  <p>Claude Code、OpenCode、Codexのセッションを並列実行。ひとつのウィンドウ。独立したブランチ。タブの混乱ゼロ。</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md"><strong>日本語</strong></a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="最新リリース" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="ダウンロード数" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="ビルド状態" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-supported-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square&logo=windows&logoColor=white" alt="Windows" /></a>
    <a href="#"><img src="https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-41-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="ライセンス" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR歓迎" /></a>
  </p>
</div>

---

## 目次

- [インストール](#インストール)
- [Hiveとは？](#hiveとは)
- [機能](#機能)
- [なぜHive？](#なぜhive)
- [クイックスタート](#クイックスタート)
- [コネクション — ゲームチェンジャー](#-コネクション---ゲームチェンジャー)
- [スクリーンショット](#スクリーンショット)
- [コミュニティ＆サポート](#コミュニティサポート)
- [ロードマップ](#ロードマップ)
- [開発](#開発)
  - [前提条件](#前提条件)
  - [セットアップ](#セットアップ)
  - [コマンド](#コマンド)
  - [アーキテクチャ](#アーキテクチャ)
  - [プロジェクト構成](#プロジェクト構成)
  - [技術スタック](#技術スタック)
  - [ドキュメント](#ドキュメント)
- [コントリビュート](#コントリビュート)
- [ライセンス](#ライセンス)

## インストール

HiveはmacOS、Windows、Linuxに対応しています。

### macOS

#### Homebrew（推奨）

```bash
brew install --cask hive-app
```

#### 直接ダウンロード

最新の`.dmg`を[GitHubリリース](https://github.com/morapelker/hive/releases/latest)からダウンロード。

### Windows

最新の`.exe`を[GitHubリリース](https://github.com/morapelker/hive/releases/latest)からダウンロード。

### Linux

最新の`.AppImage`または`.deb`を[GitHubリリース](https://github.com/morapelker/hive/releases/latest)からダウンロード。

---

以上です！Hiveを開いて、gitリポジトリを指定してください。

## Hiveとは？

複数のAIコーディングエージェントを異なるプロジェクトやブランチで実行していると、あの苦痛を知っているはずです — ターミナルタブが6つ開いていて、どのエージェントが何をしているか分からなくなり、2つのエージェントが同じファイルを編集していないか心配になる。

HiveはAIエージェントオーケストレーターです。実行中のすべてのエージェントをひとつのサイドバーで確認し、クリックで切り替え、各エージェントは独立したgit worktreeブランチで動作するため衝突しません。複数のリポジトリを接続して、ひとつのエージェントセッションがスタック全体のコンテキストを持てるようにします。

## 機能

### 🌳 **Worktreeファーストワークフロー**
スタッシュやブランチ切り替えなしに複数のブランチを同時に作業できます。ワンクリックでWorktreeを作成、アーカイブ、整理。各Worktreeには都市名ベースのユニークな名前が自動的に付けられ、簡単に識別できます。

### 🤖 **ビルトインAIコーディングセッション**
**OpenCode**、**Claude Code**、**Codex**をサポートし、Hive内で直接AIコーディングエージェントを実行。レスポンスをリアルタイムでストリーミング、ツールコールの実行を監視、必要に応じてパーミッションを承認。フルundo/redoサポートで常にコントロールを維持。

### 📁 **スマートファイルエクスプローラー**
ライブgitステータスインジケーターで変更を一目で確認。インラインdiff表示、ファイル履歴のブラウズ、アプリを離れることなくコードベースをナビゲート。統合されたMonacoエディターがVS Code並みの体験を提供。

### 🔧 **完全なGit統合**
コミット、プッシュ、プル、ブランチ管理をビジュアルに。一般的なgit操作にターミナルは不要。保留中の変更、ステージングされたファイル、コミット履歴をすべてひとつの場所で確認。

### 📦 **スペースで整理**
関連するプロジェクトとWorktreeを論理的なワークスペースにグループ化。お気に入りをピン留めしてクイックアクセス。スケールしても開発環境を整理整頓。

### ⚡ **コマンドパレット**
キーボードショートカットで素早くナビゲートとアクション。`Cmd+K`を押せば、あらゆる機能にすぐにアクセス。セッション検索、Worktree切り替え、コマンド実行をマウスに触れずに。

### 🎨 **美しいテーマ**
10種類のこだわりのテーマから選択 — ダーク6種、ライト4種。お好みや時間帯に合わせて瞬時に切り替え。お望みならシステムテーマに自動追従。

### 🔌 **Worktreeコネクション**
2つのWorktreeを接続してコンテキストを共有、実装を比較、リアルタイムでコラボレーション。ブランチ間の変更レビュー、Worktree間でのAIセッション共有、関連機能の作業時の一貫性維持に最適。接続されたWorktreeの変更をライブで確認。

## なぜHive？

Hiveがgitワークフローをどう変えるかご覧ください：

| タスク | 従来のワークフロー | Hiveなら |
|------|---------------------|-----------|
| **ブランチ切り替え** | `git stash` → `git checkout` → `git stash pop` | Worktreeをクリック → 完了 |
| **複数機能の並行作業** | 絶え間ないスタッシュとコンテキスト切り替え | 複数のWorktreeを同時に開く |
| **Worktree作成** | `git worktree add ../project-feature origin/feature` | 「新規Worktree」をクリック → ブランチを選択 |
| **AIコーディング支援** | ターミナル + 別のAIツール + コピペ | フルコンテキスト付きの統合AIセッション |
| **ファイル変更確認** | `git status` → `git diff file.ts` | インラインdiff付きビジュアルツリー |
| **ブランチ比較** | 複数のターミナルタブ、コピペの往復 | Worktreeを接続してコンテキスト共有 |
| **Worktreeを探す** | `cd ~/projects/...` → ディレクトリ名を覚える | すべてのWorktreeがひとつのサイドバーに |
| **Worktreeのクリーンアップ** | `git worktree remove` → `rm -rf directory` | 「アーカイブ」をクリック → すべて自動処理 |

## クイックスタート

2分以内で使い始められます：

### 1️⃣ **最初のプロジェクトを追加**
Hiveを開く → **「Add Project」**をクリック → マシン上の任意のgitリポジトリを選択

### 2️⃣ **Worktreeを作成**
プロジェクトを選択 → **「New Worktree」**をクリック → ブランチを選択（または新規作成）

### 3️⃣ **AIでコーディング開始**
Worktreeを開く → **「New Session」**をクリック → OpenCode、Claude、またはCodexでコーディング開始

> 💡 **プロのコツ**: いつでも`Cmd+K`を押してコマンドパレットを開き、素早くナビゲート！

📖 [完全ガイドを読む](docs/GUIDE.md) | ⌨️ [キーボードショートカット](docs/SHORTCUTS.md)

## 🔌 Worktreeコネクション — ゲームチェンジャー

Hiveの**Worktreeコネクション**機能は、2つのWorktreeをリンクして異なるブランチや機能間にブリッジを作成します。クロスブランチの認識が必要な開発ワークフローに非常に強力です。

### Worktreeコネクションとは？

任意の2つのWorktreeを接続して：
- **🔄 コンテキスト共有** - 別のブランチのファイルや変更に瞬時にアクセス
- **🤝 コラボレーション** - Worktree間のライブ更新で関連機能を作業
- **📊 比較** - 実装の違いを並べて表示
- **🎯 リファレンス** - 機能作業中もメインブランチを常に表示
- **🔗 機能のリンク** - フルスタック開発のためにフロントエンドとバックエンドのブランチを接続
- **💬 AIセッション共有** - 異なるWorktree間でAIの会話を継続

### 仕組み

1. **ソースWorktreeを選択** - 作業中のWorktreeを選択
2. **ターゲットに接続** - 接続アイコンをクリックして別のWorktreeを選択
3. **双方向リンク** - 両方のWorktreeが互いを認識
4. **リアルタイム更新** - 接続されたWorktreeの変更をリアルタイムで確認

### コネクション機能

- ✅ **ライブ同期** - 一方のWorktreeのファイル変更が接続パネルに表示
- ✅ **クイック切り替え** - 接続されたWorktree間をワンクリックでジャンプ
- ✅ **差分表示** - 接続されたWorktree間のファイルを比較
- ✅ **共有ターミナル** - 両方のWorktreeに影響するコマンドを実行
- ✅ **AIコンテキスト共有** - AIセッションが接続されたWorktreeのコードを参照可能
- ✅ **ステータスインジケーター** - 接続されたWorktreeのビルド状態、テスト、変更を表示
- ✅ **接続履歴** - どのWorktreeがいつ接続されていたかを追跡
- ✅ **スマート提案** - ワークフローに基づいて関連するWorktreeの接続を提案

### ユースケース

**機能開発**: 機能ブランチをmainに接続して互換性を確保し、変更がどう統合されるか確認。

**バグ修正**: バグ修正Worktreeをプロダクションブランチに接続して、修正がコンテキスト内で機能することを確認。

**コードレビュー**: レビュアーと作成者のWorktreeを接続して、両側のフルコンテキストで変更について議論。

**フルスタック開発**: フロントエンドとバックエンドのWorktreeを接続して、APIとUIを完璧な連携で同時に作業。

**リファクタリング**: 旧実装と新実装を接続して、大規模リファクタリング中の機能パリティを確保。

## デモを見る

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hiveデモ — プロジェクト横断のAIエージェントオーケストレーション" width="900" />
</div>

<details>
<summary><strong>スクリーンショットをもっと見る</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — git worktreeとAIコーディングセッション" width="900" />
  <sub>git worktree管理と統合されたAI搭載コーディングセッション</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="新しいWorktreeの作成" width="900" />
  <sub>Worktreeをビジュアルに作成・管理</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="gitステータス付きファイルツリー" width="900" />
  <sub>ライブgitステータスインジケーター付きファイルエクスプローラー</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="テーマショーケース" width="900" />
  <sub>あらゆる好みに対応する美しいテーマ</sub>
</div>

</details>

## コミュニティ＆サポート

<div align="center">

[![ドキュメント](https://img.shields.io/badge/📖_ドキュメント-読む-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-報告する-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_Discussions-参加する-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![コントリビュート](https://img.shields.io/badge/🤝_コントリビュート-ガイドライン-green?style=for-the-badge)](CONTRIBUTING.md)
[![セキュリティ](https://img.shields.io/badge/🔒_セキュリティ-ポリシー-orange?style=for-the-badge)](SECURITY.md)

</div>

### ヘルプを得る

- 📖 [ドキュメント](docs/)で詳細なガイドを読む
- 🐛 再現手順付きで[バグを報告](https://github.com/morapelker/hive/issues/new?template=bug_report.md)
- 💡 見たい[機能をリクエスト](https://github.com/morapelker/hive/issues/new?template=feature_request.md)
- 💬 [Discussionsに参加](https://github.com/morapelker/hive/discussions)してコミュニティとつながる
- 🔒 [セキュリティ脆弱性を報告](SECURITY.md)（責任ある開示）

### リソース

- [ユーザーガイド](docs/GUIDE.md) — はじめ方とチュートリアル
- [FAQ](docs/FAQ.md) — よくある質問とトラブルシューティング
- [キーボードショートカット](docs/SHORTCUTS.md) — 完全なショートカットリファレンス

## ロードマップ

### 🚀 近日公開

- **プラグインシステム** — カスタム統合でHiveを拡張
- **クラウド同期** — 設定、セッション、接続テンプレートをデバイス間で同期
- **チーム機能** — Worktreeを共有してリアルタイムでコラボレーション
- **Gitグラフ可視化** — ビジュアルなブランチ履歴とマージ
- **パフォーマンスプロファイリング** — 最適化のための組み込みツール

### 🎯 将来のビジョン

- **リモート開発** — SSHとコンテナベースの開発
- **三者間接続** — 複数のブランチをビジュアルに接続してマージ
- **CI/CD統合** — GitHub Actions、GitLab CI、Jenkinsモニタリング
- **コネクション自動化** — パターンに基づく関連ブランチの自動接続
- **コードレビューモード** — レビューに最適化された特別な接続タイプ
- **タイムトラッキング** — Worktreeごと、コネクションごとのアクティビティ分析

ロードマップに影響を与えたいですか？[ディスカッションに参加](https://github.com/morapelker/hive/discussions/categories/ideas)するか[コントリビュート](CONTRIBUTING.md)してください！

---

<details>
<summary><strong>開発</strong></summary>

### 前提条件

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+（worktreeサポート）

### セットアップ

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghosttyターミナル（オプション）

Hiveには[Ghostty](https://ghostty.org/)の`libghostty`を使用したオプションのネイティブターミナルが含まれています。組み込みターミナル機能で作業する場合にのみ必要です。

**セットアップ:**

1. Ghosttyソースから`libghostty`をビルド（[ビルド手順](https://ghostty.org/docs/install/build)）:
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`が生成されます。

2. Ghosttyリポジトリが`~/Documents/dev/ghostty/`にあれば、自動的に検出されます。それ以外の場合はパスを設定:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. ネイティブアドオンをリビルド:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

`libghostty`が利用できない場合でも、Hiveは正常にビルド・実行されます — Ghosttyターミナル機能が無効になるだけです。

### コマンド

| コマンド           | 説明           |
| ----------------- | --------------------- |
| `pnpm dev`        | ホットリロードで起動 |
| `pnpm build`      | プロダクションビルド      |
| `pnpm lint`       | ESLintチェック          |
| `pnpm lint:fix`   | ESLint自動修正       |
| `pnpm format`     | Prettierフォーマット       |
| `pnpm test`       | 全テスト実行         |
| `pnpm test:watch` | ウォッチモード            |
| `pnpm test:e2e`   | Playwright E2Eテスト  |
| `pnpm build:mac`  | macOS用パッケージ     |

### アーキテクチャ

Hiveは厳密なサンドボックスを備えたElectronの3プロセスモデルを使用:

```
┌─────────────────────────────────────────────────────┐
│                    メインプロセス                      │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AIセッション)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │  IPCハンドラー │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ 型付きIPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │   Preload     │                       │
│              │  (ブリッジ)    │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* API
┌──────────────────────┼──────────────────────────────┐
│                レンダラープロセス                     │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │  コンポーネント     │   │
│  │ Stores    │ │ ui       │ │  (14ドメイン)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### プロジェクト構成

```
src/
├── main/                  # Electronメインプロセス (Node.js)
│   ├── db/                # SQLiteデータベース + スキーマ + マイグレーション
│   ├── ipc/               # IPCハンドラーモジュール
│   └── services/          # Git、AI agents、ロガー、ファイルサービス
├── preload/               # ブリッジレイヤー (型付きwindow.* API)
└── renderer/src/          # React SPA
    ├── components/        # ドメイン別UIコンポーネント
    ├── hooks/             # カスタムReact hooks
    ├── lib/               # ユーティリティ、テーマ、ヘルパー
    └── stores/            # Zustand状態管理
```

### 技術スタック

| レイヤー     | テクノロジー                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| フレームワーク | [Electron 41](https://www.electronjs.org/)                                       |
| フロントエンド  | [React 19](https://react.dev/)                                                   |
| 言語  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| スタイリング   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| 状態管理     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| データベース  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WALモード)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| ビルド     | [electron-vite](https://electron-vite.org/)                                      |

### ドキュメント

詳細ドキュメントは[`docs/`](docs/)にあります:

- **[PRD](docs/prd/)** -- プロダクト要件
- **[実装](docs/implementation/)** -- 技術ガイド
- **[仕様](docs/specs/)** -- 機能仕様
- **[計画](docs/plans/)** -- 実行中の実装計画

</details>

## コントリビュート

コントリビュート大歓迎です！Hiveは開発者による、開発者のためのプロジェクトです。あらゆる改善を歓迎します。

### コントリビュートの方法

- 🐛 **バグ報告** — 明確な再現手順とともに
- 💡 **機能提案** — ワークフローを改善するもの
- 📝 **ドキュメント改善** — 他の人が始めやすくなるように
- 🎨 **UI/UX改善** — より良い使いやすさのために
- 🔧 **バグ修正** — イシュートラッカーから
- ⚡ **パフォーマンス最適化** — クリティカルパスの改善
- 🧪 **テスト追加** — カバレッジの向上
- 🌐 **翻訳** — アプリをあなたの言語に

コントリビュートの前に、[コントリビュートガイドライン](CONTRIBUTING.md)と[行動規範](CODE_OF_CONDUCT.md)をお読みください。

### クイックコントリビュートガイド

1. リポジトリをフォーク
2. 機能ブランチを作成 (`git checkout -b feature/amazing-feature`)
3. 変更を加える
4. テスト (`pnpm test`) とリント (`pnpm lint`) を実行
5. 説明的なメッセージでコミット
6. フォークにプッシュ
7. プルリクエストを開く

詳細は[CONTRIBUTING.md](CONTRIBUTING.md)をご覧ください。

## ライセンス

[MIT](LICENSE) © 2024 morapelker

Hiveはオープンソースソフトウェアで、MITライセンスの下でライセンスされています。詳細は[LICENSE](LICENSE)ファイルをご覧ください。
