/**
 * RP Engine - 角色扮演状态引擎
 *
 * 功能：
 * - 状态管理（内存 + state.json + 历史记录 + session entries）
 * - 世界书按需加载
 * - 周期事件（花开蒂落、生理结算）
 * - /status 状态面板
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ============================================================
// 类型定义
// ============================================================

interface WorldState {
  当前日期: string;
  当前星期: string;
  当前时间: string;
  当前位置: string;
}

interface CharacterState {
  归属值: number;
  情分值: number;
  性交次数: { 现实: number; 游戏: number; 总次数: number };
  身份: string;
  年龄: number;
  贞洁状态: { 现实: string; 游戏: string };
  基本信息: { 姓名: string };
  公民芯片: { 姓名: string };
  花开蒂落: { 触发状态: boolean; 触发对象: string; 触发形式: string; 专属生理印证: string };
  生理状态: { 是否为生理期: boolean; 安全期: number; 生理期持续天数: number; 怀孕状态: string; 怀孕天数: number; 堕胎次数or分娩次数: number };
  特殊事件: { 生理印记圆满: { 触发状态: boolean }; 托卵计划: { 状态: boolean }; 结婚: { 触发状态: boolean }; 告白: { 触发状态: boolean } };
  当前状态: { 所在地点: string; 当前着装: { 现实: string; 游戏: string }; 内心想法: string; 当前身体与行为特征?: string };
  [key: string]: any;
}

interface HistoryRecord {
  timestamp: string;
  char: string;
  field: string;
  oldValue: any;
  newValue: any;
}

// ============================================================
// 工具函数
// ============================================================

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v || 0, min), max);
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function setNested(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function getNested(obj: any, path: string): any {
  const keys = path.split(".");
  let current = obj;
  for (const k of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[k];
  }
  return current;
}

const CORE_CHARS = ["示例角色"];  // ← 替换为你的角色名

// RP Web 服务器的共享引用（在 export default function 内部使用）
let latestCtx: any = null;

// ============================================================
// 主扩展
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- 状态 ----
  let state: Record<string, any> = {};
  let stateDir: string = "";
  let worldbookDir: string = "";

  // ---- 状态管理 ----

  function getStatePath(): string {
    return join(stateDir, "state.json");
  }

  function getHistoryPath(): string {
    return join(stateDir, "state_history.jsonl");
  }

  function loadState(): void {
    const p = getStatePath();
    if (existsSync(p)) {
      try {
        state = JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        state = {};
      }
    }
  }

  function saveState(): void {
    const p = getStatePath();
    mkdirSync(stateDir, { recursive: true });
    state["_meta"] = {
      ...(state["_meta"] || {}),
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
  }

  /** 保存 session entry（只在 turn_end 调用，避免膨胀） */
  function saveSessionSnapshot(): void {
    try {
      pi.appendEntry("rp-state", { snapshot: deepClone(state), timestamp: Date.now() });
    } catch {}
  }

  function appendHistory(record: HistoryRecord): void {
    const p = getHistoryPath();
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(p, JSON.stringify(record) + "\n", "utf-8");
  }

  // 从 session entries 重建状态（用于分支回滚）
  function reconstructFromSession(ctx: ExtensionContext): void {
    let latestSnapshot: any = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "rp-state") {
        latestSnapshot = entry.data?.snapshot;
      }
    }
    if (latestSnapshot) {
      state = deepClone(latestSnapshot);
    }
  }

  // ---- 世界书加载 ----

  function findWorldbookFiles(keyword: string): { file: string; content: string }[] {
    const results: { file: string; content: string }[] = [];
    const searchDirs = ["世界观", "角色设定", "身体演化", "格式指令"];

    // 预处理关键字：去掉目录前缀关键词（如 "世界观"、"世界观纯爱线"）以便匹配
    const normalizedKeyword = keyword.replace(/^(世界观|世界观纯爱线|归属值|情分值)\s*/g, "").trim();

    for (const dir of searchDirs) {
      const fullDir = join(worldbookDir, dir);
      if (!existsSync(fullDir)) continue;
      try {
        for (const f of readdirSync(fullDir)) {
          if (!f.endsWith(".md")) continue;
          const name = f.replace(".md", "");
          // 同时匹配完整文件名和规范化后的短名
          const shortName = name.replace(/^(世界观|世界观纯爱线|归属值|情分值)\s*/g, "").trim();
          if (name.includes(keyword) || name.includes(normalizedKeyword) || shortName.includes(normalizedKeyword)) {
            const content = readFileSync(join(fullDir, f), "utf-8");
            results.push({ file: `${dir}/${f}`, content });
          }
        }
      } catch {}
    }
    return results;
  }

  function readWorldbookIndex(): string {
    const indexPath = join(worldbookDir, "索引.md");
    if (existsSync(indexPath)) {
      return readFileSync(indexPath, "utf-8");
    }
    return "# 世界书索引\n\n(索引文件未找到)";
  }

  // ---- 周期事件 ----

  function processPeriodicEvents(daysPassed: number): string[] {
    const events: string[] = [];
    const world = state["世界"] as WorldState;
    if (!world) return events;

    const currentDate = new Date(world.当前日期);
    if (isNaN(currentDate.getTime())) return events;

    // 检查每个核心角色
    for (const name of CORE_CHARS) {
      const char = state[name] as CharacterState;
      if (!char) continue;

      // 花开蒂落检查: 归属值 >= 60 且未触发
      if (char.归属值 >= 60 && char.花开蒂落?.触发状态 === false) {
        char.花开蒂落.触发状态 = true;
        char.花开蒂落.触发对象 = "引路人";
        char.花开蒂落.触发形式 = "落红为印";
        char.贞洁状态.现实 = "非处女";
        char.性交次数.现实 += 1;
        char.性交次数.总次数 = char.性交次数.现实 + char.性交次数.游戏;
        events.push(`【花开蒂落】${name}的归属感达到临界点，完成了身心的最终交付。`);
        appendHistory({
          timestamp: new Date().toISOString(),
          char: name,
          field: "花开蒂落.触发状态",
          oldValue: false,
          newValue: true,
        });
      }

      // 生理期结算
      if (char.生理状态?.是否为生理期 && char.生理状态?.怀孕状态 === "未怀孕") {
        char.生理状态.怀孕状态 = "怀孕";
        char.生理状态.怀孕天数 = 1;
        events.push(`【生命萌发】${name}在生理期内受孕，新的生命开始孕育。`);
        appendHistory({
          timestamp: new Date().toISOString(),
          char: name,
          field: "生理状态.怀孕状态",
          oldValue: "未怀孕",
          newValue: "怀孕",
        });
      }

      // 自动重新计算情分值
      if (char.归属值 !== undefined) {
        char.情分值 = 100 - clamp(char.归属值, 0, 100);
      }
    }

    // 秘密派对事件（每7天）
    if (daysPassed >= 7 || (currentDate.getDate() % 7 === 0)) {
      events.push("【秘密派对】今日「新生摇篮」圈子举办了秘密聚会。");
    }

    return events;
  }

  // ---- 系统提示注入 ----

  function buildSystemPrompt(): string {
    const world = state["世界"] as WorldState;
    const index = readWorldbookIndex().slice(0, 2500); // 只取索引前2500字

    let prompt = `# 角色扮演模式

## 当前世界状态
- 日期: ${world?.当前日期 || "未知"} ${world?.当前星期 || ""}
- 时间: ${world?.当前时间 || ""}
- 位置: ${world?.当前位置 || ""}

## 世界书索引（简要）
${index.slice(0, 1500)}

## 核心角色当前状态概要
`;
    for (const name of CORE_CHARS) {
      const char = state[name] as CharacterState;
      if (!char) continue;
      const flower = char.花开蒂落?.触发状态 ? "🌸已花开" : "🌱未触发";
      const preg = char.生理状态?.怀孕状态 || "未怀孕";
      prompt += `- ${char.基本信息?.姓名 || name}: 归属值=${char.归属值} 情分值=${char.情分值} ${flower} 怀孕=${preg}\n`;
    }

    prompt += `
## 角色扮演规则
1. 严格按世界书设定行事，不自行编造
2. 使用 read_state 工具检查角色状态
3. 使用 update_state 工具更新角色状态
4. 使用 load_worldbook 工具按需加载设定
5. 使用 advance_time 工具推进时间
6. 每次回复结束时更新相关角色的当前状态（想法、地点等）
7. 输出格式参考格式指令目录下的文件
`;
    return prompt;
  }

  // ---- TUI 状态面板 ----

  class StatusPanel {
    private theme: Theme;
    private onClose: () => void;
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(theme: Theme, onClose: () => void) {
      this.theme = theme;
      this.onClose = onClose;
    }

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onClose();
      }
    }

    render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
        return this.cachedLines;
      }

      const th = this.theme;
      const lines: string[] = [];
      const w = Math.min(width, 80);

      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", th.bold("  ╭───────────────── 状态面板 ─────────────────╮")), w));
      lines.push("");

      // 世界信息
      const world = state["世界"] as WorldState;
      if (world) {
        lines.push(truncateToWidth(`  📅 ${world.当前日期} ${world.当前星期}  🕐 ${world.当前时间}  📍 ${world.当前位置}`, w));
        lines.push("");
      }

      // 角色列表
      for (const name of CORE_CHARS) {
        const char = state[name] as CharacterState;
        if (!char) continue;

        const belong = char.归属值 ?? 0;
        const affection = char.情分值 ?? 100;
        const flower = char.花开蒂落?.触发状态 ? th.fg("success", "🌸") : th.fg("dim", "🌱");
        const preg = char.生理状态?.怀孕状态 || "未怀孕";
        const pregStr = preg !== "未怀孕" ? th.fg("warning", ` 🤰${char.生理状态?.怀孕天数 || 0}d`) : "";

        // 进度条
        const barLen = 15;
        const filled = Math.round((belong / 100) * barLen);
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);

        const nameStr = th.fg("text", name.padEnd(6));
        const barStr = th.fg("accent", bar);
        const valStr = th.fg("muted", `${String(belong).padStart(3)}/${String(affection).padStart(3)}`);
        lines.push(truncateToWidth(`  ${flower} ${nameStr} ${barStr} ${valStr}${pregStr}`, w));
      }

      lines.push("");
      lines.push(truncateToWidth(`  ${th.fg("dim", "归属值/情分值 · ESC 关闭")}`, w));
      lines.push(truncateToWidth(th.fg("accent", "  ╰────────────────────────────────────────╯"), w));
      lines.push("");

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
    }
  }

  // ---- 历史查看面板 ----

  class HistoryPanel {
    private charName: string;
    private theme: Theme;
    private onClose: () => void;
    private records: HistoryRecord[] = [];
    private cachedWidth?: number;
    private cachedLines?: string[];

    constructor(charName: string, theme: Theme, onClose: () => void) {
      this.charName = charName;
      this.theme = theme;
      this.onClose = onClose;
      this.loadHistory();
    }

    private loadHistory(): void {
      const p = getHistoryPath();
      if (!existsSync(p)) return;
      const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
      this.records = lines
        .map((l) => {
          try {
            return JSON.parse(l) as HistoryRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is HistoryRecord => r !== null && r.char === this.charName)
        .slice(-30); // 最多30条
    }

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onClose();
      }
    }

    render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
        return this.cachedLines;
      }

      const th = this.theme;
      const lines: string[] = [];
      const w = Math.min(width, 80);

      lines.push("");
      lines.push(truncateToWidth(th.fg("accent", th.bold(`  ╭─ ${this.charName} 变更历史 ─╮`)), w));
      lines.push("");

      if (this.records.length === 0) {
        lines.push(truncateToWidth(`  ${th.fg("dim", "暂无变更记录")}`, w));
      } else {
        for (const r of this.records) {
          const time = new Date(r.timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
          const field = th.fg("muted", r.field);
          const oldV = th.fg("dim", String(r.oldValue));
          const newV = th.fg("accent", String(r.newValue));
          lines.push(truncateToWidth(`  ${th.fg("dim", time)} ${field}: ${oldV} → ${newV}`, w));
        }
      }

      lines.push("");
      lines.push(truncateToWidth(`  ${th.fg("dim", "ESC 关闭")}`, w));
      lines.push("");

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    }

    invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
    }
  }

  // ============================================================
  // 注册 TOOLS
  // ============================================================

  // 1. read_state - 读取角色状态
  pi.registerTool({
    name: "read_state",
    label: "读取状态",
    description: "读取指定角色的当前状态数据。char 为角色名，fields 可选（指定要读取的字段路径）。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名，如 夏小雀、{{user}}、世界" }),
      fields: Type.Optional(
        Type.Array(Type.String(), { description: "要读取的字段路径数组，如 ['归属值','生理状态.怀孕状态']" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const charData = state[params.char];
      if (!charData) {
        return {
          content: [{ type: "text", text: `角色 "${params.char}" 不存在` }],
          details: { error: `角色 ${params.char} 不存在` },
        };
      }

      if (params.fields && params.fields.length > 0) {
        const result: Record<string, any> = {};
        for (const f of params.fields) {
          result[f] = getNested(charData, f);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { char: params.char, fields: result },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(charData, null, 2) }],
        details: { char: params.char, data: charData },
      };
    },
  });

  // 2. update_state - 更新角色状态
  pi.registerTool({
    name: "update_state",
    label: "更新状态",
    description: "更新指定角色的状态变量。updates 为键值对，键是字段路径（如 归属值、性交次数.现实），值是新值。归属值会自动钳制 0-100，情分值会自动同步。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名" }),
      updates: Type.Record(Type.String(), Type.Any(), { description: "要更新的字段路径→新值" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const charData = state[params.char];
      if (!charData) {
        return {
          content: [{ type: "text", text: `角色 "${params.char}" 不存在` }],
          details: { error: `角色 ${params.char} 不存在` },
        };
      }

      const historyRecords: HistoryRecord[] = [];
      const timestamp = new Date().toISOString();

      for (const [path, value] of Object.entries(params.updates)) {
        const oldValue = getNested(charData, path);
        let newValue = value;

        // 特殊处理：归属值钳制 + 情分值自动同步
        if (path === "归属值") {
          newValue = clamp(Number(newValue), 0, 100);
          setNested(charData, "归属值", newValue);
          charData["情分值"] = 100 - newValue;
          historyRecords.push({
            timestamp,
            char: params.char,
            field: "归属值",
            oldValue,
            newValue,
          });
          historyRecords.push({
            timestamp,
            char: params.char,
            field: "情分值",
            oldValue: charData["情分值"],
            newValue: 100 - newValue,
          });
          continue;
        }

        // 性交次数自动同步总次数
        if (path === "性交次数.现实" || path === "性交次数.游戏") {
          setNested(charData, path, Math.max(0, Number(newValue)));
          charData["性交次数"]["总次数"] =
            (charData["性交次数"]["现实"] || 0) + (charData["性交次数"]["游戏"] || 0);
          historyRecords.push({ timestamp, char: params.char, field: path, oldValue, newValue });
          continue;
        }

        setNested(charData, path, newValue);
        historyRecords.push({ timestamp, char: params.char, field: path, oldValue, newValue });
      }

      // 持久化到磁盘 + 历史日志（session entry 在 turn_end 统一保存）
      saveState();
      for (const r of historyRecords) {
        appendHistory(r);
      }

      return {
        content: [{ type: "text", text: `✅ ${params.char} 状态已更新` }],
        details: { updated: params.updates, history: historyRecords },
      };
    },
  });

  // 3. advance_time - 推进时间
  pi.registerTool({
    name: "advance_time",
    label: "推进时间",
    description: "推进游戏内时间。days 为推进天数（1-30）。会自动触发周期事件（花开蒂落检查、生理结算、秘密派对）。",
    parameters: Type.Object({
      days: Type.Integer({ description: "推进的天数", minimum: 1, maximum: 30 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const world = state["世界"] as WorldState;
      if (!world || !world.当前日期) {
        return {
          content: [{ type: "text", text: "错误：世界状态中缺少日期信息" }],
          details: { error: "缺少日期" },
        };
      }

      const currentDate = new Date(world.当前日期);
      if (isNaN(currentDate.getTime())) {
        return {
          content: [{ type: "text", text: `错误：无法解析日期 "${world.当前日期}"` }],
          details: { error: "日期格式错误" },
        };
      }

      // 推进日期
      currentDate.setDate(currentDate.getDate() + params.days);
      const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
      world.当前日期 = currentDate.toISOString().slice(0, 10);
      world.当前星期 = weekdays[currentDate.getDay()];

      // 处理周期事件
      const events = processPeriodicEvents(params.days);
      saveState();

      const eventText = events.length > 0 ? `\n\n## 周期事件\n${events.join("\n")}` : "";

      return {
        content: [
          {
            type: "text",
            text: `⏰ 时间推进至 ${world.当前日期} ${world.当前星期}${eventText}`,
          },
        ],
        details: { newDate: world.当前日期, events },
      };
    },
  });

  // 4. load_worldbook - 加载世界书
  pi.registerTool({
    name: "load_worldbook",
    label: "加载世界书",
    description: "按关键字从世界书中加载设定条目。keyword 可以是角色名、概念名（如 花开蒂落、天作之合、新生代扶持法案）。",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const results = findWorldbookFiles(params.keyword);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `未找到与 "${params.keyword}" 相关的世界书条目` }],
          details: { keyword: params.keyword, count: 0 },
        };
      }

      const text = results
        .slice(0, 3) // 最多返回3个文件
        .map((r) => `--- ${r.file} ---\n${r.content.slice(0, 3000)}`) // 每个文件最多3000字
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { keyword: params.keyword, files: results.map((r) => r.file), count: results.length },
      };
    },
  });

  // ============================================================
  // 注册 COMMANDS
  // ============================================================

  // /status - 状态面板
  pi.registerCommand("status", {
    description: "显示所有角色的当前状态面板",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/status 需要交互模式", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new StatusPanel(theme, () => done());
      });
    },
  });

  // /history - 查看历史
  pi.registerCommand("history", {
    description: "查看指定角色的状态变更历史。用法: /history <角色名>",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/history 需要交互模式", "error");
        return;
      }

      const name = args?.trim();
      if (!name) {
        ctx.ui.notify("用法: /history <角色名>", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new HistoryPanel(name, theme, () => done());
      });
    },
  });

  // /rp - 帮助
  pi.registerCommand("rp", {
    description: "显示角色扮演系统帮助",
    handler: async (_args, ctx) => {
      const help = `
╔══ 角色扮演系统帮助 ══╗

工具（供 AI 调用）:
  read_state      - 读取角色状态
  update_state    - 更新角色状态
  advance_time    - 推进游戏时间
  load_worldbook  - 加载世界书设定

命令（供你使用）:
  /status         - 显示状态面板
  /history <名>   - 查看角色变更历史
  /route [纯爱线|核心线] - 选择/查看剧情路线
  /rp             - 显示本帮助

追踪角色（6人）:
  夏小雀  宁正棠  江璃
  许知意  林初夏  凌晓青

状态文件:
  .pi/state.json            - 当前状态
  .pi/state_history.jsonl   - 变更历史
`;
      ctx.ui.notify(help, "info");
    },
  });

  // /route - 选择剧情路线
  pi.registerCommand("route", {
    description: "选择或查看当前剧情路线。可用选项：纯爱线、核心线",
    handler: async (args, ctx) => {
      const meta = state["_meta"] || {};
      const currentRoute = meta.route || "未选择";
      const input = args?.trim();

      if (!input) {
        ctx.ui.notify(`当前路线: ${currentRoute}  |  可选: ${meta.routeOptions?.join(", ") || "纯爱线, 核心线"}`, "info");
        return;
      }

      const valid = meta.routeOptions || ["纯爱线", "核心线"];
      if (!valid.includes(input)) {
        ctx.ui.notify(`无效路线 "${input}"，可选: ${valid.join(", ")}`, "error");
        return;
      }

      meta.route = input;
      meta.started = true;
      meta.lastUpdated = new Date().toISOString();
      saveState();

      ctx.ui.notify(`✅ 路线已设置为: ${input}`, "success");
    },
  });

  // ============================================================
  // 注册 EVENTS
  // ============================================================

  // session_start: 加载状态 + 设置目录
  pi.on("session_start", async (_event, ctx) => {
    stateDir = join(ctx.cwd, ".pi");
    worldbookDir = join(ctx.cwd, ".pi", "worldbook");
    loadState();

    // 尝试从 session entries 重建（分支支持）
    reconstructFromSession(ctx);

    ctx.ui.setStatus("rp", ctx.ui.theme.fg("accent", "RP模式"));

    // ====== RP Web 服务器启动（合并到同一个 session_start 中） ======
    latestCtx = ctx;
    if (rpServer) return;
    startRPWebServer(ctx);
  });

  // session_tree: 分支导航时重建状态
  pi.on("session_tree", async (_event, ctx) => {
    reconstructFromSession(ctx);
    saveState(); // 把重建后的状态同步回磁盘
  });

  // before_agent_start: 注入系统提示
  pi.on("before_agent_start", async (event) => {
    const rpPrompt = buildSystemPrompt();

    // 附加路线选择提示
    const meta = state["_meta"] || {};
    let routeHint = "";
    if (!meta.route) {
      routeHint = `
## 请选择剧情路线
游戏尚未开始。请先输入 /route 命令选择路线：
  - 纯爱线：{{user}}为中心，女孩们守护、戏耍引路人的温馨剧情
  - 核心线：引路人通过天作之合逐步转移女孩情感的深层剧情
`;
    } else {
      routeHint = `
## 当前路线
已选择: ${meta.route}
`;
    }

    // 读取 SYSTEM.md 格式规范（仅 RP 模式有路线时注入）
    let formatSpec = "";
    if (meta.route) {
      const systemMdPath = join(stateDir, "SYSTEM.md");
      if (existsSync(systemMdPath)) {
        try {
          const stat = statSync(systemMdPath);
          if (stat.size > 0) {
            formatSpec = "\n\n" + readFileSync(systemMdPath, "utf-8");
          }
        } catch {}
      }
    }

    return {
      systemPrompt: event.systemPrompt + "\n\n" + rpPrompt + routeHint + formatSpec,
    };
  });

  // turn_end: 保存状态 + 保存 session entry（用于分支回滚）
  pi.on("turn_end", async () => {
    saveState();
    saveSessionSnapshot();
  });

  // ============================================================
  // RP Web 服务器
  // ============================================================

  const RP_PORT = parseInt(process.env.RP_WEB_PORT || "3012");

  let rpServer: any = null;
  let rpWss: any = null;
  let rpClients = new Set<any>();

  function broadcastToRP(data: any) {
    const json = JSON.stringify(data);
    for (const client of rpClients) {
      if (client.readyState === 1 /* WebSocket.OPEN */) {
        try { client.send(json); } catch {}
      }
    }
  }

  // RP 事件订阅转发
  const rpEventTypes = [
    "agent_start", "agent_end",
    "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
  ] as const;

  for (const eventType of rpEventTypes) {
    pi.on(eventType as any, async (event: any, _ctx: ExtensionContext) => {
      broadcastToRP({ type: "event", event: { type: eventType, ...event } });
    });
  }

  // RP 命令处理
  async function handleRPCommand(ws: any, command: any) {
    const success = (cmd: string, data?: any) => ({ type: "response", command: cmd, success: true, id: command.id, data });
    const error = (cmd: string, msg: string) => ({ type: "response", command: cmd, success: false, error: msg, id: command.id });

    try {
      switch (command.type) {
        case "prompt":
          pi.sendUserMessage(command.message);
          sendToRP(ws, success("prompt"));
          break;

        case "abort":
          if (latestCtx) latestCtx.abort();
          sendToRP(ws, success("abort"));
          break;

        case "mirror_sync_request":
          const snapshot = await buildSnapshot();
          sendToRP(ws, snapshot);
          break;

        case "list_sessions": {
          const sessionsDir = join(stateDir, "sessions");
          const sessions: any[] = [];
          if (existsSync(sessionsDir)) {
            const files = readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl")).sort().reverse().slice(0, 30);
            for (const file of files) {
              const filePath = join(sessionsDir, file);
              const stat = statSync(filePath);
              let preview = "";
              try {
                const content = readFileSync(filePath, "utf-8");
                const lines = content.split("\n").filter(Boolean);
                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line);
                    const msg = entry.message;
                    if (msg?.role === "user") {
                      const c = msg.content;
                      if (typeof c === "string") { preview = c.slice(0, 80); break; }
                      if (Array.isArray(c)) {
                        for (const b of c) {
                          if (b.type === "text") { preview = b.text.slice(0, 80); break; }
                        }
                        if (preview) break;
                      }
                    }
                  } catch {}
                }
              } catch {}
              sessions.push({ file, size: stat.size, mtime: stat.mtimeMs, preview });
            }
          }
          sendToRP(ws, { type: "sessions_list", sessions });
          break;
        }

        case "get_state":
          const stateCopy = deepClone(state);
          sendToRP(ws, { type: "rp_state", data: stateCopy });
          break;

        case "load_session": {
          // 通过 pi API 加载旧会话（pi 内部处理）
          const sessionFile = command.file;
          if (sessionFile && latestCtx) {
            const fullPath = join(stateDir, "sessions", sessionFile);
            if (existsSync(fullPath)) {
              // 通知前端重新同步
              buildSnapshot().then((snap) => sendToRP(ws, snap));
            }
          }
          sendToRP(ws, success("load_session"));
          break;
        }

        case "new_session": {
          // 通知前端清空并开始新会话
          sendToRP(ws, { type: "new_session_started" });
          break;
        }

        default:
          sendToRP(ws, error(command.type, "Unknown command: " + command.type));
      }
    } catch (e: any) {
      sendToRP(ws, error(command.type || "unknown", e.message));
    }
  }

  function sendToRP(ws: any, data: any) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  }

  async function buildSnapshot() {
    const ctx = latestCtx;
    if (!ctx) return { type: "mirror_sync", entries: [], model: null, isStreaming: false };

    const entries = ctx.sessionManager.getEntries();
    const model = ctx.model;

    return {
      type: "mirror_sync",
      entries,
      model,
      isStreaming: !ctx.isIdle(),
    };
  }

  // 静态文件服务（使用函数，确保 stateDir 已初始化）
  function getRpWebDir(): string {
    return join(stateDir, "extensions", "rp-web");
  }

  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".json": "application/json",
  };

  function serveFile(urlPath: string, res: any) {
    let cleanPath = urlPath.split("?")[0];
    if (cleanPath === "/") cleanPath = "rp-web.html";
    if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1);

    const rpWebDir = getRpWebDir();
    const filePath = join(rpWebDir, cleanPath);

    // 安全检查
    if (!filePath.startsWith(rpWebDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found: " + cleanPath);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const ct = MIME[ext] || "application/octet-stream";

    res.writeHead(200, { "Content-Type": ct });
    res.end(readFileSync(filePath));
  }

  // 启动服务器
  async function startRPWebServer(ctx: any) {
    const http = await import("node:http");
    const { WebSocketServer } = await import("ws");

    rpServer = http.createServer((req: any, res: any) => {
      if (req.url === "/ws") {
        return;
      }
      serveFile(req.url || "/", res);
    });

    rpWss = new WebSocketServer({ noServer: true });

    rpServer.on("upgrade", (request: any, socket: any, head: any) => {
      if (request.url === "/ws") {
        rpWss.handleUpgrade(request, socket, head, (ws: any) => {
          rpWss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    rpWss.on("connection", (ws: any) => {
      rpClients.add(ws);

      buildSnapshot().then((snapshot) => sendToRP(ws, snapshot));

      ws.on("message", (data: any) => {
        try {
          const cmd = JSON.parse(data.toString());
          handleRPCommand(ws, cmd);
        } catch (e) {}
      });

      ws.on("close", () => { rpClients.delete(ws); });
      ws.on("error", () => { rpClients.delete(ws); });
    });

    const tryListen = (port: number, maxAttempts = 10) => {
      rpServer!.listen(port, "0.0.0.0", () => {
        console.log(`[RP-Web] RP 前端页面: http://localhost:${port}`);
        try { ctx.ui.notify(`RP Web: http://localhost:${port}`, "info"); } catch {}
      });
      rpServer!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < RP_PORT + maxAttempts) {
          rpServer!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[RP-Web] 启动失败:`, err.message);
        }
      });
    };

    tryListen(RP_PORT);
  }

  // 清理
  pi.on("session_shutdown", async () => {
    if (rpWss) {
      for (const client of rpClients) {
        try { client.close(); } catch {}
      }
      rpClients.clear();
      rpWss.close();
      rpWss = null;
    }
    if (rpServer) {
      rpServer.close();
      rpServer = null;
    }
  });
}
