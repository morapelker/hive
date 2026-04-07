<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Projeler arası paralel kodlama için açık kaynaklı bir AI ajan orkestratörü.</strong></p>
  <p>Claude Code, OpenCode ve Codex oturumlarını paralel çalıştırın. Tek pencere. İzole dallar. Sıfır sekme kaosu.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md"><strong>Türkçe</strong></a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Son Sürüm" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="İndirmeler" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Build Durumu" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Lisans" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PR'lar Hoş Geldiniz" /></a>
  </p>
</div>

---

## İçindekiler

- [Kurulum](#kurulum)
- [Hive Nedir?](#hive-nedir)
- [Özellikler](#özellikler)
- [Neden Hive?](#neden-hive)
- [Hızlı Başlangıç](#hızlı-başlangıç)
- [Bağlantılar — Oyun Değiştirici](#-bağlantılar---oyun-değiştirici)
- [Ekran Görüntüleri](#ekran-görüntüleri)
- [Topluluk ve Destek](#topluluk-ve-destek)
- [Yol Haritası](#yol-haritası)
- [Geliştirme](#geliştirme)
- [Katkıda Bulunma](#katkıda-bulunma)
- [Lisans](#lisans)

## Kurulum

> 🍎 **Yalnızca macOS** — Windows ve Linux desteği yakında.

### Homebrew ile (Önerilen)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Doğrudan İndirme

En son `.dmg` dosyasını [GitHub Releases](https://github.com/morapelker/hive/releases/latest) sayfasından indirin.

Bu kadar! Uygulamalar klasöründen Hive'ı açın ve bir git deposuna yönlendirin.

## Hive Nedir?

Farklı projeler ve dallar üzerinde birden fazla AI kodlama ajanı çalıştırıyorsanız, bu acıyı bilirsiniz — altı terminal sekmesi açık, hangi ajanın ne üzerinde çalıştığını hatırlayamıyorsunuz ve ikisinin aynı dosyaları düzenlediğinden endişeleniyorsunuz.

Hive bir AI ajan orkestratörüdür. Çalışan tüm ajanlarınızı tek bir kenar çubuğunda görün, aralarında geçiş yapmak için tıklayın ve her biri izole bir git worktree dalında çalışır, böylece çakışamazlar. Birden fazla depoyu birbirine bağlayarak tek bir ajan oturumunun tüm stack'iniz hakkında bağlama sahip olmasını sağlayın.

## Özellikler

### 🌳 **Worktree Öncelikli İş Akışı**
Stash yapmadan veya dal değiştirmeden aynı anda birden fazla dalda çalışın. Tek tıkla worktree oluşturun, arşivleyin ve düzenleyin. Her worktree kolay tanımlama için şehir tabanlı benzersiz bir ad alır.

### 🤖 **Yerleşik AI Kodlama Oturumları**
**OpenCode**, **Claude Code** ve **Codex** desteğiyle AI kodlama ajanlarını doğrudan Hive içinde çalıştırın. Yanıtları gerçek zamanlı aktarın, araç çağrılarının yürütülmesini izleyin ve gerektiğinde izinleri onaylayın. Tam geri al/yinele desteği sizi kontrol altında tutar.

### 📁 **Akıllı Dosya Gezgini**
Canlı git durum göstergeleriyle nelerin değiştiğini bir bakışta görün. Diff'leri satır içi görüntüleyin, dosya geçmişini göz atın ve uygulamadan çıkmadan kod tabanınızda gezinin. Entegre Monaco editörü tam bir VS Code deneyimi sunar.

### 🔧 **Tam Git Entegrasyonu**
Commit, push, pull yapın ve dalları görsel olarak yönetin. Yaygın git işlemleri için terminal gerekmez. Bekleyen değişiklikleri, hazırlanmış dosyaları ve commit geçmişini tek bir yerde görün.

### 📦 **Organizasyon için Alanlar**
İlgili projeleri ve worktree'leri mantıksal çalışma alanlarına gruplayın. Hızlı erişim için favorilerinizi sabitleyin. Büyüdükçe geliştirme ortamınızı düzenli tutun.

### ⚡ **Komut Paleti**
Klavye kısayollarıyla hızlıca gezinin ve hareket edin. `Cmd+K` tuşuna basarak herhangi bir özelliğe anında erişin. Fareye dokunmadan oturum arayın, worktree değiştirin veya komut çalıştırın.

### 🎨 **Güzel Temalar**
Özenle hazırlanmış 10 tema arasından seçin — 6 koyu ve 4 açık. Tercihinize veya günün saatine göre anında değiştirin. İstenirse sistem temasını otomatik takip eder.

### 🖥️ **Language Server Protocol**
Worktree başına dil sunucuları ile tam LSP entegrasyonu. TypeScript, Python, Go, Rust ve daha fazlası için akıllı kod tamamlama, tanıma git, fare üzerinde araç ipuçları ve gerçek zamanlı tanılama alın.

### 🔌 **Worktree Bağlantıları**
İki worktree'yi bağlayarak bağlam paylaşın, uygulamaları karşılaştırın veya gerçek zamanlı işbirliği yapın. Dallar arası değişiklikleri inceleme, worktree'ler arası AI oturumları paylaşma veya ilgili özellikler üzerinde çalışırken tutarlılık sağlama için mükemmeldir. Bağlı worktree'ler değiştiğinde canlı güncellemeleri görün.

## Neden Hive?

Hive'ın git iş akışınızı nasıl dönüştürdüğünü görün:

| Görev | Geleneksel İş Akışı | Hive ile |
|------|---------------------|-----------|
| **Dal değiştirme** | `git stash` → `git checkout` → `git stash pop` | Worktree'ye tıkla → Tamam |
| **Birden fazla özellik üzerinde çalışma** | Sürekli stash ve bağlam değiştirme | Birden fazla worktree'yi yan yana aç |
| **Worktree oluşturma** | `git worktree add ../project-feature origin/feature` | "Yeni Worktree" tıkla → Dal seç |
| **AI kodlama yardımı** | Terminal + ayrı AI aracı + kopyala/yapıştır | Tam bağlamlı entegre AI oturumları |
| **Dosya değişikliklerini görme** | `git status` → `git diff file.ts` | Satır içi diff'li görsel ağaç |
| **Dalları karşılaştırma** | Birden fazla terminal sekmesi, kopyala/yapıştır | Worktree'leri bağlayarak bağlam paylaş |
| **Worktree bulma** | `cd ~/projects/...` → dizin adlarını hatırla | Tüm worktree'ler tek kenar çubuğunda |
| **Worktree temizleme** | `git worktree remove` → `rm -rf directory` | "Arşivle" tıkla → Her şeyi halleder |

## Hızlı Başlangıç

2 dakikadan kısa sürede çalışmaya başlayın:

### 1️⃣ **İlk Projenizi Ekleyin**
Hive'ı açın → **"Add Project"** tıklayın → Makinenizdeki herhangi bir git deposunu seçin

### 2️⃣ **Worktree Oluşturun**
Projenizi seçin → **"New Worktree"** tıklayın → Bir dal seçin (veya yeni oluşturun)

### 3️⃣ **AI ile Kodlamaya Başlayın**
Bir worktree açın → **"New Session"** tıklayın → OpenCode, Claude veya Codex ile kodlamaya başlayın

> 💡 **Pro ipucu**: Komut paletini açmak ve hızlıca gezinmek için istediğiniz zaman `Cmd+K` tuşuna basın!

📖 [Tam kılavuzu okuyun](docs/GUIDE.md) | ⌨️ [Klavye kısayolları](docs/SHORTCUTS.md)

## 🔌 Worktree Bağlantıları — Oyun Değiştirici

Hive'ın **Worktree Bağlantıları** özelliği, iki worktree'yi birbirine bağlayarak farklı dallar veya özellikler arasında bir köprü oluşturmanıza olanak tanır. Dallar arası farkındalık gerektiren geliştirme iş akışları için inanılmaz güçlüdür.

### Worktree Bağlantıları Nedir?

Herhangi iki worktree'yi bağlayarak:
- **🔄 Bağlam Paylaşımı** - Başka bir dalın dosyalarına ve değişikliklerine anında erişin
- **🤝 İşbirliği** - Worktree'ler arası canlı güncellemelerle ilgili özellikler üzerinde çalışın
- **📊 Karşılaştırma** - Uygulamalar arasındaki farkları yan yana görün
- **🎯 Referans** - Özellikler üzerinde çalışırken ana dalınızı görünür tutun
- **🔗 Özellik Bağlama** - Full-stack geliştirme için frontend ve backend dallarını bağlayın
- **💬 AI Oturumu Paylaşımı** - Farklı worktree'ler arasında AI konuşmalarını sürdürün

### Nasıl Çalışır

1. **Kaynak Worktree'yi Seçin** - Çalıştığınız worktree'yi seçin
2. **Hedefe Bağlanın** - Bağlantı simgesine tıklayıp başka bir worktree seçin
3. **Çift Yönlü Bağlantı** - Her iki worktree birbirinden haberdar olur
4. **Gerçek Zamanlı Güncellemeler** - Bağlı worktree'lerdeki değişiklikleri anında görün

### Bağlantı Özellikleri

- ✅ **Canlı Senkronizasyon** - Bir worktree'deki dosya değişiklikleri bağlantı panelinde görünür
- ✅ **Hızlı Geçiş** - Bağlı worktree'ler arasında tek tıkla atlayın
- ✅ **Fark Görünümü** - Bağlı worktree'ler arasında dosyaları karşılaştırın
- ✅ **Paylaşılan Terminal** - Her iki worktree'yi etkileyen komutlar çalıştırın
- ✅ **AI Bağlam Paylaşımı** - AI oturumları bağlı worktree koduna başvurabilir
- ✅ **Durum Göstergeleri** - Bağlı worktree'lerdeki build durumu, testler ve değişiklikleri görün
- ✅ **Bağlantı Geçmişi** - Hangi worktree'lerin ne zaman bağlandığını takip edin
- ✅ **Akıllı Öneriler** - Hive, iş akışınıza göre bağlanılacak ilgili worktree'leri önerir

### Kullanım Senaryoları

**Özellik Geliştirme**: Uyumluluğu sağlamak ve değişikliklerinizin nasıl entegre olduğunu görmek için özellik dalınızı main'e bağlayın.

**Hata Düzeltmeleri**: Düzeltmenin bağlamda çalıştığını doğrulamak için hata düzeltme worktree'sini production dalına bağlayın.

**Kod İncelemeleri**: Her iki tarafta da tam bağlamla değişiklikleri tartışmak için inceleyici ve yazar worktree'lerini bağlayın.

**Full-Stack Geliştirme**: Mükemmel koordinasyonla API ve UI üzerinde aynı anda çalışmak için frontend ve backend worktree'lerini bağlayın.

**Yeniden Yapılandırma**: Büyük yeniden yapılandırmalar sırasında özellik eşitliğini sağlamak için eski ve yeni uygulamaları bağlayın.

## Uygulamada Görün

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Hive demosu — projeler arası AI ajanlarını yönetin" width="900" />
</div>

<details>
<summary><strong>Daha Fazla Ekran Görüntüsü</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — git worktree'lerle AI kodlama oturumu" width="900" />
  <sub>Entegre git worktree yönetimiyle AI destekli kodlama oturumları</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Yeni worktree oluşturma" width="900" />
  <sub>Worktree'leri görsel olarak oluşturun ve yönetin</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Git durumuyla dosya ağacı" width="900" />
  <sub>Canlı git durum göstergeleriyle dosya gezgini</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Tema vitrini" width="900" />
  <sub>Her tercihe uygun güzel temalar</sub>
</div>

</details>

## Topluluk ve Destek

<div align="center">

[![Dokümantasyon](https://img.shields.io/badge/📖_Dokümantasyon-Oku-blue?style=for-the-badge)](docs/)
[![Sorunlar](https://img.shields.io/badge/🐛_Sorunlar-Bildir-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Tartışmalar](https://img.shields.io/badge/💬_Tartışmalar-Katıl-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Katkı](https://img.shields.io/badge/🤝_Katkı-Kurallar-green?style=for-the-badge)](CONTRIBUTING.md)
[![Güvenlik](https://img.shields.io/badge/🔒_Güvenlik-Politika-orange?style=for-the-badge)](SECURITY.md)

</div>

### Yardım Alın

- 📖 Ayrıntılı kılavuzlar için [dokümantasyonu](docs/) okuyun
- 🐛 Yeniden üretim adımlarıyla [hata bildirin](https://github.com/morapelker/hive/issues/new?template=bug_report.md)
- 💡 Görmek istediğiniz [özellik isteyin](https://github.com/morapelker/hive/issues/new?template=feature_request.md)
- 💬 Toplulukla bağlantı kurmak için [tartışmalara katılın](https://github.com/morapelker/hive/discussions)
- 🔒 [Güvenlik açıklarını sorumlu bir şekilde bildirin](SECURITY.md)

### Kaynaklar

- [Kullanım Kılavuzu](docs/GUIDE.md) — Başlarken ve eğitimler
- [SSS](docs/FAQ.md) — Sık sorulan sorular ve sorun giderme
- [Klavye Kısayolları](docs/SHORTCUTS.md) — Tam kısayol referansı

## Yol Haritası

### 🚀 Yakında

- **Çapraz platform desteği** — Windows ve Linux derlemeleri
- **Eklenti sistemi** — Hive'ı özel entegrasyonlarla genişletin
- **Bulut senkronizasyonu** — Ayarları, oturumları ve bağlantı şablonlarını cihazlar arası senkronize edin
- **Takım özellikleri** — Worktree'leri paylaşın ve gerçek zamanlı işbirliği yapın
- **Git graf görselleştirmesi** — Görsel dal geçmişi ve birleştirmeler
- **Performans profilleme** — Optimizasyon için yerleşik araçlar

### 🎯 Gelecek Vizyonu

- **Uzaktan geliştirme** — SSH ve konteyner tabanlı geliştirme
- **Üç yönlü bağlantılar** — Birden fazla dalı görsel olarak bağlayın ve birleştirin
- **CI/CD entegrasyonu** — GitHub Actions, GitLab CI, Jenkins izleme
- **Bağlantı otomasyonu** — Kalıplara göre ilgili dalları otomatik bağlama
- **Kod inceleme modu** — İncelemeler için optimize edilmiş özel bağlantı türü
- **Zaman takibi** — Worktree başına ve bağlantı başına aktivite analitiği

Yol haritasını etkilemek ister misiniz? [Tartışmaya katılın](https://github.com/morapelker/hive/discussions/categories/ideas) veya [katkıda bulunun](CONTRIBUTING.md)!

---

<details>
<summary><strong>Geliştirme</strong></summary>

### Ön Koşullar

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (worktree desteği)

### Kurulum

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Ghostty Terminal (İsteğe Bağlı)

Hive, [Ghostty](https://ghostty.org/)'nin `libghostty`'si ile çalışan isteğe bağlı bir yerel terminal içerir. Yalnızca gömülü terminal özelliği üzerinde çalışmak istiyorsanız gereklidir.

**Kurulum:**

1. Ghostty kaynağından `libghostty` derleyin ([derleme talimatları](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Bu `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a` dosyasını üretir.

2. Ghostty deponuz `~/Documents/dev/ghostty/` konumundaysa, derleme otomatik olarak bulur. Aksi takdirde yolu ayarlayın:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Yerel eklentiyi yeniden derleyin:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

`libghostty` mevcut değilse, Hive yine de derlenir ve çalışır — Ghostty terminal özelliği sadece devre dışı kalır.

### Komutlar

| Komut           | Açıklama           |
| ----------------- | --------------------- |
| `pnpm dev`        | Hot reload ile başlat |
| `pnpm build`      | Production derlemesi      |
| `pnpm lint`       | ESLint kontrolü          |
| `pnpm lint:fix`   | ESLint otomatik düzeltme       |
| `pnpm format`     | Prettier biçimlendirme       |
| `pnpm test`       | Tüm testleri çalıştır         |
| `pnpm test:watch` | İzleme modu            |
| `pnpm test:e2e`   | Playwright E2E testleri  |
| `pnpm build:mac`  | macOS için paketleme     |

### Mimari

Hive, katı sandbox'lama ile Electron'un üç süreçli modelini kullanır:

```
┌─────────────────────────────────────────────────────┐
│                     Ana Süreç                        │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │  Agent SDK Mgr    │   │
│  │ Service   │ │ Service  │ │  (AI Oturumları)  │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ IPC İşleyicileri│                      │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ Tipli IPC
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Köprü)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ window.* API'ler
┌──────────────────────┼──────────────────────────────┐
│                Renderer Süreci                       │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Bileşenler      │   │
│  │ Stores    │ │ ui       │ │  (14 alan)        │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Proje Yapısı

```
src/
├── main/                  # Electron ana süreci (Node.js)
│   ├── db/                # SQLite veritabanı + şema + migrasyonlar
│   ├── ipc/               # IPC işleyici modülleri
│   └── services/          # Git, AI agents, logger, dosya servisleri
├── preload/               # Köprü katmanı (tipli window.* API'ler)
└── renderer/src/          # React SPA
    ├── components/        # Alana göre düzenlenmiş UI
    ├── hooks/             # Özel React hook'ları
    ├── lib/               # Yardımcılar, temalar, araçlar
    └── stores/            # Zustand durum yönetimi
```

### Teknoloji Yığını

| Katman     | Teknoloji                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Dil  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Stil   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Durum     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Veritabanı  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (WAL modu)          |
| AI        | [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Codex](https://github.com/openai/codex)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Derleme     | [electron-vite](https://electron-vite.org/)                                      |

### Dokümantasyon

Ayrıntılı dokümanlar [`docs/`](docs/) klasöründe:

- **[PRD'ler](docs/prd/)** -- Ürün gereksinimleri
- **[Uygulama](docs/implementation/)** -- Teknik kılavuzlar
- **[Spesifikasyonlar](docs/specs/)** -- Özellik spesifikasyonları
- **[Planlar](docs/plans/)** -- Aktif uygulama planları

</details>

## Katkıda Bulunma

Katkıları çok seviyoruz! Hive geliştiriciler tarafından geliştiriciler için yapılmıştır ve her türlü iyileştirmeyi memnuniyetle karşılarız.

### Katkı Yolları

- 🐛 Net yeniden üretim adımlarıyla **hata bildirin**
- 💡 İş akışınızı iyileştirecek **özellikler önerin**
- 📝 Başkalarının başlamasına yardımcı olmak için **dokümantasyonu iyileştirin**
- 🎨 Daha iyi kullanılabilirlik için **UI/UX iyileştirmeleri gönderin**
- 🔧 Sorun izleyicimizden **hataları düzeltin**
- ⚡ Kritik yollarda **performansı optimize edin**
- 🧪 Kapsamı artırmak için **test ekleyin**
- 🌐 Uygulamayı dilinize **çevirin**

Katkıda bulunmadan önce [Katkı Kurallarımızı](CONTRIBUTING.md) ve [Davranış Kurallarımızı](CODE_OF_CONDUCT.md) okuyun.

### Hızlı Katkı Kılavuzu

1. Depoyu fork edin
2. Özellik dalı oluşturun (`git checkout -b feature/amazing-feature`)
3. Değişikliklerinizi yapın
4. Testleri (`pnpm test`) ve linting'i (`pnpm lint`) çalıştırın
5. Açıklayıcı mesajla commit edin
6. Fork'unuza push edin
7. Pull Request açın

Ayrıntılı kurallar için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

## Lisans

[MIT](LICENSE) © 2024 morapelker

Hive, MIT Lisansı altında lisanslanan açık kaynaklı yazılımdır. Tam ayrıntılar için [LICENSE](LICENSE) dosyasına bakın.
