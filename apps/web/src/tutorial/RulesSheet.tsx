import { useEffect, useRef } from "react";
import { RULE_SECTIONS } from "./rules";
import type { RuleSection } from "./rules";

export interface RulesSheetProps {
  sections?: readonly RuleSection[];
  onClose: () => void;
}

/** 规则页：单个可滚动面板，按固定顺序渲染 8 节；只读，不发命令。 */
export function RulesSheet({ sections = RULE_SECTIONS, onClose }: RulesSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="tutorial-overlay">
      <section className="rules-sheet" role="dialog" aria-modal="true" aria-label="规则说明">
        <header className="rules-head">
          <h2>规则说明</h2>
          <button ref={closeRef} type="button" className="link rules-close" onClick={onClose}>
            关闭规则
          </button>
        </header>
        {sections.map((section) => (
          <section className="rules-section" key={section.id}>
            <h3>{section.title}</h3>
            {section.paragraphs.map((paragraph, paragraphIndex) => (
              <p className="rules-paragraph" key={String(paragraphIndex)}>{paragraph}</p>
            ))}
            {section.bullets.length > 0 ? (
              <ul className="rules-bullets">
                {section.bullets.map((bullet, bulletIndex) => (
                  <li key={String(bulletIndex)}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </section>
    </div>
  );
}
