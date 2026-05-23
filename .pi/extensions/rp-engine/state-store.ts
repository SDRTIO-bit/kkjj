/**
 * RP Engine - 状态存储管理（多卡片支持版）
 * 
 * 提供 state.json 读写、历史记录追加、session entry 快照、
 * session 文件清理、分支回滚重建等功能。
 * 
 * 多卡片支持：
 * - 状态结构改为 cardStates: Record<cardId, CardState>
 * - 兼容旧格式（扁平角色列表）自动迁移
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HistoryRecord, CardState } from "./types";
import { deepClone } from "./utils";

// ============================================================
// session 清理
// ============================================================

/**
 * 清理旧 session 文件：保留最近 15 个，总大小控制在 15MB 以内
 */
export function cleanupOldSessions(sessionsDir: string): void {
  if (!existsSync(sessionsDir)) return;
  try {
    const files = readdirSync(sessionsDir)
      .filter(f => f.endsWith(".jsonl") && !f.endsWith(".summary"))
      .map(f => {
        const p = join(sessionsDir, f);
        return { name: f, path: p, size: statSync(p).size, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const MAX_FILES = 15;
    const MAX_SIZE = 15 * 1024 * 1024;

    let totalSize = 0;
    const toRemove: string[] = [];

    for (let i = 0; i < files.length; i++) {
      if (i >= MAX_FILES) {
        toRemove.push(files[i].path);
      } else {
        totalSize += files[i].size;
      }
    }

    if (totalSize > MAX_SIZE) {
      const keep = files.slice(0, MAX_FILES);
      for (let i = keep.length - 1; i >= 0; i--) {
        if (totalSize <= MAX_SIZE) break;
        totalSize -= keep[i].size;
        toRemove.push(keep[i].path);
      }
    }

    for (const p of toRemove) {
      try { rmSync(p, { force: true }); } catch {}
      try { rmSync(p + ".summary", { force: true }); } catch {}
    }
    if (toRemove.length > 0) {
      console.log(`[RP] 清理了 ${toRemove.length} 个旧 session 文件`);
    }
  } catch {}
}

// ============================================================
// 旧格式兼容迁移
// ============================================================

/** 旧格式中属于全局的键（不归入卡片） */
const GLOBAL_KEYS = ["世界", "{{user}}", "_meta", "_stateDir"];

/**
 * 检测 state.json 是否为旧格式（扁平角色列表）
 * 旧格式特征：顶层有角色名（如 夏小雀）而非 cardStates 字段
 */
function isLegacyFormat(state: Record<string, any>): boolean {
  // 新格式有 cardStates 字段
  if (state.cardStates) return false;
  // 检查是否有角色名键（排除全局键）
  const keys = Object.keys(state).filter((k) => !k.startsWith("_") && !GLOBAL_KEYS.includes(k));
  // 如果有角色名键且看起来像角色状态，则是旧格式
  for (const key of keys) {
    if (state[key] && typeof state[key] === "object" && state[key].归属值 !== undefined) {
      return true;
    }
  }
  return false;
}

/**
 * 自动迁移：将旧格式 state.json 转为新格式
 */
function migrateLegacyState(state: Record<string, any>): Record<string, any> {
  console.log("[RP] 检测到旧格式 state.json，正在迁移...");

  const global: Record<string, any> = {};
  const cardCharacters: Record<string, any> = {};
  const meta = state["_meta"] || {};

  // 提取全局键
  for (const key of GLOBAL_KEYS) {
    if (state[key] !== undefined) {
      global[key] = state[key];
    }
  }

  // 提取角色状态
  const allKeys = Object.keys(state);
  for (const key of allKeys) {
    if (key.startsWith("_") || GLOBAL_KEYS.includes(key)) continue;
    if (state[key] && typeof state[key] === "object" && state[key].基本信息) {
      cardCharacters[key] = state[key];
    }
  }

  // 确定卡片 id（从 meta 推断，兜底用默认角色卡名）
  const cardId = (meta.route && meta.route !== "未选择") ? "默认角色卡" : "默认角色卡";

  const newState: Record<string, any> = {
    global,
    cardStates: {},
    _meta: {
      ...meta,
      version: 3,
      migratedAt: new Date().toISOString(),
      migratedFrom: "legacy_flat",
      activeCards: [cardId],
    },
  };

  // 单卡片场景：将角色放入该卡片
  (newState.cardStates as Record<string, any>)[cardId] = {
    meta: {
      name: cardId,
      route: meta.route || "",
      started: meta.started || false,
    },
    characters: cardCharacters,
    flags: {},
  };

  console.log(`[RP] 迁移完成: ${Object.keys(cardCharacters).length} 个角色 → cardStates['${cardId}']`);
  return newState;
}

// ============================================================
// 状态存储管理器工厂
// ============================================================

export function createStateStore() {
  let stateDir = "";
  let state: Record<string, any> = {};

  // ===== 性能优化：批量写入 + 内存缓存 =====

  let historyBuffer: HistoryRecord[] = [];
  const HISTORY_FLUSH_INTERVAL = 5000;
  const HISTORY_FLUSH_SIZE = 10;
  let historyFlushTimer: ReturnType<typeof setTimeout> | null = null;

  let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  const SAVE_DEBOUNCE_MS = 300;
  let pendingSave = false;

  function clearTimers(): void {
    if (historyFlushTimer) { clearTimeout(historyFlushTimer); historyFlushTimer = null; }
    if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
  }

  function setDirectories(dir: string) {
    stateDir = dir;
    state["_stateDir"] = dir;
  }

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

        // 自动迁移旧格式
        if (isLegacyFormat(state)) {
          state = migrateLegacyState(state);
          saveStateNow();
        }
      } catch {
        state = {};
      }
    }

    // ⭐ 从卡片目录的模板 state.json 加载角色初始数据
    // 确保 state.json 作为只读模板，动态数值由 session 历史重建
    const cardStates = state.cardStates;
    if (cardStates && typeof cardStates === "object") {
      for (const [cardId, cardData] of Object.entries(cardStates as Record<string, any>)) {
        const templatePath = join(stateDir, "cards", cardId, "state.json");
        if (!existsSync(templatePath)) continue;
        try {
          const templateState = JSON.parse(readFileSync(templatePath, "utf-8"));
          // 从模板中复制角色初始数据（只复制角色数据，不覆盖 meta/事件等）
          for (const [charName, charTemplate] of Object.entries(templateState)) {
            if (charName === "_meta" || charName === "{{user}}" || charName === "事件") continue;
            if (typeof charTemplate === "object" && charTemplate.基本信息) {
              // 如果角色在模板中存在，用模板数据覆盖（重置数值）
              if (cardData.characters[charName]) {
                // 保留当前状态中的所在地点和内心想法（如果有）
                const currentLocation = cardData.characters[charName]?.当前状态?.所在地点;
                const currentThought = cardData.characters[charName]?.当前状态?.内心想法;
                cardData.characters[charName] = deepClone(charTemplate);
                // 恢复当前对话中的位置和想法（不重置）
                if (cardData.characters[charName]?.当前状态) {
                  if (currentLocation) cardData.characters[charName].当前状态.所在地点 = currentLocation;
                  if (currentThought) cardData.characters[charName].当前状态.内心想法 = currentThought;
                }
              } else {
                // 角色在模板中存在但不在当前 state 中，添加
                cardData.characters[charName] = deepClone(charTemplate);
              }
            }
          }
        } catch { /* 模板加载失败不影响主流程 */ }
      }
    }
  }

  function saveStateNow(): void {
    const p = getStatePath();
    mkdirSync(stateDir, { recursive: true });
    state["_meta"] = {
      ...(state["_meta"] || {}),
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");

    // ⭐ state.json 作为只读模板，不再写回卡片目录
    // 动态数据通过 session 历史中的 rp-state 快照持久化

    pendingSave = false;
  }

  function saveState(immediate = false): void {
    if (immediate) {
      if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
      saveStateNow();
      return;
    }
    pendingSave = true;
    if (!saveStateTimer) {
      saveStateTimer = setTimeout(() => {
        saveStateTimer = null;
        if (pendingSave) saveStateNow();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  function flushAll(): void {
    clearTimers();
    if (pendingSave) saveStateNow();
    flushHistoryNow();
  }

  // ===== 历史记录 =====

  function flushHistoryNow(): void {
    if (historyBuffer.length === 0) return;
    const p = getHistoryPath();
    mkdirSync(stateDir, { recursive: true });
    const batch = historyBuffer.map(r => JSON.stringify(r) + "\n").join("");
    appendFileSync(p, batch, "utf-8");
    historyBuffer = [];
  }

  function appendHistory(record: HistoryRecord): void {
    historyBuffer.push(record);
    if (historyBuffer.length >= HISTORY_FLUSH_SIZE) {
      flushHistoryNow();
    } else if (!historyFlushTimer) {
      historyFlushTimer = setTimeout(() => {
        historyFlushTimer = null;
        flushHistoryNow();
      }, HISTORY_FLUSH_INTERVAL);
    }
  }

  function getState(): Record<string, any> {
    return state;
  }

  function setState(newState: Record<string, any>): void {
    state = newState;
  }

  // ===== 多卡片状态访问 =====

  /**
   * 获取指定卡片的状态
   */
  function getCardState(cardId: string): CardState | null {
    const cardStates = state.cardStates;
    if (!cardStates) return null;
    return cardStates[cardId] || null;
  }

  /**
   * 获取指定卡片的角色状态
   */
  function getCardCharacter(cardId: string, charName: string): Record<string, any> | null {
    const card = getCardState(cardId);
    if (!card) return null;
    return card.characters[charName] || null;
  }

  /**
   * 更新指定卡片中角色的字段
   */
  function updateCardCharacter(cardId: string, charName: string, updates: Record<string, any>): boolean {
    const card = getCardState(cardId);
    if (!card) return false;
    if (!card.characters[charName]) {
      card.characters[charName] = updates as any;
    } else {
      Object.assign(card.characters[charName], updates);
    }
    return true;
  }

  /**
   * 获取所有卡片的所有角色名（扁平列表）
   */
  function getAllCharacterNames(): { cardId: string; name: string }[] {
    const result: { cardId: string; name: string }[] = [];
    const cardStates = state.cardStates;
    if (!cardStates) return result;
    for (const [cardId, card] of Object.entries(cardStates as Record<string, CardState>)) {
      for (const name of Object.keys(card.characters)) {
        result.push({ cardId, name });
      }
    }
    return result;
  }

  function saveSessionSnapshot(pi: any): void {
    try {
      pi.appendEntry("rp-state", { snapshot: deepClone(state), timestamp: Date.now() });
    } catch {}
  }

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

  return {
    setDirectories,
    loadState,
    saveState,
    flushAll,
    appendHistory,
    getState,
    setState,
    getCardState,
    getCardCharacter,
    updateCardCharacter,
    getAllCharacterNames,
    saveSessionSnapshot,
    reconstructFromSession,
    getHistoryPath,
  };
}
