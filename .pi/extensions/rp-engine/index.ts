/**
 * RP Engine - 角色扮演状态引擎（入口）
 *
 * 组合所有子模块：状态存储、世界书、周期事件、系统提示、
 * TUI 面板、工具、命令、RP Web 服务器。
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorldState, CharacterState } from "./types";
import { createStateStore } from "./state-store";

function ensureDir(dir: string) { mkdirSync(dir, { recursive: true }); }
import { buildSystemPrompt } from "./system-prompt";
import { createToolRegistry } from "./tools";
import { createCommandRegistry } from "./commands";
import { createRPWebServer } from "./rp-web-server";
import { cleanupOldSessions } from "./state-store";
import { AuthorNote } from "./author-note";
import { injectRelevantWorldbook, resetInjectedEntries, buildAllCardIndexes, injectAlwaysOnWorldbook } from "./worldbook";
import { initCardManager, getActiveCardIds, getActiveCards, getCardWorldbookDirs } from "./card-manager";
import { loadRegexHooks, applyPromptHooks, applyDisplayHooks, type CompiledRegexHook } from "./regex-processor";

// ============================================================
// 配置加载
// ============================================================

/** .rpconfig.json 配置接口 */
interface RPConfig {
  character_card?: string;
  worldbook_extra_dir?: string;
  token_budget?: {
    worldbook_max?: number;
    history_max_tokens?: number;
  };
  author_note?: string;
  model_max_tokens?: number;
  rp_web_port?: number;
  rp_web_host?: string;
}

/** 内置默认配置 */
const DEFAULT_CONFIG: RPConfig = {
  token_budget: {
    worldbook_max: 1500,
    history_max_tokens: 8000,
  },
  model_max_tokens: 128000,
  rp_web_port: 3012,
  rp_web_host: "127.0.0.1",
};

/**
 * 加载 .rpconfig.json 配置
 * - 如果文件存在：读取并合并到默认配置
 * - 如果文件不存在：使用默认配置并自动生成一份
 */
function loadRPConfig(cwd: string): RPConfig {
  const configPath = join(cwd, ".rpconfig.json");
  let config: RPConfig = { ...DEFAULT_CONFIG };

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      // 深度合并
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        token_budget: {
          ...DEFAULT_CONFIG.token_budget,
          ...(raw.token_budget || {}),
        },
      };
      console.log("[RP] 已加载 .rpconfig.json");
    } catch (e) {
      console.warn("[RP] .rpconfig.json 解析失败，使用默认配置:", (e as Error).message);
    }
  } else {
    // 自动生成默认配置
    try {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      console.log("[RP] 已生成默认 .rpconfig.json（请按需修改后重启）");
    } catch {
      // 静默失败
    }
  }

  // 写入环境变量（覆盖 config 中的 author_note）
  if (config.author_note && !process.env.RP_AUTHOR_NOTE) {
    process.env.RP_AUTHOR_NOTE = config.author_note;
  }

  // 写入端口/主机到环境变量（如果未设置）
  if (config.rp_web_port && !process.env.RP_WEB_PORT) {
    process.env.RP_WEB_PORT = String(config.rp_web_port);
  }
  if (config.rp_web_host && !process.env.RP_WEB_HOST) {
    process.env.RP_WEB_HOST = config.rp_web_host;
  }

  return config;
}

export default function (pi: ExtensionAPI) {
  // ========== 加载配置 ==========
  // cwd 在 session_start 中设置，此处先用占位
  let rpConfig: RPConfig = { ...DEFAULT_CONFIG };
  // ========== 初始化子模块 ==========

  const store = createStateStore();
  const rpWeb = createRPWebServer(
    pi,
    () => stateDir,
    () => store.getState(),
    () => {
      // 返回 display 阶段渲染钩子（供前端使用）
      const displayHooks: { name: string; pattern: string; flags: string; replacement: string }[] = [];
      for (const h of compiledHooks) {
        if (h.phase === "display") {
          displayHooks.push({
            name: h.name,
            pattern: h.regex.source,
            flags: h.regex.flags,
            replacement: h.replacement,
          });
        }
      }
      return { prompt: [], display: displayHooks };
    }
  );

  let stateDir = "";
  /** @deprecated 单个 worldbook 目录，保留兼容。新代码应使用 getWorldbookDirs() */
  let worldbookDir = "";

  // ========== 注册事件转发（必须在 session_start 之前） ==========
  rpWeb.registerEventForwarding();

  // ========== Author Note 实例 ==========
  const authorNote = new AuthorNote();

  // ========== 正则脚本钩子 ==========
  let compiledHooks: CompiledRegexHook[] = [];

  // ========== turn_start 计数器 ==========
  let turnCounter = 0;
  let compacting = false;
  let lastTotalTokens = 0;

  // ========== 注册事件 ==========

  // session_start: 加载配置 + 状态 + 设置目录 + 清理旧 session
  pi.on("session_start", async (_event, ctx) => {
    rpConfig = loadRPConfig(ctx.cwd);
    stateDir = join(ctx.cwd, ".pi");
    worldbookDir = join(ctx.cwd, ".pi", "worldbook");

    // 初始化卡片管理器
    initCardManager(ctx.cwd);
    const activeCards = getActiveCards();
    const activeCardIds = getActiveCardIds();
    console.log(`[RP] 激活卡片 (${activeCardIds.length}): ${activeCardIds.join(", ") || "无"}`);
    if (activeCards.length === 0) {
      console.log("[RP] 提示: 没有激活的角色卡，使用默认世界书。输入 /card 管理卡片。");
    }

    // 加载激活卡片的正则脚本
    const activeCardsList = getActiveCards();
    const cardDirs = activeCardsList.map((c) => c.dir);
    const hooks = loadRegexHooks(cardDirs);
    compiledHooks = [...hooks.prompt, ...hooks.display];
    console.log(`[RP] 正则钩子: ${hooks.prompt.length} prompt + ${hooks.display.length} display (来自 ${activeCardsList.length} 张卡)`);

    // 构建动态关键词索引（替代旧的硬编码 extractKeywords）
    buildAllCardIndexes(activeCardsList.map((c) => ({ id: c.id, dir: c.dir })));

    store.setDirectories(stateDir);
    store.loadState();

    // ⭐ 按激活卡片设置独立的 session/history 目录
    const cardSessionsRoot = join(stateDir, "sessions");
    const cardIds = getActiveCardIds();
    const sessionSubDir = cardIds.length === 1
      ? cardIds[0]                        // 单卡：.pi/sessions/<卡名>/
      : cardIds.join("+");                 // 多卡：.pi/sessions/<卡1+卡2>/
    const cardSessionsDir = join(cardSessionsRoot, sessionSubDir);
    // 更新 pi settings 中的 sessionDir（下轮生效）
    try {
      const settingsPath = join(stateDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      const newSessionDir = ".pi/sessions/" + sessionSubDir;
      if (settings.sessionDir !== newSessionDir) {
        settings.sessionDir = newSessionDir;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        console.log(`[RP] sessionDir → ${newSessionDir}`);
      }
    } catch { /* settings 写入失败不影响主流程 */ }

    ensureDir(cardSessionsDir);
    cleanupOldSessions(cardSessionsDir);

    store.reconstructFromSession(ctx);

    ctx.ui.setStatus("rp", ctx.ui.theme.fg("accent", "RP模式"));

    rpWeb.setLatestCtx(ctx);
    await rpWeb.start(ctx);
  });

  // session_tree: 分支导航时重建状态
  pi.on("session_tree", async (_event, ctx) => {
    store.reconstructFromSession(ctx);
    store.saveState();
  });

  // ══════════════════════════════════════════════
  // 正则脚本钩子应用
  // ══════════════════════════════════════════════

  /**
   * 对助理消息应用正则钩子（prompt 剥离 + display 替换）
   * 在 message_end 时由引擎层处理，确保：
   *   - prompt 钩子剥离的内容不会进入上下文
   *   - display 钩子替换的内容可被前端正确渲染
   */
  function applyHooksToMessage(msg: any): void {
    if (!msg || msg.role !== "assistant") return;
    if (compiledHooks.length === 0) return;

    if (typeof msg.content === "string") {
      msg.content = applyPromptHooks(msg.content, compiledHooks);
      msg.content = applyDisplayHooks(msg.content, compiledHooks);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text = applyPromptHooks(block.text, compiledHooks);
          block.text = applyDisplayHooks(block.text, compiledHooks);
        }
      }
    }
  }

  // message_end: 在消息最终确定后应用正则钩子
  pi.on("message_end", async (event: any) => {
    if (event?.message) {
      applyHooksToMessage(event.message);
    }
  });

  // before_agent_start: 注入系统提示 + 开场指令
  pi.on("before_agent_start", async (event) => {
    const worldbookDirs = getCardWorldbookDirs();
    const searchDirs = worldbookDirs.length > 0 ? worldbookDirs : (worldbookDir ? [worldbookDir] : []);
    const rpPrompt = buildSystemPrompt(store.getState(), searchDirs, authorNote);

    // 构建开场指令：检测激活卡片，自动开始角色扮演
    const activeCards = getActiveCards();
    let startPrompt = "";
    if (activeCards.length > 0) {
      const cardNames = activeCards.map((c) => c.meta?.name || c.id).join("、");
      const cardIds = activeCards.map((c) => c.id).join("、");
      startPrompt = `
## 开始角色扮演
已加载角色卡：${cardNames} (${cardIds})
请根据世界书设定和角色状态，直接开始扮演。
使用 read_state 检查角色状态，load_worldbook 加载设定，update_state 更新进度。
`;
    }

    return {
      systemPrompt: event.systemPrompt + "\n\n" + rpPrompt + startPrompt,
    };
  });

  // ============================================================
  // 用户真实交互轮数计数器
  // turn_end 在每次用户→AI完整回合结束时触发，是准确的用户交互计数
  // 而 turn_start 会被 steer/toolResult 等消息重复触发，不适合计数
  // ============================================================
  let userTurnCounter = 0;

  // turn_end: 保存状态 + 记录 token 用量 + 清理旧 session + 用户轮数计数 + 强制压缩
  pi.on("turn_end", async (event: any, ctx: ExtensionContext) => {
    store.saveState(true); // 立即写入，确保轮次结束时状态持久化
    store.saveSessionSnapshot(pi);
    userTurnCounter++; // ⭐ 每完成一轮用户↔AI交互，用户轮数 +1

    const msg = event?.message;
    if (msg?.role === "assistant" && msg?.usage?.totalTokens) {
      lastTotalTokens = msg.usage.totalTokens;
    }

    // ===== AI 生成完后再压缩（每 15 次用户交互一次，完成后跳过 15 轮防止重复触发） =====
    if (userTurnCounter > 0 && userTurnCounter % 15 === 0) {
      if (!compacting) {
        compacting = true;
        try {
          await ctx.compact(
            "保留以下核心信息：\n" +
            "1. 当前场景和角色位置\n" +
            "2. 各角色的归属值/情分值/关系变化\n" +
            "3. 已触发的剧情事件\n" +
            "4. 最近 2 轮对话的详细内容\n" +
            "5. 当前角色的心理状态和内心想法\n" +
            "6. 每次回复正文必须达到800-1200字（硬性要求）"
          );
        } catch {}
        // 压缩完成后跳过 15 轮，防止 turn_end 重复触发压缩
        userTurnCounter += 15;
        compacting = false;
      }

      // 重置世界书注入追踪（压缩后上下文重置，旧注入标记应解锁）
      resetInjectedEntries();

      // 常开世界书注入已移到 turn_start 中执行，避免在 turn_end 发消息导致界面混叠
    }

    if (userTurnCounter % 10 === 0) {
      const sessionsDir = join(stateDir, "sessions");
      cleanupOldSessions(sessionsDir);
    }

    // 每 20 轮重置世界书注入追踪（模拟场景切换）
    if (userTurnCounter % 20 === 0) {
      resetInjectedEntries();
    }
  });

  // turn_start: 世界书注入 + [禁用]格式刷新/状态概览/轻量提醒（由 APPEND_SYSTEM.md 前端附加替代）
  pi.on("turn_start", async (event: any, ctx: ExtensionContext) => {
    rpWeb.broadcastToRP({ type: "event", event: { type: "turn_start", ...event } });
    turnCounter++;
    const state = store.getState();

    // ===== 世界书主动注入 =====
    const worldbookDirs = getCardWorldbookDirs();
    const searchDirs = worldbookDirs.length > 0 ? worldbookDirs : (worldbookDir ? [worldbookDir] : []);
    if (searchDirs.length > 0 && (userTurnCounter + 1) % 3 === 1) {
      try {
        const userMsg = event?.message?.content || "";
        const recentContext: string[] = [];
        const injected = injectRelevantWorldbook(userMsg, recentContext, searchDirs);
        if (injected) {
          pi.sendUserMessage(
            `[系统 · 世界书主动注入]
${injected}`,
            { deliverAs: "steer" }
          );
        }
      } catch { /* 注入失败不影响主流程 */ }
    }
  });

  // ========== 注册工具和命令 ==========
  // 使用注册表模式：先创建注册表收集所有定义，再批量注册到 pi API

  const toolRegistry = createToolRegistry(
    () => store.getState(),
    () => store.saveState(),
    (record) => store.appendHistory(record),
    () => {
      const cardDirs = getCardWorldbookDirs();
      return cardDirs.length > 0 ? cardDirs : [worldbookDir];
    },
    () => {
      // 从所有激活卡片加载 variable_schema.json，按 cardId 索引
      // 格式: { cardId: { charName: { fieldName: type } } }
      const schemas: Record<string, Record<string, Record<string, string>>> = {};
      try {
        for (const card of getActiveCards()) {
          const schemaPath = join(card.dir, "variable_schema.json");
          if (!existsSync(schemaPath)) continue;
          const cardSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));
          const charSchemas: Record<string, Record<string, string>> = {};
          for (const [charName, fields] of Object.entries(cardSchema)) {
            if (charName === "事件") continue;
            const typedFields: Record<string, string> = {};
            for (const [fname, fval] of Object.entries(fields as Record<string, any>)) {
              typedFields[fname] = typeof fval;
            }
            charSchemas[charName] = typedFields;
          }
          if (Object.keys(charSchemas).length > 0) {
            schemas[card.id] = charSchemas;
          }
        }
      } catch {}
      return schemas;
    }
  );
  toolRegistry.registerAll(pi);

  const cmdRegistry = createCommandRegistry(
    () => store.getState(),
    () => store.saveState(),
    () => store.getHistoryPath(),
    stateDir
  );
  cmdRegistry.registerAll(pi);

  // ========== 清理 ==========

  pi.on("session_shutdown", async () => {
    store.flushAll(); // 刷新所有缓冲数据到磁盘
    await rpWeb.shutdown();
  });
}
