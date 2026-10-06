"use client";

import { Component, useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronRight, Filter, Eye, EyeOff, Sparkles, RotateCcw, CalendarDays, GripVertical, type LucideIcon } from "lucide-react";
import { simpleLLMCall } from "@/lib/api-helpers";
import { kvGet, kvSet, kvRemove } from "@/lib/kv-db";
import { ConfirmDialog } from "@/components/ui/modal";
import { MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig } from "@/lib/memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT, DEFAULT_REFINE_PROMPT, DEFAULT_SUMMARIZATION_PROMPT, isMemoryHidden } from "@/lib/memory-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
    getLastCoreSummarizedTimestamp,
} from "@/lib/memory-storage";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline } from "@/lib/memory-summarizer";
import { runCoreMemoryPipeline } from "@/lib/core-memory-builder";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "core" | "long";
type MemoryBudgetKey = "shortTermTokenBudget" | "coreMemoryTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 200,
};
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 5000,
    coreMemoryTokenBudget: 1000,
    longTermTokenBudget: 1000,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;
// 详情页时间线最多解析渲染的条数：全量历史可能有几万条，
// 一次性解析+渲染会把 iOS Safari 的单页内存顶爆（灰屏杀页）
const MEMORY_TIMELINE_ENTRY_CAP = 2000;

/** 详情页兜底：时间线渲染抛错时显示提示，而不是整页白屏 */
class MemoryDetailBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <p className="text-center ts-14 mt-10 text-secondary">这一页加载出错了，返回上一页再试一次。</p>;
        }
        return this.props.children;
    }
}

type SummarizeRange = "auto" | "all" | number;

const SUMMARIZE_RANGE_OPTIONS: Array<{ value: SummarizeRange; label: string; desc?: string }> = [
    { value: "auto", label: "接着上次总结", desc: "默认方式，从上次进度继续" },
    { value: 1, label: "最近 1 天" },
    { value: 3, label: "最近 3 天" },
    { value: 7, label: "最近 7 天" },
    { value: 14, label: "最近 14 天" },
    { value: 30, label: "最近 30 天" },
    { value: "all", label: "全部历史" },
];

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 记忆来源开关：同时作用于短期上下文与长期总结 */
const MEMORY_SOURCE_OPTIONS: Array<{ key: MemorySourceKey; label: string }> = [
    { key: "chat", label: "私聊上下文" },
    { key: "group_chat", label: "群聊上下文" },
    { key: "moments", label: "朋友圈" },
    { key: "checkphone", label: "查手机" },
    { key: "diary", label: "手记便签" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "interview_magazine", label: "在场访谈" },
    { key: "cocreate", label: "共创" },
    { key: "game", label: "内置小游戏" },
    { key: "story", label: "剧情小剧场" },
    { key: "vn", label: "漫卷" },
    { key: "adventure", label: "地图冒险" },
    { key: "custom_app", label: "自定义应用" },
];

type RefineDraft = {
    sourceIds: string[];
    content: string;
    memoryDate: string;
    /** 重新提炼已有记忆时的目标 id；缺省为新建 */
    targetId?: string;
};

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
};

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item memory-slider-item">
            <div className="memory-slider-header">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <span className="ui-slider-value memory-slider-current">{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-settings-slider"
                aria-label={label}
            />
        </div>
    );
}

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

const MEMORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toLocalDateString(isoStr: string): string {
    const date = new Date(isoStr);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 长期记忆的显示/排序日期：优先用户设定的 memoryDate（年月日），否则取 createdAt。
 *  不直接改 createdAt：核心记忆总结靠它判断哪些记忆还没总结过。 */
function getMemoryDisplayDate(entry: MemoryEntry): string {
    const custom = entry.metadata?.memoryDate;
    if (typeof custom === "string" && MEMORY_DATE_PATTERN.test(custom)) return custom;
    return toLocalDateString(entry.createdAt);
}

// ── 手动排序：按「角色 + 记忆类型」保存 id 顺序，只影响显示，不影响注入与总结 ──
const MEMORY_ORDER_PREFIX = "ai_phone_memory_manual_order_v1_";

function loadManualOrder(charId: string, type: MemoryEntry["type"]): string[] | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(`${MEMORY_ORDER_PREFIX}${type}_${charId}`);
        const parsed = raw ? JSON.parse(raw) : null;
        return Array.isArray(parsed) && parsed.length > 0 ? parsed.map(String) : null;
    } catch {
        return null;
    }
}

function saveManualOrder(charId: string, type: MemoryEntry["type"], ids: string[] | null): void {
    const key = `${MEMORY_ORDER_PREFIX}${type}_${charId}`;
    if (ids && ids.length > 0) kvSet(key, JSON.stringify(ids));
    else kvRemove(key);
}

/** 已排过的按记录顺序；新出现的（没排过的）放最上面，保持原有相对顺序 */
function applyManualOrder(entries: MemoryEntry[], order: string[]): MemoryEntry[] {
    const pos = new Map(order.map((id, index) => [id, index]));
    const fresh = entries.filter(entry => !pos.has(entry.id));
    const known = entries
        .filter(entry => pos.has(entry.id))
        .sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    return [...fresh, ...known];
}

/** 最新在上，越旧越靠下；同一天内按创建时间倒序 */
function sortMemoriesByDateDesc(entries: MemoryEntry[]): MemoryEntry[] {
    return [...entries].sort((a, b) => {
        const cmp = getMemoryDisplayDate(b).localeCompare(getMemoryDisplayDate(a));
        return cmp !== 0 ? cmp : b.createdAt.localeCompare(a.createdAt);
    });
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    coreCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [coreEntries, setCoreEntries] = useState<MemoryEntry[]>([]);
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [rebuildingCore, setRebuildingCore] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [editingCorePrompt, setEditingCorePrompt] = useState<string | null>(null);
    const [editingRefinePrompt, setEditingRefinePrompt] = useState<string | null>(null);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [selectedLongTermIds, setSelectedLongTermIds] = useState<string[]>([]);
    const [refineDraft, setRefineDraft] = useState<RefineDraft | null>(null);
    const [refining, setRefining] = useState(false);
    const [dateEditor, setDateEditor] = useState<{ id: string; value: string } | null>(null);
    const [memDrag, setMemDrag] = useState<{ id: string; startY: number; offset: number } | null>(null);
    const [orderRevision, setOrderRevision] = useState(0);

    const disabledSourceCount = MEMORY_SOURCE_OPTIONS
        .filter(source => (config.shortTermAllowedSources ?? {})[source.key] === false).length;

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const loadCharacterList = useCallback(async (isCancelled?: () => boolean) => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            let coreCount = 0;
            try {
                [ltCount, coreCount] = await Promise.all([
                    getMemoryCountByType(id, "long_term"),
                    getMemoryCountByType(id, "core"),
                ]);
            } catch { /* ignore */ }
            infos.push({ character: char, longTermCount: ltCount, coreCount, shortTermCount: 0 });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            infos.push({ character: char, longTermCount: 0, coreCount: 0, shortTermCount: 0 });
        }

        if (isCancelled?.()) return;
        setCharacters(infos);

        // 短期计数逐个异步补齐：loadNativeTimeline 是全量组装，重数据账号
        // 在循环里同步跑完会长时间卡死主线程、瞬时吃掉大量内存
        for (const info of infos) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled?.()) return;
            let stCount = 0;
            try { stCount = loadNativeTimeline(info.character.id).length; } catch { /* ignore */ }
            if (isCancelled?.()) return;
            setCharacters(prev => prev.map(item =>
                item.character.id === info.character.id ? { ...item, shortTermCount: stCount } : item));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadCharacterList(() => cancelled);
        return () => { cancelled = true; };
    }, [loadCharacterList]);

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [core, lt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            setCoreEntries(core);
            setLongTermEntries(lt);
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
        }
        // Native timeline is sync (localStorage) — no await needed.
        // 只取最近一段（全量可能几万条），防止解析+渲染把 iOS Safari 内存顶爆
        const timeline = loadNativeTimeline(charId).slice(-MEMORY_TIMELINE_ENTRY_CAP);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            setActiveTab("short");
            setExpandedId(null);
            setSelectedLongTermIds([]);
            setRefineDraft(null);
            setDateEditor(null);
            loadDetailData(selectedCharId);
        }
    }, [view, selectedCharId, loadDetailData]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
            setEditingCorePrompt(null);
            setEditingRefinePrompt(null);
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setCoreEntries(prev => prev.filter(e => e.id !== id));
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setSelectedLongTermIds(prev => prev.filter(itemId => itemId !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        if (type === "core") setCoreEntries([]);
        else {
            setLongTermEntries([]);
            setSelectedLongTermIds([]);
        }
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    const handleManualSummarize = async (range: SummarizeRange = "auto") => {
        if (!selectedCharId || summarizing) return;
        setSummarizeRangeOpen(false);
        setSummarizing(true);
        try {
            const sinceTimestamp = typeof range === "number"
                ? new Date(Date.now() - range * 86400000).toISOString()
                : undefined;
            const afterTimestamp = range === "all"
                ? undefined
                : sinceTimestamp ?? getLastSummarizedTimestamp(selectedCharId) ?? undefined;
            const timelineCount = loadNativeTimeline(
                selectedCharId,
                afterTimestamp ? { afterTimestamp } : undefined,
            ).length;
            if (timelineCount < 4) {
                showNotice("所选范围内事件不足 4 条");
                return;
            }

            const result = await runSummarizationPipeline(
                selectedCharId,
                selectedChar?.name ?? "",
                range === "all" ? { force: true } : sinceTimestamp ? { sinceTimestamp } : undefined,
            );
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const handleManualRebuildCore = async () => {
        if (!selectedCharId || rebuildingCore) return;
        setRebuildingCore(true);
        try {
            const lastCoreSummarizedAt = getLastCoreSummarizedTimestamp(selectedCharId);
            const longTermEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice(result.rebuiltCount ? `核心记忆已重建（${result.rebuiltCount}条）` : "核心记忆已重建");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "核心记忆重建失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual core rebuild failed:", err);
            showNotice("核心记忆重建失败: " + String(err));
        } finally {
            setRebuildingCore(false);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveCoreInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(20, Math.max(1, Math.round(value)));
        const next = { ...config, coreSummarizationInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const handleSaveCorePrompt = () => {
        if (editingCorePrompt === null) return;
        const next = { ...config, coreMemoryPrompt: editingCorePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已保存");
    };

    const handleResetCorePrompt = () => {
        setEditingCorePrompt(DEFAULT_CORE_MEMORY_PROMPT);
        const next = { ...config, coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已恢复默认");
    };

    const handleSaveRefinePrompt = () => {
        if (editingRefinePrompt === null) return;
        const trimmed = editingRefinePrompt.trim();
        // 空内容或与默认一致时存 undefined，以后默认提示词升级能自动跟上
        const refinePrompt = trimmed && trimmed !== DEFAULT_REFINE_PROMPT.trim() ? editingRefinePrompt : undefined;
        const next = { ...config, refinePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提炼提示词已保存");
    };

    const handleResetRefinePrompt = () => {
        setEditingRefinePrompt(DEFAULT_REFINE_PROMPT);
        const next = { ...config, refinePrompt: undefined };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提炼提示词已恢复默认");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"]) => {
        setEntryMenuId(null);
        setMemoryEditor({ type, content: "" });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setMemoryEditor({ type: entry.type, entry, content: entry.content });
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const content = memoryEditor.content.trim();
        if (!content) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const type = memoryEditor.type;
            const source = memoryEditor.entry;
            const contentChanged = !source || source.content.trim() !== content;
            const embedding = type === "long_term"
                ? (contentChanged ? await maybeBuildManualMemoryEmbedding(type, content) : source?.embedding)
                : undefined;
            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content,
                    embedding,
                    importance: type === "core" ? 0.95 : 0.8,
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                    },
                };

            await saveMemoryEntry(entry);
            if (type === "core") {
                setCoreEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            } else {
                setLongTermEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            }
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice(type === "core" ? "核心记忆已保存" : "长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    // ── Long-term: hide / date / refine ──
    const updateLongTermEntry = async (entry: MemoryEntry) => {
        await saveMemoryEntry(entry);
        setLongTermEntries(prev => prev.map(item => item.id === entry.id ? entry : item));
    };

    const handleToggleHidden = async (entry: MemoryEntry) => {
        setEntryMenuId(null);
        const hidden = !isMemoryHidden(entry);
        try {
            await updateLongTermEntry({
                ...entry,
                updatedAt: new Date().toISOString(),
                metadata: { ...(entry.metadata ?? {}), hidden },
            });
            showNotice(hidden ? "已隐藏：角色不再读取，也不参与总结" : "已取消隐藏");
        } catch (error) {
            showNotice("操作失败: " + String(error));
        }
    };

    const openDateEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setDateEditor({ id: entry.id, value: getMemoryDisplayDate(entry) });
    };

    const handleSaveMemoryDate = async (entry: MemoryEntry) => {
        if (!dateEditor || !MEMORY_DATE_PATTERN.test(dateEditor.value)) {
            showNotice("请选择有效日期");
            return;
        }
        try {
            await updateLongTermEntry({
                ...entry,
                metadata: { ...(entry.metadata ?? {}), memoryDate: dateEditor.value },
            });
            setDateEditor(null);
            showNotice("日期已更新");
        } catch (error) {
            showNotice("日期保存失败: " + String(error));
        }
    };

    const toggleLongTermSelected = (id: string) => {
        setSelectedLongTermIds(prev => prev.includes(id) ? prev.filter(itemId => itemId !== id) : [...prev, id]);
    };

    const runRefineGeneration = async (sourceIds: string[]) => {
        const sources = longTermEntries
            .filter(entry => sourceIds.includes(entry.id))
            .sort((a, b) => getMemoryDisplayDate(a).localeCompare(getMemoryDisplayDate(b)));
        if (sources.length === 0) {
            showNotice("原始记忆已不存在，无法重新生成");
            return;
        }
        const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
        if (!apiConfig) {
            showNotice("未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）");
            return;
        }
        const memoriesText = sources.map(entry => `- [${getMemoryDisplayDate(entry)}] ${entry.content}`).join("\n");
        const template = config.refinePrompt?.trim() || DEFAULT_REFINE_PROMPT;
        // 自定义提示词漏了 {{memories}} 时把记忆接在末尾，避免模型收不到内容
        const withMemories = /\{\{memories\}\}/i.test(template) ? template : `${template}\n\n{{memories}}`;
        const prompt = withMemories
            .replace(/\{\{char\}\}/gi, () => selectedChar?.name ?? "")
            .replace(/\{\{memories\}\}/gi, () => memoriesText);
        setRefining(true);
        try {
            const result = await simpleLLMCall(
                apiConfig,
                [{ role: "user", content: prompt }],
                { temperature: 0.3 },
            );
            if (!result.content) {
                showNotice(result.error || "提炼失败");
                return;
            }
            if (result.wasTruncated) showNotice("提炼结果疑似被截断，可重新生成或手动补全");
            const content = result.content.trim();
            setRefineDraft(prev => prev ? { ...prev, content } : prev);
        } catch (error) {
            showNotice("提炼失败: " + String(error));
        } finally {
            setRefining(false);
        }
    };

    const handleStartRefine = () => {
        const sources = longTermEntries.filter(entry => selectedLongTermIds.includes(entry.id));
        if (sources.length === 0) {
            showNotice("请先勾选要提炼的长期记忆");
            return;
        }
        const sourceIds = sources.map(entry => entry.id);
        const memoryDate = sources.map(getMemoryDisplayDate).sort()[0];
        setRefineDraft({ sourceIds, content: "", memoryDate });
        void runRefineGeneration(sourceIds);
    };

    const openReRefine = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        const refinedFrom = entry.metadata?.refinedFrom;
        const sourceIds = Array.isArray(refinedFrom) ? refinedFrom.map(String) : [];
        setRefineDraft({ sourceIds, content: entry.content, memoryDate: getMemoryDisplayDate(entry), targetId: entry.id });
    };

    const handleSaveRefined = async () => {
        if (!selectedCharId || !refineDraft || refining || savingMemory) return;
        const content = refineDraft.content.trim();
        if (!content) {
            showNotice("提炼内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }
        if (!MEMORY_DATE_PATTERN.test(refineDraft.memoryDate)) {
            showNotice("请选择有效日期");
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const sources = longTermEntries.filter(entry => refineDraft.sourceIds.includes(entry.id));
            const target = refineDraft.targetId
                ? longTermEntries.find(entry => entry.id === refineDraft.targetId)
                : undefined;
            const embedding = target && target.content.trim() === content
                ? target.embedding
                : await maybeBuildManualMemoryEmbedding("long_term", content);
            const refined: MemoryEntry = target
                ? {
                    ...target,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: { ...(target.metadata ?? {}), memoryDate: refineDraft.memoryDate, refinedFrom: refineDraft.sourceIds },
                }
                : {
                    id: createManualMemoryId("long_term"),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type: "long_term",
                    content,
                    embedding,
                    importance: Math.max(0.8, ...sources.map(entry => entry.importance ?? 0)),
                    createdAt: now,
                    updatedAt: now,
                    metadata: { origin: "user_refined", memoryDate: refineDraft.memoryDate, refinedFrom: refineDraft.sourceIds },
                };
            // 原记忆自动隐藏，仅作存档
            const archivedSources = sources.map(entry => ({
                ...entry,
                updatedAt: now,
                metadata: { ...(entry.metadata ?? {}), hidden: true, refinedInto: refined.id },
            }));

            await saveMemoryEntry(refined);
            for (const entry of archivedSources) await saveMemoryEntry(entry);
            setLongTermEntries(prev => {
                const next = prev.map(item => item.id === refined.id
                    ? refined
                    : archivedSources.find(source => source.id === item.id) ?? item);
                return target ? next : [...next, refined];
            });
            setRefineDraft(null);
            setSelectedLongTermIds([]);
            setExpandedId(refined.id);
            loadCharacterList();
            showNotice(target ? "提炼记忆已更新" : `已提炼为 1 条新记忆，原 ${archivedSources.length} 条已隐藏存档`);
        } catch (error) {
            console.error("[MemoryBank] Save refined memory failed:", error);
            showNotice("提炼保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], entries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";
        const isLong = type === "long_term";
        const baseList = isLong ? sortMemoriesByDateDesc(entries) : entries;
        // orderRevision 变化时重新读取手动顺序
        const manualOrder = orderRevision >= 0 && selectedCharId ? loadManualOrder(selectedCharId, type) : null;
        const list = manualOrder ? applyManualOrder(baseList, manualOrder) : baseList;
        const finishMemoryDrag = (draggedId: string, clientY: number) => {
            const others = Array.from(document.querySelectorAll<HTMLElement>("[data-mem-card]"))
                .filter(el => el.dataset.memCard !== draggedId);
            const target = others.filter(el => {
                const rect = el.getBoundingClientRect();
                return rect.top + rect.height / 2 < clientY;
            }).length;
            const ids = list.map(item => item.id).filter(id => id !== draggedId);
            ids.splice(target, 0, draggedId);
            if (selectedCharId) saveManualOrder(selectedCharId, type, ids);
            setOrderRevision(prev => prev + 1);
        };
        return (
            <>
                {entries.length > 0 && (
                    <div className="mem-entry-toolbar">
                        <button
                            className="mem-entry-add-btn"
                            onClick={() => openCreateMemoryEditor(type)}
                        >
                            <Plus size={15} strokeWidth={1.8} />
                            <span>新增{label}</span>
                        </button>
                        <button
                            className="mem-entry-clear-btn"
                            onClick={() => setConfirmClearAll(true)}
                        >
                            <Trash2 size={15} strokeWidth={1.8} />
                            <span>清除{label}</span>
                        </button>
                        {manualOrder && (
                            <button
                                className="mem-entry-clear-btn"
                                onClick={() => {
                                    if (selectedCharId) saveManualOrder(selectedCharId, type, null);
                                    setOrderRevision(prev => prev + 1);
                                }}
                            >
                                <RotateCcw size={15} strokeWidth={1.8} />
                                <span>{isLong ? "按日期重排" : "恢复默认顺序"}</span>
                            </button>
                        )}
                        {isLong && (
                            <button
                                className="mem-entry-add-btn"
                                disabled={selectedLongTermIds.length === 0 || refining || !!refineDraft}
                                onClick={handleStartRefine}
                            >
                                <Sparkles size={15} strokeWidth={1.8} />
                                <span>提炼所选{selectedLongTermIds.length > 0 ? `（${selectedLongTermIds.length}）` : ""}</span>
                            </button>
                        )}
                    </div>
                )}
                {isLong && refineDraft && (
                    <div className="g-card memory-report-card">
                        <div className="mem-report-head">
                            <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>
                                [ {refineDraft.targetId ? "重新提炼" : "提炼"} · {refineDraft.sourceIds.length} 条 ]
                            </span>
                            <input
                                type="date"
                                className="ts-11"
                                value={refineDraft.memoryDate}
                                onChange={event => setRefineDraft(prev => prev ? { ...prev, memoryDate: event.target.value } : prev)}
                            />
                        </div>
                        <textarea
                            className="ts-12 leading-[1.7]"
                            value={refineDraft.content}
                            disabled={refining}
                            placeholder={refining ? "正在提炼…" : "提炼结果，可直接编辑"}
                            onChange={event => setRefineDraft(prev => prev ? { ...prev, content: event.target.value } : prev)}
                            style={{ width: "100%", minHeight: 140, padding: 10, borderRadius: 10, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit", font: "inherit", resize: "vertical" }}
                        />
                        <div className="mem-entry-toolbar">
                            <button
                                className="mem-entry-add-btn"
                                disabled={refining || savingMemory || refineDraft.sourceIds.length === 0}
                                onClick={() => void runRefineGeneration(refineDraft.sourceIds)}
                            >
                                <RotateCcw size={15} strokeWidth={1.8} />
                                <span>{refining ? "提炼中…" : "重新生成"}</span>
                            </button>
                            <button
                                className="mem-entry-add-btn"
                                disabled={refining || savingMemory || !refineDraft.content.trim()}
                                onClick={() => void handleSaveRefined()}
                            >
                                <Check size={15} strokeWidth={1.8} />
                                <span>{savingMemory ? "保存中…" : "保存"}</span>
                            </button>
                            <button
                                className="mem-entry-clear-btn"
                                disabled={refining || savingMemory}
                                onClick={() => setRefineDraft(null)}
                            >
                                <X size={15} strokeWidth={1.8} />
                                <span>取消</span>
                            </button>
                        </div>
                    </div>
                )}
                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}
                {entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : (
                    list.map(entry => (
                        <div
                            key={entry.id}
                            className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}`}
                            data-mem-card={entry.id}
                            style={{
                                ...(isLong && isMemoryHidden(entry) ? { opacity: 0.55 } : {}),
                                ...(memDrag?.id === entry.id ? {
                                    transform: `translateY(${memDrag.offset}px)`,
                                    position: "relative" as const,
                                    zIndex: 5,
                                    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
                                } : {}),
                            }}
                            onClick={() => {
                                if (entryMenuId) {
                                    setEntryMenuId(null);
                                    return;
                                }
                                setExpandedId(expandedId === entry.id ? null : entry.id);
                            }}
                        >
                            <div className="mem-report-head">
                                {isLong ? (
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                        <input
                                            type="checkbox"
                                            aria-label="勾选用于提炼"
                                            checked={selectedLongTermIds.includes(entry.id)}
                                            onClick={event => event.stopPropagation()}
                                            onChange={() => toggleLongTermSelected(entry.id)}
                                        />
                                        {dateEditor?.id === entry.id ? (
                                            <>
                                                <input
                                                    type="date"
                                                    className="ts-11"
                                                    value={dateEditor.value}
                                                    onClick={event => event.stopPropagation()}
                                                    onChange={event => setDateEditor({ id: entry.id, value: event.target.value })}
                                                />
                                                <button className="mem-entry-menu-btn" title="保存日期" onClick={event => { event.stopPropagation(); void handleSaveMemoryDate(entry); }}>
                                                    <Check size={15} />
                                                </button>
                                                <button className="mem-entry-menu-btn" title="取消" onClick={event => { event.stopPropagation(); setDateEditor(null); }}>
                                                    <X size={15} />
                                                </button>
                                            </>
                                        ) : (
                                            <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {getMemoryDisplayDate(entry)} ]</span>
                                        )}
                                    </div>
                                ) : (
                                    <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {relativeTime(entry.createdAt)} ]</span>
                                )}
                                <div className="mem-report-actions">
                                    {isLong && isMemoryHidden(entry) && (
                                        <span className="mem-origin-badge">HIDDEN</span>
                                    )}
                                    <span className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}>
                                        {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                                    </span>
                                    <span
                                        role="button"
                                        aria-label="按住拖动排序"
                                        title="按住拖动排序"
                                        className="mem-entry-menu-btn"
                                        style={{ touchAction: "none", cursor: "grab", opacity: 0.6 }}
                                        onClick={event => event.stopPropagation()}
                                        onPointerDown={event => {
                                            event.stopPropagation();
                                            event.currentTarget.setPointerCapture(event.pointerId);
                                            setMemDrag({ id: entry.id, startY: event.clientY, offset: 0 });
                                        }}
                                        onPointerMove={event => {
                                            if (!memDrag || memDrag.id !== entry.id) return;
                                            setMemDrag({ ...memDrag, offset: event.clientY - memDrag.startY });
                                        }}
                                        onPointerUp={event => {
                                            if (!memDrag || memDrag.id !== entry.id) return;
                                            setMemDrag(null);
                                            finishMemoryDrag(entry.id, event.clientY);
                                        }}
                                        onPointerCancel={() => setMemDrag(null)}
                                    >
                                        <GripVertical size={16} />
                                    </span>
                                    <div className="mem-entry-menu-wrap">
                                        <button
                                            className="mem-entry-menu-btn"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                                            }}
                                            title="更多"
                                        >
                                            <MoreHorizontal size={18} />
                                        </button>
                                        {entryMenuId === entry.id && (
                                            <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                                <button onClick={() => openEditMemoryEditor(entry)}>
                                                    <Edit3 size={13} />
                                                    <span>编辑</span>
                                                </button>
                                                {isLong && (
                                                    <>
                                                        <button onClick={() => void handleToggleHidden(entry)}>
                                                            {isMemoryHidden(entry) ? <Eye size={13} /> : <EyeOff size={13} />}
                                                            <span>{isMemoryHidden(entry) ? "取消隐藏" : "隐藏"}</span>
                                                        </button>
                                                        <button onClick={() => openDateEditor(entry)}>
                                                            <CalendarDays size={13} />
                                                            <span>修改日期</span>
                                                        </button>
                                                        {Array.isArray(entry.metadata?.refinedFrom) && (
                                                            <button onClick={() => openReRefine(entry)}>
                                                                <Sparkles size={13} />
                                                                <span>重新提炼</span>
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                                <button
                                                    className="is-danger"
                                                    onClick={() => {
                                                        setEntryMenuId(null);
                                                        setConfirmDeleteEntryId(entry.id);
                                                    }}
                                                >
                                                    <Trash2 size={13} />
                                                    <span>删除</span>
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="ts-12 leading-[1.7]">
                                {expandedId === entry.id
                                    ? entry.content
                                    : entry.content.length > 100
                                        ? entry.content.slice(0, 100) + "..."
                                        : entry.content
                                }
                            </div>
                        </div>
                    ))
                )}
            </>
        );
    };


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col absolute inset-0 overflow-hidden" style={{ padding: "0 16px" }}>
                {/* Content */}
                <div className="memory-detail-scroll flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                    <MemoryDetailBoundary>
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        )
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — floating above bottom */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isCore = memoryEditor.type === "core";
                    const isEdit = Boolean(memoryEditor.entry);
                    const title = `${isEdit ? "编辑" : "新增"}${isCore ? "核心记忆" : "长期记忆"}`;
                    const placeholder = isCore
                        ? "记录稳定、长期影响角色判断的事实，例如关系身份、重大约定、长期设定。"
                        : "记录一次重要事件、承诺、偏好、关系变化，后续对话会参考。";
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => savingMemory ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    <textarea
                                        className="ui-textarea mem-edit-textarea"
                                        value={memoryEditor.content}
                                        placeholder={placeholder}
                                        disabled={savingMemory}
                                        onChange={event => setMemoryEditor(prev => prev ? { ...prev, content: event.target.value } : prev)}
                                    />
                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`}>
                                        <span>{isCore ? "CORE" : "LONG TERM"}</span>
                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                    </div>
                                    <button
                                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        {savingMemory ? "保存中..." : "保存记忆"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message={activeTab === "core" ? "将清除该角色所有核心记忆，此操作无法恢复。" : "将清除该角色所有长期记忆，此操作无法恢复。"}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries(activeTab === "core" ? "core" : "long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
                    />
                )}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt ?? config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
        const currentCorePrompt = editingCorePrompt ?? config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT;
        const isModified = currentPrompt !== (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT);
        const isDefault = (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT) === DEFAULT_SUMMARIZATION_PROMPT;
        const isCoreModified = currentCorePrompt !== (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT);
        const isCoreDefault = (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT) === DEFAULT_CORE_MEMORY_PROMPT;

        return (
            <div className="page-menu memory-settings-menu">
                {/* Manual summarize */}
                {selectedCharId && (
                    <>
                        <p className="menu-group-desc mx-2">手动操作</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动总结</span>
                                    <span className="menu-desc">将新产生的事件整理为长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => setSummarizeRangeOpen(true)}
                                        disabled={summarizing}
                                    >
                                        <Zap size={12} className="mr-1" />
                                        {summarizing ? "处理中..." : "总结"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆手动总结</span>
                                    <span className="menu-desc">将长期记忆整理为核心记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualRebuildCore}
                                        disabled={rebuildingCore}
                                    >
                                        <Archive size={12} className="mr-1" />
                                        {rebuildingCore ? "处理中..." : "重建"}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {summarizeRangeOpen ? (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeRangeOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeRangeOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">选择总结范围</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            {SUMMARIZE_RANGE_OPTIONS.map(option => (
                                                <button
                                                    key={String(option.value)}
                                                    type="button"
                                                    className="menu-item w-full text-left"
                                                    onClick={() => void handleManualSummarize(option.value)}
                                                >
                                                    <div className="menu-label-group">
                                                        <span className="menu-label">{option.label}</span>
                                                        {option.desc ? <span className="menu-desc">{option.desc}</span> : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </>
                )}

                {/* Memory source filter — one entry row, full picker lives in a bottom sheet */}
                <p className="menu-group-desc mx-2">记忆来源</p>
                <div className="menu-group">
                    <button type="button" className="menu-item" onClick={() => setSourcePickerOpen(true)}>
                        <MemorySettingsIcon icon={Filter} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆来源</span>
                            <span className="menu-desc">选择哪些内容参与记忆</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{disabledSourceCount === 0 ? "全部开启" : `已关闭 ${disabledSourceCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {sourcePickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSourcePickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSourcePickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_SOURCE_OPTIONS.map(source => {
                                        const allowed = config.shortTermAllowedSources ?? {};
                                        const isChecked = allowed[source.key] !== false;
                                        return (
                                            <button
                                                key={source.key}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={isChecked ? undefined : ""}
                                                aria-pressed={isChecked}
                                                onClick={() => {
                                                    const next = {
                                                        ...config,
                                                        shortTermAllowedSources: { ...allowed, [source.key]: !isChecked },
                                                    };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            >
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* Feature toggles */}
                <p className="menu-group-desc mx-2">自动化</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动将新事件整理为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数长期记忆，自动整理为核心记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoBuildCoreEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoBuildCoreEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">长期记忆超出预算时，通过 embedding 按相关性检索</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                </div>

                {/* Token budget sliders */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={value => saveBudget("shortTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={value => saveBudget("longTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆"
                        desc="高优先级里程碑注入量"
                        value={config.coreMemoryTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.coreMemoryTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.coreMemoryTokenBudget}
                        onChange={value => saveBudget("coreMemoryTokenBudget", value)}
                    />
                </div>

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 50}
                        min={10}
                        max={200}
                        step={10}
                        onChange={saveInterval}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆总结间隔"
                        desc="每 N 条长期记忆自动触发核心记忆总结"
                        value={config.coreSummarizationInterval ?? 5}
                        min={1}
                        max={20}
                        step={1}
                        onChange={saveCoreInterval}
                    />
                </div>

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 记录集合
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">核心记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{"{{char}}"} 角色、{"{{earliest}}"} 起始时间、{"{{latest}}"} 结束时间、{"{{events}}"} 长期记忆集合
                            </span>
                        </div>
                        {!isCoreDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetCorePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentCorePrompt}
                            onChange={e => setEditingCorePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {isCoreModified && (
                            <button
                                onClick={handleSaveCorePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Archive size={14} className="mr-1.5" /> 保存核心记忆提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">提炼提示词</p>
                {(() => {
                    const savedRefinePrompt = config.refinePrompt?.trim() ? config.refinePrompt : DEFAULT_REFINE_PROMPT;
                    const currentRefinePrompt = editingRefinePrompt ?? savedRefinePrompt;
                    const isRefineDefault = !config.refinePrompt?.trim();
                    const isRefineModified = editingRefinePrompt !== null && editingRefinePrompt !== savedRefinePrompt;
                    return (
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Sparkles} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动提炼提示词</span>
                                    <span className="menu-desc">
                                        变量：{"{{char}}"} 角色、{"{{memories}}"} 勾选的长期记忆
                                    </span>
                                </div>
                                {!isRefineDefault && (
                                    <div className="menu-right">
                                        <button onClick={handleResetRefinePrompt} className="menu-label menu-label-danger ts-12 underline">
                                            恢复默认
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="px-4 pb-4 flex flex-col gap-3">
                                <textarea
                                    value={currentRefinePrompt}
                                    onChange={e => setEditingRefinePrompt(e.target.value)}
                                    className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                                />
                                {isRefineModified && (
                                    <button
                                        onClick={handleSaveRefinePrompt}
                                        className="ui-btn ui-btn-primary p-2.5 w-full"
                                    >
                                        <Sparkles size={14} className="mr-1.5" /> 保存提炼提词配置
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })()}
            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    {"MEMORY".split("").map((ch, i) => (
                        <span key={i} className={`mem-picker-cover-letter mem-picker-letter-${i}`}>{ch}</span>
                    ))}
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.coreCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
