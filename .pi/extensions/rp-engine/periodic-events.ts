/**
 * RP Engine - 周期事件处理
 * 
 * 花开蒂落检查、生理期结算、秘密派对等周期事件。
 */

import type { WorldState, CharacterState, HistoryRecord } from "./types";
import { clamp } from "./utils";

/**
 * 处理周期事件，返回事件描述字符串数组
 */
export function processPeriodicEvents(
  state: Record<string, any>,
  daysPassed: number,
  appendHistory: (record: HistoryRecord) => void
): string[] {
  const events: string[] = [];
  const world = state["世界"] as WorldState;
  if (!world) return events;

  const currentDate = new Date(world.当前日期);
  if (isNaN(currentDate.getTime())) return events;

  // 动态获取所有角色（排除非角色键）
  const charNames = Object.keys(state).filter(k => k !== '世界' && k !== '{{user}}' && k !== '_meta' && k !== 'global' && k !== 'cardStates');
  for (const name of charNames) {
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
