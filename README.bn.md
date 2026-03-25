<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>প্রজেক্ট জুড়ে সমান্তরাল কোডিংয়ের জন্য একটি ওপেন সোর্স AI এজেন্ট অর্কেস্ট্রেটর।</strong></p>
  <p>Claude Code, OpenCode এবং Codex সেশন সমান্তরালে চালান। একটি উইন্ডো। বিচ্ছিন্ন ব্রাঞ্চ। শূন্য ট্যাব বিশৃঙ্খলা।</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md"><strong>বাংলা</strong></a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## সূচিপত্র

- [Hive কী?](#hive-কী)
- [বৈশিষ্ট্যসমূহ](#বৈশিষ্ট্যসমূহ)
- [কেন Hive?](#কেন-hive)
- [ইনস্টলেশন](#ইনস্টলেশন)
- [দ্রুত শুরু](#দ্রুত-শুরু)
- [সংযোগ - গেম চেঞ্জার](#-সংযোগ---গেম-চেঞ্জার)
- [স্ক্রিনশট](#স্ক্রিনশট)
- [কমিউনিটি ও সাপোর্ট](#কমিউনিটি-ও-সাপোর্ট)
- [রোডম্যাপ](#রোডম্যাপ)
- [ডেভেলপমেন্ট](#ডেভেলপমেন্ট)
- [অবদান](#অবদান)
- [লাইসেন্স](#লাইসেন্স)

## Hive কী?

আপনি যদি বিভিন্ন প্রজেক্ট এবং ব্রাঞ্চ জুড়ে একাধিক AI কোডিং এজেন্ট চালান, আপনি এই কষ্ট জানেন -- ছয়টি টার্মিনাল ট্যাব খোলা, কোন এজেন্ট কী নিয়ে কাজ করছে মনে নেই, এবং চিন্তা হচ্ছে দুটো একই ফাইল এডিট করছে কিনা।

Hive একটি AI এজেন্ট অর্কেস্ট্রেটর। আপনার সব চলমান এজেন্ট একটি সাইডবারে দেখুন, তাদের মধ্যে সুইচ করতে ক্লিক করুন, এবং প্রতিটি একটি বিচ্ছিন্ন git worktree ব্রাঞ্চে চলে তাই তারা সংঘাত করতে পারে না। একাধিক রিপোজিটরি একসাথে সংযুক্ত করুন যাতে একটি একক এজেন্ট সেশনের আপনার পুরো স্ট্যাক জুড়ে কনটেক্সট থাকে।

## বৈশিষ্ট্যসমূহ

### 🌳 **Worktree-First ওয়ার্কফ্লো**
stashing বা switching ছাড়াই একসাথে একাধিক ব্রাঞ্চে কাজ করুন। এক ক্লিকে worktree তৈরি, আর্কাইভ এবং সংগঠিত করুন। প্রতিটি worktree সহজ শনাক্তকরণের জন্য একটি অনন্য শহর-ভিত্তিক নাম পায়।

### 🤖 **বিল্ট-ইন AI কোডিং সেশন**
**OpenCode** এবং **Claude Code** উভয় সাপোর্ট সহ সরাসরি Hive-এর ভেতরে AI কোডিং এজেন্ট চালান। রিয়েল-টাইমে রেসপন্স স্ট্রিম করুন, tool call এক্সিকিউট হতে দেখুন, এবং প্রয়োজন অনুযায়ী পারমিশন অনুমোদন করুন। সম্পূর্ণ undo/redo সাপোর্ট আপনাকে নিয়ন্ত্রণে রাখে।

### 📁 **স্মার্ট ফাইল এক্সপ্লোরার**
লাইভ git স্ট্যাটাস ইন্ডিকেটর দিয়ে এক নজরে পরিবর্তন দেখুন। ইনলাইনে diff দেখুন, ফাইল হিস্ট্রি ব্রাউজ করুন, এবং অ্যাপ ছাড়াই কোডবেসে নেভিগেট করুন। ইন্টিগ্রেটেড Monaco এডিটর সম্পূর্ণ VS Code অভিজ্ঞতা প্রদান করে।

### 🔧 **সম্পূর্ণ Git ইন্টিগ্রেশন**
ভিজ্যুয়ালি commit, push, pull এবং ব্রাঞ্চ পরিচালনা করুন। সাধারণ git অপারেশনের জন্য টার্মিনালের প্রয়োজন নেই। পেন্ডিং পরিবর্তন, staged ফাইল এবং commit হিস্ট্রি সব এক জায়গায় দেখুন।

### 📦 **সংগঠনের জন্য Spaces**
সম্পর্কিত প্রজেক্ট এবং worktree-গুলি লজিক্যা�� ওয়ার্কস্পেসে গ্রুপ করুন। দ্রুত অ্যাক্সেসের জন্য পছন্দের আইটেম পিন করুন। আপনি বড় হওয়ার সাথে সাথে আপনার ডেভেলপমেন্ট পরিবেশ সংগঠিত রাখুন।

### ⚡ **কমান্ড প্যালেট**
কীবোর্ড শর্টকাট দিয়ে দ্রুত নেভিগেট এবং কাজ করুন। যেকোনো ফিচারে তাৎক্ষণিক অ্যাক্সেসের জন্য `Cmd+K` চাপুন। সেশন খুঁজুন, worktree সুইচ করুন, বা মাউস ছাড়াই কমান্ড চালান।

### 🎨 **সুন্দর থিম**
১০টি যত্ন সহকারে ডিজাইন করা থিম থেকে বেছে নিন — ৬টি ডার্ক এবং ৪টি লাইট। আপনার পছন্দ বা দিনের সময় অনুযায়ী তাৎক্ষণিকভাবে সুইচ করুন। চাইলে স্বয়ংক্রিয়ভাবে সিস্টেম থিম অনুসরণ করে।

### 🖥️ **Language Server Protocol**
প্রতি-worktree ল্যাঙ্গুয়েজ সার্ভার সহ সম্পূর্ণ LSP ইন্টিগ্রেশন। TypeScript, Python, Go, Rust এবং আরও অনেক কিছুর জন্য বুদ্ধিমান কোড কমপ্লিশন, go-to-definition, hover টুলটিপ এবং রিয়েল-টাইম ডায়াগনস্টিক পান।

### 🔌 **Worktree সংযোগ**
কনটেক্সট শেয়ার, ইমপ্লিমেন্টেশন তুলনা, বা রিয়েল-টাইমে সহযোগিতা করতে দুটি worktree একসাথে সংযুক্ত করুন। ব্রাঞ্চের মধ্যে পরিবর্তন পর্যালোচনা, worktree জুড়ে AI সেশন শেয়ার, বা সম্পর্কিত ফিচারে কাজ করার সময় সামঞ্জস্য বজায় রাখার জন্য আদর্শ। সংযুক্ত worktree পরিবর্তন হলে লাইভ আপডেট দেখুন।

## কেন Hive?

দেখুন কিভাবে Hive আপনার git ওয়ার্কফ্লো রূপান্তরিত করে:

| কাজ | ঐতিহ্যগত ওয়ার্কফ্লো | Hive-এর সাথে |
|------|---------------------|-----------|
| **ব্রাঞ্চ সুইচ** | `git stash` → `git checkout` → `git stash pop` | worktree-তে ক্লিক → সম্পন্ন |
| **একাধিক ফিচারে কাজ** | ক্রমাগত stashing এবং কনটেক্সট সুইচিং | একাধিক worktree পাশাপাশি খুলুন |
| **Worktree তৈরি** | `git worktree add ../project-feature origin/feature` | "নতুন Worktree" ক্লিক → ব্রাঞ্চ নির্বাচন |
| **AI কোডিং সহায়তা** | টার্মিনাল + আলাদা AI টুল + কপি/পেস্ট | সম্পূর্ণ কনটেক্সট সহ ইন্টিগ্রেটেড AI সেশন |
| **ফাইল পরিবর্তন দেখা** | `git status` → `git diff file.ts` | ইনলাইন diff সহ ভিজ্যুয়াল ট্রি |
| **ব্রাঞ্চ তুলনা** | একাধিক টার্মিনাল ট্যাব, মাঝে কপি/পেস্ট | কনটেক্সট শেয়ারে worktree সংযুক্ত করুন |
| **Worktree খুঁজুন** | `cd ~/projects/...` → ডিরেক্টরি নাম মনে রাখুন | সব worktree এক সাইডবারে |
| **Worktree পরিষ্কার** | `git worktree remove` → `rm -rf directory` | "আর্কাইভ" ক্লিক → সব সামলায় |

## ইনস্টলেশন

> 🍎 **শুধুমাত্র macOS** — Windows এবং Linux সাপোর্ট শীঘ্রই আসছে।

### Homebrew দিয়ে (সুপারিশকৃত)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### সরাসরি ডাউনলোড

[GitHub Releases](https://github.com/morapelker/hive/releases/latest) থেকে সর্বশেষ `.dmg` ডাউনলোড করুন।

ব্যস! Applications ফোল্ডার থেকে Hive খুলুন এবং একটি git repo-তে পয়েন্ট করুন।

## দ্রুত শুরু

২ মিনিটের মধ্যে শুরু করুন:

### 1️⃣ **আপনার প্রথম প্রজেক্ট যোগ করুন**
Hive খুলুন → **"প্রজেক্ট যোগ করুন"** ক্লিক → আপনার মেশিনে যেকোনো git repository নির্বাচন করুন

### 2️⃣ **একটি Worktree তৈরি করুন**
আপনার প্রজেক্ট নির্বাচন করুন → **"নতুন Worktree"** ক্লিক → একটি ব্রাঞ্চ বেছে নিন (বা নতুন তৈরি করুন)

### 3️⃣ **AI দিয়ে কোডিং শুরু করুন**
একটি worktree খুলুন → **"নতুন সেশন"** ক্লিক → OpenCode বা Claude দিয়ে কোডিং শুরু করুন

> 💡 **প্রো টিপ**: কমান্ড প্যালেট খুলতে এবং দ্রুত নেভিগেট করতে যেকোনো সময় `Cmd+K` চাপুন!

📖 [সম্পূর্ণ গাইড পড়ুন](docs/GUIDE.md) | ⌨️ [কীবোর্ড শর্টকাট](docs/SHORTCUTS.md)

## 🔌 Worktree সংযোগ - গেম চেঞ্জার

Hive-এর **Worktree সংযোগ** ফিচার আপনাকে দুটি worktree একসাথে লিংক করতে দেয়, বিভিন্ন ব্রাঞ্চ বা ফিচারের মধ্যে একটি সেতু তৈরি করে। ক্রস-ব্রাঞ্চ সচেতনতার প্রয়োজন এমন ডেভেলপমেন্ট ওয়ার্কফ্লোর জন্য এটি অবিশ্বাস্যভাবে শক্তিশালী।

### Worktree সংযোগ কী?

যেকোনো দুটি worktree সংযুক্ত করুন:
- **🔄 কনটেক্সট শেয়ার** - অন্য ব্রাঞ্চ থেকে তাৎক্ষণিকভাবে ফাইল ও পরিবর্তন অ্যাক্সেস করুন
- **🤝 সহযোগিতা** - worktree-এর মধ্যে লাইভ আপডেট সহ সম্পর্কিত ফিচারে কাজ করুন
- **📊 তুলনা** - ইমপ্লিমেন্টেশনের মধ্যে পাশাপাশি পার্থক্য দেখুন
- **🎯 রেফারেন্স** - ফিচারে কাজ করার সময় মেইন ব্রাঞ্চ দৃশ্যমান রাখুন
- **🔗 ফিচার লিংক** - full-stack ডেভেলপমেন্টের জন্য frontend ও backend ব্রাঞ্চ সংযুক্ত করুন
- **💬 AI সেশন শেয়ার** - বিভিন্ন worktree জুড়ে AI কথোপকথন চালিয়ে যান

### কিভাবে কাজ করে

1. **সোর্স Worktree নির্বাচন** - আপনি যে worktree-তে কাজ করছেন সেটি বেছে নিন
2. **টার্গেটে সংযুক্ত করুন** - সংযোগ আইকনে ক্লিক করুন এবং অন্য worktree নির্বাচন করুন
3. **দ্বিমুখী লিংক** - উভয় worktree একে অপরের সম্পর্কে সচেতন হয়
4. **রিয়েল-টাইম আপডেট** - সংযুক্ত worktree-তে পরিবর্তন ঘটার সাথে সাথে দেখুন

### সংযোগ বৈশিষ্ট্য

- ✅ **লাইভ সিংক** - একটি worktree-তে ফাইল পরিবর্তন সংযোগ প্যানেলে দেখা যায়
- ✅ **দ্রুত সুইচ** - এক ক্লিকে সংযুক্ত worktree-এর মধ্যে লাফ দিন
- ✅ **Diff ভিউ** - সংযুক্ত worktree-এর মধ্যে ফাইল তুলনা করুন
- ✅ **শেয়ারড টার্মিনাল** - উভয় worktree-কে প্রভাবিত করে এমন কমান্ড চালান
- ✅ **AI কনটেক্সট শেয়ারিং** - AI সেশন সংযুক্ত worktree কোড রেফারেন্স করতে পারে
- ✅ **স্ট্যাটাস ইন্ডিকেটর** - সংযুক্ত worktree-তে build স্ট্যাটাস, টেস্ট এবং পরিবর্তন দেখুন
- ✅ **সংযোগ ইতিহাস** - কোন worktree কখন সংযুক্ত ছিল ট্র্যাক করুন
- ✅ **স্মার্ট সাজেশন** - Hive আপনার ওয়ার্কফ্লোর ভিত্তিতে সংযোগ করার জন্য প্রাসঙ্গিক worktree সাজেস্ট করে

### ব্যবহারের উদাহরণ

**ফিচার ডেভেলপমেন্ট**: সামঞ্জস্যতা নিশ্চিত করতে এবং আপনার পরিবর্তনগুলি কিভাবে ইন্টিগ্রেট হয় তা দেখতে আপনার ফিচার ব্রাঞ্চকে main-এ সংযুক্ত করুন।

**বাগ ফিক্স**: ফিক্স কনটেক্সটে কাজ করে কিনা যাচাই করতে বাগ ফিক্স worktree-কে প্রোডাকশন ব্রাঞ্চে সংযুক্ত করুন।

**কোড রিভিউ**: উভয় পক্ষের সম্পূর্ণ কনটেক্সট সহ পরিবর্তন আলোচনা করতে রিভিউয়ার এবং অথরের worktree সংযুক্ত করুন।

**Full-Stack ডেভেলপমেন্ট**: নিখুঁত সমন্বয়ে একসাথে API এবং UI-তে কাজ করতে frontend এবং backend worktree সংযুক্ত করুন।

**রিফ্যাক্টরিং**: বড় রিফ্যাক্টরিংয়ের সময় ফিচার সমতা নিশ্চিত করতে পুরানো এবং নতুন ইমপ্লিমেন্টেশন সংযুক্ত করুন।

## Hive দেখুন কর্মরত অবস্থায়

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive ডেমো — প্রজেক্ট জুড়ে AI এজেন্ট অর্কেস্ট্রেট করুন" width="900" />
</div>

<details>
<summary><strong>আরও স্ক্রিনশট</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — git worktree সহ AI কোডিং সেশন" width="900" />
  <sub>ইন্টিগ্রেটেড git worktree ম্যানেজমেন্ট সহ AI-চালিত কোডিং সেশন</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="নতুন worktree তৈরি" width="900" />
  <sub>ভিজ্যুয়ালি worktree তৈরি এবং পরিচালনা করুন</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="git স্ট্যাটাস সহ ফাইল ট্রি" width="900" />
  <sub>লাইভ git স্ট্যাটাস ইন্ডিকেটর সহ ফাইল এক্সপ্লোরার</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="থিম শোকেস" width="900" />
  <sub>প্রতিটি পছন্দের জন্য সুন্দর থিম</sub>
</div>

</details>

## কমিউনিটি ও সাপোর্ট

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_ডকুমেন্টেশন-পড়ুন-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_সমস্যা-রিপোর্ট-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_আলোচনা-যোগদান-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_অবদান-নির্দেশিকা-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_নিরাপত্তা-নীতি-orange?style=for-the-badge)](SECURITY.md)

</div>

### সাহায্য পান

- 📖 বিস্তারিত গাইডের জন্য [ডকুমেন্টেশন](docs/) পড়ুন
- 🐛 পুনরুত্পাদন ধাপ সহ [বাগ রিপোর্ট করুন](https://github.com/morapelker/hive/issues/new?template=bug_report.md)
- 💡 আপনি যা দেখতে চান এমন [ফিচার অনুরোধ করুন](https://github.com/morapelker/hive/issues/new?template=feature_request.md)
- 💬 কমিউনিটির সাথে সংযুক্ত হতে [আলোচনায় যোগ দিন](https://github.com/morapelker/hive/discussions)
- 🔒 দায়িত্বশীলভাবে [নিরাপত্তা দুর্বলতা রিপোর্ট করুন](SECURITY.md)

### রিসোর্স

- [ব্যবহারকারী গাইড](docs/GUIDE.md) — শুরু করা এবং টিউটোরিয়াল
- [FAQ](docs/FAQ.md) — সাধারণ প্রশ্ন এবং সমস্যা সমাধান
- [কীবোর্ড শর্টকাট](docs/SHORTCUTS.md) — সম্পূর্ণ শর্টকাট রেফারেন্স

## রোডম্যাপ

### 🚀 শীঘ্রই আসছে

- **ক্রস-প্ল্যাটফর্ম সাপোর্ট** — Windows এবং Linux বিল্ড
- **প্লাগইন সিস্টেম** — কাস্টম ইন্টিগ্রেশন দিয়ে Hive প্রসারিত করুন
- **উন্নত সংযোগ** — মাল্টি-ওয়ে সংযোগ, সংযোগ গ্রুপ, স্মার্ট সাজেশন
- **ক্লাউড সিংক** — ডিভাইস জুড়ে সেটিংস, সেশন এবং সংযোগ টেমপ্লেট ���িংক করুন
- **টিম ফিচার** — worktree শেয়ার করুন এবং রিয়েল-টাইমে সহযোগিতা করুন
- **কাস্টম AI মডেল** — আপনার নিজের OpenAI/Anthropic API কী ব্যবহার করুন
- **টার্মিনাল ট্যাব** — প্রতি worktree-তে একাধিক টার্মিনাল সেশন
- **Git গ্রাফ ভিজ্যুয়ালাইজেশন** — ভিজ্যুয়াল ব্রাঞ্চ হিস্ট্রি এবং merge
- **পারফরম্যান্স প্রোফাইলিং** — অপ্টিমাইজেশনের জন্য বিল্ট-ইন টুল

### 🎯 ভবিষ্যৎ দৃষ্টিভঙ্গি

- **সংযোগ ইন্টেলিজেন্স** — git হিস্ট্রি ভিত্তিক AI-চালিত সংযোগ সাজেশন
- **সংযোগ মার্কেটপ্লেস** — সংযোগ টেমপ্লেট শেয়ার এবং আবিষ্কার করুন
- **রিমোট ডেভেলপমেন্ট** — SSH এবং কন্টেইনার-ভিত্তিক ডেভেলপমেন্ট
- **থ্রি-ওয়ে সংযোগ** — ভিজ্যুয়ালি একাধিক ব্রাঞ্চ সংযুক্ত এবং merge করুন
- **CI/CD ইন্টিগ্রেশন** — GitHub Actions, GitLab CI, Jenkins মনিটরিং
- **সংযোগ অটোমেশন** — প্যাটার্নের ভিত্তিতে সম্পর্কিত ব্রাঞ্চ স্বয়ংক্রিয়ভাবে সংযুক্ত করুন
- **কোড রিভিউ মোড** — রিভিউয়ের জন্য অপ্টিমাইজড বিশেষ সংযোগ ধরন
- **টাইম ট্র্যাকিং** — প্রতি-worktree এবং প্রতি-সংযোগ কার্যকলাপ বিশ্লেষণ

রোডম্যাপে প্রভাব রাখতে চান? [আলোচনায় যোগ দিন](https://github.com/morapelker/hive/discussions/categories/ideas) বা [অবদান রাখুন](CONTRIBUTING.md)!

---

<details>
<summary><strong>ডেভেলপমেন্ট</strong></summary>

### পূর্বশর্ত

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree সাপোর্ট)

### সেটআপ

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty টার্মিনাল (ঐচ্ছিক)

Hive [Ghostty](https://ghostty.org/)-এর `libghostty` দ্বারা চালিত একটি ঐচ্ছিক নেটিভ টার্মিনাল অন্তর্ভুক্ত করে। এটি শুধুমাত্র তখন প্রয়োজন যদি আপনি এমবেডেড টার্মিনাল ফিচারে কাজ করতে চান।

**সেটআপ:**

1. Ghostty সোর্স থেকে `libghostty` বিল্ড করুন ([বিল্ড নির্দেশনা](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   এটি `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a` তৈরি করে।

2. যদি আপনার Ghostty repo `~/Documents/dev/ghostty/`-তে থাকে, বিল্ড স্বয়ংক্রিয়ভাবে খুঁজে পাবে। অন্যথায়, পাথ সেট করুন:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. নেটিভ addon রিবিল্ড করুন:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

যদি `libghostty` পাওয়া না যায়, Hive এখনও বিল্ড এবং রান হবে -- Ghostty টার্মিনাল ফিচার শুধু নিষ্ক্রিয় থাকবে।

### কমান্ড

| কমান্ড           | বিবরণ           |
| ----------------- | --------------------- |
| `pnpm dev`        | hot reload সহ শুরু |
| `pnpm build`      | প্রোডাকশন বিল্ড      |
| `pnpm lint`       | ESLint চেক          |
| `pnpm lint:fix`   | ESLint অটো-ফিক্স       |
| `pnpm format`     | Prettier ফরম্যাট       |
| `pnpm test`       | সব টেস্ট চালান         |
| `pnpm test:watch` | ওয়াচ মোড            |
| `pnpm test:e2e`   | Playwright E2E টেস্ট  |
| `pnpm build:mac`  | macOS-এর জন্য প্যাকেজ     |

### আর্কিটেকচার

Hive কঠোর স্যান্ডবক্সিং সহ Electron-এর তিন-প্রসেস মডেল ব্যবহার করে:

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
│  └──────────┘ └──────────┘ └─────────────────���─┘   │
└─────────────────────────────────────────────────────┘
```

### প্রজেক্ট স্ট্রাকচার

```
src/
├── main/                  # Electron মেইন প্রসেস (Node.js)
│   ├── db/                # SQLite ডাটাবেস + স্কিমা + মাইগ্রেশন
│   ├── ipc/               # IPC হ্যান্ডলার মডিউল
│   └── services/          # Git, OpenCode, লগার, ফাইল সার্ভিস
├── preload/               # ব্রিজ লেয়ার (টাইপড window.* API)
└── renderer/src/          # React SPA
    ├── components/        # ডোমেইন অনুযায়ী UI
    ├── hooks/             # কাস্টম React hook
    ├── lib/               # ইউটিলিটি, থিম, হেল্পার
    └── stores/            # Zustand স্টেট ম্যানেজমেন্ট
```

### টেক স্ট্যাক

| লেয়ার     | প্রযুক্তি                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| ফ্রেমওয়ার্ক | [Electron 33](https://www.electronjs.org/)                                       |
| ফ্রন্টএন্ড  | [React 19](https://react.dev/)                                                   |
| ভাষা  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| স্টাইলিং   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| স্টেট     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| ডাটাবেস  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL মোড)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| বিল্ড     | [electron-vite](https://electron-vite.org/)                                      |

### ডকুমেন্টেশন

বিস্তারিত ডকুমেন্টেশন [`docs/`](docs/)-এ আছে:

- **[PRDs](docs/prd/)** -- প্রোডাক্ট রিকোয়ারমেন্ট
- **[ইমপ্লিমেন্টেশন](docs/implementation/)** -- টেকনিক্যাল গাইড
- **[স্পেক](docs/specs/)** -- ফিচার স্পেসিফিকেশন
- **[প্ল্যান](docs/plans/)** -- সক্রিয় ইমপ্লিমেন্টেশন প্ল্যান

</details>

## অবদান

আমরা অবদান পছন্দ করি! Hive ডেভেলপারদের দ্বারা, ডেভেলপারদের জন্য তৈরি, এবং আমরা সব ধরনের উন্নতি স্বাগত জানাই।

### অবদানের উপায়

- 🐛 স্পষ্ট পুনরুত্পাদন ধাপ সহ **বাগ রিপোর্ট করুন**
- 💡 আপনার ওয়ার্কফ্লো উন্নত করবে এমন **ফিচার সাজেস্ট করুন**
- 📝 অন্যদের শুরু করতে সাহায্যে **ডকুমেন্টেশন উন্নত করুন**
- 🎨 ভালো ব্যবহারযোগ্যতার জন্য **UI/UX উন্নতি জমা দিন**
- 🔧 আমাদের issue tracker থেকে **বাগ ঠিক করুন**
- ⚡ গুরুত্বপূর্ণ পাথে **পারফরম্যান্স অপ্টিমাইজ করুন**
- 🧪 কভারেজ উন্নত করতে **টেস্ট যোগ করুন**
- 🌐 আপনার ভাষায় অ্যাপ **অনুবাদ করুন**

অবদান রাখার আগে, অনুগ্রহ করে আমাদের [অবদান নির্দেশিকা](CONTRIBUTING.md) এবং [আচরণবিধি](CODE_OF_CONDUCT.md) পড়ুন।

### দ্রুত অবদান গাইড

1. রিপোজিটরি Fork করুন
2. একটি ফিচার ব্রাঞ্চ তৈরি করুন (`git checkout -b feature/amazing-feature`)
3. আপনার পরিবর্তন করুন
4. টেস্ট (`pnpm test`) এবং linting (`pnpm lint`) চালান
5. বর্ণনামূলক বার্তা সহ commit করুন
6. আপনার fork-এ push করুন
7. একটি Pull Request খুলুন

বিস্তারিত নির্দেশিকার জন্য [CONTRIBUTING.md](CONTRIBUTING.md) দেখুন।

## লাইসেন্স

[MIT](LICENSE) © 2024 morapelker

Hive MIT লাইসেন্সের অধীনে লাইসেন্সকৃত ওপেন সোর্স সফটওয়্যার। সম্পূর্ণ বিবরণের জন্য [LICENSE](LICENSE) ফাইল দেখুন।
