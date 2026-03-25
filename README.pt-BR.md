<div align="center">
  <img src="resources/icon.png" alt="Hive" width="128" />
  <h1>Hive</h1>
  <p><strong>Um orquestrador de agentes IA open-source para programação em paralelo entre projetos.</strong></p>
  <p>Execute sessões de Claude Code, OpenCode e Codex em paralelo. Uma janela. Branches isolados. Zero caos de abas.</p>
  <p>
    <a href="README.md">English</a> | <a href="README.ar.md">العربية</a> | <a href="README.bn.md">বাংলা</a> | <a href="README.bs.md">Bosanski</a> | <a href="README.da.md">Dansk</a> | <a href="README.de.md">Deutsch</a> | <a href="README.el.md">Ελληνικά</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.he.md">עברית</a> | <a href="README.it.md">Italiano</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a> | <a href="README.no.md">Norsk</a> | <a href="README.pl.md">Polski</a> | <a href="README.pt-BR.md"><strong>Português (BR)</strong></a> | <a href="README.ru.md">Русский</a> | <a href="README.th.md">ไทย</a> | <a href="README.tr.md">Türkçe</a> | <a href="README.uk.md">Українська</a> | <a href="README.vi.md">Tiếng Việt</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a>
  </p>
    <a href="https://github.com/morapelker/hive/releases/latest"><img src="https://img.shields.io/github/v/release/morapelker/hive?style=flat-square&logo=github&label=version" alt="Última versão" /></a>
    <a href="https://github.com/morapelker/hive/releases"><img src="https://img.shields.io/github/downloads/morapelker/hive/total?style=flat-square&logo=github" alt="Downloads" /></a>
    <a href="https://github.com/morapelker/hive/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/morapelker/hive/release.yml?style=flat-square&logo=github-actions&label=build" alt="Status do build" /></a>
    <a href="#"><img src="https://img.shields.io/badge/macOS-only-000000?style=flat-square&logo=apple&logoColor=white" alt="macOS" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
    <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="Licença" /></a>
    <a href="https://github.com/morapelker/hive/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs bem-vindos" /></a>
  </p>
</div>

---

## Índice

- [O que é o Hive?](#o-que-é-o-hive)
- [Funcionalidades](#funcionalidades)
- [Por que Hive?](#por-que-hive)
- [Instalação](#instalação)
- [Início rápido](#início-rápido)
- [Conexões — O diferencial](#-conexões---o-diferencial)
- [Capturas de tela](#capturas-de-tela)
- [Comunidade e suporte](#comunidade-e-suporte)
- [Roadmap](#roadmap)
- [Desenvolvimento](#desenvolvimento)
- [Contribuir](#contribuir)
- [Licença](#licença)

## O que é o Hive?

Se você executa múltiplos agentes de codificação IA em diferentes projetos e branches, conhece a dor — seis abas de terminal abertas, você não lembra qual agente está trabalhando em quê, e se preocupa que dois deles estejam editando os mesmos arquivos.

Hive é um orquestrador de agentes IA. Veja todos os seus agentes em execução em uma barra lateral, clique para alternar entre eles, e cada um roda em um branch git worktree isolado para que não possam conflitar. Conecte múltiplos repositórios para que uma única sessão de agente tenha contexto de toda a sua stack.

## Funcionalidades

### 🌳 **Workflow orientado a Worktrees**
Trabalhe em múltiplos branches simultaneamente sem stash ou troca. Crie, arquive e organize worktrees com um clique. Cada worktree recebe um nome único baseado em cidades para fácil identificação.

### 🤖 **Sessões de codificação IA integradas**
Execute agentes de codificação IA diretamente dentro do Hive com suporte para **OpenCode** e **Claude Code**. Transmita respostas em tempo real, observe a execução de chamadas de ferramentas e aprove permissões conforme necessário. Suporte completo de desfazer/refazer mantém você no controle.

### 📁 **Explorador de arquivos inteligente**
Veja o que mudou num relance com indicadores de status git ao vivo. Visualize diffs inline, navegue pelo histórico de arquivos e explore seu código sem sair do app. O editor Monaco integrado proporciona uma experiência completa estilo VS Code.

### 🔧 **Integração Git completa**
Commit, push, pull e gerencie branches visualmente. Sem necessidade de terminal para operações git comuns. Veja alterações pendentes, arquivos em staging e histórico de commits tudo em um só lugar.

### 📦 **Espaços para organização**
Agrupe projetos e worktrees relacionados em espaços de trabalho lógicos. Fixe seus favoritos para acesso rápido. Mantenha seu ambiente de desenvolvimento organizado conforme cresce.

### ⚡ **Paleta de comandos**
Navegue e aja rápido com atalhos de teclado. Pressione `Cmd+K` para acessar qualquer funcionalidade instantaneamente. Pesquise sessões, troque de worktree ou execute comandos sem tocar no mouse.

### 🎨 **Temas bonitos**
Escolha entre 10 temas cuidadosamente criados — 6 escuros e 4 claros. Troque instantaneamente de acordo com sua preferência ou hora do dia. Segue o tema do sistema automaticamente se desejado.

### 🖥️ **Language Server Protocol**
Integração LSP completa com servidores de linguagem por worktree. Obtenha autocompletar inteligente, ir para definição, tooltips ao passar o mouse e diagnósticos em tempo real para TypeScript, Python, Go, Rust e mais.

### 🔌 **Conexões de Worktree**
Conecte dois worktrees para compartilhar contexto, comparar implementações ou colaborar em tempo real. Perfeito para revisar mudanças entre branches, compartilhar sessões IA entre worktrees ou manter consistência ao trabalhar em funcionalidades relacionadas. Veja atualizações ao vivo quando worktrees conectados mudam.

## Por que Hive?

Veja como o Hive transforma seu workflow git:

| Tarefa | Workflow tradicional | Com Hive |
|------|---------------------|-----------|
| **Trocar de branch** | `git stash` → `git checkout` → `git stash pop` | Clique no worktree → Pronto |
| **Trabalhar em múltiplas features** | Stash constante e troca de contexto | Abra múltiplos worktrees lado a lado |
| **Criar worktree** | `git worktree add ../project-feature origin/feature` | Clique "Novo Worktree" → Selecione branch |
| **Assistência IA para codificar** | Terminal + ferramenta IA separada + copiar/colar | Sessões IA integradas com contexto completo |
| **Ver mudanças em arquivos** | `git status` → `git diff file.ts` | Árvore visual com diffs inline |
| **Comparar branches** | Múltiplas abas de terminal, copiar/colar | Conecte worktrees para compartilhar contexto |
| **Encontrar um worktree** | `cd ~/projects/...` → lembrar nomes de diretórios | Todos os worktrees em uma barra lateral |
| **Limpar worktrees** | `git worktree remove` → `rm -rf directory` | Clique "Arquivar" → Cuida de tudo |

## Instalação

> 🍎 **Apenas macOS** — Suporte para Windows e Linux em breve.

### Via Homebrew (recomendado)

```bash
brew tap morapelker/hive
brew install --cask hive
```

### Download direto

Baixe o último `.dmg` do [GitHub Releases](https://github.com/morapelker/hive/releases/latest).

É isso! Abra o Hive da pasta Aplicativos e aponte para um repositório git.

## Início rápido

Comece em menos de 2 minutos:

### 1️⃣ **Adicione seu primeiro projeto**
Abra o Hive → Clique **"Add Project"** → Selecione qualquer repositório git na sua máquina

### 2️⃣ **Crie um Worktree**
Selecione seu projeto → Clique **"New Worktree"** → Escolha um branch (ou crie um novo)

### 3️⃣ **Comece a codificar com IA**
Abra um worktree → Clique **"New Session"** → Comece a codificar com OpenCode ou Claude

> 💡 **Dica pro**: Pressione `Cmd+K` a qualquer momento para abrir a paleta de comandos e navegar rapidamente!

📖 [Leia o guia completo](docs/GUIDE.md) | ⌨️ [Atalhos de teclado](docs/SHORTCUTS.md)

## 🔌 Conexões de Worktree — O diferencial

A funcionalidade **Conexões de Worktree** do Hive permite vincular dois worktrees, criando uma ponte entre diferentes branches ou funcionalidades. É incrivelmente poderosa para workflows de desenvolvimento que requerem consciência entre branches.

### O que são Conexões de Worktree?

Conecte qualquer par de worktrees para:
- **🔄 Compartilhar contexto** - Acesse arquivos e mudanças de outro branch instantaneamente
- **🤝 Colaborar** - Trabalhe em funcionalidades relacionadas com atualizações ao vivo entre worktrees
- **📊 Comparar** - Veja diferenças entre implementações lado a lado
- **🎯 Referenciar** - Mantenha seu branch principal visível enquanto trabalha em funcionalidades
- **🔗 Vincular funcionalidades** - Conecte branches de frontend e backend para desenvolvimento full-stack
- **💬 Compartilhar sessões IA** - Continue conversas IA entre worktrees diferentes

### Como funciona

1. **Selecione o Worktree de origem** - Escolha o worktree em que está trabalhando
2. **Conecte ao destino** - Clique no ícone de conexão e selecione outro worktree
3. **Link bidirecional** - Ambos worktrees ficam cientes um do outro
4. **Atualizações em tempo real** - Veja mudanças em worktrees conectados conforme acontecem

### Funcionalidades de conexão

- ✅ **Sincronização ao vivo** - Mudanças de arquivo em um worktree aparecem no painel de conexão
- ✅ **Troca rápida** - Pule entre worktrees conectados com um clique
- ✅ **Visualização de diferenças** - Compare arquivos entre worktrees conectados
- ✅ **Terminal compartilhado** - Execute comandos que afetam ambos worktrees
- ✅ **Contexto IA compartilhado** - Sessões IA podem referenciar código do worktree conectado
- ✅ **Indicadores de status** - Veja status do build, testes e mudanças em worktrees conectados
- ✅ **Histórico de conexões** - Rastreie quais worktrees foram conectados e quando
- ✅ **Sugestões inteligentes** - Hive sugere worktrees relevantes para conectar baseado no seu workflow

### Casos de uso

**Desenvolvimento de funcionalidades**: Conecte seu branch de funcionalidade ao main para garantir compatibilidade e ver como suas mudanças se integram.

**Correção de bugs**: Conecte o worktree de correção ao branch de produção para verificar que a correção funciona em contexto.

**Revisões de código**: Conecte worktrees do revisor e do autor para discutir mudanças com contexto completo dos dois lados.

**Desenvolvimento full-stack**: Conecte worktrees de frontend e backend para trabalhar em API e interface simultaneamente com coordenação perfeita.

**Refatoração**: Conecte implementações antiga e nova para garantir paridade de funcionalidades durante grandes refatorações.

## Veja em ação

<div align="center">
  <img src="docs/screenshots/hive-full-demo.gif" alt="Demo do Hive — orquestre agentes IA entre projetos" width="900" />
</div>

<details>
<summary><strong>Mais capturas de tela</strong></summary>

<div align="center">
  <br/>
  <img src="docs/screenshots/hive-ss-1.png" alt="Hive — sessão de codificação IA com git worktrees" width="900" />
  <sub>Sessões de codificação com IA integradas ao gerenciamento de git worktrees</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-worktree-create.png" alt="Criando um novo worktree" width="900" />
  <sub>Crie e gerencie worktrees visualmente</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-file-tree.png" alt="Árvore de arquivos com status git" width="900" />
  <sub>Explorador de arquivos com indicadores de status git ao vivo</sub>
  <br/><br/>
  <img src="docs/screenshots/hive-themes.png" alt="Vitrine de temas" width="900" />
  <sub>Temas bonitos para cada preferência</sub>
</div>

</details>

## Comunidade e suporte

<div align="center">

[![Documentação](https://img.shields.io/badge/📖_Documentação-Ler-blue?style=for-the-badge)](docs/)
[![Issues](https://img.shields.io/badge/🐛_Issues-Reportar-red?style=for-the-badge)](https://github.com/morapelker/hive/issues)
[![Discussões](https://img.shields.io/badge/💬_Discussões-Participar-purple?style=for-the-badge)](https://github.com/morapelker/hive/discussions)
[![Contribuir](https://img.shields.io/badge/🤝_Contribuir-Diretrizes-green?style=for-the-badge)](CONTRIBUTING.md)
[![Segurança](https://img.shields.io/badge/🔒_Segurança-Política-orange?style=for-the-badge)](SECURITY.md)

</div>

### Obtenha ajuda

- 📖 Leia a [documentação](docs/) para guias detalhados
- 🐛 [Reporte bugs](https://github.com/morapelker/hive/issues/new?template=bug_report.md) com passos de reprodução
- 💡 [Solicite funcionalidades](https://github.com/morapelker/hive/issues/new?template=feature_request.md) que gostaria de ver
- 💬 [Participe das discussões](https://github.com/morapelker/hive/discussions) para conectar com a comunidade
- 🔒 [Reporte vulnerabilidades de segurança](SECURITY.md) responsavelmente

### Recursos

- [Guia do usuário](docs/GUIDE.md) — Primeiros passos e tutoriais
- [FAQ](docs/FAQ.md) — Perguntas frequentes e solução de problemas
- [Atalhos de teclado](docs/SHORTCUTS.md) — Referência completa de atalhos

## Roadmap

### 🚀 Em breve

- **Suporte multiplataforma** — Builds para Windows e Linux
- **Sistema de plugins** — Estenda o Hive com integrações personalizadas
- **Conexões aprimoradas** — Conexões multivias, grupos de conexão, sugestões inteligentes
- **Sincronização na nuvem** — Sincronize configurações, sessões e modelos de conexão entre dispositivos
- **Funcionalidades de equipe** — Compartilhe worktrees e colabore em tempo real
- **Modelos IA personalizados** — Use suas próprias chaves API OpenAI/Anthropic
- **Abas de terminal** — Múltiplas sessões de terminal por worktree
- **Visualização do grafo Git** — Histórico visual de branches e merges
- **Análise de performance** — Ferramentas integradas para otimização

### 🎯 Visão futura

- **Inteligência de conexões** — Sugestões de conexão com IA baseadas no histórico git
- **Marketplace de conexões** — Compartilhe e descubra modelos de conexão
- **Desenvolvimento remoto** — Desenvolvimento baseado em SSH e containers
- **Conexões trilaterais** — Conecte e faça merge de múltiplos branches visualmente
- **Integração CI/CD** — Monitoramento de GitHub Actions, GitLab CI, Jenkins
- **Automação de conexões** — Auto-conexão de branches relacionados baseada em padrões
- **Modo de revisão de código** — Tipo de conexão especial otimizado para revisões
- **Rastreamento de tempo** — Análise de atividade por worktree e por conexão

Quer influenciar o roadmap? [Participe da discussão](https://github.com/morapelker/hive/discussions/categories/ideas) ou [contribua](CONTRIBUTING.md)!

---

<details>
<summary><strong>Desenvolvimento</strong></summary>

### Pré-requisitos

- **Node.js** 20+
- **pnpm** 9+
- **Git** 2.20+ (suporte a worktree)

### Configuração

```bash
git clone https://github.com/anomalyco/hive.git
cd hive
pnpm install
pnpm dev
```

### Terminal Ghostty (opcional)

O Hive inclui um terminal nativo opcional alimentado pelo `libghostty` do [Ghostty](https://ghostty.org/). Necessário apenas se você quiser trabalhar na funcionalidade de terminal embutido.

**Configuração:**

1. Compile `libghostty` do código-fonte do Ghostty ([instruções de compilação](https://ghostty.org/docs/install/build)):
   ```bash
   cd ~/Documents/dev
   git clone https://github.com/ghostty-org/ghostty.git
   cd ghostty
   zig build -Doptimize=ReleaseFast
   ```
   Isso produz `macos/GhosttyKit.xcframework/macos-arm64_x86_64/libghostty.a`.

2. Se seu repositório Ghostty está em `~/Documents/dev/ghostty/`, o build o encontrará automaticamente. Caso contrário, configure o caminho:
   ```bash
   export GHOSTTY_LIB_PATH="/path/to/libghostty.a"
   ```

3. Recompile o addon nativo:
   ```bash
   cd src/native && npx node-gyp rebuild
   ```

Se `libghostty` não estiver disponível, o Hive ainda compila e roda — a funcionalidade de terminal Ghostty será simplesmente desabilitada.

### Comandos

| Comando           | Descrição           |
| ----------------- | --------------------- |
| `pnpm dev`        | Inicia com hot reload |
| `pnpm build`      | Build de produção      |
| `pnpm lint`       | Verificação ESLint          |
| `pnpm lint:fix`   | Auto-correção ESLint       |
| `pnpm format`     | Formatação Prettier       |
| `pnpm test`       | Executar todos os testes         |
| `pnpm test:watch` | Modo observação            |
| `pnpm test:e2e`   | Testes E2E Playwright  |
| `pnpm build:mac`  | Empacotar para macOS     |

### Arquitetura

O Hive usa o modelo de três processos do Electron com sandboxing rigoroso:

```
┌─────────────────────────────────────────────────────┐
│                  Processo principal                   │
│               (Node.js + SQLite)                     │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Database  │ │   Git    │ │ OpenCode Service  │   │
│  │ Service   │ │ Service  │ │  (Sessões IA)     │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
│                      │                               │
│              ┌───────┴───────┐                       │
│              │ Manipuladores │                       │
│              │     IPC       │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ IPC tipado
┌──────────────────────┼──────────────────────────────┐
│              ┌───────┴───────┐                       │
│              │    Preload    │                       │
│              │   (Ponte)     │                       │
│              └───────┬───────┘                       │
└──────────────────────┼──────────────────────────────┘
                       │ APIs window.*
┌──────────────────────┼──────────────────────────────┐
│               Processo de renderização               │
│              (React + Tailwind)                      │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐   │
│  │ Zustand   │ │ shadcn/  │ │   Componentes     │   │
│  │ Stores    │ │ ui       │ │  (14 domínios)    │   │
│  └──────────┘ └──────────┘ └───────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Estrutura do projeto

```
src/
├── main/                  # Processo principal Electron (Node.js)
│   ├── db/                # Banco de dados SQLite + schema + migrações
│   ├── ipc/               # Módulos de manipuladores IPC
│   └── services/          # Git, OpenCode, logger, serviços de arquivo
├── preload/               # Camada ponte (APIs window.* tipadas)
└── renderer/src/          # React SPA
    ├── components/        # UI organizada por domínio
    ├── hooks/             # Hooks React personalizados
    ├── lib/               # Utilitários, temas, helpers
    └── stores/            # Gerenciamento de estado Zustand
```

### Stack tecnológico

| Camada     | Tecnologia                                                                       |
| --------- | -------------------------------------------------------------------------------- |
| Framework | [Electron 33](https://www.electronjs.org/)                                       |
| Frontend  | [React 19](https://react.dev/)                                                   |
| Linguagem  | [TypeScript 5.7](https://www.typescriptlang.org/)                                |
| Estilos   | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) |
| Estado     | [Zustand 5](https://zustand.docs.pmnd.rs/)                                       |
| Banco de dados  | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (modo WAL)          |
| IA        | [OpenCode SDK](https://opencode.ai)                                              |
| Git       | [simple-git](https://github.com/steveukx/git-js)                                 |
| Build     | [electron-vite](https://electron-vite.org/)                                      |

### Documentação

Documentação detalhada está em [`docs/`](docs/):

- **[PRDs](docs/prd/)** -- Requisitos de produto
- **[Implementação](docs/implementation/)** -- Guias técnicos
- **[Especificações](docs/specs/)** -- Especificações de funcionalidades
- **[Planos](docs/plans/)** -- Planos de implementação ativos

</details>

## Contribuir

Adoramos contribuições! Hive é feito por desenvolvedores, para desenvolvedores, e damos boas-vindas a melhorias de todos os tipos.

### Formas de contribuir

- 🐛 **Reporte bugs** com passos de reprodução claros
- 💡 **Sugira funcionalidades** que melhorariam seu workflow
- 📝 **Melhore a documentação** para ajudar outros a começar
- 🎨 **Envie melhorias de UI/UX** para melhor usabilidade
- 🔧 **Corrija bugs** do nosso rastreador de issues
- ⚡ **Otimize performance** em caminhos críticos
- 🧪 **Adicione testes** para melhorar a cobertura
- 🌐 **Traduza** o app para seu idioma

Antes de contribuir, leia nossas [Diretrizes de contribuição](CONTRIBUTING.md) e [Código de conduta](CODE_OF_CONDUCT.md).

### Guia rápido de contribuição

1. Faça fork do repositório
2. Crie um branch de funcionalidade (`git checkout -b feature/amazing-feature`)
3. Faça suas alterações
4. Execute testes (`pnpm test`) e linting (`pnpm lint`)
5. Faça commit com uma mensagem descritiva
6. Faça push para seu fork
7. Abra um Pull Request

Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para diretrizes detalhadas.

## Licença

[MIT](LICENSE) © 2024 morapelker

Hive é software de código aberto licenciado sob a Licença MIT. Consulte o arquivo [LICENSE](LICENSE) para detalhes completos.
