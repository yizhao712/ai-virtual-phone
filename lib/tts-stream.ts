// lib/tts-stream.ts — 逐句合成 + 边合成边播
//
// 为什么需要：原来通话是把整段回复一次性合成，再开始播。回复 20 秒的音频
// 要等 20~30 秒才出声。改成逐句之后，第一句合成完（约 2~4 秒）就开始播，
// 而下一句在"当前句播放期间"就已经开始合成（预取），所以总时长几乎被
// 播放时间盖住，用户体感从"等半天"变成"马上开口"。
//
// 注意：本文件不改协议，仍然是每个句子发一次标准的 /audio/speech 请求，
// 因此后端无需任何改动。

import type { VoiceApiConfig } from "./settings-types";
import { synthesizeSpeech } from "./tts-service";

export type StreamingPlayback = {
    /** 全部句子播完时 resolve（被打断也会 resolve） */
    promise: Promise<void>;
    /** 打断：停止当前播放，并且不再继续后面的句子 */
    abort: () => void;
};

/**
 * 把一段回复切成适合单独合成的句子（保留标点）。
 * - 按 . ! ? 。！？… ；; 切句
 * - 单句超过 maxLen 字符时，再按逗号切，避免一句太长又变慢/易退化
 * - 丢掉没有可朗读内容的片段（纯标点）
 */
export function splitSpeechSentences(text: string, maxLen = 160): string[] {
    const cleaned = (text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
    if (!cleaned) return [];

    const out: string[] = [];
    const push = (raw: string) => {
        const s = raw.trim();
        if (!s) return;
        if (!/[0-9A-Za-z\u4e00-\u9fff]/.test(s)) return; // 纯标点不合成
        out.push(s);
    };

    const chunks = cleaned.match(/[^.!?。！？…；;]+[.!?。！？…；;]*/g) || [cleaned];
    for (const chunk of chunks) {
        const s = chunk.trim();
        if (!s) continue;
        if (s.length <= maxLen) {
            push(s);
            continue;
        }
        for (const piece of s.match(/[^,，]+[,，]?/g) || [s]) push(piece);
    }
    return out;
}

/**
 * 逐句合成并顺序播放，下一句与当前句的播放**并行**合成。
 *
 * @param text        整段台词
 * @param voiceConfig 语音配置（与原来传给 synthesizeSpeech 的同一个）
 * @param playBlob    播放函数：playAudioBlob（iOS 通话）或 playAudioBlobViaMediaElement（其他）
 * @param onSentence  可选：每句开始播放时回调（做字幕高亮/日志用）
 * @param gapMs       句间小停顿，默认 120ms
 */
export function playSpeechStream(
    text: string,
    voiceConfig: VoiceApiConfig,
    playBlob: (blob: Blob) => { promise: Promise<void>; abort: () => void },
    onSentence?: (sentence: string, index: number) => void,
    gapMs = 120,
): StreamingPlayback {
    const sentences = splitSpeechSentences(text);
    let aborted = false;
    let playAbort: (() => void) | null = null;

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const promise = (async () => {
        if (sentences.length === 0) return;

        // 先把第一句送去合成
        let pending: Promise<Blob | null> = synthesizeSpeech(sentences[0], voiceConfig).catch(() => null);

        for (let i = 0; i < sentences.length; i++) {
            if (aborted) return;
            const blob = await pending;
            if (aborted) return;

            // 立刻开始预取下一句 —— 与当前句的播放重叠
            const nextIdx = i + 1;
            if (nextIdx < sentences.length) {
                pending = synthesizeSpeech(sentences[nextIdx], voiceConfig).catch(() => null);
            }

            if (!blob) {
                // 这一句合成失败：跳过，但继续后面的句子
                continue;
            }

            onSentence?.(sentences[i], i);
            const { promise: played, abort } = playBlob(blob);
            playAbort = abort;
            await played;
            playAbort = null;
            if (aborted) return;
            if (gapMs > 0 && nextIdx < sentences.length) await sleep(gapMs);
        }
    })().catch((e) => {
        console.warn("[tts-stream] playback error:", e);
    });

    return {
        promise,
        abort: () => {
            aborted = true;
            if (playAbort) {
                try { playAbort(); } catch { /* ignore */ }
                playAbort = null;
            }
        },
    };
}
