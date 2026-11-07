import { useEffect, useRef, useState } from "react";
import type { AudioController } from "./audio";

export interface AudioButtonProps {
  onOpen?: () => void;
  className?: string;
}

/** 各页面共用的“声音”入口；aria-label 固定，方便无障碍与测试。 */
export function AudioButton({ onOpen, className = "link" }: AudioButtonProps) {
  return (
    <button type="button" className={className} aria-label="声音设置" onClick={() => onOpen?.()}>
      声音
    </button>
  );
}

export interface AudioPanelProps {
  controller: AudioController;
  onClose: () => void;
}

/** 声音设置面板：静音、BGM/音效滑杆；Esc 或遮罩关闭。 */
export function AudioPanel({ controller, onClose }: AudioPanelProps) {
  const [state, setState] = useState(controller.getState());
  const [unavailable, setUnavailable] = useState(controller.isUnavailable());
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(() => {
      setState(controller.getState());
      setUnavailable(controller.isUnavailable());
    });
    return unsubscribe;
  }, [controller]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="audio-overlay" onClick={onClose}>
      <section
        ref={panelRef}
        className="audio-panel"
        role="dialog"
        aria-modal="true"
        aria-label="声音设置"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="audio-head">
          <h2>声音设置</h2>
          <button type="button" className="link audio-close" onClick={onClose}>
            关闭声音设置
          </button>
        </header>

        <label className="audio-row">
          <span>静音</span>
          <input
            type="checkbox"
            checked={state.muted}
            onChange={(event) => controller.setMuted(event.target.checked)}
            aria-label="静音"
          />
        </label>

        <label className="audio-row">
          <span>背景音乐</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(state.bgmVolume * 100)}
            disabled={unavailable}
            onChange={(event) => controller.setBgmVolume(Number(event.target.value) / 100)}
            aria-label="背景音乐音量"
          />
          <span className="audio-value">{Math.round(state.bgmVolume * 100)}</span>
        </label>

        <label className="audio-row">
          <span>音效</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(state.sfxVolume * 100)}
            disabled={unavailable}
            onChange={(event) => controller.setSfxVolume(Number(event.target.value) / 100)}
            aria-label="音效音量"
          />
          <span className="audio-value">{Math.round(state.sfxVolume * 100)}</span>
        </label>

        <p className={unavailable ? "hint audio-unavailable" : "hint"}>
          {unavailable ? "当前设备无法播放声音，不影响游戏" : "首次点击页面后开始播放"}
        </p>
      </section>
    </div>
  );
}
