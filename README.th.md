<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>ตัวจัดการ AI agent แบบโอเพนซอร์สสำหรับการเขียนโค้ดแบบขนานข้ามโปรเจกต์</strong></p>
  <p>รัน Claude Code, OpenCode และ Codex sessions แบบขนาน หน้าต่างเดียว แบรนช์แยกอิสระ ไม่มีแท็บรกรุงรัง</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md"><strong>ไทย</strong></a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## สารบัญ

- [Hive คืออะไร?](#hive-คืออะไร)
- [ฟีเจอร์](#ฟีเจอร์)
- [ทำไมต้อง Hive?](#ทำไมต้อง-hive)
- [การติดตั้ง](#การติดตั้ง)
- [เริ่มต้นอย่างรวดเร็ว](#เริ่มต้นอย่างรวดเร็ว)
- [การเชื่อมต่อ - ตัวเปลี่ยนเกม](#-การเชื่อมต่อ---ตัวเปลี่ยนเกม)
- [ภาพหน้าจอ](#ภาพหน้าจอ)
- [ชุมชนและการสนับสนุน](#ชุมชนและการสนับสนุน)
- [แผนงาน](#แผนงาน)
- [การพัฒนา](#การพัฒนา)
- [การมีส่วนร่วม](#การมีส่วนร่วม)
- [สัญญาอนุญาต](#สัญญาอนุญาต)

## Hive คืออะไร?

หากคุณรัน AI coding agent หลายตัวข้ามโปรเจกต์และแบรนช์ต่างๆ คุณรู้ดีถึงความลำบาก -- เปิดแท็บเทอร์มินัลหกตัว จำไม่ได้ว่า agent ตัวไหนทำอะไรอยู่ และกังวลว่าสองตัวกำลังแก้ไฟล์เดียวกัน

Hive เป็นตัวจัดการ AI agent ดู agent ที่กำลังทำงานทั้งหมดในแถบด้านข้างเดียว คลิกเพื่อสลับระหว่างพวกมัน และแต่ละตัวทำงานบนแบรนช์ git worktree ที่แยกอิสระจึงไม่ขัดกัน เชื่อมต่อ repository หลายตัวเข้าด้วยกันเพื่อให้ agent session เดียวมี context ครอบคลุมทั้ง stack ของคุณ

## ฟีเจอร์

### 🌳 **เวิร์กโฟลว์แบบ Worktree-First**
ทำงานหลายแบรนช์พร้อมกันโดยไม่ต้อง stash หรือ switch สร้าง เก็บถาวร และจัดระเบียบ worktree ได้ในคลิกเดียว แต่ละ worktree จะได้ชื่อเมืองที่ไม่ซ้ำกันเพื่อง่ายต่อการระบุ

### 🤖 **เซสชันเขียนโค้ด AI ในตัว**
รัน AI coding agent โดยตรงใน Hive พร้อมรองรับทั้ง **OpenCode** และ **Claude Code** สตรีมการตอบกลับแบบเรียลไทม์ ดู tool call ทำงาน และอนุมัติสิทธิ์ตามต้องการ รองรับ undo/redo เต็มรูปแบบเพื่อให้คุณควบคุมได้ตลอด

### 📁 **ตัวสำรวจไฟล์อัจฉริยะ**
ดูสิ่งที่เปลี่ยนแปลงได้ทันทีด้วยตัวบ่งชี้สถานะ git แบบสด ดู diff แบบ inline เรียกดูประวัติไฟล์ และนำทาง codebase โดยไม่ต้องออกจากแอป Monaco editor ในตัวให้ประสบการณ์ VS Code เต็มรูปแบบ

### 🔧 **การผสาน Git ที่สมบูรณ์**
Commit, push, pull และจัดการแบรนช์แบบวิชวล ไม่ต้องใช้เทอร์มินัลสำหรับการดำเนินการ git ทั่วไป ดูการเปลี่ยนแปลงที่รอดำเนินการ ไฟล์ที่ stage แล้ว และประวัติ commit ทั้งหมดในที่เดียว

### 📦 **Spaces สำหรับการจัดระเบียบ**
จัดกลุ่มโปรเจกต์และ worktree ที่เกี่ยวข้องเข้าเป็นพื้นที่ทำงานเชิงตรรกะ ปักหมุดรายการโปรดเพื่อเข้าถึงอย่างรวดเร็ว ร���กษาสภาพแวดล้อมการพัฒนาให้เป็นระเบียบเมื่อขยายตัว

### ⚡ **Command Palette**
นำทางและดำเนินการอย่างรวดเร็วด้วยแป้นลัด กด `Cmd+K` เพื่อเข้าถึงฟีเจอร์ใดก็ได้ทันที ค้นหาเซสชัน สลับ worktree หรือรันคำสั่งโดยไม่ต้องแตะเมาส์

### 🎨 **ธีมที่สวยงาม**
เลือกจาก 10 ธีมที่ออกแบบอย่างพิถีพิถัน — 6 ธีมมืดและ 4 ธีมสว่าง สลับได้ทันทีตามความชอบหรือช่วงเวลาของวัน ติดตามธีมระบบอัตโนมัติหากต้องการ

### 🖥️ **Language Server Protocol**
การผสาน LSP เต็มรูปแบบพร้อม language server สำหรับแต่ละ worktree รับ code completion อัจฉริยะ, go-to-definition, hover tooltip และการวินิจฉัยแบบเรียลไทม์สำหรับ TypeScript, Python, Go, Rust และอื่นๆ

### 🔌 **การเชื่อมต่อ Worktree**
เชื่อมต่อ worktree สองตัวเข้าด้วยกันเพื่อแชร์ context เปรียบเทียบ implementation หรือทำงานร่วมกันแบบเรียลไทม์ เหมาะสำหรับการ review การเปลี่ยนแปลงระหว่างแบรนช์ แชร์เซสชัน AI ข้าม worktree หรือรักษาความสอดคล้องเมื่อทำงานกับฟีเจอร์ที่เกี่ยวข้อง ดูการอัปเดตสดเมื่อ worktree ที่เชื่อมต่อมีการเปลี่ยนแปลง

## ทำไมต้อง Hive?

ดูว่า Hive เปลี่ยนเวิร์กโฟลว์ git ของคุณอย่างไร:

| งาน | เวิร์กโฟลว์แบบดั้งเดิม | กับ Hive |
|------|---------------------|-----------|
| **สลับแบรนช์** | `git stash` → `git checkout` → `git stash pop` | คลิกที่ worktree → เสร็จ |
| **ทำงานหลายฟีเจอร์** | Stash ตลอดเวลาและสลับ context | เปิดหลาย worktree เคียงข้างกัน |
| **สร้าง worktree** | `git worktree add ../project-feature origin/feature` | คลิก "Worktree ใหม่" → เลือกแบรนช์ |
| **ความช่วยเหลือ AI** | เทอร์มินัล + เครื่องมือ AI แยก + copy/paste | เซสชัน AI ในตัวพร้อม context ครบ |
| **ดูการเปลี่ยนแปลงไฟล์** | `git status` → `git diff file.ts` | ทรีวิชวลพร้อม diff แบบ inline |
| **เปรียบเทียบแบรนช์** | หลายแท็บเทอร์มินัล copy/paste ระหว่างกัน | เชื่อมต่อ worktree เพื่อแชร์ context |
| **หา worktree** | `cd ~/projects/...` → จำชื่อไดเรกทอรี | worktree ทั้งหมดในแถบด้านข้างเดียว |
| **ล้าง worktree** | `git worktree remove` → `rm -rf directory` | คลิก "เก็บถาวร" → จัดการทุกอย่าง |

## การติดตั้ง

> 🍎 **macOS เท่านั้น** — รองรับ Windows และ Linux เร็วๆ นี้

### ผ่าน Homebrew (แนะนำ)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### ดาวน์โหลดโดยตรง

ดาวน์โหลดไฟล์ `.dmg` ล่าสุดจาก [GitHub Releases](https://github.com/morapelker/hive/releases/latest)

แค่นั้น! เปิด Hive จากโฟลเดอร์ Applications แล้วชี้ไปที่ git repo

## เริ่มต้นอย่างรวดเร็ว

เริ่มใช้งานได้ภายในไม่ถึง 2 นาที:

### 1️⃣ **เพิ่มโปรเจกต์แรกของคุณ**
เปิด Hive → คลิก **"เพิ่มโปรเจกต์"** → เลือก git repository ใดก็ได้บนเครื่องของคุณ

### 2️⃣ **สร้าง Worktree**
เลือกโปรเจกต์ → คลิก **"Worktree ใหม่"** → เลือกแบรนช์ (หรือสร้างใหม่)

### 3️⃣ **เริ่มเขียนโค้ดกับ AI**
เปิด worktree → คลิก **"เซสชันใหม่"** → เริ่มเขียนโค้ดกับ OpenCode หรือ Claude

> 💡 **เคล็ดลับ**: กด `Cmd+K` ได้ทุกเมื่อเพื่อเปิด command palette และนำทางอย่างรวดเร็ว!

📖 [อ่านคู่มือฉบับเต็ม](docs/GUIDE.md) | ⌨️ [แป้นลัด](docs/SHORTCUTS.md)

## 🔌 การเชื่อมต่อ Worktree - ตัวเปลี่ยนเกม

ฟีเจอร์ **การเชื่อมต่อ Worktree** ของ Hive ให้คุณเชื่อมโยง worktree สองตัวเข้าด้วยกัน สร้างสะพานระหว่างแบรนช์หรือฟีเจอร์ต่างๆ นี่มีพลังอย่างไม่น่าเชื่อสำหรับเวิร์กโฟลว์การพัฒนาที่ต้องการการรับรู้ข้ามแบรนช์

### การเชื่อมต่อ Worktree คืออะไร?

เชื่อมต่อ worktree สองตัวใดก็ได้เพื่อ:
- **🔄 แชร์ Context** - เข้าถึงไฟล์และการเปลี่ยนแปลงจากแบรนช์อื่นทันที
- **🤝 ทำงานร่วมกัน** - ทำงานกับฟีเจอร์ที่เกี่ยวข้องพร้อมอัปเดตสดระหว่าง worktree
- **📊 เปรียบเทียบ** - ดูความแตกต่างระหว่าง implementation เคียงข้างกัน
- **🎯 อ้างอิง** - รักษาแบรนช์หลักให้มองเห็นได้ขณะทำงานกับฟีเจอร์
- **🔗 เชื่อมโยงฟีเจอร์** - เชื่อมต่อแบรนช์ frontend และ backend สำหรับการพัฒนา full-stack
- **💬 แชร์เซสชัน AI** - สานต่อการสนทนา AI ข้าม worktree ต่างๆ

### วิธีการทำงาน

1. **เลือก Worktree ต้นทาง** - เลือก worktree ที่คุณกำลังทำงาน
2. **เชื่อมต่อกับเป้าหมาย** - คลิกไอคอนเชื่อมต่อและเลือก worktree อื่น
3. **การเชื่อมโยงสองทาง** - worktree ทั้งสองจะรับรู้ซึ่งกันแ���ะกัน
4. **อัปเดตแบบเรียลไทม์** - ดูการเปลี่ยนแปลงใน worktree ที่เชื่อมต่อเมื่อเกิดขึ้น

### ฟีเจอร์การเชื่อมต่อ

- ✅ **ซิงค์สด** - การเปลี่ยนแปลงไฟล์ใน worktree หนึ่งปรากฏในแผงเชื่อมต่อ
- ✅ **สลับด่วน** - กระโดดระหว่าง worktree ที่เชื่อมต่อด้วยคลิกเดียว
- ✅ **มุมมอง Diff** - เปรียบเทียบไฟล์ระหว่าง worktree ที่เชื่อมต่อ
- ✅ **เทอร์มินัลร่วม** - รันคำสั่งที่มีผลกับ worktree ทั้งสอง
- ✅ **แชร์ Context AI** - เซสชัน AI สามารถอ้างอิงโค้ด worktree ที่เชื่อมต่อ
- ✅ **ตัวบ่งชี้สถานะ** - ดูสถานะ build, test และการเปลี่ยนแปลงใน worktree ที่เชื่อมต่อ
- ✅ **ประวัติการเชื่อมต่อ** - ติดตามว่า worktree ใดเชื่อมต่อกันและเมื่อใด
- ✅ **การแนะนำอัจฉริยะ** - Hive แนะนำ worktree ที่เกี่ยวข้องเพื่อเชื่อมต่อตามเวิร์กโฟลว์ของคุณ

### ตัวอย่างการใช้งาน

**การพัฒนาฟีเจอร์**: เชื่อมต่อแบรนช์ฟีเจอร์กับ main เพื่อรับรองความเข้ากันได้และดูว่าการเปลี่ยนแปลงของคุณรวมเข้าด้วยกันอย่างไร

**การแก้ไขบัก**: เชื่อมต่อ worktree แก้ไขบักกับแบรนช์ production เพื่อตรวจสอบว่าการแก้ไขทำงานได้ใน context

**การ Review โค้ด**: เชื่อมต่อ worktree ของ reviewer และผู้เขียนเพื่อพูดคุยเกี่ยวกับการเปลี่ยนแปลงพร้อม context ครบจากทั้งสองฝั่ง

**การพัฒนา Full-Stack**: เชื่อมต่อ worktree frontend และ backend เพื่อทำงานกับ API และ UI พร้อมกันด้วยการประสานงานที่สมบูรณ์แบบ

**การ Refactor**: เชื่อมต่อ implementation เก่าและใหม่เพื่อรับรองความเท่าเทียมของฟีเจอร์ระหว่างการ refactor ขนาดใหญ่

## ดู Hive ในการใช้งานจริง

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="สาธิต Hive — จัดการ AI agent ข้ามโปรเจกต์" width="900" />
</div>

<details>
<summary><strong>ภาพหน้าจอเพิ่มเติม</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — เซสชันเขียนโค้ด AI กับ git worktree" width="900" />
  <sub>เซสชันเขียนโค้ด AI พร้อมการจัดการ git worktree แบบบูรณาการ</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="สร้าง worktree ใหม่" width="900" />
  <sub>สร้างและจัดการ worktree แบบวิชวล</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="ทรีไฟล์พร้อมสถานะ git" width="900" />
  <sub>ตัวสำรวจไฟล์พร้อมตัวบ่งชี้สถานะ git แบบสด</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="โชว์เคสธีม" width="900" />
  <sub>ธีมสวยงามสำหรับทุกความชอบ</sub>
</div>

</details>

## ชุมชนและการสนับสนุน

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_เอกสาร-อ่าน-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_ปัญหา-รายงาน-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_สนทนา-เข้าร่วม-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_มีส่วนร่วม-แนวทาง-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_ความปลอดภัย-นโยบาย-orange?style=for-the-badge)](SECURITY.md)

</div>

### รับความช่วยเหลือ

- 📖 อ่าน[เอกสาร](docs/)สำหรับคู่มือโดยละเอียด
- 🐛 [รายงานบัก](https://github.com/morapelker/hive/issues/new?template=bug_report.md) พร้อมขั้นตอนการทำซ้ำ
- 💡 [ขอฟีเจอร์](https://github.com/morapelker/hive/issues/new?template=feature_request.md) ที่คุณอยากเห็น
- 💬 [เข้าร่วมการสนทนา](https://github.com/morapelker/hive/discussions) เพื่อเชื่อมต่อกับชุมชน
- 🔒 [รายงานช่องโหว่ด้านความปลอดภัย](SECURITY.md) อย่างรับผิดชอบ

### ทรัพยากร

- [คู่มือผู้ใช้](docs/GUIDE.md) — เริ่มต้นและบทเรียน
- [FAQ](docs/FAQ.md) — คำถามที่พบบ่อยและการแก้ปัญหา
- [แป้นลัด](docs/SHORTCUTS.md) — อ้างอิงแป้นลัดฉบับสมบูรณ์

## แผนงาน

### 🚀 เร็วๆ นี้

- **รองรับข้ามแพลตฟอร์ม** — Build สำหรับ Windows และ Linux
- **ระบบปลั๊กอิน** — ขยาย Hive ด้วยการผสานแบบกำหนดเอง
- **ซิงค์คลาวด์** — ซิงค์การตั้งค่า เซสชัน และเทมเพลตการเชื่อมต่อข้ามอุปกรณ์
- **ฟีเจอร์ทีม** — แชร์ worktree และทำงานร่วมกันแบบเรียลไทม์
- **การแสดงผลกราฟ Git** — ประวัติแบรนช์และ merge แบบวิชวล
- **การวัดประสิทธิภาพ** — เครื่องมือในตัวสำหรับการเพิ่มประสิทธิภาพ

### �� วิสัยทัศน์ในอนาคต

- **การพัฒนาระยะไกล** — การพัฒนาผ่าน SSH และ container
- **การเชื่อมต่อสามทาง** — เชื่อมต่อและ merge หลายแบรนช์แบบวิชวล
- **การผสาน CI/CD** — การติดตาม GitHub Actions, GitLab CI, Jenkins
- **การเชื่อมต่ออัตโนมัติ** — เชื่อมต่อแบรนช์ที่เกี่ยวข้องโดยอัตโนมัติตามรูปแบบ
- **โหมด Review โค้ด** — ประเภทการเชื่อมต่อพิเศษที่ปรับแต่งสำหรับการ review
- **การติดตามเวลา** — การวิเคราะห์กิจกรรมต่อ worktree และการเชื่อมต่อ

อยากมีอิทธิพลต่อแผนงาน? [เข้าร่วมการสนทนา](https://github.com/morapelker/hive/discussions/categories/ideas) หรือ [มีส่วนร่วม](CONTRIBUTING.md)!

---

<details>
<summary><strong>การพัฒนา</strong></summary>

### ข้อกำหนดเบื้องต้น

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (รองรับ worktree)

### การตั้งค่า

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### เทอร์มินัล Ghostty (ตัวเลือก)

Hive มีเทอร์มินัล native แบบตัวเลือกที่ขับเคลื่อนด้วย `libghostty` ของ [Ghostty](https://ghostty.org/) จำเป็นเฉพาะเมื่อคุณต้องการทำงานกับฟีเจอร์เทอร์มินัลแบบฝัง

**การตั้งค่า:**

1. Build `libghostty` จาก source ของ Ghostty ([คำแนะนำการ build](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   จะได้ `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`

2. หาก repo Ghostty ของคุณอยู่ที่ `~/Documents/dev/ghostty/` build จะหาเจอโดยอัตโนมัติ ไม่งั้นตั้งค่าเส้นทาง:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Rebuild native addon:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

หาก `libghostty` ไม่พร้อมใช้งาน Hive ยังคง build และรันได้ -- ฟีเจอร์เทอร์มินัล Ghostty จะถูกปิดใช้งาน

### คำสั่ง

| คำสั่ง           | คำอธิบาย           |
| ----------------- | --------------------- |
| `pnpm dev`        | เริ่มพร้อม hot reload |
| `pnpm build`      | Build สำหรับ production      |
| `pnpm lint`       | ตรวจสอบ ESLint          |
| `pnpm lint:fix`   | แก้ไขอัตโนมัติ ESLint       |
| `pnpm format`     | จัดรูปแบบ Prettier       |
| `pnpm test`       | รันการทดสอบทั้งหมด         |
| `pnpm test:watch` | โหมด watch            |
| `pnpm test:e2e`   | ทดสอบ Playwright E2E  |
| `pnpm build:mac`  | แพ็กเกจสำหรับ macOS     |

### สถาปัตยกรรม

Hive ใช้โมเดลสามโปรเซสของ Electron พร้อม sandboxing ที่เข้มงวด:

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

### โครงสร้างโปรเจกต์

```
src/
├── main/                  # โปรเซสหลัก Electron (Node.js)
│   ├── db/                # ฐานข้อมูล SQLite + schema + migration
│   ├── ipc/               # โมดูลตัวจัดการ IPC
│   └── services/          # บริการ Git, OpenCode, logger, file
├── preload/               # ชั้นสะพาน (API window.* แบบมีชนิด)
└── renderer/src/          # แอป React SPA
    ├── components/        # UI จัดตามโดเมน
    ├── hooks/             # React hook แบบกำหนดเอง
    ├── lib/               # ��ูทิลิตี้ ธีม ตัวช่วย
    └── stores/            # การจัดการ state ด้วย Zustand
```

### Tech Stack

| ชั้น     | เทคโนโลยี                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| ภาษา  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Styling   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| State     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Database  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (โหมด WAL)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### เอกสาร

เอกสารโดยละเอียดอยู่ใน [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- ข้อกำหนดผลิตภัณฑ์
- **[Implementation](docs/implementation/)** -- คู่มือด้านเทคนิค
- **[Specs](docs/specs/)** -- ข้อมูลจำเพาะฟีเจอร์
- **[Plans](docs/plans/)** -- แผนการ implementation ที่กำลังดำเนินการ

</details>

## การมีส่วนร่วม

เรารักการมีส่วนร่วม! Hive สร้างโดยนักพัฒนา เพื่อนักพัฒนา และเรายินดีต้อนรับการปรับปรุงทุกประเภท

### วิธีการมีส่วนร่วม

- 🐛 **รายงานบัก** พร้อมขั้นตอนการทำซ้ำที่ชัดเจน
- 💡 **เสนอฟีเจอร์** ที่จะปรับปรุงเวิร์กโฟลว์ของคุณ
- 📝 **ปรับปรุงเอกสาร** เพื่อช่วยผู้อื่นเริ่มต้น
- 🎨 **ส่งการปรับปรุง UI/UX** เพื่อความสะดวกในการใช้งานที่ดีขึ้น
- 🔧 **แก้ไขบัก** จาก issue tracker ของเรา
- ⚡ **เพิ่มประสิทธิภาพ** ในเส้นทางที่สำคัญ
- 🧪 **เพิ่มการทดสอบ** เพื่อปรับปรุง coverage
- 🌐 **แปล** แอปเป็นภาษาของคุณ

ก่อนมีส่วนร่วม โปรดอ่าน[แนวทางการมีส่วนร่วม](CONTRIBUTING.md) และ[จรรยาบรรณ](CODE_OF_CONDUCT.md)

### คู่มือการมีส่วนร่วมอย่างรวดเร็ว

1. Fork repository
2. สร้างแบรนช์ฟีเจอร์ (`git checkout -b feature/amazing-feature`)
3. ทำการเปลี่ยนแปลง
4. รันการทดสอบ (`pnpm test`) และ linting (`pnpm lint`)
5. Commit พร้อมข้อความอธิบาย
6. Push ไปยัง fork ของคุณ
7. เปิด Pull Request

ดู [CONTRIBUTING.md](CONTRIBUTING.md) สำหรับแนวทางโดยละเอียด

## สัญญาอนุญาต

[MIT](LICENSE) © 2024 morapelker

Hive เป็นซอฟต์แวร์โอเพนซอร์สที่อนุญาตภายใต้สัญญาอนุญาต MIT ดูไฟล์ [LICENSE](LICENSE) สำหรับรายละเอียดทั้งหมด
