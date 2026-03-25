<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Un orquestador de agentes IA de código abierto para programación en paralelo entre proyectos.</strong></p>
  <p>Ejecuta sesiones de Claude Code, OpenCode y Codex en paralelo. Una ventana. Ramas aisladas. Cero caos de pestañas.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md"><strong>Español</strong></a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md">Português (BR)</a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Última versión" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Descargas" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Estado del build" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licencia" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs bienvenidos" /></a>
  </p>
</div>

---

## Tabla de contenidos

- [¿Qué es Hive?](#qué-es-hive)
- [Características](#características)
- [¿Por qué Hive?](#por-qué-hive)
- [Instalación](#instalación)
- [Inicio rápido](#inicio-rápido)
- [Conexiones — El cambio radical](#-conexiones---el-cambio-radical)
- [Capturas de pantalla](#capturas-de-pantalla)
- [Comunidad y soporte](#comunidad-y-soporte)
- [Hoja de ruta](#hoja-de-ruta)
- [Desarrollo](#desarrollo)
  - [Prerequisitos](#prerequisitos)
  - [Configuración](#configuración)
  - [Comandos](#comandos)
  - [Arquitectura](#arquitectura)
  - [Estructura del proyecto](#estructura-del-proyecto)
  - [Stack tecnológico](#stack-tecnológico)
  - [Documentación](#documentación)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

## ¿Qué es Hive?

Si ejecutas múltiples agentes de codificación IA en diferentes proyectos y ramas, conoces el dolor — seis pestañas de terminal abiertas, no recuerdas qué agente está trabajando en qué, y te preocupa que dos de ellos estén editando los mismos archivos.

Hive es un orquestador de agentes IA. Ve todos tus agentes en ejecución en una barra lateral, haz clic para cambiar entre ellos, y cada uno se ejecuta en una rama aislada de git worktree para que no puedan entrar en conflicto. Conecta múltiples repositorios para que una sola sesión de agente tenga contexto de todo tu stack.

## Características

### 🌳 **Flujo de trabajo orientado a Worktrees**
Trabaja en múltiples ramas simultáneamente sin stash ni cambios de rama. Crea, archiva y organiza worktrees con un solo clic. Cada worktree recibe un nombre único basado en ciudades para fácil identificación.

### 🤖 **Sesiones de codificación IA integradas**
Ejecuta agentes de codificación IA directamente dentro de Hive con soporte para **OpenCode** y **Claude Code**. Transmite respuestas en tiempo real, observa la ejecución de llamadas a herramientas y aprueba permisos según sea necesario. El soporte completo de deshacer/rehacer te mantiene en control.

### 📁 **Explorador de archivos inteligente**
Ve los cambios de un vistazo con indicadores de estado git en vivo. Visualiza diffs en línea, navega el historial de archivos y explora tu código sin salir de la aplicación. El editor Monaco integrado proporciona una experiencia completa tipo VS Code.

### 🔧 **Integración Git completa**
Commit, push, pull y gestión de ramas de forma visual. No se necesita terminal para operaciones git comunes. Ve los cambios pendientes, archivos en staging y el historial de commits en un solo lugar.

### 📦 **Espacios para organización**
Agrupa proyectos y worktrees relacionados en espacios de trabajo lógicos. Fija tus favoritos para acceso rápido. Mantén tu entorno de desarrollo organizado mientras creces.

### ⚡ **Paleta de comandos**
Navega y actúa rápido con atajos de teclado. Presiona `Cmd+K` para acceder a cualquier función al instante. Busca sesiones, cambia de worktree o ejecuta comandos sin tocar el ratón.

### 🎨 **Temas hermosos**
Elige entre 10 temas cuidadosamente diseñados — 6 oscuros y 4 claros. Cambia al instante según tu preferencia o la hora del día. Sigue el tema del sistema automáticamente si lo deseas.

### 🖥️ **Language Server Protocol**
Integración LSP completa con servidores de lenguaje por worktree. Obtén autocompletado inteligente, ir a definición, tooltips al pasar el cursor y diagnósticos en tiempo real para TypeScript, Python, Go, Rust y más.

### 🔌 **Conexiones de Worktree**
Conecta dos worktrees para compartir contexto, comparar implementaciones o colaborar en tiempo real. Perfecto para revisar cambios entre ramas, compartir sesiones de IA entre worktrees o mantener consistencia al trabajar en funciones relacionadas. Ve actualizaciones en vivo cuando los worktrees conectados cambian.

## ¿Por qué Hive?

Mira cómo Hive transforma tu flujo de trabajo con git:

| Tarea | Flujo tradicional | Con Hive |
|------|---------------------|-----------|
| **Cambiar de rama** | `git stash` → `git checkout` → `git stash pop` | Clic en worktree → Listo |
| **Trabajar en múltiples funciones** | Stash constante y cambio de contexto | Abre múltiples worktrees lado a lado |
| **Crear worktree** | `git worktree add ../project-feature origin/feature` | Clic en "Nuevo Worktree" → Selecciona rama |
| **Asistencia IA para codificar** | Terminal + herramienta IA separada + copiar/pegar | Sesiones IA integradas con contexto completo |
| **Ver cambios en archivos** | `git status` → `git diff file.ts` | Árbol visual con diffs en línea |
| **Comparar ramas** | Múltiples pestañas de terminal, copiar/pegar entre ellas | Conecta worktrees para compartir contexto |
| **Encontrar un worktree** | `cd ~/projects/...` → recordar nombres de directorios | Todos los worktrees en una barra lateral |
| **Limpiar worktrees** | `git worktree remove` → `rm -rf directory` | Clic en "Archivar" → Se encarga de todo |

## Instalación

> 🍎 **Solo macOS** — Soporte para Windows y Linux próximamente.

### Vía Homebrew (recomendado)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Descarga directa

Descarga el último `.dmg` desde [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

¡Eso es todo! Abre Hive desde tu carpeta de Aplicaciones y apúntalo a un repositorio git.

## Inicio rápido

Empieza a funcionar en menos de 2 minutos:

### 1️⃣ **Agrega tu primer proyecto**
Abre Hive → Clic en **"Add Project"** → Selecciona cualquier repositorio git en tu máquina

### 2️⃣ **Crea un Worktree**
Selecciona tu proyecto → Clic en **"New Worktree"** → Elige una rama (o crea una nueva)

### 3️⃣ **Empieza a codificar con IA**
Abre un worktree → Clic en **"New Session"** → Comienza a codificar con OpenCode o Claude

> 💡 **Consejo pro**: ¡Presiona `Cmd+K` en cualquier momento para abrir la paleta de comandos y navegar rápidamente!

📖 [Lee la guía completa](docs/GUIDE.md) | ⌨️ [Atajos de teclado](docs/SHORTCUTS.md)

## 🔌 Conexiones de Worktree — El cambio radical

La función de **Conexiones de Worktree** de Hive te permite vincular dos worktrees, creando un puente entre diferentes ramas o funciones. Es increíblemente poderosa para flujos de trabajo de desarrollo que requieren conocimiento entre ramas.

### ¿Qué son las Conexiones de Worktree?

Conecta cualquier par de worktrees para:
- **🔄 Compartir contexto** - Accede a archivos y cambios de otra rama al instante
- **🤝 Colaborar** - Trabaja en funciones relacionadas con actualizaciones en vivo entre worktrees
- **📊 Comparar** - Ve las diferencias entre implementaciones lado a lado
- **🎯 Referenciar** - Mantén tu rama principal visible mientras trabajas en funciones
- **🔗 Vincular funciones** - Conecta ramas de frontend y backend para desarrollo full-stack
- **💬 Compartir sesiones IA** - Continúa conversaciones de IA entre diferentes worktrees

### Cómo funciona

1. **Selecciona el Worktree origen** - Elige el worktree en el que estás trabajando
2. **Conecta al destino** - Haz clic en el icono de conexión y selecciona otro worktree
3. **Enlace bidireccional** - Ambos worktrees se vuelven conscientes el uno del otro
4. **Actualizaciones en tiempo real** - Ve los cambios en worktrees conectados conforme ocurren

### Funciones de conexión

- ✅ **Sincronización en vivo** - Los cambios de archivo en un worktree aparecen en el panel de conexión
- ✅ **Cambio rápido** - Salta entre worktrees conectados con un clic
- ✅ **Vista de diferencias** - Compara archivos entre worktrees conectados
- ✅ **Terminal compartida** - Ejecuta comandos que afectan a ambos worktrees
- ✅ **Contexto IA compartido** - Las sesiones IA pueden referenciar código del worktree conectado
- ✅ **Indicadores de estado** - Ve el estado del build, tests y cambios en worktrees conectados
- ✅ **Historial de conexiones** - Rastrea qué worktrees estuvieron conectados y cuándo
- ✅ **Sugerencias inteligentes** - Hive sugiere worktrees relevantes para conectar según tu flujo de trabajo

### Casos de uso

**Desarrollo de funciones**: Conecta tu rama de función a main para asegurar compatibilidad y ver cómo se integran tus cambios.

**Corrección de errores**: Conecta el worktree de corrección a la rama de producción para verificar que la corrección funciona en contexto.

**Revisiones de código**: Conecta los worktrees del revisor y del autor para discutir cambios con contexto completo en ambos lados.

**Desarrollo full-stack**: Conecta worktrees de frontend y backend para trabajar en API e interfaz simultáneamente con coordinación perfecta.

**Refactorización**: Conecta implementaciones antigua y nueva para asegurar paridad de funciones durante refactorizaciones grandes.

## Míralo en acción

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo de Hive — orquesta agentes IA entre proyectos" width="900" />
</div>

<details>
<summary><strong>Más capturas de pantalla</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — sesión de codificación IA con git worktrees" width="900" />
  <sub>Sesiones de codificación potenciadas por IA con gestión integrada de git worktrees</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Creando un nuevo worktree" width="900" />
  <sub>Crea y gestiona worktrees visualmente</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Árbol de archivos con estado git" width="900" />
  <sub>Explorador de archivos con indicadores de estado git en vivo</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Muestra de temas" width="900" />
  <sub>Temas hermosos para cada preferencia</sub>
</div>

</details>

## Comunidad y soporte

<div align="center">

[![Documentación](https://img.shields.io/badge/📖_Documentación-Leer-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Reportar-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discusiones](https://img.shields.io/badge/💬_Discusiones-Unirse-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contribuir](https://img.shields.io/badge/🤝_Contribuir-Guías-green?style=for-the-badge)](CONTRIBUTING.md)
[![Seguridad](https://img.shields.io/badge/🔒_Seguridad-Política-orange?style=for-the-badge)](SECURITY.md)

</div>

### Obtén ayuda

- 📖 Lee la [documentación](docs/) para guías detalladas
- 🐛 [Reporta errores](https://github.com/morapelker/hive/issues/new?template=bug_report.md) con pasos de reproducción
- 💡 [Solicita funciones](https://github.com/morapelker/hive/issues/new?template=feature_request.md) que te gustaría ver
- 💬 [Únete a las discusiones](https://github.com/morapelker/hive/discussions) para conectar con la comunidad
- 🔒 [Reporta vulnerabilidades de seguridad](SECURITY.md) de forma responsable

### Recursos

- [Guía del usuario](docs/GUIDE.md) — Primeros pasos y tutoriales
- [FAQ](docs/FAQ.md) — Preguntas frecuentes y solución de problemas
- [Atajos de teclado](docs/SHORTCUTS.md) — Referencia completa de atajos

## Hoja de ruta

### 🚀 Próximamente

- **Soporte multiplataforma** — Builds para Windows y Linux
- **Sistema de plugins** — Extiende Hive con integraciones personalizadas
- **Conexiones mejoradas** — Conexiones multi-vía, grupos de conexión, sugerencias inteligentes
- **Sincronización en la nube** — Sincroniza configuraciones, sesiones y plantillas de conexión entre dispositivos
- **Funciones de equipo** — Comparte worktrees y colabora en tiempo real
- **Modelos IA personalizados** — Usa tus propias claves API de OpenAI/Anthropic
- **Pestañas de terminal** — Múltiples sesiones de terminal por worktree
- **Visualización de grafo Git** — Historial visual de ramas y merges
- **Perfilado de rendimiento** — Herramientas integradas para optimización

### 🎯 Visión futura

- **Inteligencia de conexiones** — Sugerencias de conexión impulsadas por IA basadas en historial git
- **Marketplace de conexiones** — Comparte y descubre plantillas de conexión
- **Desarrollo remoto** — Desarrollo basado en SSH y contenedores
- **Conexiones trilaterales** — Conecta y fusiona múltiples ramas visualmente
- **Integración CI/CD** — Monitoreo de GitHub Actions, GitLab CI, Jenkins
- **Automatización de conexiones** — Auto-conexión de ramas relacionadas basada en patrones
- **Modo de revisión de código** — Tipo de conexión especial optimizado para revisiones
- **Seguimiento de tiempo** — Análisis de actividad por worktree y por conexión

¿Quieres influir en la hoja de ruta? ¡[Únete a la discusión](https://github.com/morapelker/hive/discussions/categories/ideas) o [contribuye](CONTRIBUTING.md)!

---

<details>
<summary><strong>Desarrollo</strong></summary>

### Prerequisitos

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (soporte de worktree)

### Configuración

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminal Ghostty (opcional)

Hive incluye un terminal nativo opcional impulsado por `libghostty` de [Ghostty](https://ghostty.org/). Solo es necesario si quieres trabajar en la función de terminal integrado.

**Configuración:**

1. Compila `libghostty` desde el código fuente de Ghostty ([instrucciones de compilación](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Esto produce `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Si tu repositorio de Ghostty está en `~/Documents/dev/ghostty/`, el build lo encontrará automáticamente. De lo contrario, configura la ruta:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Reconstruye el addon nativo:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Si `libghostty` no está disponible, Hive aún se compila y ejecuta — la función de terminal Ghostty simplemente estará deshabilitada.

### Comandos

| Comando           | Descripción           |
| ----------------- | --------------------- |
| `pnpm dev`        | Inicia con hot reload |
| `pnpm build`      | Build de producción      |
| `pnpm lint`       | Verificación ESLint          |
| `pnpm lint:fix`   | Auto-corrección ESLint       |
| `pnpm format`     | Formato con Prettier       |
| `pnpm test`       | Ejecutar todos los tests         |
| `pnpm test:watch` | Modo observación            |
| `pnpm test:e2e`   | Tests E2E con Playwright  |
| `pnpm build:mac`  | Empaquetar para macOS     |

### Arquitectura

Hive usa el modelo de tres procesos de Electron con sandboxing estricto:

```
┌─────────────────────────────────────────────────────┐
│                    Proceso principal                  │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
│  │ Service   │ │ Service  │ │  (Sesiones IA)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Manejadores   │                       │
│              │     IPC       │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ IPC tipado
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Puente)    │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ APIs window.*
┌──────────────────────┼──────────────────────────────┐
│                 Proceso renderizador                  │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Componentes     │   │
│  │ Stores    │ │ ui       │ │  (14 dominios)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Estructura del proyecto

```
src/
├── main/                  # Proceso principal de Electron (Node.js)
│   ├── db/                # Base de datos SQLite + esquema + migraciones
│   ├── ipc/               # Módulos de manejadores IPC
│   └── services/          # Git, OpenCode, logger, servicios de archivos
├── preload/               # Capa puente (APIs window.* tipadas)
└── renderer/src/          # React SPA
    ├── components/        # UI organizada por dominio
    ├── hooks/             # Hooks React personalizados
    ├── lib/               # Utilidades, temas, helpers
    └── stores/            # Gestión de estado con Zustand
```

### Stack tecnológico

| Capa     | Tecnología                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Lenguaje  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Estilos   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Estado     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Base de datos  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (modo WAL)          |
| IA        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentación

La documentación detallada está en [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Requisitos de producto
- **[Implementación](docs/implementation/)** -- Guías técnicas
- **[Especificaciones](docs/specs/)** -- Especificaciones de funciones
- **[Planes](docs/plans/)** -- Planes de implementación activos

</details>

## Contribuir

¡Nos encantan las contribuciones! Hive está hecho por desarrolladores, para desarrolladores, y damos la bienvenida a mejoras de todo tipo.

### Formas de contribuir

- 🐛 **Reportar errores** con pasos de reproducción claros
- 💡 **Sugerir funciones** que mejoren tu flujo de trabajo
- 📝 **Mejorar la documentación** para ayudar a otros a empezar
- 🎨 **Enviar mejoras de UI/UX** para mejor usabilidad
- 🔧 **Corregir errores** de nuestro rastreador de issues
- ⚡ **Optimizar rendimiento** en rutas críticas
- 🧪 **Agregar tests** para mejorar la cobertura
- 🌐 **Traducir** la app a tu idioma

Antes de contribuir, por favor lee nuestras [Guías de contribución](CONTRIBUTING.md) y [Código de conducta](CODE_OF_CONDUCT.md).

### Guía rápida de contribución

1. Haz fork del repositorio
2. Crea una rama de función (`git checkout -b feature/amazing-feature`)
3. Realiza tus cambios
4. Ejecuta tests (`pnpm test`) y linting (`pnpm lint`)
5. Haz commit con un mensaje descriptivo
6. Haz push a tu fork
7. Abre un Pull Request

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para guías detalladas.

## Licencia

[MIT](LICENSE) © 2024 morapelker

Hive es software de código abierto licenciado bajo la Licencia MIT. Consulta el archivo [LICENSE](LICENSE) para los detalles completos.
