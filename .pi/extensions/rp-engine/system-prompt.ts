/**
 * RP Engine - 系统提示构建（多卡片支持版）
 *
 * 负责构建注入到 AI 对话的系统提示，包含：
 * - 动态读取激活卡片的世界观和角色信息
 * - Token 预算管理（世界书内容硬上限 1500 token）
 * - Author Note 注入
 * - 多卡片融合提示
 */

import type { WorldState, CharacterState, CardState } from "./types";
import { readWorldbookIndexMulti, estimateTokens, MAX_WORLDBOOK_TOKENS } from "./worldbook";
import { AuthorNote } from "./author-note";
import { getActiveCards, getCardName } from "./card-manager";

// ============================================================
// Token 预算常量
// ============================================================

const WORLD_BOOK_TOKEN_LIMIT = MAX_WORLDBOOK_TOKENS;

// ============================================================
// 世界书 Token 预算控制
// ============================================================

/**
 * 对世界书索引按 token 预算进行截断
 */
function truncateWorldbookToBudget(indexText: string): string {
  if (!indexText) return "";

  const tokens = estimateTokens(indexText);
  if (tokens <= WORLD_BOOK_TOKEN_LIMIT) return indexText;

  const ratio = WORLD_BOOK_TOKEN_LIMIT / tokens;
  const targetChars = Math.floor(indexText.length * ratio);

  const truncated = indexText.slice(0, targetChars);
  const lastNewline = truncated.lastIndexOf("\n\n");
  const cutPoint = lastNewline > 0 ? lastNewline : targetChars;

  return truncated.slice(0, cutPoint) + "\n\n(世界书索引已截断，超出 token 预算)";
}

// ============================================================
// 角色状态概要构建
// ============================================================

/**
 * 从卡片状态中构建角色状态概要
 */
function buildCharacterSummary(cardId: string, card: CardState): string {
  const lines: string[] = [];
  const charNames = Object.keys(card.characters);

  if (charNames.length === 0) return "";

  lines.push(`### ${card.meta.name || cardId} (${charNames.length} 个角色)`);

  // 限制最多显示 15 个角色
  const displayNames = charNames.slice(0, 15);
  for (const name of displayNames) {
    const char = card.characters[name] as CharacterState;
    if (!char) continue;
    const flower = char.花开蒂落?.触发状态 ? "🌸" : "🌱";
    const preg = char.生理状态?.怀孕状态 || "未怀孕";
    const belong = char.归属值 ?? 0;
    const affection = char.情分值 ?? 100;
    lines.push(`  - ${char.基本信息?.姓名 || name}: 归属=${belong} 情分=${affection} ${flower} 孕=${preg}`);
  }

  if (charNames.length > 15) {
    lines.push(`  ... 及其他 ${charNames.length - 15} 个角色`);
  }

  return lines.join("\n");
}

// ============================================================
// 多卡片融合描述
// ============================================================

/**
 * 生成多卡片融合时的场景描述
 */
function buildFusionDescription(cardIds: string[]): string {
  if (cardIds.length <= 1) return "";

  const names = cardIds.map((id) => getCardName(id));
  const fusionMsg = `\n## 🌐 跨世界融合模式
当前同时激活 ${cardIds.length} 个世界：${names.join("、")}。
这是一个跨界相遇的故事，不同世界的角色因为某种事件交织在一起。
请合理安排各世界角色的出场，注意世界观之间的差异和融合点。
`;

  return fusionMsg;
}

// ============================================================
// 系统提示构建
// ============================================================

/**
 * 构建注入到 AI 对话的系统提示（多卡片版）
 *
 * @param state 当前世界/角色状态（新格式：含 global + cardStates）
 * @param worldbookDirs 世界书目录路径数组
 * @param authorNote AuthorNote 实例
 * @returns 完整的系统提示文本
 */
export function buildSystemPrompt(
  state: Record<string, any>,
  worldbookDirs: string | string[],
  authorNote?: AuthorNote
): string {
  // 兼容处理
  const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];

  // 读取世界状态（新格式：state.global.世界；旧格式：state.世界）
  const world: WorldState | undefined =
    (state.global?.["世界"]) || state["世界"];

  // 世界书索引：多目录合并 + Token 预算截断
  const rawIndex = dirs.length > 0 ? readWorldbookIndexMulti(dirs) : "";
  const index = truncateWorldbookToBudget(rawIndex);

  // 获取激活卡片信息
  const activeCards = getActiveCards();
  const activeCardIds = activeCards.map((c) => c.id);

  let prompt = `# 角色扮演模式\n\n`;

  // 全局世界状态
  prompt += `## 当前世界状态
- 日期: ${world?.当前日期 || "未知"} ${world?.当前星期 || ""}
- 时间: ${world?.当前时间 || ""}
- 位置: ${world?.当前位置 || ""}
`;

  // 激活卡片概览
  if (activeCardIds.length > 0) {
    prompt += `\n## 已加载世界/角色卡 (${activeCardIds.length})\n`;
    for (const card of activeCards) {
      const name = getCardName(card.id);
      prompt += `- **${name}** (${card.id})\n`;
    }
  }

  // 多卡片融合提示
  if (activeCards.length > 1) {
    prompt += buildFusionDescription(activeCardIds);
  }

  // 世界书索引
  if (index) {
    prompt += `\n## 世界书索引（简要）\n${index.slice(0, 2500)}\n`;
  } else {
    prompt += `\n## 世界书索引\n（世界书未加载，使用 load_worldbook 工具按需查询）\n`;
  }

  // 核心角色状态概要
  prompt += `\n## 核心角色当前状态概要\n`;

  const cardStates = state.cardStates;
  if (cardStates && typeof cardStates === "object") {
    // 新格式：遍历所有卡片状态
    let hasChars = false;
    for (const [cardId, card] of Object.entries(cardStates as Record<string, CardState>)) {
      const summary = buildCharacterSummary(cardId, card);
      if (summary) {
        prompt += summary + "\n";
        hasChars = true;
      }
    }
    if (!hasChars) {
      prompt += "（暂无角色状态）\n";
    }
  } else {
    // 旧格式兼容：直接遍历顶层角色
    const CORE_CHARS = ["夏小雀", "宁正棠", "江璃", "许知意", "林初夏", "凌晓青"];
    for (const name of CORE_CHARS) {
      const char = state[name] as CharacterState;
      if (!char) continue;
      const flower = char.花开蒂落?.触发状态 ? "🌸已花开" : "🌱未触发";
      const preg = char.生理状态?.怀孕状态 || "未怀孕";
      prompt += `- ${char.基本信息?.姓名 || name}: 归属值=${char.归属值} 情分值=${char.情分值} ${flower} 怀孕=${preg}\n`;
    }
  }

  // 角色扮演规则
  prompt += `
## 角色扮演规则
1. 严格按世界书设定行事，不自行编造
2. 使用 read_state 工具检查角色状态（可指定 cardId 参数）
3. 每次回复结束时必须使用 update_state 工具更新相关角色的状态：
   - 归属值：正面互动 +1~5，负面互动 -1~5，重大事件 +5~15
   - 情分值：归属值上升时自动同步（情分值 = 100 - 归属值）
   - 当前状态.内心想法：更新角色在当前情境下的想法
   - 当前状态.所在地点：如果位置发生变化
   - 每次回复至少更新一个角色的归属值（推进关系）
4. 使用 load_worldbook 工具按需加载设定（可加 cardId 过滤）
5. 使用 advance_time 工具推进时间
6. 输出格式参考格式指令目录下的文件

## 输出长度要求
每次回复的正文（<content> 标签内）必须达到 **800-1200 字**。
请严格遵守，不要因为对话轮次增多而缩短篇幅。
这是硬性要求，不受上下文长度影响。
`;

  // Author Note 注入
  if (authorNote) {
    const noteText = authorNote.getInjectionText();
    prompt += `\n## 作者注\n${noteText}\n`;
  }

  return prompt;
}

/**
 * 构建用于周期性注入的系统提示（精简版，不含世界书索引）
 */
export function buildCompactSystemPrompt(
  state: Record<string, any>,
  authorNote?: AuthorNote
): string {
  const world: WorldState | undefined =
    (state.global?.["世界"]) || state["世界"];

  let prompt = `[系统 · 状态刷新] 📅 ${world?.当前日期 || "?"} ${world?.当前星期 || ""} 🕐 ${world?.当前时间 || ""} 📍 ${world?.当前位置 || ""}\n`;

  // 遍历所有卡片的所有角色
  const cardStates = state.cardStates;
  if (cardStates && typeof cardStates === "object") {
    for (const [cardId, card] of Object.entries(cardStates as Record<string, CardState>)) {
      const cardName = card.meta?.name || cardId;
      prompt += `\n## ${cardName}\n`;
      for (const [name, charData] of Object.entries(card.characters)) {
        const char = charData as CharacterState;
        if (!char?.基本信息) continue;
        const flower = char.花开蒂落?.触发状态 ? "🌸" : "🌱";
        const loc = char.当前状态?.所在地点 || "?";
        prompt += `- ${char.基本信息.姓名 || name}: ${flower}归属=${char.归属值} 情分=${char.情分值} 📍${loc}\n`;
      }
    }
  } else {
    // 旧格式兼容
    const CORE_CHARS = ["夏小雀", "宁正棠", "江璃", "许知意", "林初夏", "凌晓青"];
    for (const name of CORE_CHARS) {
      const char = state[name] as CharacterState;
      if (!char) continue;
      const flower = char.花开蒂落?.触发状态 ? "🌸" : "🌱";
      const loc = char.当前状态?.所在地点 || "?";
      prompt += `- ${char.基本信息?.姓名 || name}: ${flower}归属=${char.归属值} 情分=${char.情分值} 📍${loc}\n`;
    }
  }

  prompt += `\n规则提醒：read_state 检查状态 → load_worldbook 加载设定 → 动笔 → update_state 更新状态`;

  if (authorNote) {
    prompt += `\n\n${authorNote.getInjectionText()}`;
  }

  return prompt;
}
