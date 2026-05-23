<h1 align="center">🎭 RP Engine · 角色扮演引擎</h1>

<p align="center">
  <strong>基于 pi coding agent 的通用角色扮演引擎</strong>
  <br/>
  多卡片并发 · 多角色状态追踪 · 实时 Web 前端 · SillyTavern 角色卡导入
  <br/><br/>
  <img src="https://img.shields.io/badge/pi-v0.75%2B-blue" alt="pi">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="license">
</p>

---

> **⚠️ 声明**：本项目为个人学习/测试用途，基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 构建。

## 📖 项目简介

RP Engine 是一个运行在 pi coding agent 之上的**通用角色扮演引擎**。不绑定特定世界观——你可以导入任意 SillyTavern 格式的角色卡来扮演。

### 核心特性

| 特性 | 说明 |
|------|------|
| **多卡片并发** | 同时激活多张角色卡，支持跨世界融合叙事 |
| **SillyTavern 兼容** | 支持 V2/V3 PNG 角色卡和 JSON 导出格式导入 |
| **导入自动预处理** | 正则→渲染钩子、酒馆→变量定义、远程 URL 扫描、待办生成 |
| **卡片完全隔离** | 状态、世界书、正则脚本、session 历史均按卡片独立 |
| **动态变量系统** | Zod Schema 提取 → 类型校验 → 值域钳制 → state.json 持久化 |
| **正则全链路** | 引擎层 prompt 剥离 + 前端 display 替换，WebSocket 下发 |
| **卡片 UI 组件** | AI 本地化产物放入 `ui/` 目录，引擎自动扫描下发给前端 |
| **世界书注入** | 关键词匹配 + Token 预算 1500 + 去重 + 优先级排序 |
| **用户轮数计数** | 基于 turn_end 精确统计用户交互次数，避免 steer 消息污染轮数 |
| **state.json 只读模板** | 卡片模板永不被覆盖，动态数据通过 session 快照持久化 |
| **APPEND_SYSTEM 前端附加** | 格式规范拼到用户消息末尾发送，利用 AI 末尾注意力最高特性 |

---

## 🚀 快速开始

```bash
# 1. 进入项目
cd your-project

# 2. 安装依赖
npm install

# 3. 导入角色卡（SillyTavern PNG/JSON）
node setup.mjs --character path/to/character.png

# 4. 启动 pi
pi

# 5. 浏览器打开 http://localhost:3012
```

或者直接双击根目录的 **`start.bat** 自动启动 pi 并打开浏览器。

---

## 📇 角色卡管理

### 导入角色卡

```bash
node setup.mjs --character path/to/character.png
node setup.mjs --character path/to/card.png --target ./my-cards
node setup.mjs --scan
```

每张卡片生成独立目录 `.pi/cards/<卡名>/`：

```
.pi/cards/<卡名>/
├── worldbook/               # 角色描述 + character_book 条目
├── state.json               # ⭐ 只读模板（永不覆盖）
├── config.json              # 卡片配置
├── APPEND_SYSTEM.md          # 常驻风格规范
├── regex_hooks.json         # 渲染钩子
└── variable_schema.json     # 角色变量定义
```

### 卡片命令

| 命令 | 说明 |
|------|------|
| `/card list` | 列出所有已导入卡片 |
| `/card activate <id>` | 激活卡片（支持多张并发） |
| `/card deactivate <id>` | 休眠卡片 |
| `/card set <id>` | 仅激活单张（清空其他） |
| `/reset` | 从卡片模板重置所有角色数值到初始状态 |
| `/status` | TUI 状态面板 |
| `/history <角色名>` | 查看角色数值变更历史 |
| `/route [路线]` | 选择/查看剧情路线 |
| `/rp` | 帮助 |

---

## 🏗️ 项目结构

```
├── .pi/
│   ├── settings.json               # pi 设置
│   ├── APPEND_SYSTEM.md            # 常驻风格规范（前端附加）
│   ├── state.json                  # 运行时状态（由 session 快照重建）
│   ├── state_history.jsonl         # 状态变更历史
│   ├── sessions/                   # 对话记录（按卡片隔离）
│   ├── cards/                      # 📇 角色卡仓库
│   │   ├── registry.json           #   卡片注册表
│   │   └── <卡名>/                 #   单张卡片目录
│   │       └── state.json          #   ⭐ 只读模板
│   ├── extensions/
│   │   ├── rp-engine/              # 🔧 引擎模块
│   │   └── rp-web/                 # 🌐 前端界面
│   └── skills/rp/SKILL.md          # RP Skill 指令
├── setup.mjs                       # ⭐ 导入/注册/切换卡片脚本
├── start.bat                       # 🚀 一键启动（pi + 浏览器）
├── .rpconfig.json                  # 运行时配置
└── README.md
```

---

## 📡 核心功能

### 角色状态系统

| 属性 | 范围 | 说明 |
|------|------|------|
| 归属值 | 0~100 | 角色对玩家的情感偏向 |
| 情分值 | 0~100 | 自动同步 = 100 - 归属值 |
| 背德值/欲望值 | 0~200 | 卡片自定义数值，分阶段驱动角色行为 |
| 生理状态 | 动态 | 生理期、安全期、怀孕状态追踪 |
| 特殊事件 | 布尔 | 花开蒂落、告白、结婚等里程碑标记 |

### AI 工具（4 个）

| 工具 | 功能 |
|------|------|
| `read_state` | 读取角色当前状态 |
| `update_state` | 更新归属值/背德值/欲望值/内心想法等 |
| `advance_time` | 推进游戏天数 |
| `load_worldbook` | 按关键词加载世界书条目 |

### state.json 只读模板机制

- `cards/<卡名>/state.json` 是**只读模板**，存储角色初始设定
- 运行时动态数据通过 session 历史中的 `rp-state` 快照持久化
- `saveState()` 不再写回卡片目录，保护模板不被污染
- `loadState()` 启动时从卡片模板加载初始值
- **`/reset` 命令**：从卡片模板重建，一键重置所有数值

### 上下文管理

| 机制 | 说明 |
|------|------|
| **对话压缩** | 每 15 次用户交互强制压缩（AI 回复后触发，用户无感知） |
| **世界书注入** | 每 3 次用户交互关键词匹配注入（前端不可见） |
| **APPEND_SYSTEM 附加** | 每 5 次用户输入自动拼格式规范到消息末尾 |
| **用户轮数计数** | 基于 `turn_end` 精确计数，不受 steer 污染 |

---

## ⚙️ 配置

### .rpconfig.json

```json
{
  "token_budget": {
    "worldbook_max": 1500,
    "history_max_tokens": 8000
  },
  "model_max_tokens": 128000,
  "rp_web_port": 3012,
  "rp_web_host": "127.0.0.1"
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RP_WEB_PORT` | `3012` | Web 前端端口 |
| `RP_WEB_HOST` | `127.0.0.1` | 监听地址（局域网改 `0.0.0.0`） |
| `RP_AUTHOR_NOTE` | — | Author Note 注入文本 |

---

## 🚀 部署

### 前置条件

- pi ≥ v0.75
- Node.js ≥ 18

### 启动方式

```bash
# 方式一：命令行
pi
# 浏览器打开 http://localhost:3012

# 方式二：双击 start.bat（自动启动 pi + 打开浏览器）
```

---

## 📚 文档索引

| 文档 | 说明 |
|------|------|
| [项目规程.md](项目规程.md) | 全流程操作规范 |
| [1-项目大纲.md](1-项目大纲.md) | 项目定位、数据流、核心特性 |
| [1-项目结构.md](1-项目结构.md) | 文件组织速查 |
| [3-脚本与正则改造.md](3-脚本与正则改造.md) | 正则脚本全链路处理 |
| [4-世界书处理.md](4-世界书处理.md) | 世界书搜索/注入/大规模条目策略 |
| [rp-engine/README.md](.pi/extensions/rp-engine/README.md) | 引擎模块详细文档 |

---

## 📄 许可

MIT License
