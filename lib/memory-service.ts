// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { isMemoryHidden } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
// 隐藏（存档）记忆：不固定注入，只在与当前对话相关时按向量相似度取回少量几条
const ARCHIVED_RECALL_TOP_K = 3;
const ARCHIVED_RECALL_MIN_SCORE = 0.35;
// 片段召回：整条存档记忆太长时，只保留和当前对话字面相关的句子
const ARCHIVED_EXCERPT_MAX_CHARS = 150;
// 召回和截取都只看最近一小段对话（约最新一两条消息），话题过去后就不再召回
const ARCHIVED_QUERY_TAIL_CHARS = 200;

function textGrams(text: string): Set<string> {
    const grams = new Set<string>();
    const lower = text.toLowerCase();
    // 英文 / 数字按词，中文按相邻两字
    (lower.match(/[a-z0-9]{2,}/g) ?? []).forEach(word => grams.add(word));
    (lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []).forEach(run => {
        for (let i = 0; i < run.length - 1; i++) grams.add(run.slice(i, i + 2));
    });
    return grams;
}

// 关键词门槛用：太常见的二字词不算「聊到了」
const COMMON_BIGRAMS = new Set([
    "我们", "你们", "他们", "她们", "今天", "明天", "昨天", "现在", "一起", "觉得", "喜欢", "什么", "怎么",
    "没有", "可以", "知道", "一个", "这个", "那个", "就是", "还是", "真的", "时候", "因为", "所以", "但是",
    "然后", "如果", "已经", "自己", "不是", "这样", "那样", "用户", "对方", "一下", "有点", "感觉", "起来",
    "出来", "东西", "事情", "问题", "关系", "的时", "了一", "一些", "很多", "非常", "之后", "之前", "为什",
]);

function informativeGrams(text: string): Set<string> {
    const grams = textGrams(text);
    COMMON_BIGRAMS.forEach(gram => grams.delete(gram));
    // 英文 / 数字只认 3 个字符以上的词（ok、hi 之类不算）
    grams.forEach(gram => { if (/^[a-z0-9]+$/.test(gram) && gram.length < 3) grams.delete(gram); });
    return grams;
}

function excerptArchivedMemory(entry: MemoryEntry, context: string): MemoryEntry {
    const content = entry.content.trim();
    if (content.length <= ARCHIVED_EXCERPT_MAX_CHARS) return entry;
    // 不用正则后行断言，兼容旧版 iOS Safari
    const sentences = (content.match(/[^。！？!?；;\n]+[。！？!?；;\n]?/g) ?? [])
        .map(text => text.trim())
        .filter(Boolean);
    if (sentences.length <= 1) {
        return { ...entry, content: `${content.slice(0, ARCHIVED_EXCERPT_MAX_CHARS)}…` };
    }
    const query = textGrams(context.slice(-ARCHIVED_QUERY_TAIL_CHARS));
    const scored = sentences.map((text, index) => {
        let score = 0;
        textGrams(text).forEach(gram => { if (query.has(gram)) score++; });
        return { text, index, score };
    });
    // 有字面重合：按重合度取；没有：按原顺序取开头几句
    const ranked = scored.some(item => item.score > 0)
        ? scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score)
        : scored;
    const picked: typeof scored = [];
    let length = 0;
    for (const item of ranked) {
        if (picked.length > 0 && length + item.text.length > ARCHIVED_EXCERPT_MAX_CHARS) continue;
        picked.push(item);
        length += item.text.length;
        if (length >= ARCHIVED_EXCERPT_MAX_CHARS) break;
    }
    const excerpt = picked
        .sort((a, b) => a.index - b.index)
        .map(item => item.text)
        .join("")
        .slice(0, ARCHIVED_EXCERPT_MAX_CHARS);
    return { ...entry, content: `${excerpt}…` };
}

export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
    /** 隐藏记忆召回专用的比对文本（建议只放用户自己最近的消息）；缺省用 currentContext */
    archivedQueryText?: string,
): Promise<MemoryEntry[]> {
    const visible = await retrieveVisibleMemoriesForPrompt(characterId, currentContext, config);
    if (!currentContext.trim() || !config.vectorRecallEnabled) return visible;
    const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return visible;

    const archived = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(entry => isMemoryHidden(entry) && entry.embedding && entry.embedding.length > 0);
    if (archived.length === 0) return visible;

    let usedTokens = 0;
    for (const entry of visible) usedTokens += estimateTokens(entry.content) + 4;
    const remaining = config.longTermTokenBudget - usedTokens;
    if (remaining <= 0) return visible;

    try {
        // 只用用户自己最近说的话比对，避免角色回复里提到的内容反复把同一条记忆召回
        const recentQuery = (archivedQueryText?.trim() || currentContext).slice(-ARCHIVED_QUERY_TAIL_CHARS);

        // 门槛 1：最近对话与记忆要有「有辨识度」的词重合（常用词、多数记忆都有的词不算）
        const queryGrams = informativeGrams(recentQuery);
        if (queryGrams.size === 0) return visible;
        const memoryGrams = archived.map(entry => informativeGrams(entry.content));
        const docFreq = new Map<string, number>();
        memoryGrams.forEach(grams => grams.forEach(gram => {
            if (queryGrams.has(gram)) docFreq.set(gram, (docFreq.get(gram) ?? 0) + 1);
        }));
        const maxDocFreq = Math.max(1, Math.floor(archived.length * 0.3));
        const keywordHit = archived.map((_, index) => {
            for (const gram of memoryGrams[index]) {
                if (queryGrams.has(gram) && (docFreq.get(gram) ?? 0) <= maxDocFreq) return true;
            }
            return false;
        });
        const candidates = archived.filter((_, index) => keywordHit[index]);
        // 没有候选就不调用 embedding 接口（省掉多数轮次的向量请求）
        if (candidates.length === 0) return visible;

        const queryEmbedding = await generateEmbedding(recentQuery, embeddingApiConfig);
        if (!queryEmbedding) return visible;
        // 门槛 2：分数既要过绝对值，也要高于全部隐藏记忆的平均分
        const allScores = archived.map(entry => cosineSimilarity(queryEmbedding, entry.embedding!));
        const meanScore = allScores.reduce((sum, score) => sum + score, 0) / allScores.length;
        const minScore = archived.length >= 4 ? Math.max(ARCHIVED_RECALL_MIN_SCORE, meanScore) : ARCHIVED_RECALL_MIN_SCORE;
        const recalled = archived
            .map((entry, index) => ({ entry, score: allScores[index], hit: keywordHit[index] }))
            .filter(item => item.hit && item.score >= minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, ARCHIVED_RECALL_TOP_K)
            .map(item => excerptArchivedMemory(item.entry, recentQuery));
        return [...visible, ...fillByBudget(recalled, remaining)];
    } catch {
        return visible;
    }
}

/** 正常（未隐藏）记忆的注入选择：原有三种策略不变 */
async function retrieveVisibleMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = (await loadMemoryEntriesByType(characterId, "long_term"))
        .filter(entry => !isMemoryHidden(entry));
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
