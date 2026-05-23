/**
 * RP Engine - 工具注册（read_state, update_state, advance_time, load_worldbook）
 *
 * 每个工具定义为独立对象，通过 ToolRegistry 收集后批量注册到 pi API。
 * 后续加新工具只需：① 在此文件或新文件中定义 ② 加入 toolRegistry.register()。
 */

import { Type } from "typebox";
import type { WorldState, CharacterState, HistoryRecord } from "./types";
import { getNested, setNested, clamp } from "./utils";
import { findWorldbookFiles, findWorldbookFilesMulti } from "./worldbook";
import { getActiveCardIds } from "./card-manager";
import { processPeriodicEvents } from "./periodic-events";
import { ToolRegistry, type ToolDefinition } from "./registry";

/**
 * 创建所有工具定义，返回注册表
 */
export function createToolRegistry(
  getState: () => Record<string, any>,
  saveState: () => void,
  appendHistory: (record: HistoryRecord) => void,
  getWorldbookDirs: () => string[],
  getVariableSchemas?: () => Record<string, Record<string, Record<string, string>>> // cardId → charName → fieldName → type
): ToolRegistry {
  const registry = new ToolRegistry();
  const stateRef = getState; // 每次执行时重新获取 state 引用

  // --------------------------------------------------
  // 1. read_state - 读取角色状态
  // --------------------------------------------------
  registry.register({
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
      const state = stateRef();
      let charData = state[params.char];
      let sourceCardId = "";

      // 顶层找不到则遍历 cardStates 查找（多卡片隔离）
      if (!charData && state.cardStates) {
        for (const [cardId, cardData] of Object.entries(state.cardStates as Record<string, any>)) {
          const chars = cardData.characters || {};
          if (chars[params.char]) {
            charData = chars[params.char];
            sourceCardId = cardId;
            break;
          }
        }
      }

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
          details: { char: params.char, cardId: sourceCardId, fields: result },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(charData, null, 2) }],
        details: { char: params.char, cardId: sourceCardId, data: charData },
      };
    },
  });

  // --------------------------------------------------
  // 2. update_state - 更新角色状态
  // --------------------------------------------------
  registry.register({
    name: "update_state",
    label: "更新状态",
    description: "更新指定角色的状态变量。updates 为键值对，键是字段路径（如 归属值、背德值），值是新值。归属值自动钳制 0-100 并同步情分值。其他变量根据卡片的 variable_schema.json 校验类型。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名" }),
      updates: Type.Record(Type.String(), Type.Any(), { description: "要更新的字段路径→新值" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = stateRef();
      let charData = state[params.char];
      let sourceCardId = "";

      // 顶层找不到则遍历 cardStates 查找（多卡片隔离）
      if (!charData && state.cardStates) {
        for (const [cardId, cardData] of Object.entries(state.cardStates as Record<string, any>)) {
          const chars = cardData.characters || {};
          if (chars[params.char]) {
            charData = chars[params.char];
            sourceCardId = cardId;
            break;
          }
        }
      }

      if (!charData) {
        return {
          content: [{ type: "text", text: `角色 "${params.char}" 不存在` }],
          details: { error: `角色 ${params.char} 不存在` },
        };
      }

      // 加载变量 Schema（按 sourceCardId 隔离）
      const varSchemas = getVariableSchemas ? getVariableSchemas() : {};
      // 按 cardId 查找该角色的 schema
      let charSchema: Record<string, string> = {};
      if (sourceCardId && varSchemas[sourceCardId]) {
        charSchema = varSchemas[sourceCardId][params.char] || {};
      } else {
        // 兜底：遍历所有卡片找
        for (const [, cardSchemas] of Object.entries(varSchemas)) {
          if (cardSchemas[params.char]) {
            charSchema = cardSchemas[params.char];
            break;
          }
        }
      }

      const historyRecords: HistoryRecord[] = [];
      const timestamp = new Date().toISOString();

      for (const [path, value] of Object.entries(params.updates)) {
        const oldValue = getNested(charData, path);
        let newValue: any = value;

        // 归属值：通用钳制 0-100，同步情分值
        if (path === "归属值") {
          newValue = clamp(Number(newValue), 0, 100);
          setNested(charData, "归属值", newValue);
          charData["情分值"] = 100 - newValue;
          historyRecords.push({ timestamp, char: params.char, field: "归属值", oldValue, newValue });
          historyRecords.push({ timestamp, char: params.char, field: "情分值", oldValue: charData["情分值"], newValue: 100 - newValue });
          continue;
        }

        // 根据 variable_schema.json 动态校验类型
        const varType = charSchema[path];
        if (varType === "number") {
          const num = Number(newValue);
          if (isNaN(num)) continue; // 不是数字，跳过
          // 特殊字段范围：背德值 0-200，欲望值 0-200
          if (path === "背德值" || path === "欲望值") {
            newValue = clamp(num, 0, 200);
          } else {
            newValue = num;
          }
        } else if (varType === "boolean") {
          newValue = Boolean(newValue);
        } else if (varType === "string") {
          newValue = String(newValue);
        }
        // 未知类型直接透传（向后兼容旧字段）

        setNested(charData, path, newValue);
        historyRecords.push({ timestamp, char: params.char, field: path, oldValue, newValue });
      }

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

  // --------------------------------------------------
  // 3. advance_time - 推进时间
  // --------------------------------------------------
  registry.register({
    name: "advance_time",
    label: "推进时间",
    description: "推进游戏内时间。days 为推进天数（1-30）。会自动触发周期事件（花开蒂落检查、生理结算、秘密派对）。",
    parameters: Type.Object({
      days: Type.Integer({ description: "推进的天数", minimum: 1, maximum: 30 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = stateRef();
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

      currentDate.setDate(currentDate.getDate() + params.days);
      const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
      world.当前日期 = currentDate.toISOString().slice(0, 10);
      world.当前星期 = weekdays[currentDate.getDay()];

      const events = processPeriodicEvents(state, params.days, appendHistory);
      saveState();

      const eventText = events.length > 0 ? `\n\n## 周期事件\n${events.join("\n")}` : "";

      return {
        content: [{
          type: "text",
          text: `⏰ 时间推进至 ${world.当前日期} ${world.当前星期}${eventText}`,
        }],
        details: { newDate: world.当前日期, events },
      };
    },
  });

  // --------------------------------------------------
  // 4. load_worldbook - 加载世界书（支持按卡片过滤）
  // --------------------------------------------------
  registry.register({
    name: "load_worldbook",
    label: "加载世界书",
    description: "按关键字从世界书中加载设定条目。keyword 可以是角色名、概念名（如 花开蒂落、天作之合）。可选 cardId 过滤指定卡片（不提供则搜索所有激活卡片）。",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词" }),
      cardId: Type.Optional(Type.String({ description: "限定卡片 id，不填则搜索所有激活卡片" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const dirs = getWorldbookDirs();
      if (dirs.length === 0) {
        return {
          content: [{ type: "text", text: "世界书目录未就绪。请先激活至少一张角色卡。" }],
          details: { error: "无世界书目录" },
        };
      }

      const results = findWorldbookFilesMulti(params.keyword, dirs, params.cardId);
      if (results.length === 0) {
        const activeIds = getActiveCardIds();
        const hint = params.cardId
          ? `在卡片 "${params.cardId}" 中`
          : `在当前 ${activeIds.length} 张激活卡片中`;
        return {
          content: [{ type: "text", text: `${hint}未找到与 "${params.keyword}" 相关的世界书条目` }],
          details: { keyword: params.keyword, cardId: params.cardId, count: 0 },
        };
      }

      const text = results
        .slice(0, 5)
        .map((r) => `--- [${r.sourceCard}] ${r.file} ---\n${r.content.slice(0, 3000)}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: {
          keyword: params.keyword,
          cardId: params.cardId,
          files: results.map((r) => ({ sourceCard: r.sourceCard, file: r.file })),
          count: results.length,
        },
      };
    },
  });

  return registry;
}

// 保留旧的 registerTools 导出以兼容
export { createToolRegistry as registerTools };
