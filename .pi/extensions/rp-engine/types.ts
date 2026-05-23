/**
 * RP Engine - 共享类型定义
 */

export interface WorldState {
  当前日期: string;
  当前星期: string;
  当前时间: string;
  当前位置: string;
}

export interface CharacterState {
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

export interface HistoryRecord {
  timestamp: string;
  char: string;
  field: string;
  oldValue: any;
  newValue: any;
}

/** 核心追踪角色列表（已弃用，保留兼容旧格式 state.json） */
export const CORE_CHARS: string[] = [];

// ============================================================
// 卡片管理器相关类型
// ============================================================

/** 单张卡片条目 */
export interface CardEntry {
  id: string;           // 卡片目录名（唯一标识）
  dir: string;          // 卡片目录绝对路径
  imported_at: string;  // ISO 时间戳
}

/** 卡片注册表结构 */
export interface CardRegistry {
  cards: Record<string, CardEntry>;
  active: string[];     // 当前激活的卡片 id 列表（支持多卡并存）
}

/** 世界书条目（带来源卡片标记） */
export interface WorldbookFileEntry {
  /** 文件相对路径（如 "世界观/天作之合.md"） */
  file: string;
  /** 文件内容 */
  content: string;
  /** 命中关键词数（用于优先级排序） */
  hitCount: number;
  /** 内容 token 估算 */
  tokenEstimate: number;
  /** 来源卡片 id */
  sourceCard: string;
}

/** 卡片状态（state.json 中 cardStates 的值） */
export interface CardState {
  /** 卡片元信息 */
  meta: {
    name: string;
    route: string;
    started: boolean;
  };
  /** 该卡片的角色状态 */
  characters: Record<string, CharacterState>;
  /** 该卡片的世界状态（可覆盖全局） */
  world?: Partial<WorldState>;
  /** 卡片特有标记 */
  flags: Record<string, any>;
}
