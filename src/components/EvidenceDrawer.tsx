import { useEffect, useRef } from "react";
import {
  ArrowUpRight,
  CheckCheck,
  FileText,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Evidence, VerificationStatus } from "../types";

export interface EvidenceDetail {
  title: string;
  confidence: number;
  verification_status: VerificationStatus;
  before_evidence: Evidence[];
  after_evidence: Evidence[];
  explanation: string;
  recommendation: string;
}

export function EvidenceDrawer({
  detail,
  onClose,
  demo,
}: {
  detail: EvidenceDetail;
  onClose: () => void;
  demo: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = dialog.current?.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex="0"]',
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [onClose]);

  const review = detail.verification_status === "NEEDS_REVIEW";
  const source = (evidence: Evidence[], label: string) => (
    <section className="source-block">
      <div className="eyebrow">{label}</div>
      {evidence.length ? (
        evidence.map((item, i) => (
          <div
            className="source-card"
            key={`${item.document}-${item.section}-${i}`}
          >
            <div className="source-meta">
              <FileText size={16} />
              <strong>{item.document}</strong>
              <span>{item.section === null ? "Без номера пункта" : `п. ${item.section}`}</span>
            </div>
            <blockquote>«{item.text}»</blockquote>
          </div>
        ))
      ) : (
        <div className="source-empty" role="note">
          <TriangleAlert size={17} /> Подтверждающий фрагмент не найден.
          Отсутствие источника само по себе не доказывает потерю функции.
        </div>
      )}
    </section>
  );

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="evidence-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-title"
      >
        <div className="drawer-top">
          <span>
            <ShieldCheck size={18} /> Документальные основания
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть источники"
          >
            <X size={21} />
          </button>
        </div>
        <div className="drawer-content">
          <div className="eyebrow">EVIDENCE EXPLORER</div>
          <h2 id="evidence-title">{detail.title}</h2>
          <span className={`status-pill ${review ? "review" : "verified"}`}>
            {review ? <TriangleAlert size={14} /> : <CheckCheck size={14} />}
            {review
              ? "Требует проверки · NEEDS REVIEW"
              : "Подтверждено · VERIFIED"}
          </span>
          {review && (
            <div className="review-callout">
              <strong>Вывод не подтверждён полностью</strong>
              <p>
                Это гипотеза для проверки экспертом. Не принимайте
                организационное решение только на основании этого вывода.
              </p>
            </div>
          )}
          {demo && (
            <p className="demo-source-note">
              Учебный пример. Цитаты взяты из синтетического набора, а не из
              документов Казахтелекома.
            </p>
          )}
          {source(detail.before_evidence, "BEFORE SOURCE · ДО ИЗМЕНЕНИЙ")}
          {source(detail.after_evidence, "AFTER SOURCE · ПОСЛЕ ИЗМЕНЕНИЙ")}
          <section className="drawer-section">
            <h3>Интерпретация изменения</h3>
            <p>{detail.explanation}</p>
          </section>
          <section className="drawer-section">
            <div className="confidence-heading">
              <h3>Уверенность сопоставления</h3>
              <strong>{Math.round(detail.confidence * 100)}%</strong>
            </div>
            <div className="confidence-track">
              <span style={{ width: `${detail.confidence * 100}%` }} />
            </div>
            <small>
              Оценка сопоставления, не вероятность достоверности вывода.
              {demo ? " В демо задана вручную." : ""}
            </small>
          </section>
          <section className="recommendation">
            <span>
              <ArrowUpRight size={19} /> Рекомендуемое действие
            </span>
            <p>{detail.recommendation}</p>
          </section>
        </div>
        <div className="drawer-footer">
          <ShieldCheck size={15} /> От вывода — к конкретному пункту документа
        </div>
      </div>
    </div>
  );
}
