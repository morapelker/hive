<div align="center" dir="rtl">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>منسّق وكلاء ذكاء اصطناعي مفتوح المصدر للبرمجة المتوازية عبر المشاريع.</strong></p>
  <p>شغّل جلسات Claude Code وOpenCode وCodex بالتوازي. نافذة واحدة. فروع معزولة. بلا فوضى تبويبات.</p>
</div>
<div align="center">
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md"><strong>العربية</strong></a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

<div dir="rtl">

## جدول المحتويات

- [ما هو Hive؟](#ما-هو-hive)
- [الميزات](#الميزات)
- [لماذا Hive؟](#لماذا-hive)
- [التثبيت](#التثبيت)
- [البداية السريعة](#البداية-السريعة)
- [الاتصالات - نقطة التحول](#-الاتصالات---نقطة-التحول)
- [لقطات الشاشة](#لقطات-الشاشة)
- [المجتمع والدعم](#المجتمع-والدعم)
- [خارطة الطريق](#خارطة-الطريق)
- [التطوير](#التطوير)
- [المساهمة](#المساهمة)
- [الرخصة](#الرخصة)

## ما هو Hive؟

إذا كنت تشغّل عدة وكلاء ذكاء اصطناعي للبرمجة عبر مشاريع وفروع مختلفة، فأنت تعرف المعاناة -- ست تبويبات طرفية مفتوحة، لا تتذكر أي وكيل يعمل على ماذا، وتقلق من أن اثنين منهم يعدّلان نفس الملفات.

Hive هو منسّق وكلاء ذكاء اصطناعي. شاهد جميع وكلائك العاملين في شريط جانبي واحد، انقر للتبديل بينهم، وكل واحد يعمل على فرع worktree معزول في git حتى لا يتعارضوا. اربط عدة مستودعات معاً ليكون لجلسة وكيل واحدة سياق عبر مجموعتك التقنية بالكامل.

## الميزات

### 🌳 **سير عمل قائم على Worktree**
اعمل على عدة فروع في وقت واحد بدون تخبئة أو تبديل. أنشئ وأرشف ونظّم أشجار العمل بنقرة واحدة. كل worktree يحصل على اسم فريد مستوحى من المدن لسهولة التعرّف.

### 🤖 **جلسات برمجة بالذكاء الاصطناعي مدمجة**
شغّل وكلاء برمجة بالذكاء الاصطناعي مباشرة داخل Hive مع دعم **OpenCode** و**Claude Code** و**Codex**. تابع الردود في الوقت الفعلي، راقب تنفيذ استدعاءات الأدوات، ووافق على الأذونات حسب الحاجة. دعم كامل للتراجع والإعادة يبقيك متحكماً.

### 📁 **مستكشف ملفات ذكي**
شاهد التغييرات بلمحة مع مؤشرات حالة git الحية. اعرض الفروقات مباشرة، تصفّح تاريخ الملفات، وتنقّل في قاعدة الكود دون مغادرة التطبيق. محرر Monaco المدمج يوفر تجربة VS Code كاملة.

### 🔧 **تكامل Git كامل**
أنشئ commits، ادفع، اسحب، وأدر الفروع بصرياً. لا حاجة للطرفية لعمليات git الشائعة. شاهد التغييرات المعلّقة والملفات المرحّلة وتاريخ الإيداعات في مكان واحد.

### 📦 **المساحات للتنظيم**
جمّع المشاريع وأشجار العمل المترابطة في مساحات عمل منطقية. ثبّت المفضلة للوصول السريع. حافظ على تنظيم بيئة التطوير مع التوسع.

### ⚡ **لوحة الأوامر**
تنقّل وتصرّف بسرعة باستخدام اختصارات لوحة المفاتيح. اضغط `Cmd+K` للوصول لأي ميزة فوراً. ابحث في الجلسات، بدّل أشجار العمل، أو نفّذ أوامر بدون لمس الفأرة.

### 🎨 **سمات جميلة**
اختر من 10 سمات مصمّمة بعناية — 6 داكنة و4 فاتحة. بدّل فوراً لتتناسب مع تفضيلاتك أو وقت اليوم. تتبع سمة النظام تلقائياً إذا أردت.

### 🖥️ **بروتوكول خادم اللغة**
تكامل LSP كامل مع خوادم لغة لكل worktree. احصل على إكمال كود ذكي، الانتقال للتعريف، تلميحات التمرير، وتشخيصات فورية لـ TypeScript وPython وGo وRust والمزيد.

### 🔌 **اتصالات Worktree**
اربط شجرتي عمل معاً لمشاركة السياق، مقارنة التطبيقات، أو التعاون في الوقت الفعلي. مثالي لمراجعة التغييرات بين الفروع، مشاركة جلسات الذكاء الاصطناعي عبر أشجار العمل، أو الحفاظ على الاتساق عند العمل على ميزات مترابطة. شاهد التحديثات الحية عند تغيّر أشجار العمل المتصلة.

## لماذا Hive؟

شاهد كيف يحوّل Hive سير عمل git الخاص بك:

| المهمة | سير العمل التقليدي | مع Hive |
|------|---------------------|-----------|
| **تبديل الفروع** | `git stash` → `git checkout` → `git stash pop` | انقر على worktree → تم |
| **العمل على عدة ميزات** | تخبئة مستمرة وتبديل سياق | افتح عدة أشجار عمل جنباً إلى جنب |
| **إنشاء worktree** | `git worktree add ../project-feature origin/feature` | انقر "Worktree جديد" → اختر فرع |
| **مساعدة الذكاء الاصطناعي** | طرفية + أداة AI منفصلة + نسخ/لصق | جلسات AI مدمجة مع سياق كامل |
| **عرض تغييرات الملفات** | `git status` → `git diff file.ts` | شجرة مرئية مع فروقات مباشرة |
| **مقارنة الفروع** | عدة تبويبات طرفية، نسخ/لصق بينها | اربط أشجار العمل لمشاركة السياق |
| **إيجاد worktree** | `cd ~/projects/...` → تذكّر أسماء المجلدات | كل أشجار العمل في شريط جانبي واحد |
| **تنظيف أشجار العمل** | `git worktree remove` → `rm -rf directory` | انقر "أرشفة" → يتعامل مع كل شيء |

## التثبيت

> 🍎 **macOS فقط** — دعم Windows وLinux قادم قريباً.

### عبر Homebrew (موصى به)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### التحميل المباشر

حمّل أحدث ملف `.dmg` من [إصدارات GitHub](https://github.com/morapelker/hive/releases/latest).

هذا كل شيء! افتح Hive من مجلد التطبيقات ووجّهه إلى مستودع git.

## البداية السريعة

ابدأ العمل في أقل من دقيقتين:

### 1️⃣ **أضف مشروعك الأول**
افتح Hive → انقر **"إضافة مشروع"** → اختر أي مستودع git على جهازك

### 2️⃣ **أنشئ Worktree**
اختر مشروعك → انقر **"Worktree جديد"** → اختر فرعاً (أو أنشئ واحداً جديداً)

### 3️⃣ **ابدأ البرمجة مع الذكاء الاصطناعي**
افتح worktree → انقر **"جلسة جديدة"** → ابدأ البرمجة مع OpenCode أو Claude أو Codex

> 💡 **نصيحة احترافية**: اضغط `Cmd+K` في أي وقت لفتح لوحة الأوامر والتنقل بسرعة!

📖 [اقرأ الدليل الكامل](docs/GUIDE.md) | ⌨️ [اختصارات لوحة المفاتيح](docs/SHORTCUTS.md)

## 🔌 اتصالات Worktree - نقطة التحول

ميزة **اتصالات Worktree** في Hive تتيح لك ربط شجرتي عمل معاً، مما يخلق جسراً بين فروع أو ميزات مختلفة. هذا قوي بشكل لا يصدق لسير عمل التطوير الذي يتطلب وعياً عبر الفروع.

### ما هي اتصالات Worktree؟

اربط أي شجرتي عمل لـ:
- **🔄 مشاركة السياق** - الوصول إلى الملفات والتغييرات من فرع آخر فوراً
- **🤝 التعاون** - العمل على ميزات مترابطة مع تحديثات حية بين أشجار العمل
- **📊 المقارنة** - رؤية الفروقات بين التطبيقات جنباً إلى جنب
- **🎯 المرجعية** - إبقاء الفرع الرئيسي مرئياً أثناء العمل على الميزات
- **🔗 ربط الميزات** - ربط فروع الواجهة الأمامية والخلفية للتطوير الشامل
- **💬 مشاركة جلسات AI** - متابعة محادثات الذكاء الاصطناعي عبر أشجار عمل مختلفة

### كيف يعمل

1. **اختر Worktree المصدر** - اختر شجرة العمل التي تعمل فيها
2. **اتصل بالهدف** - انقر أيقونة الاتصال واختر شجرة عمل أخرى
3. **رابط ثنائي الاتجاه** - تصبح كلتا شجرتي العمل على دراية ببعضهما
4. **تحديثات فورية** - شاهد التغييرات في أشجار العمل المتصلة فور حدوثها

### ميزات الاتصال

- ✅ **مزامنة حية** - تظهر تغييرات الملفات في شجرة عمل واحدة في لوحة الاتصال
- ✅ **تبديل سريع** - انتقل بين أشجار العمل المتصلة بنقرة واحدة
- ✅ **عرض الفروقات** - قارن الملفات بين أشجار العمل المتصلة
- ✅ **طرفية مشتركة** - نفّذ أوامر تؤثر على كلتا شجرتي العمل
- ✅ **مشاركة سياق AI** - يمكن لجلسات الذكاء الاصطناعي الإشارة إلى كود شجرة العمل المتصلة
- ✅ **مؤشرات الحالة** - شاهد حالة البناء والاختبارات والتغييرات في أشجار العمل المتصلة
- ✅ **سجل الاتصالات** - تتبّع أشجار العمل المتصلة ومتى تم ذلك
- ✅ **اقتراحات ذكية** - يقترح Hive أشجار عمل ذات صلة للاتصال بناءً على سير عملك

### أمثلة على حالات الاستخدام

**تطوير الميزات**: اربط فرع الميزة بالفرع الرئيسي لضمان التوافق ورؤية كيف تتكامل تغييراتك.

**إصلاح الأخطاء**: اربط worktree إصلاح الخطأ بفرع الإنتاج للتحقق من أن الإصلاح يعمل في السياق.

**مراجعة الكود**: اربط أشجار عمل المراجع والمؤلف لمناقشة التغييرات مع سياق كامل من كلا الجانبين.

**التطوير الشامل**: اربط أشجار عمل الواجهة الأمامية والخلفية للعمل على API وواجهة المستخدم في وقت واحد بتنسيق مثالي.

**إعادة الهيكلة**: اربط التطبيقات القديمة والجديدة لضمان تكافؤ الميزات أثناء عمليات إعادة الهيكلة الكبيرة.

## شاهده أثناء العمل

</div>

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="عرض Hive — تنسيق وكلاء AI عبر المشاريع" width="900" />
</div>

<details>
<summary><strong>المزيد من لقطات الشاشة</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — جلسة برمجة بالذكاء الاصطناعي مع أشجار عمل git" width="900" />
  <sub>جلسات برمجة بالذكاء الاصطناعي مع إدارة متكاملة لأشجار عمل git</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="إنشاء worktree جديد" width="900" />
  <sub>إنشاء وإدارة أشجار العمل بصرياً</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="شجرة الملفات مع حالة git" width="900" />
  <sub>مستكشف الملفات مع مؤشرات حالة git الحية</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="عرض السمات" width="900" />
  <sub>سمات جميلة لكل تفضيل</sub>
</div>

</details>

<div dir="rtl">

## المجتمع والدعم

</div>

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_التوثيق-اقرأ-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_المشاكل-أبلغ-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_النقاشات-انضم-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_المساهمة-إرشادات-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_الأمان-السياسة-orange?style=for-the-badge)](SECURITY.md)

</div>

<div dir="rtl">

### احصل على المساعدة

- 📖 اقرأ [التوثيق](docs/) للأدلة التفصيلية
- 🐛 [أبلغ عن الأخطاء](https://github.com/morapelker/hive/issues/new?template=bug_report.md) مع خطوات إعادة الإنتاج
- 💡 [اطلب ميزات](https://github.com/morapelker/hive/issues/new?template=feature_request.md) تريد رؤيتها
- 💬 [انضم للنقاشات](https://github.com/morapelker/hive/discussions) للتواصل مع المجتمع
- 🔒 [أبلغ عن ثغرات أمنية](SECURITY.md) بمسؤولية

### الموارد

- [دليل المستخدم](docs/GUIDE.md) — البداية والدروس التعليمية
- [الأسئلة الشائعة](docs/FAQ.md) — أسئلة شائعة واستكشاف الأخطاء
- [اختصارات لوحة المفاتيح](docs/SHORTCUTS.md) — مرجع كامل للاختصارات

## خارطة الطريق

### 🚀 قادم قريباً

- **دعم عبر المنصات** — بناء لـ Windows وLinux
- **نظام إضافات** — وسّع Hive بتكاملات مخصصة
- **مزامنة سحابية** — مزامنة الإعدادات والجلسات وقوالب الاتصال عبر الأجهزة
- **ميزات الفريق** — شارك أشجار العمل وتعاون في الوقت الفعلي
- **تصور مخطط Git** — تاريخ الفروع والدمج بصرياً
- **ملفات تعريف الأداء** — أدوات مدمجة للتحسين

### 🎯 الرؤية المستقبلية

- **التطوير عن بُعد** — تطوير عبر SSH والحاويات
- **اتصالات ثلاثية** — اربط وادمج عدة فروع بصرياً
- **تكامل CI/CD** — مراقبة GitHub Actions وGitLab CI وJenkins
- **أتمتة الاتصالات** — اتصال تلقائي بالفروع المترابطة بناءً على الأنماط
- **وضع مراجعة الكود** — نوع اتصال خاص محسّن للمراجعات
- **تتبع الوقت** — تحليلات نشاط لكل worktree واتصال

هل تريد التأثير في خارطة الطريق؟ [انضم للنقاش](https://github.com/morapelker/hive/discussions/categories/ideas) أو [ساهم](CONTRIBUTING.md)!

---

<details>
<summary><strong>التطوير</strong></summary>

### المتطلبات الأساسية

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (دعم worktree)

### الإعداد

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### طرفية Ghostty (اختياري)

يتضمن Hive طرفية أصلية اختيارية مدعومة بـ `libghostty` من [Ghostty](https://ghostty.org/). هذا مطلوب فقط إذا أردت العمل على ميزة الطرفية المدمجة.

**الإعداد:**

1. ابنِ `libghostty` من مصدر Ghostty ([تعليمات البناء](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   هذا ينتج `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. إذا كان مستودع Ghostty في `~/Documents/dev/ghostty/`، سيجده البناء تلقائياً. وإلا، حدد المسار:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. أعد بناء الوحدة الأصلية:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

إذا لم يكن `libghostty` متاحاً، سيبني Hive ويعمل بشكل طبيعي -- ستكون ميزة طرفية Ghostty معطّلة فقط.

### الأوامر

| الأمر           | الوصف           |
| ----------------- | --------------------- |
| `pnpm dev`        | بدء مع إعادة التحميل الحي |
| `pnpm build`      | بناء الإنتاج      |
| `pnpm lint`       | فحص ESLint          |
| `pnpm lint:fix`   | إصلاح ESLint تلقائياً       |
| `pnpm format`     | تنسيق Prettier       |
| `pnpm test`       | تشغيل جميع الاختبارات         |
| `pnpm test:watch` | وضع المراقبة            |
| `pnpm test:e2e`   | اختبارات Playwright E2E  |
| `pnpm build:mac`  | حزمة لـ macOS     |

### البنية

يستخدم Hive نموذج العمليات الثلاث في Electron مع وضع الحماية الصارم:

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

### هيكل المشروع

```
src/
├── main/                  # عملية Electron الرئيسية (Node.js)
│   ├── db/                # قاعدة بيانات SQLite + مخطط + ترحيلات
│   ├── ipc/               # وحدات معالجة IPC
│   └── services/          # خدمات Git، AI agents، السجل، الملفات
├── preload/               # طبقة الجسر (واجهات window.* المصنّفة)
└── renderer/src/          # تطبيق React SPA
    ├── components/        # واجهات منظمة حسب المجال
    ├── hooks/             # React hooks مخصصة
    ├── lib/               # أدوات مساعدة، سمات، مساعدين
    └── stores/            # إدارة حالة Zustand
```

### المجموعة التقنية

| الطبقة     | التقنية                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| الإطار | [Electron 33](https://www.electronjs.org/)                                       |
| الواجهة  | [React 19](https://react.dev/)                                                   |
| اللغة  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| التنسيق   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| الحالة     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| قاعدة البيانات  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (وضع WAL)          |
| الذكاء الاصطناعي        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| البناء     | [electron-vite](https://electron-vite.org/)                                      |

### التوثيق

التوثيق التفصيلي في [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- متطلبات المنتج
- **[التنفيذ](docs/implementation/)** -- أدلة تقنية
- **[المواصفات](docs/specs/)** -- مواصفات الميزات
- **[الخطط](docs/plans/)** -- خطط التنفيذ النشطة

</details>

## المساهمة

نحب المساهمات! Hive مبني بواسطة المطورين، للمطورين، ونرحب بالتحسينات من كل نوع.

### طرق المساهمة

- 🐛 **أبلغ عن الأخطاء** مع خطوات واضحة لإعادة الإنتاج
- 💡 **اقترح ميزات** من شأنها تحسين سير عملك
- 📝 **حسّن التوثيق** لمساعدة الآخرين على البدء
- 🎨 **قدّم تحسينات UI/UX** لسهولة استخدام أفضل
- 🔧 **أصلح الأخطاء** من متتبع المشاكل
- ⚡ **حسّن الأداء** في المسارات الحرجة
- 🧪 **أضف اختبارات** لتحسين التغطية
- 🌐 **ترجم** التطبيق إلى لغتك

قبل المساهمة، يرجى قراءة [إرشادات المساهمة](CONTRIBUTING.md) و[قواعد السلوك](CODE_OF_CONDUCT.md).

### دليل المساهمة السريع

1. افرع المستودع (Fork)
2. أنشئ فرع ميزة (`git checkout -b feature/amazing-feature`)
3. أجرِ تغييراتك
4. شغّل الاختبارات (`pnpm test`) والفحص (`pnpm lint`)
5. أودع بالتزام مع رسالة وصفية
6. ادفع إلى نسختك
7. افتح طلب سحب (Pull Request)

انظر [CONTRIBUTING.md](CONTRIBUTING.md) للإرشادات التفصيلية.

## الرخصة

[MIT](LICENSE) © 2024 morapelker

Hive برنامج مفتوح المصدر مرخص بموجب رخصة MIT. انظر ملف [LICENSE](LICENSE) للتفاصيل الكاملة.

</div>
