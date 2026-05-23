/**
 * RP Engine - 卡片管理器
 *
 * 统一管理角色卡片的导入、激活、状态。
 * 读取 registry.json，提供激活卡片列表、获取卡片路径等功能。
 * 后续所有模块都从这里获取当前生效的卡片信息。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { CardRegistry, CardEntry } from "./types";

// ============================================================
// 全局状态
// ============================================================

/** registry.json 的绝对路径 */
let registryPath = "";

/** 项目根目录（cwd） */
let projectCwd = "";

/** 内存缓存的注册表 */
let cachedRegistry: CardRegistry | null = null;

// ============================================================
// 初始化
// ============================================================

/**
 * 初始化卡片管理器
 * @param cwd 项目根目录
 */
export function initCardManager(cwd: string): void {
  projectCwd = cwd;
  registryPath = join(cwd, ".pi", "cards", "registry.json");
  cachedRegistry = null; // 强制重新读取
}

// ============================================================
// 注册表读写
// ============================================================

/**
 * 读取并缓存 registry.json
 */
export function getRegistry(): CardRegistry {
  if (cachedRegistry) return cachedRegistry;

  if (!existsSync(registryPath)) {
    cachedRegistry = { cards: {}, active: [] };
    return cachedRegistry;
  }

  try {
    const raw = readFileSync(registryPath, "utf-8");
    const parsed = JSON.parse(raw);

    // 兼容旧格式：active 可能是字符串
    const active = Array.isArray(parsed.active)
      ? parsed.active
      : (parsed.active ? [parsed.active] : []);

    cachedRegistry = {
      cards: parsed.cards || {},
      active,
    };
  } catch {
    cachedRegistry = { cards: {}, active: [] };
  }

  return cachedRegistry;
}

/**
 * 保存注册表到磁盘
 */
export function saveRegistry(registry: CardRegistry): void {
  const dir = join(projectCwd, ".pi", "cards");
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  cachedRegistry = registry;
}

// ============================================================
// 激活卡片查询
// ============================================================

/**
 * 获取当前激活的卡片 id 列表
 */
export function getActiveCardIds(): string[] {
  const reg = getRegistry();
  return [...reg.active];
}

/**
 * 获取当前激活的卡片条目列表
 */
export function getActiveCards(): CardEntry[] {
  const reg = getRegistry();
  return reg.active
    .map((id) => reg.cards[id])
    .filter((c): c is CardEntry => c !== undefined);
}

/**
 * 获取激活卡片的世界书目录
 * @returns 世界书目录绝对路径数组
 */
export function getCardWorldbookDirs(): string[] {
  const cards = getActiveCards();
  return cards.map((card) => join(card.dir, "worldbook")).filter((d) => existsSync(d));
}

/**
 * 获取激活卡片的角色名列表
 * 从每个卡片的 state.json 中提取角色名
 */
export function getActiveCardCharacterNames(): { cardId: string; names: string[] }[] {
  const cards = getActiveCards();
  return cards.map((card) => {
    const statePath = join(card.dir, "state.json");
    const names: string[] = [];
    if (existsSync(statePath)) {
      try {
        const cardState = JSON.parse(readFileSync(statePath, "utf-8"));
        // 提取顶级角色名（排除 _meta、世界 等元数据键）
        for (const key of Object.keys(cardState)) {
          if (key.startsWith("_") || key === "世界" || key === "{{user}}") continue;
          if (typeof cardState[key] === "object" && cardState[key]?.基本信息?.姓名) {
            names.push(key);
          }
        }
      } catch { /* 忽略解析错误 */ }
    }
    return { cardId: card.id, names };
  });
}

/**
 * 获取指定卡片的 worldbook 目录
 */
export function getCardWorldbookDir(cardId: string): string | null {
  const reg = getRegistry();
  const card = reg.cards[cardId];
  if (!card) return null;
  const dir = join(card.dir, "worldbook");
  return existsSync(dir) ? dir : null;
}

// ============================================================
// 卡片切换
// ============================================================

/**
 * 激活卡片（添加到活跃列表）
 * @param cardIds 要激活的卡片 id 数组
 * @returns 实际激活的卡片 id 列表
 */
export function activateCards(cardIds: string[]): string[] {
  const reg = getRegistry();
  const validIds: string[] = [];

  for (const id of cardIds) {
    if (reg.cards[id]) {
      if (!reg.active.includes(id)) {
        reg.active.push(id);
      }
      validIds.push(id);
    }
  }

  saveRegistry(reg);
  return validIds;
}

/**
 * 取消激活卡片（从活跃列表移除）
 * @param cardIds 要取消激活的卡片 id 数组
 */
export function deactivateCards(cardIds: string[]): void {
  const reg = getRegistry();
  reg.active = reg.active.filter((id) => !cardIds.includes(id));
  saveRegistry(reg);
}

/**
 * 仅激活单张卡片（清空其他）
 */
export function setActiveCard(cardId: string): boolean {
  const reg = getRegistry();
  if (!reg.cards[cardId]) return false;
  reg.active = [cardId];
  saveRegistry(reg);
  return true;
}

/**
 * 获取卡片名称（优先从 config.json 读取）
 */
export function getCardName(cardId: string): string {
  const reg = getRegistry();
  const card = reg.cards[cardId];
  if (!card) return cardId;

  const configPath = join(card.dir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.character?.name) return config.character.name;
    } catch { /* 忽略 */ }
  }

  // 回退：用目录名
  return basename(card.dir);
}
