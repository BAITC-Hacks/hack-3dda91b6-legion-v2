import {
  Download,
  FileCheck2,
  FileText,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  ArrowUpRight,
} from "lucide-react";
import type { AnalysisResult, Finding, Transformation } from "../types";

const transformationLabels: Record<string, string> = {
  PRESERVED: "сохранение",
  CREATED: "создание",
  REMOVED: "удаление",
  RENAMED: "переименование",
  SPLIT: "разделение",
  MERGED: "объединение",
};

export function Conclusion({
  analysis,
  generated,
  onGenerate,
  onEvidence,
  onTransformation,
  demo,
}: {
  analysis: AnalysisResult;
  generated: boolean;
  onGenerate: () => void;
  onEvidence: (finding: Finding) => void;
  onTransformation: (transformation: Transformation) => void;
  demo: boolean;
}) {
  const { summary, findings } = analysis;
  const referenced = findings.filter(
    (f) => f.before_evidence.length + f.after_evidence.length > 0,
  ).length;
  const verified = findings.filter(
    (f) => f.verification_status === "VERIFIED",
  ).length;
  const name = (id: string | null) =>
    analysis.units.find((u) => u.id === id)?.name ?? "—";
  const executive = `Структура изменилась: ${summary.units_before} → ${summary.units_after} подразделения. Новых подразделений: ${summary.created_units}, упразднённых: ${summary.removed_units}. Передано функций: ${summary.moved_functions}. К проверке: возможная потеря функций — ${summary.lost_functions}, дублирование — ${summary.duplications}, потенциальные конфликты — ${summary.potential_conflicts}.`;
  const download = () => {
    const lines = [
      "# OrgLens AI — Аналитическое заключение",
      "",
      `Анализ: ${analysis.analysis_id}`,
      `Документы: ${analysis.before_document} → ${analysis.after_document}`,
      "",
      demo
        ? "**ДЕМО: синтетические документы и цитаты. Не является анализом реальной организации.**"
        : "Заключение составлено из структурированного ответа API.",
      "",
      "## Executive summary",
      executive,
      "",
      "## Основные изменения",
      ...analysis.transformations.map(
        (t) =>
          `- ${name(t.before_unit)} → ${name(t.after_unit)}: ${transformationLabels[t.type]}. ${t.verification_status}. ${t.explanation}\n${[...t.before_evidence, ...t.after_evidence].map((e) => `  - ${e.document}, п. ${e.section}: «${e.text}»`).join("\n")}`,
      ),
      "",
      "## Выводы и рекомендации",
      ...findings.map(
        (f) =>
          `### ${f.title}\nСтатус: ${f.verification_status}. Уверенность сопоставления: ${Math.round(f.confidence * 100)}%.\n${f.explanation}\n\nРекомендация: ${f.recommendation}\n\n${[...f.before_evidence, ...f.after_evidence].map((e) => `- ${e.document}, п. ${e.section}: «${e.text}»`).join("\n")}${f.after_evidence.length ? "" : "\nИсточник AFTER отсутствует; вывод требует экспертной проверки."}\n`,
      ),
      "",
      "## Покрытие источниками",
      `${referenced}/${findings.length} выводов имеют хотя бы один исходный фрагмент. Подтверждено: ${verified}/${findings.length}. Наличие цитаты не равно подтверждению вывода.`,
      "",
      "## Ограничения",
      "Потенциальный конфликт не доказывает нарушение. Отсутствие сопоставления не доказывает потерю функции. Confidence — оценка сопоставления, не калиброванная вероятность. Заключение собрано по шаблону из результата анализа; требуется экспертная проверка.",
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + lines.join("\n")], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `OrgLens-${analysis.analysis_id.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!generated)
    return (
      <section className="conclusion-start panel">
        <div className="large-icon">
          <FileCheck2 size={30} />
        </div>
        <span className="eyebrow">ОТ АНАЛИЗА К РЕШЕНИЮ</span>
        <h2>Вся картина. Одно заключение.</h2>
        <p>
          Основные изменения, риски и рекомендуемые действия — с привязкой к
          документальным источникам.
        </p>
        <button className="button primary" onClick={onGenerate}>
          <Sparkles size={17} /> Сформировать заключение
        </button>
        <small>
          Формируется из результатов анализа. Неподтверждённые выводы сохраняют
          свой статус.
        </small>
      </section>
    );
  return (
    <section className="conclusion panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">ANALYTICAL CONCLUSION</div>
          <h2>Аналитическое заключение</h2>
        </div>
        <button className="button secondary" onClick={download}>
          <Download size={16} /> Скачать заключение
        </button>
      </div>
      <div className="report-meta">
        <FileText size={15} /> {analysis.before_document}
        <span>→</span>
        {analysis.after_document}
        <span className="status-pill verified">
          {demo ? "Демонстрационный отчёт" : analysis.analysis_id}
        </span>
      </div>
      <div className="executive-summary">
        <h3>Краткое резюме</h3>
        <p>{executive}</p>
      </div>
      <div className="report-section">
        <h3>Основные преобразования</h3>
        {analysis.transformations.length ? (
          analysis.transformations.map((t) => (
            <div className="report-transformation" key={t.id}>
              <span className="report-dot" />
              <div>
                <button className="report-source-button" onClick={() => onTransformation(t)}>
                  {name(t.before_unit)} → {name(t.after_unit)}
                  <ArrowUpRight size={13} />
                </button>
                <p>{t.explanation}</p>
                <small>
                  {transformationLabels[t.type]} ·{" "}
                  {t.verification_status === "VERIFIED"
                    ? "Подтверждено источниками"
                    : "Требует проверки"}
                </small>
              </div>
            </div>
          ))
        ) : (
          <p>Преобразования подразделений не обнаружены.</p>
        )}
      </div>
      {(
        [
          ["LOST", "Потерянные функции"],
          ["DUPLICATED", "Дублирование ответственности"],
          ["CONFLICT", "Потенциальные конфликты"],
        ] as const
      ).map(([type, title]) => (
        <div className="report-section" key={type}>
          <h3>{title}</h3>
          {findings.filter((f) => f.type === type).length ? (
            findings
              .filter((f) => f.type === type)
              .map((f) => (
                <button
                  className="report-finding"
                  key={f.id}
                  onClick={() => onEvidence(f)}
                >
                  <span>
                    <strong>{f.title}</strong>
                    <span>{f.explanation}</span>
                  </span>
                  <span
                    className={`status-pill ${f.verification_status === "VERIFIED" ? "verified" : "review"}`}
                  >
                    {f.verification_status === "VERIFIED" ? (
                      <ShieldCheck size={14} />
                    ) : (
                      <TriangleAlert size={14} />
                    )}
                    {f.verification_status === "VERIFIED"
                      ? "Подтверждено"
                      : "Проверить"}
                  </span>
                </button>
              ))
          ) : (
            <p className="muted">В текущем анализе не выявлены.</p>
          )}
        </div>
      ))}
      <div className="report-section">
        <h3>Рекомендуемые действия</h3>
        {findings.length ? (
          <ol className="recommendation-list">
            {findings.map((f) => (
              <li key={f.id}>
                <button onClick={() => onEvidence(f)}>
                  {f.recommendation}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            Дополнительные действия не предложены. Отсутствие выводов не
            гарантирует отсутствия рисков.
          </p>
        )}
      </div>
      <div className="coverage-box">
        <ShieldCheck size={25} />
        <div>
          <strong>
            Покрытие источниками: {referenced} из {findings.length} выводов
          </strong>
          <p>
            Подтверждено: {verified}. Требуют проверки:{" "}
            {findings.length - verified}. Наличие цитаты не означает, что вывод
            полностью подтверждён.
          </p>
        </div>
      </div>
      <p className="report-disclaimer">
        {demo && "Учебный сценарий на синтетических данных. "}Заключение собрано
        по шаблону из результатов анализа. Потенциальные риски требуют оценки
        экспертом.
      </p>
    </section>
  );
}
