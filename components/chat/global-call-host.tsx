"use client";

// 全局通话托管：通话挂在桌面外壳的全局浮层，离开聊天室、回桌面、打开其他 App 都不断线。
// 全屏时左上角可最小化；最小化后通话界面隐藏但不卸载（声音、识别继续），
// 屏幕上浮一个可拖动的小胶囊（头像 + 名字 + 通话时长），点击回到全屏。

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Minimize2 } from "lucide-react";
import type { ChatSession } from "@/lib/chat-storage";
import type { Character } from "@/lib/character-types";
import { VoiceCallScreen } from "./voice-call-screen";

export const GLOBAL_CALL_START_EVENT = "global-call-start";
export const GLOBAL_CALL_ENDED_EVENT = "global-call-ended";

export type GlobalCallRequest = {
    type: "voice";
    session: ChatSession;
    character: Character;
    initiator: "user" | "character";
};

export function startGlobalCall(request: GlobalCallRequest): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent<GlobalCallRequest>(GLOBAL_CALL_START_EVENT, { detail: request }));
}

type ActiveCall = GlobalCallRequest & { key: string; startedAt: number; connectedAt: number | null };

type PillDrag = {
    id: number;
    sx: number;
    sy: number;
    left: number;
    top: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function clampPos(value: number, max: number): number {
    return Math.min(Math.max(8, value), max);
}

const MINIMIZE_BTN_STYLE: CSSProperties = {
    position: "absolute",
    top: "calc(var(--safe-area-top, 44px) + 10px)",
    left: 12,
    zIndex: 1000,
    width: 36,
    height: 36,
    borderRadius: 18,
    border: "none",
    background: "rgba(0, 0, 0, 0.35)",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
};

export function GlobalCallHost() {
    const [call, setCall] = useState<ActiveCall | null>(null);
    const [minimized, setMinimized] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const [pillPos, setPillPos] = useState<{ left: number; top: number } | null>(null);
    const callRef = useRef<ActiveCall | null>(null);
    const dragRef = useRef<PillDrag | null>(null);
    const suppressClickRef = useRef(false);

    useEffect(() => {
        const onStart = (event: Event) => {
            const detail = (event as CustomEvent<GlobalCallRequest>).detail;
            if (!detail?.session || !detail.character) return;
            // 已有通话时不叠加第二通
            if (callRef.current) return;
            const next: ActiveCall = {
                ...detail,
                key: `${detail.session.id}-${Date.now()}`,
                startedAt: Date.now(),
                connectedAt: null,
            };
            callRef.current = next;
            setCall(next);
            setMinimized(false);
        };
        window.addEventListener(GLOBAL_CALL_START_EVENT, onStart);
        return () => window.removeEventListener(GLOBAL_CALL_START_EVENT, onStart);
    }, []);

    // 只在最小化时每秒刷新计时
    useEffect(() => {
        if (!call || !minimized) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [call, minimized]);

    const handleConnect = useCallback(() => {
        setCall(prev => {
            if (!prev || prev.connectedAt) return prev;
            const next = { ...prev, connectedAt: Date.now() };
            callRef.current = next;
            return next;
        });
    }, []);

    const handleEnd = useCallback(() => {
        const ended = callRef.current;
        callRef.current = null;
        setCall(null);
        setMinimized(false);
        if (ended) {
            // 聊天室若仍挂载，会据此重载消息、滚到底部并触发回复（与原挂断收尾一致）
            window.dispatchEvent(new CustomEvent(GLOBAL_CALL_ENDED_EVENT, { detail: { sessionId: ended.session.id } }));
        }
    }, []);

    const getBounds = (el: HTMLElement) => {
        const parent = el.offsetParent instanceof HTMLElement ? el.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
        const rect = el.getBoundingClientRect();
        return {
            left: rect.left - parentRect.left,
            top: rect.top - parentRect.top,
            maxLeft: Math.max(8, parentRect.width - rect.width - 8),
            maxTop: Math.max(8, parentRect.height - rect.height - 8),
        };
    };

    const handlePillPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const bounds = getBounds(event.currentTarget);
        dragRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ...bounds, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const handlePillPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.sx;
        const dy = event.clientY - drag.sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        setPillPos({ left: clampPos(drag.left + dx, drag.maxLeft), top: clampPos(drag.top + dy, drag.maxTop) });
    };

    const handlePillPointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        if (drag.moved) suppressClickRef.current = true;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };

    const handlePillClick = () => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        setMinimized(false);
    };

    if (!call) return null;

    const elapsed = now - (call.connectedAt ?? call.startedAt);
    const pillStyle: CSSProperties = {
        position: "absolute",
        zIndex: 950,
        ...(pillPos
            ? { left: pillPos.left, top: pillPos.top }
            : { right: 12, top: "calc(var(--safe-area-top, 44px) + 56px)" }),
        display: "flex",
        alignItems: "center",
        gap: 8,
        maxWidth: 220,
        padding: "5px 12px 5px 5px",
        borderRadius: 22,
        border: "none",
        background: "rgba(20, 20, 20, 0.85)",
        color: "#fff",
        boxShadow: "0 6px 20px rgba(0, 0, 0, 0.25)",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        cursor: "pointer",
    };

    return (
        <>
            <div
                style={{ position: "absolute", inset: 0, zIndex: 900, display: minimized ? "none" : "block" }}
                aria-hidden={minimized}
            >
                <VoiceCallScreen
                    key={call.key}
                    session={call.session}
                    character={call.character}
                    initiator={call.initiator}
                    onConnect={handleConnect}
                    onEnd={handleEnd}
                />
                <button
                    type="button"
                    style={MINIMIZE_BTN_STYLE}
                    onClick={() => setMinimized(true)}
                    aria-label="最小化通话"
                    title="最小化通话"
                >
                    <Minimize2 size={18} />
                </button>
            </div>

            {minimized && (
                <button
                    type="button"
                    style={pillStyle}
                    aria-label={`与${call.character.name}通话中，已通话 ${formatDuration(elapsed)}，点击返回通话`}
                    onPointerDown={handlePillPointerDown}
                    onPointerMove={handlePillPointerMove}
                    onPointerUp={handlePillPointerEnd}
                    onPointerCancel={handlePillPointerEnd}
                    onClick={handlePillClick}
                >
                    <span
                        style={{ width: 30, height: 30, borderRadius: 15, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}
                        aria-hidden="true"
                    >
                        {call.character.avatar
                            ? <img src={call.character.avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : (call.character.name || "?").slice(0, 1)}
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0, lineHeight: 1.2 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {call.character.name}
                        </span>
                        <span style={{ fontSize: 12, opacity: 0.85, fontVariantNumeric: "tabular-nums", display: "flex", alignItems: "center", gap: 4 }}>
                            <span style={{ width: 6, height: 6, borderRadius: 3, background: "#34C759" }} aria-hidden="true" />
                            {formatDuration(elapsed)}
                        </span>
                    </span>
                </button>
            )}
        </>
    );
}
