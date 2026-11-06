import { useEffect, useRef, useState } from "react";
import { TUTORIAL_PAGES } from "./pages";
import type { TutorialPage } from "./pages";

export interface TutorialOverlayProps {
  pages?: readonly TutorialPage[];
  onFinish: () => void;
}

/**
 * 教程覆盖层：只负责阅读与翻页，不读写存储、不发网络请求。
 * 跳过/关闭/末页“我知道了”统一交给 onFinish，由 App 写 seen。
 */
export function TutorialOverlay({ pages = TUTORIAL_PAGES, onFinish }: TutorialOverlayProps) {
  const [index, setIndex] = useState(0);
  const firstButtonRef = useRef<HTMLButtonElement>(null);
  const total = pages.length;
  const current = pages[index];
  const lastIndex = Math.max(0, total - 1);

  useEffect(() => {
    firstButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onFinish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onFinish]);

  if (current === undefined) {
    return (
      <div className="tutorial-overlay">
        <section className="tutorial-panel" role="dialog" aria-modal="true" aria-label="新手教程">
          <div className="tutorial-head">
            <h2>新手教程</h2>
          </div>
          <div className="tutorial-body">
            <p>暂无教程内容。</p>
          </div>
          <div className="tutorial-actions">
            <button type="button" className="primary" onClick={onFinish}>我知道了</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="tutorial-overlay">
      <section className="tutorial-panel" role="dialog" aria-modal="true" aria-label="新手教程">
        <header className="tutorial-head">
          <div>
            <h2>新手教程</h2>
            <p className="eyebrow">第 {index + 1} / {total} 页</p>
          </div>
          <div className="tutorial-head-actions">
            <button ref={firstButtonRef} type="button" className="link tutorial-head-btn" onClick={onFinish}>
              跳过教程
            </button>
            <button type="button" className="link tutorial-head-btn" onClick={onFinish}>
              关闭教程
            </button>
          </div>
        </header>

        <div className="tutorial-body">
          <h3 className="tutorial-title">{current.title}</h3>
          {current.paragraphs.map((paragraph, paragraphIndex) => (
            <p className="tutorial-paragraph" key={String(paragraphIndex)}>{paragraph}</p>
          ))}
          {current.checklist !== undefined && current.checklist.length > 0 ? (
            <ul className="tutorial-checklist">
              {current.checklist.map((item, itemIndex) => (
                <li key={String(itemIndex)}>{item}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="tutorial-actions">
          <button
            type="button"
            className="topbar-btn"
            disabled={index === 0}
            onClick={() => setIndex((currentIndex) => Math.max(0, currentIndex - 1))}
          >
            上一步
          </button>
          {index < lastIndex ? (
            <button
              type="button"
              className="primary"
              onClick={() => setIndex((currentIndex) => Math.min(lastIndex, currentIndex + 1))}
            >
              下一步
            </button>
          ) : (
            <button type="button" className="primary" onClick={onFinish}>我知道了</button>
          )}
        </footer>
      </section>
    </div>
  );
}
