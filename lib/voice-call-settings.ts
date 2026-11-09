// lib/voice-call-settings.ts — 语音通话：模式、主题、背景、各模式音色
import { kvGet, kvSet } from "./kv-db";

export type CallMode = "daily" | "whisper";
export type CallTheme = "light-mono" | "light-violet" | "night";

export type VoiceCallSettings = {
    theme: CallTheme;
    /** 自定义背景图（IndexedDB 资源 id），为空则用主题底色 */
    bgId?: string;
    /** 日常聊天模式使用的语音配置 id，为空则沿用角色绑定的语音 */
    voiceDaily?: string;
    /** 深夜耳语模式使用的语音配置 id，为空则沿用角色绑定的语音 */
    voiceWhisper?: string;
};

const KEY = "ai_phone_voice_call_settings_v1";

export const CALL_MODE_LABELS: Record<CallMode, { title: string; desc: string; icon: string }> = {
    daily: { title: "日常聊天", desc: "像面对面聊天一样自然地说话", icon: "☀" },
    whisper: { title: "深夜耳语", desc: "低声细语，陪你慢慢入睡", icon: "☾" },
};

export const CALL_THEMES: Record<CallTheme, {
    label: string; bg: string; ai: string; user: string; line: string; sub: string; light: boolean;
}> = {
    "light-mono": { label: "白天 · 黑白灰", bg: "#ffffff", ai: "#222222", user: "#7A6A9A", line: "rgba(0,0,0,0.12)", sub: "rgba(0,0,0,0.5)", light: true },
    "light-violet": { label: "白天 · 灰紫黑", bg: "#E9E6EE", ai: "#26232B", user: "#7A6A9A", line: "rgba(38,35,43,0.16)", sub: "rgba(38,35,43,0.55)", light: true },
    night: { label: "夜间", bg: "#0f1115", ai: "#ffffff", user: "#B9A8D6", line: "rgba(255,255,255,0.18)", sub: "rgba(255,255,255,0.6)", light: false },
};

export function loadVoiceCallSettings(): VoiceCallSettings {
    const fallback: VoiceCallSettings = { theme: "light-mono" };
    try {
        const raw = kvGet(KEY);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const theme: CallTheme = parsed?.theme in CALL_THEMES ? parsed.theme : "light-mono";
        return { ...fallback, ...parsed, theme };
    } catch {
        return fallback;
    }
}

export function saveVoiceCallSettings(settings: VoiceCallSettings): void {
    try { kvSet(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// 聊天室选好模式后、通话页挂载前的一次性传递。
// 通话页挂载后会清空；角色主动来电没有设置过，取默认「日常」。
let _pendingMode: CallMode | null = null;
export function setPendingCallMode(mode: CallMode): void { _pendingMode = mode; }
export function peekPendingCallMode(): CallMode { return _pendingMode ?? "daily"; }
export function clearPendingCallMode(): void { _pendingMode = null; }
