// 世界书条目的「按角色」开关：同一本世界书挂给多个角色时，各角色可单独开关条目，互不影响。
// 只记录与世界书默认开关（entry.disable）不同的条目；没有记录的条目沿用默认值。
// 结构：characterId → worldBookId → entryUid → enabled

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { WorldBookConfig } from "./settings-types";

export const WORLDBOOK_ENTRY_OVERRIDES_KEY = "ai_phone_worldbook_entry_overrides_v1";
registerKvMigration(WORLDBOOK_ENTRY_OVERRIDES_KEY);

export type WorldBookEntryOverrides = Record<string, Record<string, Record<string, boolean>>>;

export function loadWorldBookEntryOverrides(): WorldBookEntryOverrides {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(WORLDBOOK_ENTRY_OVERRIDES_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as WorldBookEntryOverrides : {};
    } catch {
        return {};
    }
}

export function saveWorldBookEntryOverrides(overrides: WorldBookEntryOverrides): void {
    if (typeof window === "undefined") return;
    kvSet(WORLDBOOK_ENTRY_OVERRIDES_KEY, JSON.stringify(overrides));
}

/** 该角色眼里这个条目是否开启：有单独设置用单独设置，否则用世界书默认 */
export function isWorldBookEntryEnabled(
    overrides: WorldBookEntryOverrides,
    characterId: string,
    worldBookId: string,
    entry: { uid: string; disable: boolean },
): boolean {
    const value = overrides[characterId]?.[worldBookId]?.[entry.uid];
    return typeof value === "boolean" ? value : !entry.disable;
}

/** 设置角色的单独开关；与默认值相同时删除记录。返回新对象，不修改入参。 */
export function setWorldBookEntryOverride(
    overrides: WorldBookEntryOverrides,
    characterId: string,
    worldBookId: string,
    entry: { uid: string; disable: boolean },
    enabled: boolean,
): WorldBookEntryOverrides {
    const next: WorldBookEntryOverrides = { ...overrides };
    const byBook = { ...(next[characterId] ?? {}) };
    const byEntry = { ...(byBook[worldBookId] ?? {}) };
    if (enabled === !entry.disable) delete byEntry[entry.uid];
    else byEntry[entry.uid] = enabled;
    if (Object.keys(byEntry).length > 0) byBook[worldBookId] = byEntry;
    else delete byBook[worldBookId];
    if (Object.keys(byBook).length > 0) next[characterId] = byBook;
    else delete next[characterId];
    return next;
}

/** 组装提示词前调用：按角色的单独开关改写条目的 disable（返回副本，不改原世界书） */
export function applyWorldBookEntryOverrides(characterId: string, books: WorldBookConfig[]): WorldBookConfig[] {
    const byBook = loadWorldBookEntryOverrides()[characterId];
    if (!byBook) return books;
    return books.map(book => {
        const byEntry = byBook[book.id];
        if (!byEntry) return book;
        return {
            ...book,
            entries: book.entries.map(entry => {
                const value = byEntry[entry.uid];
                return typeof value === "boolean" ? { ...entry, disable: !value } : entry;
            }),
        };
    });
}
