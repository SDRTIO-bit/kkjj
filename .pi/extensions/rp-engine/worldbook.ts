/**
 * RP Engine - 世界书加载与主动注入(多卡片支持版)
 *
 * 提供世界书搜索、索引读取,以及基于上下文的主动注入机制:
 * - 支持多目录(来自不同卡片的世界书合并搜索)
 * - 关键词匹配搜索 + 来源卡片标记
 * - Token 预算控制(硬上限 1500 token)
 * - 条目去重(基于「来源卡片 + 文件路径」的 Set 追踪)
 * - 优先级排序(命中关键词越多越靠前)
 * - 冲突检测(不同卡片包含同名关键词时记录)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

// ============================================================
// Token 估算(独立实现,与 system-prompt.ts 保持一致)
// ============================================================

/** 中文文本 token 估算比率:1 token ≈ 1.5 个字符 */
const CN_CHARS_PER_TOKEN = 1.5;

/** 世界书主动注入的 token 硬上限 */
export const MAX_WORLDBOOK_TOKENS = 1500;

/**
 * 估算文本的 token 数量
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cnChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      cnChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cnChars / CN_CHARS_PER_TOKEN + otherChars / 4);
}

// ============================================================
// 搜索目录常量
// ============================================================

/** 世界书的搜索子目录(按优先级排序) */
const SEARCH_DIRS = ["世界观", "角色设定", "身体演化", "格式指令"];

// ============================================================
// 条目去重(按来源卡片 + 文件路径 联合去重)
// ============================================================

/** 去重 key = "cardId::filePath" */
function dedupKey(cardId: string, filePath: string): string {
  return `${cardId}::${filePath}`;
}

/**
 * 已注入条目追踪器
 */
class InjectedEntriesTracker {
  private injected: Set<string> = new Set();

  isInjected(cardId: string, filePath: string): boolean {
    return this.injected.has(dedupKey(cardId, filePath));
  }

  mark(cardId: string, filePath: string): void {
    this.injected.add(dedupKey(cardId, filePath));
  }

  markAll(entries: { cardId: string; file: string }[]): void {
    for (const e of entries) this.injected.add(dedupKey(e.cardId, e.file));
  }

  reset(): void {
    this.injected.clear();
  }

  get size(): number {
    return this.injected.size;
  }

  get all(): string[] {
    return Array.from(this.injected);
  }
}

/** 全局已注入条目追踪器实例 */
const injectedTracker = new InjectedEntriesTracker();

export function resetInjectedEntries(): void {
  injectedTracker.reset();
}

export function getInjectedTracker(): InjectedEntriesTracker {
  return injectedTracker;
}

// ============================================================
// 世界书条目类型(带来源卡片标记)
// ============================================================

/** 世界书搜索结果(带卡片来源) */
export interface WorldbookEntry {
  /** 文件相对路径(如 "世界观/天作之合.md") */
  file: string;
  /** 文件内容 */
  content: string;
  /** 命中关键词数(用于优先级排序) */
  hitCount: number;
  /** 内容 token 估算 */
  tokenEstimate: number;
  /** 来源卡片 id */
  sourceCard: string;
  /** 来源卡片名称 */
  sourceCardName: string;
}

// ============================================================
// 冲突检测类型
// ============================================================

/** 冲突记录 */
export interface WorldbookConflict {
  /** 关键词 */
  keyword: string;
  /** 冲突涉及的卡片 */
  cards: string[];
  /** 各卡片中匹配到的文件 */
  files: { cardId: string; file: string }[];
}

// ============================================================
// 动态关键词索引(按卡片隔离)
// ============================================================

/**
 * 倒排索引:关键词 -> 匹配的文件列表
 * 每张卡片独立维护一份,避免串卡
 */
interface KeywordIndex {
  map: Map<string, { cardId: string; file: string; priority: number }[]>;
  cardId: string;
}

/** 按卡片 id 隔离的索引集合 */
const cardKeywordIndexes: Map<string, KeywordIndex> = new Map();

/**
 * 从 yaml front matter 中解析 keywords 数组
 * 格式:keywords: ["词1", "词2"]
 */
function parseYamlKeywords(content: string): string[] {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const yaml = match[1];
  const kwMatch = yaml.match(/^keywords:\s*\[([^\]]*)\]/m);
  if (!kwMatch) return [];
  return kwMatch[1]
    .split(",")
    .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * 从 yaml front matter 中解析 name 字段
 */
function parseYamlName(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return "";
  const yaml = match[1];
  const nameMatch = yaml.match(/^name:\s*["']?([^"']+)["']?/m);

  return nameMatch ? nameMatch[1].trim() : "";
}

/**
 * 从文件名中提取关键词
 * - 去掉 .md 后缀
 * - 按常见分隔符拆分
 * - 去掉前缀分类词
 */
function extractKeywordsFromFileName(fileName: string): string[] {
  const withoutExt = fileName.replace(/\.md$/, "");
  const cleaned = withoutExt.replace(
    /^(世界观|世界观纯爱线|归属值|情分值|角色设定|身体演化|格式指令|角色 - |亲密行为设定 - |性爱规则 - |选开 - )\s*/g,
    ""
  );
  const parts = cleaned.split(/[\s\-·、,,]+/).filter(Boolean);
  return [...new Set([cleaned, ...parts])];
}

/**
 * 为单张卡片构建关键词倒排索引
 */
function buildKeywordIndexForCard(cardDir: string, cardId: string): KeywordIndex {
  const index: KeywordIndex = { map: new Map(), cardId };
  const wbDir = join(cardDir, "worldbook");
  if (!existsSync(wbDir)) return index;

  for (const subDir of SEARCH_DIRS) {
    const fullDir = join(wbDir, subDir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const f of readdirSync(fullDir)) {
        if (!f.endsWith(".md")) continue;
        const filePath = subDir + "/" + f;
        const content = readFileSync(join(fullDir, f), "utf-8");

        const yamlKeywords = parseYamlKeywords(content);
        const yamlName = parseYamlName(content);
        const fileNameKeywords = extractKeywordsFromFileName(f);

        const allKeywords = [...new Set([
          ...yamlKeywords,
          ...(yamlName ? [yamlName] : []),
          ...fileNameKeywords,
        ].filter(Boolean))];

        for (const kw of allKeywords) {
          if (!index.map.has(kw)) index.map.set(kw, []);
          index.map.get(kw)!.push({ cardId, file: filePath, priority: 0 });
        }
      }
    } catch { /* skip unreadable dirs */ }
  }
  return index;
}

/**
 * 为所有激活卡片构建关键词索引
 * 在 session_start 时调用
 */
export function buildAllCardIndexes(cardDirs: { id: string; dir: string }[]): void {
  cardKeywordIndexes.clear();
  for (const { id, dir } of cardDirs) {
    const idx = buildKeywordIndexForCard(dir, id);
    if (idx.map.size > 0) cardKeywordIndexes.set(id, idx);
  }
  const totalKeys = [...cardKeywordIndexes.values()].reduce(
    (sum, idx) => sum + idx.map.size, 0
  );
  console.log("[Worldbook] 关键词索引已构建: " + cardKeywordIndexes.size + " 张卡片, " + totalKeys + " 个关键词");
}

/**
 * 从文本中提取可用于匹配世界书的核心关键词
 * 从所有激活卡片的关键词索引中动态匹配,不再硬编码
 */
function extractKeywords(text: string): string[] {
  if (!text) return [];
  const allKeys = new Set<string>();
  for (const idx of cardKeywordIndexes.values()) {
    for (const kw of idx.map.keys()) allKeys.add(kw);
  }
  if (allKeys.size === 0) return [];
  const keywords: string[] = [];
  for (const kw of allKeys) {
    if (text.includes(kw)) keywords.push(kw);
  }
  return keywords;
}

// ============================================================
// 从目录名推断卡片 id
// ============================================================

/**
 * 从 worldbook 目录路径推断卡片 id
 * 目录结构: .pi/cards/<cardId>/worldbook
 */
function inferCardIdFromWorldbookDir(worldbookDir: string): string {
  const parent = basename(join(worldbookDir, ".."));
  return parent;
}

/**
 * 从卡片目录路径获取卡片名
 */
function getCardNameFromDir(cardDir: string): string {
  const configPath = join(cardDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.character?.name) return config.character.name;
    } catch { /* 忽略 */ }
  }
  return basename(cardDir);
}

// ============================================================
// 多目录世界书搜索
// ============================================================

/**
 * 按关键词搜索世界书文件(多目录版)
 * 返回每个命中的关键词数量及来源卡片
 *
 * @param keywords 搜索关键词数组
 * @param worldbookDirs 世界书根目录数组(来自不同卡片)
 * @returns 搜索结果(含命中计数和来源卡片)
 */
function searchWorldbookMultiDir(
  keywords: string[],
  worldbookDirs: string[]
): WorldbookEntry[] {
  const results: WorldbookEntry[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;

    const cardId = inferCardIdFromWorldbookDir(worldbookDir);
    const cardDir = join(worldbookDir, "..");
    const cardName = getCardNameFromDir(cardDir);

    for (const dir of SEARCH_DIRS) {
      const fullDir = join(worldbookDir, dir);
      if (!existsSync(fullDir)) continue;

      try {
        for (const f of readdirSync(fullDir)) {
          if (!f.endsWith(".md")) continue;

          const fileName = f.replace(".md", "");
          const filePath = `${dir}/${f}`;
          let hitCount = 0;

          // 对每个关键词检查文件名是否匹配
          for (const kw of keywords) {
            if (!kw) continue;
            if (fileName.includes(kw)) {
              hitCount++;
              continue;
            }
            // 去除常见前缀后匹配
            const shortName = fileName.replace(
              /^(世界观|世界观纯爱线|归属值|情分值|\[世界观\]|\[世界观纯爱线\]|\[控制器\]|\[档案\]|\[变量\]|\[指南\])\s*/g,
              ""
            ).trim();
            if (shortName.includes(kw)) {
              hitCount++;
            }
          }

          if (hitCount > 0) {
            const content = readFileSync(join(fullDir, f), "utf-8");
            results.push({
              file: filePath,
              content,
              hitCount,
              tokenEstimate: estimateTokens(content),
              sourceCard: cardId,
              sourceCardName: cardName,
            });
          }
        }
      } catch { /* 跳过无法读取的目录 */ }
    }
  }

  return results;
}

// ============================================================
// 冲突检测
// ============================================================

/**
 * 检测不同卡片世界书之间的关键词冲突
 * 同名关键词在不同卡片中出现即视为潜在冲突
 */
export function detectConflicts(
  entries: WorldbookEntry[]
): WorldbookConflict[] {
  const conflictMap = new Map<string, Set<string>>();
  const fileMap = new Map<string, { cardId: string; file: string }[]>();

  for (const entry of entries) {
    if (!conflictMap.has(entry.file)) {
      conflictMap.set(entry.file, new Set());
      fileMap.set(entry.file, []);
    }
    conflictMap.get(entry.file)!.add(entry.sourceCard);
    fileMap.get(entry.file)!.push({ cardId: entry.sourceCard, file: entry.file });
  }

  const conflicts: WorldbookConflict[] = [];
  for (const [keyword, cards] of conflictMap) {
    if (cards.size > 1) {
      conflicts.push({
        keyword,
        cards: Array.from(cards),
        files: fileMap.get(keyword) || [],
      });
    }
  }

  return conflicts;
}

// ============================================================
// 按关键词搜索世界书(兼容旧接口)
// ============================================================

/**
 * 按关键字搜索世界书文件(兼容旧接口,单目录版)
 * @deprecated 推荐使用 injectRelevantWorldbookMulti 获取多目录结果
 */
export function findWorldbookFiles(
  keyword: string,
  worldbookDir: string
): { file: string; content: string }[] {
  const normalizedKeyword = keyword
    .replace(/^(世界观|世界观纯爱线|归属值|情分值)\s*/g, "")
    .trim();

  const results: { file: string; content: string }[] = [];

  for (const dir of SEARCH_DIRS) {
    const fullDir = join(worldbookDir, dir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const f of readdirSync(fullDir)) {
        if (!f.endsWith(".md")) continue;
        const name = f.replace(".md", "");
        const shortName = name
          .replace(/^(世界观|世界观纯爱线|归属值|情分值|\[世界观\]|\[世界观纯爱线\])\s*/g, "")
          .trim();
        if (
          name.includes(keyword) ||
          name.includes(normalizedKeyword) ||
          shortName.includes(normalizedKeyword)
        ) {
          const content = readFileSync(join(fullDir, f), "utf-8");
          results.push({ file: `${dir}/${f}`, content });
        }
      }
    } catch { /* 跳过 */ }
  }
  return results;
}

/**
 * 按关键字 + 可选卡片 id 搜索世界书(多目录版)
 */
export function findWorldbookFilesMulti(
  keyword: string,
  worldbookDirs: string[],
  cardId?: string
): { file: string; content: string; sourceCard: string }[] {
  // 如果指定了卡片 id,过滤目录
  let dirs = worldbookDirs;
  if (cardId) {
    dirs = worldbookDirs.filter((d) => inferCardIdFromWorldbookDir(d) === cardId);
  }

  const entries = searchWorldbookMultiDir([keyword], dirs);
  return entries.map((e) => ({
    file: e.file,
    content: e.content,
    sourceCard: e.sourceCard,
  }));
}

// ============================================================
// 读取世界书索引(多目录版)
// ============================================================

/**
 * 读取世界书索引(单目录版,保留兼容)
 */
export function readWorldbookIndex(worldbookDir: string): string {
  const indexPath = join(worldbookDir, "索引.md");
  if (existsSync(indexPath)) {
    return readFileSync(indexPath, "utf-8");
  }
  return "";
}

/**
 * 读取多个世界书目录的合并索引
 */
export function readWorldbookIndexMulti(worldbookDirs: string[]): string {
  const parts: string[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;
    const cardName = getCardNameFromDir(join(worldbookDir, ".."));
    const indexPath = join(worldbookDir, "索引.md");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      parts.push(`## 📇 ${cardName}\n${content}`);
    } else {
      // 无索引文件时生成简单目录
      parts.push(`## 📇 ${cardName}\n(无索引文件,以下为自动扫描)\n`);
      for (const dir of SEARCH_DIRS) {
        const fullDir = join(worldbookDir, dir);
        if (!existsSync(fullDir)) continue;
        try {
          const files = readdirSync(fullDir).filter((f) => f.endsWith(".md"));
          if (files.length > 0) {
            parts.push(`### ${dir} (${files.length} 个文件)`);
            for (const f of files) {
              parts.push(`- ${f.replace(".md", "")}`);
            }
          }
        } catch { /* 跳过 */ }
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ============================================================
// 主动注入逻辑(多目录版)
// ============================================================

/**
 * 基于用户消息和已有上下文,决定注入哪些世界书条目(多目录版)。
 *
 * 逻辑:
 * 1. 从 userMessage + existingContext 中提取关键词
 * 2. 搜索所有世界书目录,匹配文件名含有关键词的条目
 * 3. 过滤已注入条目(通过 InjectedEntriesTracker 去重)
 * 4. 按命中关键词数降序排列(优先级)
 * 5. 累计 token 数 ≤ MAX_WORLDBOOK_TOKENS,超出则截断
 * 6. 将选中条目标记为已注入
 *
 * @param userMessage 当前用户消息
 * @param existingContext 已有的上下文文本数组(最近 AI 回复等)
 * @param worldbookDirs 世界书根目录路径数组
 * @returns 格式化的世界书注入文本;若无新条目则返回空字符串
 */
export function injectRelevantWorldbook(
  userMessage: string,
  existingContext: string[],
  worldbookDirs: string | string[]
): string {
  // 兼容旧接口:如果是字符串,转为数组
  const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];
  if (dirs.length === 0) return "";

  // ----- 1. 提取关键词 -----
  const contextText = existingContext.join(" ");
  const combinedText = userMessage + " " + contextText;
  const keywords = extractKeywords(combinedText);

  if (keywords.length === 0) return "";

  // ----- 2. 搜索世界书 -----
  const searchResults = searchWorldbookMultiDir(keywords, dirs);
  if (searchResults.length === 0) return "";

  // ----- 3. 过滤已注入条目 -----
  const newEntries = searchResults.filter(
    (entry) => !injectedTracker.isInjected(entry.sourceCard, entry.file)
  );
  if (newEntries.length === 0) return "";

  // ----- 4. 按优先级排序(命中数降序,同命中数时按卡片分组) -----
  newEntries.sort((a, b) => b.hitCount - a.hitCount);

  // ----- 5. Token 预算控制 -----
  const selected: WorldbookEntry[] = [];
  let totalTokens = 0;
  const FORMAT_OVERHEAD = 120; // 多卡片情况下格式开销更大

  for (const entry of newEntries) {
    const effectiveTokens = totalTokens + entry.tokenEstimate + FORMAT_OVERHEAD;
    if (effectiveTokens > MAX_WORLDBOOK_TOKENS) break;
    selected.push(entry);
    totalTokens += entry.tokenEstimate;
  }

  if (selected.length === 0) return "";

  // ----- 6. 标记为已注入 -----
  injectedTracker.markAll(selected.map((e) => ({ cardId: e.sourceCard, file: e.file })));

  // ----- 7. 构建注入文本 -----
  const parts: string[] = [];
  const cardCount = new Set(selected.map((e) => e.sourceCard)).size;
  parts.push(`\n---\n## 世界书主动注入(${selected.length} 条,来自 ${cardCount} 张卡片)\n`);

  // 按卡片分组显示
  const grouped = new Map<string, WorldbookEntry[]>();
  for (const entry of selected) {
    if (!grouped.has(entry.sourceCard)) {
      grouped.set(entry.sourceCard, []);
    }
    grouped.get(entry.sourceCard)!.push(entry);
  }

  for (const [cardId, entries] of grouped) {
    const cardName = entries[0].sourceCardName;
    parts.push(`### 📁 ${cardName} (${cardId})`);
    for (const entry of entries) {
      const tag = entry.hitCount >= 3 ? "🔴" : entry.hitCount >= 2 ? "🟡" : "🟢";
      parts.push(`#### ${tag} ${entry.file}`);
      parts.push(entry.content);
      parts.push("");
    }
  }

  return parts.join("\n");
}

/**
 * 精简版主动注入:仅返回最高优先级的一条世界书条目
 */
export function injectTopWorldbook(
  userMessage: string,
  worldbookDirs: string | string[]
): string {
  const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];
  if (dirs.length === 0) return "";

  const keywords = extractKeywords(userMessage);
  if (keywords.length === 0) return "";

  const results = searchWorldbookMultiDir(keywords, dirs)
    .filter((e) => !injectedTracker.isInjected(e.sourceCard, e.file))
    .sort((a, b) => b.hitCount - a.hitCount);

  if (results.length === 0) return "";

  const top = results[0];
  injectedTracker.mark(top.sourceCard, top.file);

  return `\n---\n## 世界书参考 | ${top.sourceCardName} / ${top.file}\n${top.content}\n`;
}


/**
 * 注入常开世界书(从索引.md 的"常开设定"章节读取文件列表并加载内容)
 * 在 7 轮压缩后调用,确保 AI 始终有核心设定可用
 *
 * @param worldbookDirs 世界书根目录路径数组
 * @returns 格式化的注入文本;若无常开条目则返回空字符串
 */
export function injectAlwaysOnWorldbook(worldbookDirs: string[]): string {
  if (worldbookDirs.length === 0) return "";

  const parts: string[] = [];
  parts.push(`
---
## 世界书常开设定(压缩后重载)
`);

  for (const wbDir of worldbookDirs) {
    if (!existsSync(wbDir)) continue;
    const indexPath = join(wbDir, "索引.md");
    if (!existsSync(indexPath)) continue;

    const cardDir = join(wbDir, "..");
    const cardName = getCardNameFromDir(cardDir);
    const indexContent = readFileSync(indexPath, "utf-8");

    // 解析"常开设定"章节:匹配 ## 常开设定 到下一个 ## 或 文件末尾 之间的内容
    const alwaysOnMatch = indexContent.match(
      /## 常开设定[\s\S]*?(?=## |$)/

    );
    if (!alwaysOnMatch) continue;

    const sectionContent = alwaysOnMatch[0];
    // 提取所有反引号内的文件名(`xxx.md`)
    const filePattern = /`([^`]+?\.md)`/g;
    let fileMatch: RegExpExecArray | null;
    const loadedFiles: string[] = [];

    parts.push(`
### ${cardName}
`);

    while ((fileMatch = filePattern.exec(sectionContent)) !== null) {
      const fileName = fileMatch[1];
      // 在所有 SEARCH_DIRS 中查找该文件
      let found = false;
      for (const subDir of SEARCH_DIRS) {
        const filePath = join(wbDir, subDir, fileName);
        if (existsSync(filePath)) {
          const fileContent = readFileSync(filePath, "utf-8");
          // 跳过 yaml front matter
          const cleanContent = fileContent.replace(/^---[\s\S]*?\n---\n?/, "");
          parts.push(`#### ${fileName}
${cleanContent}
`);
          loadedFiles.push(subDir + "/" + fileName);
          found = true;
          break;
        }
      }
      if (!found) {
        parts.push(`(文件 ${fileName} 未找到)
`);
      }
    }

    if (loadedFiles.length === 0) {
      parts.push(`(无常开设定文件)
`);
    }
  }

  if (parts.length <= 1) return "";

  // 追加提醒:其他世界书从未被读取过
  parts.push(
    `---
` +
    `**提醒:以上是常开设定。除此之外,还有其他世界书条目(性爱规则/事件触发器/角色详情等)` +
    `在当前上下文中从未被加载过。请根据剧情进展,使用 load_worldbook 工具按需加载。**
`
  );

  return parts.join(`
`);
}