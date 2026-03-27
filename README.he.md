<div align="center" dir="rtl">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>מתזמר סוכני AI בקוד פתוח לקידוד מקבילי בין פרויקטים.</strong></p>
  <p>הריצו סשנים של Claude Code, OpenCode ו-Codex במקביל. חלון אחד. ענפים מבודדים. אפס כאוס טאבים.</p>
</div>
<div align="center">
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md"><strong>עברית</strong></a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
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

## תוכן עניינים

- [מה זה Hive?](#מה-זה-hive)
- [תכונות](#תכונות)
- [למה Hive?](#למה-hive)
- [התקנה](#התקנה)
- [התחלה מהירה](#התחלה-מהירה)
- [חיבורים - משנה את כללי המשחק](#-חיבורים---משנה-את-כללי-המשחק)
- [צילומי מסך](#צילומי-מסך)
- [קהילה ותמיכה](#קהילה-ותמיכה)
- [מפת דרכים](#מפת-דרכים)
- [פיתוח](#פיתוח)
- [תרומה](#תרומה)
- [רישיון](#רישיון)

## מה זה Hive?

אם אתם מריצים מספר סוכני קידוד AI בין פרויקטים וענפים שונים, אתם מכירים את הכאב -- שישה טאבים של טרמינל פתוחים, אתם לא זוכרים איזה סוכן עובד על מה, ואתם מודאגים ששניים מהם עורכים את אותם קבצים.

Hive הוא מתזמר סוכני AI. ראו את כל הסוכנים הפעילים שלכם בסרגל צד אחד, לחצו כדי לעבור ביניהם, וכל אחד רץ על ענף worktree מבודד ב-git כך שהם לא יכולים להתנגש. חברו מספר מאגרים יחד כך שלסשן סוכן יחיד יש הקשר על כל הסטאק הטכנולוגי שלכם.

## תכונות

### 🌳 **זרימת עבודה מבוססת Worktree**
עבדו על מספר ענפים בו-זמנית בלי stashing או switching. צרו, ארכבו וארגנו עצי עבודה בלחיצה אחת. כל worktree מקבל שם ייחודי מבוסס ערים לזיהוי קל.

### 🤖 **סשני קידוד AI מובנים**
הריצו סוכני קידוד AI ישירות בתוך Hive עם תמיכה ב-**OpenCode** וב-**Claude Code**. צפו בתגובות בזמן אמת, עקבו אחרי קריאות כלים בביצוע, ואשרו הרשאות לפי הצורך. תמיכה מלאה ב-undo/redo שומרת אתכם בשליטה.

### 📁 **סייר קבצים חכם**
ראו מה השתנה במבט עם מחווני סטטוס git חיים. צפו ב-diffs ישירות, דפדפו בהיסטוריית קבצים, ונווטו בקוד בלי לעזוב את האפליקציה. עורך Monaco המשולב מספק חווית VS Code מלאה.

### 🔧 **אינטגרציית Git מלאה**
בצעו commit, push, pull ונהלו ענפים ויזואלית. אין צורך בטרמינל לפעולות git נפוצות. ראו שינויים ממתינים, קבצים ב-stage והיסטוריית commits הכל במקום אחד.

### 📦 **מרחבים לארגון**
קבצו פרויקטים ועצי עבודה קשורים למרחבי עבודה לוגיים. הצמידו מועדפים לגישה מהירה. שמרו על סביבת הפיתוח מסודרת כשאתם מתרחבים.

### ⚡ **פלטת פקודות**
נווטו ופעלו מהר עם קיצורי מקלדת. לחצו `Cmd+K` כדי לגשת לכל תכונה מיידית. חפשו סשנים, החליפו עצי עבודה, או הריצו פקודות בלי לגעת בעכבר.

### 🎨 **ערכות נושא יפות**
בחרו מתוך 10 ערכות נושא מעוצבות בקפידה — 6 כהות ו-4 בהירות. החליפו מיידית להתאים להעדפותיכם או לזמן ביום. עוקב אחרי ערכת הנושא של המערכת אוטומטית אם תרצו.

### 🖥️ **פרוטוקול שרת שפה**
אינטגרציית LSP מלאה עם שרתי שפה לכל worktree. קבלו השלמת קוד חכמה, מעבר להגדרה, tooltips בריחוף, ודיאגנוסטיקה בזמן אמת ל-TypeScript, Python, Go, Rust ועוד.

### 🔌 **חיבורי Worktree**
חברו שני עצי עבודה יחד כדי לשתף הקשר, להשוות מימושים, או לשתף פעולה בזמן אמת. מושלם לסקירת שינויים בין ענפים, שיתוף סשני AI בין עצי עבודה, או שמירה על עקביות כשעובדים על תכונות קשורות. ראו עדכונים חיים כשעצי עבודה מחוברים משתנים.

## למה Hive?

ראו איך Hive משנה את זרימת העבודה שלכם עם git:

| משימה | זרימת עבודה מסורתית | עם Hive |
|------|---------------------|-----------|
| **החלפת ענפים** | `git stash` → `git checkout` → `git stash pop` | לחיצה על worktree → סיום |
| **עבודה על מספר תכונות** | stashing מתמיד ומעבר הקשר | פתיחת מספר עצי עבודה זה לצד זה |
| **יצירת worktree** | `git worktree add ../project-feature origin/feature` | לחיצה על "Worktree חדש" → בחירת ענף |
| **עזרת קידוד AI** | טרמינל + כלי AI נפרד + העתק/הדבק | סשני AI משולבים עם הקשר מלא |
| **צפייה בשינויי קבצים** | `git status` → `git diff file.ts` | עץ ויזואלי עם diffs מוטמעים |
| **השוואת ענפים** | מספר טאבים של טרמינל, העתק/הדבק ביניהם | חיבור עצי עבודה לשיתוף הקשר |
| **מציאת worktree** | `cd ~/projects/...` → לזכור שמות תיקיות | כל עצי העבודה בסרגל צד אחד |
| **ניקוי עצי עבודה** | `git worktree remove` → `rm -rf directory` | לחיצה על "ארכיב" → מטפל בהכל |

## התקנה

> 🍎 **macOS בלבד** — תמיכה ב-Windows ו-Linux בקרוב.

### דרך Homebrew (מומלץ)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### הורדה ישירה

הורידו את קובץ ה-`.dmg` העדכני ביותר מ-[GitHub Releases](https://github.com/morapelker/hive/releases/latest).

זהו! פתחו את Hive מתיקיית היישומים וכוונו אותו למאגר git.

## התחלה מהירה

התחילו לעבוד תוך פחות מ-2 דקות:

### 1️⃣ **הוסיפו את הפרויקט הראשון שלכם**
פתחו את Hive → לחצו **"הוסף פרויקט"** → בחרו כל מאגר git במחשב שלכם

### 2️⃣ **צרו Worktree**
בחרו את הפרויקט שלכם → לחצו **"Worktree חדש"** → בחרו ענף (או צרו חדש)

### 3️⃣ **התחילו לקודד עם AI**
פתחו worktree → לחצו **"סשן חדש"** → התחילו לקודד עם OpenCode או Claude

> 💡 **טיפ מקצועי**: לחצו `Cmd+K` בכל עת כדי לפתוח את פלטת הפקודות ולנווט במהירות!

📖 [קראו את המדריך המלא](docs/GUIDE.md) | ⌨️ [קיצורי מקלדת](docs/SHORTCUTS.md)

## 🔌 חיבורי Worktree - משנה את כללי המשחק

תכונת **חיבורי ה-Worktree** של Hive מאפשרת לכם לקשר שני עצי עבודה יחד, ויוצרת גשר בין ענפים או תכונות שונות. זה חזק להפליא עבור זרימות עבודה בפיתוח שדורשות מודעות בין-ענפית.

### מה הם חיבורי Worktree?

חברו כל שני עצי עבודה כדי:
- **🔄 שיתוף הקשר** - גישה לקבצים ושינויים מענף אחר מיידית
- **🤝 שיתוף פעולה** - עבודה על תכונות קשורות עם עדכונים חיים בין עצי עבודה
- **📊 השוואה** - ראו הבדלים בין מימושים זה לצד זה
- **🎯 התייחסות** - שמירה על הענף הראשי גלוי בזמן עבודה על תכונות
- **🔗 קישור תכונות** - חיבור ענפי frontend ו-backend לפיתוח full-stack
- **💬 שיתוף סשני AI** - המשך שיחות AI בין עצי עבודה שונים

### איך זה עובד

1. **בחרו Worktree מקור** - בחרו את עץ העבודה שבו אתם עובדים
2. **חברו ליעד** - לחצו על אייקון החיבור ובחרו עץ עבודה אחר
3. **קישור דו-כיווני** - שני עצי העבודה הופכים מודעים זה לזה
4. **עדכונים בזמן אמת** - ראו שינויים בעצי עבודה מחוברים כשהם קורים

### תכונות חיבור

- ✅ **סנכרון חי** - שינויי קבצים בעץ עבודה אחד מופיעים בפאנל החיבור
- ✅ **החלפה מהירה** - קפצו בין עצי עבודה מחוברים בלחיצה אחת
- ✅ **תצוגת Diff** - השוו קבצים בין עצי עבודה מחוברים
- ✅ **טרמינל משותף** - הריצו פקודות שמשפיעות על שני עצי העבודה
- ✅ **שיתוף הקשר AI** - סשני AI יכולים להתייחס לקוד של עץ עבודה מחובר
- ✅ **מחווני סטטוס** - ראו סטטוס build, טסטים ושינויים בעצי עבודה מחוברים
- ✅ **היסטוריית חיבורים** - עקבו אחרי אילו עצי עבודה חוברו ומתי
- ✅ **הצעות חכמות** - Hive מציע עצי עבודה רלוונטיים לחיבור בהתבסס על זרימת העבודה שלכם

### דוגמאות לשימוש

**פיתוח תכונות**: חברו את ענף התכונה ל-main כדי להבטיח תאימות ולראות איך השינויים שלכם משתלבים.

**תיקוני באגים**: חברו את worktree תיקון הבאג לענף הייצור כדי לוודא שהתיקון עובד בהקשר.

**סקירות קוד**: חברו עצי עבודה של הסוקר והמחבר כדי לדון בשינויים עם הקשר מלא משני הצדדים.

**פיתוח Full-Stack**: חברו עצי עבודה של frontend ו-backend כדי לעבוד על API ו-UI בו-זמנית עם תיאום מושלם.

**רפקטורינג**: חברו מימושים ישנים וחדשים כדי להבטיח שוויון תכונות במהלך רפקטורינג גדול.

## ראו את זה בפעולה

</div>

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="הדגמת Hive — תזמור סוכני AI בין פרויקטים" width="900" />
</div>

<details>
<summary><strong>צילומי מסך נוספים</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — סשן קידוד AI עם עצי עבודה של git" width="900" />
  <sub>סשני קידוד AI עם ניהול משולב של עצי עבודה git</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="יצירת worktree חדש" width="900" />
  <sub>צרו ונהלו עצי עבודה ויזואלית</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="עץ קבצים עם סטטוס git" width="900" />
  <sub>סייר קבצים עם מחווני סטטוס git חיים</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="תצוגת ערכות נושא" width="900" />
  <sub>ערכות נושא יפות לכל העדפה</sub>
</div>

</details>

<div dir="rtl">

## קהילה ותמיכה

</div>

<div align="center">

[![Documentation](https://img.shields.io/badge/📖_תיעוד-קראו-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_באגים-דווחו-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussions](https://img.shields.io/badge/💬_דיונים-הצטרפו-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contributing](https://img.shields.io/badge/🤝_תרומה-הנחיות-green?style=for-the-badge)](CONTRIBUTING.md)
[![Security](https://img.shields.io/badge/🔒_אבטחה-מדיניות-orange?style=for-the-badge)](SECURITY.md)

</div>

<div dir="rtl">

### קבלו עזרה

- 📖 קראו את [התיעוד](docs/) למדריכים מפורטים
- 🐛 [דווחו על באגים](https://github.com/morapelker/hive/issues/new?template=bug_report.md) עם צעדים לשחזור
- 💡 [בקשו תכונות](https://github.com/morapelker/hive/issues/new?template=feature_request.md) שתרצו לראות
- 💬 [הצטרפו לדיונים](https://github.com/morapelker/hive/discussions) כדי להתחבר לקהילה
- 🔒 [דווחו על חולשות אבטחה](SECURITY.md) באחריות

### משאבים

- [מדריך למשתמש](docs/GUIDE.md) — תחילת עבודה ומדריכים
- [שאלות נפוצות](docs/FAQ.md) — שאלות נפוצות ופתרון בעיות
- [קיצורי מקלדת](docs/SHORTCUTS.md) — מדריך מלא לקיצורים

## מפת דרכים

### 🚀 בקרוב

- **תמיכה חוצת פלטפורמות** — בנייה ל-Windows ו-Linux
- **מערכת תוספים** — הרחיבו את Hive עם אינטגרציות מותאמות
- **סנכרון ענן** — סנכרון הגדרות, סשנים ותבניות חיבור בין מכשירים
- **תכונות צוות** — שתפו עצי עבודה ושתפו פעולה בזמן אמת
- **ויזואליזציית גרף Git** — היסטוריית ענפים ומיזוגים ויזואלית
- **פרופיילינג ביצועים** — כלים מובנים לאופטימיזציה

### 🎯 חזון עתידי

- **פיתוח מרחוק** — פיתוח מבוסס SSH וקונטיינרים
- **חיבורים תלת-כיווניים** — חברו ומזגו מספר ענפים ויזואלית
- **אינטגרציית CI/CD** — מעקב GitHub Actions, GitLab CI, Jenkins
- **אוטומציית חיבורים** — חיבור אוטומטי של ענפים קשורים לפי דפוסים
- **מצב סקירת קוד** — סוג חיבור מיוחד מותאם לסקירות
- **מעקב זמן** — אנליטיקת פעילות לכל worktree וחיבור

רוצים להשפיע על מפת הדרכים? [הצטרפו לדיון](https://github.com/morapelker/hive/discussions/categories/ideas) או [תרמו](CONTRIBUTING.md)!

---

<details>
<summary><strong>פיתוח</strong></summary>

### דרישות מוקדמות

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (תמיכת worktree)

### הגדרה

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### טרמינל Ghostty (אופציונלי)

Hive כולל טרמינל native אופציונלי מופעל על ידי `libghostty` של [Ghostty](https://ghostty.org/). זה נדרש רק אם רוצים לעבוד על תכונת הטרמינל המשובץ.

**הגדרה:**

1. בנו את `libghostty` ממקור Ghostty ([הוראות בנייה](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   זה מייצר `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. אם מאגר ה-Ghostty שלכם ב-`~/Documents/dev/ghostty/`, הבנייה תמצא אותו אוטומטית. אחרת, הגדירו את הנתיב:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. בנו מחדש את ה-addon ה-native:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

אם `libghostty` לא זמין, Hive עדיין נבנה ורץ -- תכונת הטרמינל של Ghostty פשוט תהיה מושבתת.

### פקודות

| פקודה           | תיאור           |
| ----------------- | --------------------- |
| `pnpm dev`        | התחלה עם hot reload |
| `pnpm build`      | בניית production      |
| `pnpm lint`       | בדיקת ESLint          |
| `pnpm lint:fix`   | תיקון אוטומטי ESLint       |
| `pnpm format`     | עיצוב Prettier       |
| `pnpm test`       | הרצת כל הטסטים         |
| `pnpm test:watch` | מצב צפייה            |
| `pnpm test:e2e`   | טסטי Playwright E2E  |
| `pnpm build:mac`  | אריזה ל-macOS     |

### ארכיטקטורה

Hive משתמש במודל שלוש התהליכים של Electron עם sandboxing קפדני:

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

### מבנה הפרויקט

```
src/
├── main/                  # תהליך Electron ראשי (Node.js)
│   ├── db/                # מסד נתונים SQLite + סכמה + מיגרציות
│   ├── ipc/               # מודולי מטפלי IPC
│   └── services/          # שירותי Git, OpenCode, לוגר, קבצים
├── preload/               # שכבת גשר (ממשקי window.* מוקלדים)
└── renderer/src/          # אפליקציית React SPA
    ├── components/        # ממשק משתמש מאורגן לפי תחום
    ├── hooks/             # React hooks מותאמים
    ├── lib/               # כלי עזר, ערכות נושא, מסייעים
    └── stores/            # ניהול מצב Zustand
```

### סטאק טכנולוגי

| שכבה     | טכנולוגיה                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| פריימוורק | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| שפה  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| עיצוב   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| מצב     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| מסד נתונים  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (מצב WAL)          |
| AI        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| בנייה     | [electron-vite](https://electron-vite.org/)                                      |

### תיעוד

תיעוד מפורט ב-[`docs/`](docs/):

- **[PRDs](docs/prd/)** -- דרישות מוצר
- **[מימוש](docs/implementation/)** -- מדריכים טכניים
- **[מפרטים](docs/specs/)** -- מפרטי תכונות
- **[תוכניות](docs/plans/)** -- תוכניות מימוש פעילות

</details>

## תרומה

אנחנו אוהבים תרומות! Hive נבנה על ידי מפתחים, למפתחים, ואנחנו מקבלים בברכה שיפורים מכל הסוגים.

### דרכים לתרום

- 🐛 **דווחו על באגים** עם צעדי שחזור ברורים
- 💡 **הציעו תכונות** שישפרו את זרימת העבודה שלכם
- 📝 **שפרו תיעוד** כדי לעזור לאחרים להתחיל
- 🎨 **הגישו שיפורי UI/UX** לנוחות שימוש טובה יותר
- 🔧 **תקנו באגים** ממעקב הבעיות שלנו
- ⚡ **ייעלו ביצועים** בנתיבים קריטיים
- 🧪 **הוסיפו טסטים** לשיפור הכיסוי
- 🌐 **תרגמו** את האפליקציה לשפה שלכם

לפני שתורמים, אנא קראו את [הנחיות התרומה](CONTRIBUTING.md) ו[כללי ההתנהגות](CODE_OF_CONDUCT.md).

### מדריך תרומה מהיר

1. עשו Fork למאגר
2. צרו ענף תכונה (`git checkout -b feature/amazing-feature`)
3. בצעו את השינויים שלכם
4. הריצו טסטים (`pnpm test`) ו-linting (`pnpm lint`)
5. בצעו commit עם הודעה מתארת
6. דחפו ל-fork שלכם
7. פתחו Pull Request

ראו [CONTRIBUTING.md](CONTRIBUTING.md) להנחיות מפורטות.

## רישיון

[MIT](LICENSE) © 2024 morapelker

Hive הוא תוכנת קוד פתוח ברישיון MIT. ראו את קובץ [LICENSE](LICENSE) לפרטים מלאים.

</div>
