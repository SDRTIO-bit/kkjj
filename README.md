<h1 align="center">🎭 pi 角色扮演框架</h1>

<p align="center">
  <strong>基于 pi 编码代理的角色扮演框架</strong>
  <br/>
  支持多角色状态追踪 · 实时 Web 前端 · 沉浸式叙事引擎
  <br/><br/>
  <img src="https://img.shields.io/badge/pi-v0.75%2B-blue" alt="pi">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="license">
</p>

---

> **⚠️ 声明**：本项目为个人学习/测试用途，基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 构建。如有引用第三方设定或素材，版权归原作者所有。

## 📖 概述

这是一个构建在 **pi 编码代理** 之上的角色扮演框架。它通过一套可复用的工具链和前端界面，将 AI 聊天代理转变为沉浸式的角色扮演游戏引擎。

### 技术栈

| 组件 | 说明 |
|------|------|
| [**pi**](https://github.com/earendil-works/pi-coding-agent) | 编码代理 CLI，提供扩展机制和 TUI 界面 |
| [**tau**](https://github.com/earendil-works/pi-coding-agent) | pi 内置的 tau-mirror 消息镜像机制，Web 前端基于此构建 |
| **rp-engine.ts** | pi 扩展，提供状态管理、世界书、周期事件、Web 服务 |
| **rp-web/** | 纯前端界面（HTML + JS + CSS），通过 WebSocket 与引擎通信 |
| **LLM** | 后端大语言模型（由 pi 调用），输出 XML 标签格式的叙事内容 |

### 核心特色

- **状态系统** — 追踪角色的归属值、情分值、生理状态、事件进度等游戏数据
- **双轨叙事** — 主视角 + 副视角并行推进剧情
- **周期事件** — 时间推进自动触发特定事件
- **实时前端** — 浏览器 Web 界面，支持选项点击、状态面板、会话管理
- **XML 标签系统** — AI 原生友好的结构化输出格式，前端转为可交互 UI

## 🚀 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/your-username/pi-rp-framework.git
cd pi-rp-framework

# 2. 安装依赖
npm install ws

# 3. 初始化世界书和状态
node setup.mjs

# 4. 启动 pi
pi

# 5. 浏览器打开
open http://localhost:3012
```

## 🏗️ 项目结构

```
pi-rp-framework/
├── .pi/                          # pi 运行时目录
│   ├── settings.json             # pi 设置
│   ├── APPEND_SYSTEM.md          # 每次对话自动注入的风格规范
│   ├── state.json                # 游戏状态数据库（由 setup.mjs 生成，不提交）
│   ├── sessions/                 # 对话历史（不提交）
│   ├── extensions/
│   │   ├── rp-engine.ts          # 🔧 核心引擎（工具 + Web 服务器）
│   │   └── rp-web/               # 🌐 前端页面
│   ├── skills/rp/SKILL.md        # RP skill 指令
│   ├── worldbook/                # 📚 世界书（由 setup.mjs 生成，不提交）
│   └── prompts/                  # 预设模板
├── worldbook_clean/              # 📝 世界书源文件（编辑入口）
│   ├── 世界观/                   # 世界设定
│   ├── 角色设定/                 # 角色详细描述
│   ├── 角色初始状态/             # 角色初始数值
│   ├── 身体演化/                 # 身体变化描述
│   └── 格式指令/                 # 输出格式规范
├── setup.mjs                     # 初始化脚本
├── .github/                      # GitHub Issue 模板
│   └── ISSUE_TEMPLATE/
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── 1-项目结构.md
├── 2-复现.md                     # 从零复现指南
└── 3-改造过程.md                  # 改造记录
```

## 🧩 系统架构

```
┌─────────────────────────────────────────────────────┐
│                   用户界面层                         │
│  ┌─────────────────┐    ┌─────────────────────────┐ │
│  │  pi 终端（TUI）   │    │  RP Web（浏览器 3012）   │ │
│  └────────┬────────┘    └───────────┬─────────────┘ │
└───────────┼─────────────────────────┼───────────────┘
            │                         │
            ▼                         ▼
┌─────────────────────────────────────────────────────┐
│                    引擎层                            │
│  ┌──────────────────────────────────────────────┐  │
│  │              rp-engine.ts                     │  │
│  │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ │  │
│  │  │状态管理 │ │世界书  │ │周期事件 │ │Web服务 │ │  │
│  │  └────────┘ └────────┘ └────────┘ └────────┘ │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│                   AI 层                              │
│  ┌──────────────────────────────────────────────┐  │
│  │           大语言模型（LLM）                    │  │
│  │  输出 XML 标签格式 → 前端解析为交互组件        │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 📡 核心概念

### 状态追踪系统

每个角色有以下关键数值：
| 属性 | 范围 | 说明 |
|------|------|------|
| 归属值 | 0~100 | 角色对玩家的情感偏向，互动中增减 |
| 情分值 | 0~100 | 角色自身的情绪/好感度，归属值上升时自动下降 |
| 性交次数 | 累加 | 区分现实/游戏内，影响剧情分支 |

### 双轨叙事

- **主视角**（`<content>`）— 以玩家角色为中心的沉浸式叙事
- **副视角**（`<perspective>`）— 并行时间线中其他角色的互动
- **选项系统**（`<choice>`）— AI 生成 3~5 个选项供玩家选择，推动剧情

### 周期事件

使用 `advance_time` 工具推进游戏时间（1~30天），自动触发：
- 花开蒂落 — 特定角色成熟度检查
- 生理结算 — 生理周期更新
- 特殊事件 — 按设定触发

## 🛠️ 工具说明

| 工具 | 用途 | 示例 |
|------|------|------|
| `read_state` | 查看角色当前状态 | `read_state("角色名")` |
| `update_state` | 更新角色属性 | `update_state("角色名", {归属值: 15})` |
| `advance_time` | 推进游戏天数 | `advance_time(3)` |
| `load_worldbook` | 按关键词搜索设定 | `load_worldbook("花开蒂落")` |

## 🚀 部署指南

### 前置条件

需要先安装 [pi 编码代理](https://github.com/earendil-works/pi-coding-agent)（内置 tau-mirror）：

```bash
pi --version    # ≥ v0.75
node --version  # ≥ 18
```

### 标准部署

```bash
# 1. 克隆
git clone https://github.com/your-username/pi-rp-framework.git
cd pi-rp-framework

# 2. 安装 WebSocket 依赖（rp-engine 需要）
npm install ws

# 3. 初始化世界书和状态
node setup.mjs

# 4. 启动 pi（自动加载 rp-engine 扩展并启动 Web 服务）
pi
```

### 首次运行

1. 在 pi 终端中，输入 `/route 纯爱线`（或 `核心线`）选择剧情路线
2. 浏览器打开 `http://localhost:3012` 进入 RP Web 界面
3. 开始与 AI 进行角色扮演对话

> **注意**：`pi` 终端是主要交互入口，Web 页面为辅助界面（可视化的状态面板、选项点击、会话管理）。两者可以同时使用。

### 自定义世界

1. 编辑 `worldbook_clean/` 下的文件
2. 运行 `node setup.mjs` 重新生成
3. 重启 pi

### 配置说明

**`.pi/settings.json`**
```json
{
  "skills": ["./skills/rp/SKILL.md"],
  "enableSkillCommands": true,
  "sessionDir": ".pi/sessions"
}
```

端口配置在 `rp-engine.ts` 中搜索 `3012` 修改。

## 🤔 常见问题

### `Cannot find module 'ws'`
```bash
npm install ws
```

### `window is not defined`
前端文件必须在 `extensions/rp-web/` 子目录下，pi 不递归扫描子目录。

### Web 页面返回 `Not Found`
检查 `rp-engine.ts` 中路径拼接，确保不以 `/` 开头。

### 修改角色状态后不生效
重新运行 `node setup.mjs`。

### 对话历史和普通 pi 混在一起
检查 `settings.json` 中是否配置了 `"sessionDir": ".pi/sessions"`。

## 📚 文档索引

| 文档 | 说明 |
|------|------|
| [1-项目结构.md](./1-项目结构.md) | 文件组织速查 |
| [2-复现.md](./2-复现.md) | 从零搭建的详细步骤与踩坑记录 |
| [3-改造过程.md](./3-改造过程.md) | 从编辑器脚本到独立前端的改造思路 |

## 📄 许可

MIT License

---

<p align="center">
  <sub>基于 <a href="https://github.com/earendil-works/pi-coding-agent">pi coding agent</a> 构建</sub>
  <br/>
  <sub>个人学习/测试用途</sub>
</p>
