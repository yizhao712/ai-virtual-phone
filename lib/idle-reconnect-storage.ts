// 冷场重连：用户超过 X 时间没有发消息时，角色主动发一次消息。
// 计时锚定"用户最后一条消息"；角色的重连消息不重置计时，用连发计数控制；
// 用户回复后计数清零，周期重新开始。每个角色一条规则。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const IDLE_RECONNECT_RULES_KEY = "ai_phone_idle_reconnect_rules_v1";
registerKvMigration(IDLE_RECONNECT_RULES_KEY);

/** 连发上限：用户不回复时最多主动发这么多次，回复后清零 */
export const IDLE_RECONNECT_MAX_CONSECUTIVE = 3;

export type IdleReconnectRule = {
    id: string;
    characterId: string;
    sessionId: string;
    /** 沉默阈值（分钟），1 分钟 ~ 72 小时 */
    intervalMinutes: number;
    /** 用户附加意图（可空） */
    intent: string;
    /** 自上次用户消息以来已连发次数 */
    consecutiveCount: number;
    /** 上次触发时刻（毫秒） */
    lastFiredAt?: number;
    /** 当前这次主动生成被用户停止后，短时间内不再重试 */
    suppressedUntil?: number;
    /** 本次间隔的随机浮动系数（每次触发 / 用户回复后重新随机），缺省按 1 */
    jitterFactor?: number;
    createdAt: number;
};

// ── 忽快忽慢：实际间隔 = 设定 × 随机系数 × 连发放缓 ──
const IDLE_JITTER_MIN = 0.7;
const IDLE_JITTER_MAX = 1.5;
/** 每多连发一次，间隔再拉长 50%（用户一直不回时越来越慢，不会越催越急） */
const IDLE_BACKOFF_STEP = 0.5;

function randomJitter(): number {
    return IDLE_JITTER_MIN + Math.random() * (IDLE_JITTER_MAX - IDLE_JITTER_MIN);
}

/** 本次实际生效的沉默阈值（分钟）。本地判断与云端预约都应使用它，保证两边时间一致。 */
export function getIdleReconnectEffectiveMinutes(rule: IdleReconnectRule): number {
    const jitter = typeof rule.jitterFactor === "number" && Number.isFinite(rule.jitterFactor) ? rule.jitterFactor : 1;
    const backoff = 1 + IDLE_BACKOFF_STEP * Math.max(0, rule.consecutiveCount);
    return Math.max(1, Math.round(rule.intervalMinutes * jitter * backoff));
}

function isRule(value: unknown): value is IdleReconnectRule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<IdleReconnectRule>;
    return typeof item.id === "string"
        && typeof item.characterId === "string"
        && typeof item.sessionId === "string"
        && typeof item.intervalMinutes === "number"
        && typeof item.intent === "string"
        && typeof item.consecutiveCount === "number"
        && typeof item.createdAt === "number";
}

export function loadIdleReconnectRules(): IdleReconnectRule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(IDLE_RECONNECT_RULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isRule) : [];
    } catch {
        return [];
    }
}

function saveRules(rules: IdleReconnectRule[]): void {
    if (typeof window === "undefined") return;
    kvSet(IDLE_RECONNECT_RULES_KEY, JSON.stringify(rules.slice(0, 100)));
}

/** 每角色一条：同角色再建即替换。 */
export function upsertIdleReconnectRule(rule: IdleReconnectRule): void {
    const rest = loadIdleReconnectRules().filter(item => item.characterId !== rule.characterId);
    saveRules([...rest, { ...rule, jitterFactor: rule.jitterFactor ?? randomJitter() }]);
}

export function removeIdleReconnectRule(id: string): void {
    saveRules(loadIdleReconnectRules().filter(item => item.id !== id));
}

/** 记一次触发（本地触发或服务端触发回端合并时都调用）。 */
export function markIdleReconnectFired(id: string, firedAtMs: number): void {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return;
    if (!rule.lastFiredAt || firedAtMs > rule.lastFiredAt) {
        rule.lastFiredAt = firedAtMs;
        rule.consecutiveCount = Math.min(IDLE_RECONNECT_MAX_CONSECUTIVE, rule.consecutiveCount + 1);
        rule.jitterFactor = randomJitter();
        saveRules(rules);
    }
}

/** 用户停止了当前这次冷场生成：不计入连发，只推迟下一次尝试。 */
export function suppressIdleReconnectUntil(id: string, untilMs: number): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return null;
    rule.suppressedUntil = Math.max(rule.suppressedUntil ?? 0, untilMs);
    saveRules(rules);
    return rule;
}

/** 用户在该会话发了消息：连发计数清零。返回被重置的规则（用于重挂预约）。 */
export function resetIdleReconnectForSession(sessionId: string): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.sessionId === sessionId);
    if (!rule) return null;
    if (rule.consecutiveCount !== 0) {
        rule.consecutiveCount = 0;
    }
    rule.suppressedUntil = undefined;
    rule.jitterFactor = randomJitter();
    saveRules(rules);
    return rule;
}
