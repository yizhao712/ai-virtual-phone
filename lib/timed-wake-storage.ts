import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /** 创建来源：tool=角色自己约的（"你当时想着"视角）/ user=用户预约（"TA拜托你"视角）。缺省按 tool。 */
    source?: "tool" | "user";
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = all.filter(item => item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

export function clearTimedWakeSchedule(sessionId: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
}

// ── 暂停 / 启用 ──
// 暂停 = 移出生效列表（到点不会触发），另存剩余时长；启用 = 按剩余时长重新排期。
// 不改触发逻辑，触发方只认生效列表。
export const TIMED_WAKE_PAUSED_KEY = "ai_phone_timed_wake_paused_v1";

registerKvMigration(TIMED_WAKE_PAUSED_KEY);

export type PausedTimedWakeSchedule = TimedWakeSchedule & {
    pausedAt: number;
    remainingMs: number;
};

export function loadPausedTimedWakeSchedules(): PausedTimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_PAUSED_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item: unknown): item is PausedTimedWakeSchedule =>
            isTimedWakeSchedule(item) && typeof (item as PausedTimedWakeSchedule).remainingMs === "number");
    } catch {
        return [];
    }
}

function savePausedTimedWakeSchedules(list: PausedTimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_PAUSED_KEY, JSON.stringify(list));
}

export function pauseTimedWakeSchedule(id: string): PausedTimedWakeSchedule | null {
    const target = loadTimedWakeSchedules().find(item => item.id === id);
    if (!target) return null;
    const now = Date.now();
    const paused: PausedTimedWakeSchedule = {
        ...target,
        pausedAt: now,
        remainingMs: Math.max(60_000, target.fireAt - now),
    };
    removeTimedWakeSchedule(id);
    savePausedTimedWakeSchedules([...loadPausedTimedWakeSchedules().filter(item => item.id !== id), paused]);
    return paused;
}

/** 启用：按暂停时的剩余时长重新排期（同一会话已有新排期时会被替换） */
export function resumeTimedWakeSchedule(id: string): TimedWakeSchedule | null {
    const paused = loadPausedTimedWakeSchedules().find(item => item.id === id);
    if (!paused) return null;
    const schedule: TimedWakeSchedule = {
        id: paused.id,
        sessionId: paused.sessionId,
        characterId: paused.characterId,
        createdAt: paused.createdAt,
        delayMinutes: paused.delayMinutes,
        intent: paused.intent,
        source: paused.source,
        fireAt: Date.now() + paused.remainingMs,
    };
    savePausedTimedWakeSchedules(loadPausedTimedWakeSchedules().filter(item => item.id !== id));
    saveTimedWakeSchedule(schedule);
    return schedule;
}

export function removePausedTimedWakeSchedule(id: string): void {
    savePausedTimedWakeSchedules(loadPausedTimedWakeSchedules().filter(item => item.id !== id));
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
