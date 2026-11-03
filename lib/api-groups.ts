import { kvGet, kvSet } from "@/lib/kv-db";

// API 分组：独立存储，不改 ApiConfig 结构。折叠状态一并保存，设置页与悬浮窗共用。
export type ApiGroup = { id: string; name: string; apiIds: string[]; collapsed?: boolean };

const API_GROUPS_KEY = "ai_phone_api_groups_v1";
export const API_GROUPS_UPDATED_EVENT = "api-groups-updated";

export function loadApiGroups(): ApiGroup[] {
    try {
        const raw = kvGet(API_GROUPS_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(item => item && typeof item.id === "string" && Array.isArray(item.apiIds))
            .map(item => ({
                id: String(item.id),
                name: String(item.name || "未命名分组"),
                apiIds: item.apiIds.map(String),
                collapsed: item.collapsed === true,
            }));
    } catch {
        return [];
    }
}

export function saveApiGroups(groups: ApiGroup[]): void {
    kvSet(API_GROUPS_KEY, JSON.stringify(groups));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(API_GROUPS_UPDATED_EVENT));
}
