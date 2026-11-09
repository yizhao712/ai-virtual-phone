"use client";

import { CALL_MODE_LABELS, type CallMode } from "@/lib/voice-call-settings";

type Props = {
    onPick: (mode: CallMode) => void;
    onClose: () => void;
};

const MODES: CallMode[] = ["daily", "whisper"];

export function VoiceCallModePicker({ onPick, onClose }: Props) {
    return (
        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" role="dialog" aria-modal="true" aria-label="选择通话模式" onClick={onClose}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ padding: "20px 18px calc(20px + env(safe-area-inset-bottom))" }}>
                <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600, marginBottom: 4 }}>选择通话模式</div>
                <div style={{ textAlign: "center", fontSize: 12, opacity: 0.55, marginBottom: 16 }}>两种模式使用各自的提示词和语音</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {MODES.map((mode) => {
                        const item = CALL_MODE_LABELS[mode];
                        const night = mode === "whisper";
                        return (
                            <button
                                key={mode}
                                type="button"
                                onClick={() => onPick(mode)}
                                style={{
                                    display: "flex", alignItems: "center", gap: 14, padding: "16px 18px", borderRadius: 18,
                                    border: night ? "1px solid rgba(185,168,214,0.35)" : "1px solid rgba(0,0,0,0.1)",
                                    background: night ? "linear-gradient(135deg,#1a1c24,#2a2540)" : "linear-gradient(135deg,#ffffff,#f1f0f4)",
                                    color: night ? "#fff" : "#222", textAlign: "left", cursor: "pointer",
                                }}
                            >
                                <span style={{ fontSize: 28, width: 40, textAlign: "center" }}>{item.icon}</span>
                                <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                    <span style={{ fontSize: 16, fontWeight: 600 }}>{item.title}</span>
                                    <span style={{ fontSize: 12, opacity: 0.65 }}>{item.desc}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
                <button type="button" className="ui-btn ui-btn-outline" onClick={onClose} style={{ width: "100%", marginTop: 16 }}>取消</button>
            </div>
        </div>
    );
}
