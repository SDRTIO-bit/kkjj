/**
 * RP Engine - TUI 面板（状态面板 & 历史面板）
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import type { WorldState, CharacterState, HistoryRecord } from "./types";
import { CORE_CHARS } from "./types";

/**
 * 状态面板 - 显示所有角色状态概览
 */
export class StatusPanel {
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private getState: () => Record<string, any>;

  constructor(theme: Theme, onClose: () => void, getState: () => Record<string, any>) {
    this.theme = theme;
    this.onClose = onClose;
    this.getState = getState;
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
    const state = this.getState();
    const lines: string[] = [];
    const w = Math.min(width, 80);

    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", th.bold("  ╭───────────────── 状态面板 ─────────────────╮")), w));
    lines.push("");

    const world = state["世界"] as WorldState;
    if (world) {
      lines.push(truncateToWidth(`  📅 ${world.当前日期} ${world.当前星期}  🕐 ${world.当前时间}  📍 ${world.当前位置}`, w));
      lines.push("");
    }

    for (const name of CORE_CHARS) {
      const char = state[name] as CharacterState;
      if (!char) continue;

      const belong = char.归属值 ?? 0;
      const affection = char.情分值 ?? 100;
      const flower = char.花开蒂落?.触发状态 ? th.fg("success", "🌸") : th.fg("dim", "🌱");
      const preg = char.生理状态?.怀孕状态 || "未怀孕";
      const pregStr = preg !== "未怀孕" ? th.fg("warning", ` 🤰${char.生理状态?.怀孕天数 || 0}d`) : "";

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

/**
 * 历史面板 - 查看指定角色的状态变更历史
 */
export class HistoryPanel {
  private charName: string;
  private theme: Theme;
  private onClose: () => void;
  private records: HistoryRecord[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];
  private getHistoryPath: () => string;

  constructor(charName: string, theme: Theme, onClose: () => void, getHistoryPath: () => string) {
    this.charName = charName;
    this.theme = theme;
    this.onClose = onClose;
    this.getHistoryPath = getHistoryPath;
    this.loadHistory();
  }

  private loadHistory(): void {
    const p = this.getHistoryPath();
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
      .slice(-30);
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
