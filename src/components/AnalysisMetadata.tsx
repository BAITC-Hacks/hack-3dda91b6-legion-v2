import { Check, ShieldCheck, TriangleAlert } from "lucide-react";
import type { AnalysisResult } from "../types";

// Only known actions can be shown as agent activity. Arbitrary backend text is
// never interpreted as a reasoning trace or rendered as completed work.
const actionLabels: Record<string, string> = {
  "Parsing BEFORE document": "Чтение документа BEFORE",
  "Parsing AFTER document": "Чтение документа AFTER",
  "Extracting organizational units": "Извлечение подразделений",
  "Extracting functions": "Извлечение функций",
  "Matching organizational units": "Сопоставление подразделений",
  "Comparing structure": "Сравнение структуры",
  "Comparing functions": "Сопоставление функций",
  "Checking lost functions": "Проверка потери функций",
  "Checking for lost functions": "Проверка потери функций",
  "Checking duplicated responsibilities": "Проверка дублирования ответственности",
  "Checking for duplicate responsibilities": "Проверка дублирования ответственности",
  "Checking for overlapping responsibilities and conflicts": "Проверка пересечений и конфликтов",
  "Checking duplicates/conflicts": "Проверка дублирования и конфликтов",
  "Reviewing semantic relations with OpenAI": "Проверка смысловых связей",
  "Verifying documentary evidence": "Проверка документальных оснований",
  "Verifying evidence": "Проверка документальных оснований",
  "Building analytical conclusion": "Подготовка заключения",
  "Generating analytical conclusion": "Подготовка заключения",
  "Generating conclusion": "Подготовка заключения",
};

export function AnalysisMetadata({ analysis }: { analysis: AnalysisResult }) {
  const actions = (analysis.agent_trace ?? []).flatMap(action => actionLabels[action] ? [actionLabels[action]] : []);
  return <section className="analysis-metadata panel" aria-label="Сведения о реальном анализе">
    <div className="backend-mode"><ShieldCheck size={15} /><strong>{analysis.analysis_mode === "semantic" ? "Семантический анализ" : analysis.analysis_mode === "deterministic" ? "Детерминированный анализ" : "Результат API"}</strong><span>{analysis.analysis_mode === "deterministic" ? "Текстовое сопоставление · без обращения к языковой модели" : "Выводы носят рекомендательный характер"}</span></div>
    {analysis.clauses_before !== undefined && analysis.clauses_after !== undefined && <p className="backend-coverage">Обработано фрагментов: {analysis.clauses_before} до / {analysis.clauses_after} после</p>}
    <details className="metadata-details">
      <summary>Действия сервиса · {actions.length} завершено</summary>
      <p>Этапы получены вместе с результатом. Это журнал действий, не поток промежуточных рассуждений.</p>
      {actions.length ? <ol className="completed-actions">{actions.map((action, index) => <li key={`${index}-${action}`}><Check size={13} />{action}</li>)}</ol> : <p>Сервис не передал поддерживаемый журнал действий.</p>}
    </details>
    {Boolean(analysis.warnings?.length) && <details className="metadata-details backend-warnings">
      <summary><TriangleAlert size={14} /> Ограничения анализа · {analysis.warnings!.length}</summary>
      <ul>{analysis.warnings!.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
    </details>}
  </section>;
}
