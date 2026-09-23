import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  FileCheck2,
  FileText,
  GitBranch,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import {
  analyzeDocuments,
  ACTIVITY_STEPS,
  AnalysisError,
  USE_MOCK,
} from "./services/analysis";
import type {
  AnalysisResult,
  Finding,
  FunctionMatch,
  Transformation,
} from "./types";
import TransformationGraph from "./components/TransformationGraph";
import { EvidenceDrawer } from "./components/EvidenceDrawer";
import type { EvidenceDetail } from "./components/EvidenceDrawer";
import { Conclusion } from "./components/Conclusion";

type View = "documents" | "overview" | "functions" | "findings" | "conclusion";
type FileSlot = { name: string; file: File | null };
const functionLabels: Record<string, string> = {
  PRESERVED: "Сохранена",
  MOVED: "Передана",
  CHANGED: "Изменена",
  LOST: "Потеряна",
  DUPLICATED: "Дублируется",
};
const findingLabels: Record<string, string> = {
  LOST: "Потеря функции",
  MOVED: "Передача",
  DUPLICATED: "Дублирование",
  OVERLAP: "Пересечение ответственности",
  CONFLICT: "Конфликт интересов",
  CREATED: "Появление функции или подразделения",
};
const transformationLabels: Record<string, string> = {
  PRESERVED: "Подразделение сохранено",
  CREATED: "Создано подразделение",
  REMOVED: "Подразделение упразднено",
  RENAMED: "Подразделение переименовано",
  SPLIT: "Разделение подразделения",
  MERGED: "Объединение подразделений",
};
const navItems = [
  { id: "documents", label: "Документы", icon: FileText },
  { id: "overview", label: "Обзор изменений", icon: LayoutDashboard },
  { id: "functions", label: "Сравнение функций", icon: GitBranch },
  { id: "findings", label: "Риски и выводы", icon: ShieldCheck },
  { id: "conclusion", label: "Заключение", icon: FileCheck2 },
] as const;

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal-error">
          <TriangleAlert size={40} />
          <h1>Не удалось отобразить анализ</h1>
          <p>Перезагрузите страницу и повторите демонстрацию.</p>
          <button
            className="button primary"
            onClick={() => window.location.reload()}
          >
            Начать заново
          </button>
        </main>
      );
    return this.props.children;
  }
}

function UploadCard({
  side,
  value,
  onFile,
  onRemove,
  demo,
}: {
  side: "before" | "after";
  value: FileSlot | null;
  onFile: (file: File) => void;
  onRemove: () => void;
  demo: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const before = side === "before";
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.[0]) onFile(event.target.files[0]);
    event.target.value = "";
  };
  return (
    <div
      className={`upload-card ${value ? "has-file" : ""} ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      }}
    >
      <div className="upload-card-top">
        <span className={`revision-tag ${before ? "" : "after"}`}>
          {before ? "01 / BEFORE" : "02 / AFTER"}
        </span>
        <span>{before ? "Текущая структура" : "Новая структура"}</span>
      </div>
      <div className={`upload-file-icon ${value ? "selected" : ""}`}>
        {value ? <FileCheck2 size={28} /> : <Upload size={26} />}
      </div>
      <h3>
        {value
          ? value.name
          : before
            ? "До реорганизации"
            : "После реорганизации"}
      </h3>
      <p>
        {value
          ? demo
            ? "Демонстрационный документ · синтетические данные"
            : `${Math.max(1, Math.round((value.file?.size ?? 0) / 1024))} КБ · готов к отправке`
          : "Перетащите документ или выберите файл"}
      </p>
      <input
        ref={input}
        type="file"
        accept=".docx"
        aria-label={
          before ? "Документ до реорганизации" : "Документ после реорганизации"
        }
        onChange={pick}
        hidden
      />
      <div className="upload-card-actions">
        <button
          className="button secondary"
          onClick={() => input.current?.click()}
        >
          {value ? "Заменить документ" : "Выбрать документ"}
        </button>
        {value && (
          <button
            className="icon-button"
            onClick={onRemove}
            aria-label={
              before ? "Удалить документ до" : "Удалить документ после"
            }
          >
            <X size={17} />
          </button>
        )}
      </div>
      <span className="upload-formats">
        {value ? (
          <>
            <Check size={12} /> Документ выбран
          </>
        ) : (
          "DOCX · до 10 МБ"
        )}
      </span>
    </div>
  );
}

function FunctionTable({
  analysis,
  onSelect,
}: {
  analysis: AnalysisResult;
  onSelect: (row: FunctionMatch) => void;
}) {
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const owner = (ids: string[]) =>
    ids
      .map((id) => analysis.units.find((unit) => unit.id === id)?.name ?? id)
      .join(" / ") || "Не назначен";
  const rows = analysis.function_matches.filter(
    (row) =>
      (filter === "ALL" || row.status === filter) &&
      `${row.name} ${owner(row.before_owner)} ${owner(row.after_owner)}`
        .toLocaleLowerCase("ru")
        .includes(query.toLocaleLowerCase("ru")),
  );
  return (
    <section className="panel function-panel">
      <div className="panel-heading">
        <div>
          <h2>
            Сопоставление функций{" "}
            <span className="count-badge">
              {analysis.function_matches.length}
            </span>
          </h2>
          <p>От ответственности — к конкретному владельцу</p>
        </div>
        <span className="subtle-label">
          <ArrowUpRight size={15} /> Нажмите на строку для проверки
        </span>
      </div>
      <div className="table-controls">
        <div className="filter-tabs" aria-label="Статус функции">
          {[["ALL", "Все функции"], ...Object.entries(functionLabels)].map(
            ([key, label]) => (
              <button
                key={key}
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
                aria-pressed={filter === key}
              >
                {label}
              </button>
            ),
          )}
        </div>
        <label className="search-field">
          <Search size={16} />
          <input
            placeholder="Найти функцию…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Поиск функций"
          />
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Функция</th>
              <th>Владелец до</th>
              <th>Владелец после</th>
              <th>Статус</th>
              <th>Уверенность</th>
              <th>
                <span className="sr-only">Источники</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} onClick={() => onSelect(row)}>
                <td>
                  <button
                    className="function-name"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(row);
                    }}
                  >
                    {row.name}
                  </button>
                  {row.verification_status === "NEEDS_REVIEW" && (
                    <span className="row-review">
                      <TriangleAlert size={11} /> Требует проверки
                    </span>
                  )}
                </td>
                <td>{owner(row.before_owner)}</td>
                <td className={!row.after_owner.length ? "lost-owner" : ""}>
                  {owner(row.after_owner)}
                </td>
                <td>
                  <span
                    className={`status-pill status-${row.status.toLowerCase()}`}
                  >
                    {functionLabels[row.status]}
                  </span>
                </td>
                <td>
                  <span className="table-confidence">
                    <span
                      style={
                        {
                          "--confidence": `${row.confidence * 100}%`,
                        } as CSSProperties
                      }
                    />
                    {Math.round(row.confidence * 100)}%
                  </span>
                </td>
                <td>
                  <ArrowUpRight size={16} className="muted" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <div className="empty-state">
          <Search size={27} />
          <h3>Функции не найдены</h3>
          <p>
            {analysis.function_matches.length
              ? "Измените фильтр или поисковый запрос."
              : "В ответе анализа нет сопоставленных функций."}
          </p>
          {analysis.function_matches.length > 0 && (
            <button
              className="text-button"
              onClick={() => {
                setQuery("");
                setFilter("ALL");
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      )}
      <div className="table-footer">
        <span>
          Показано {rows.length} из {analysis.function_matches.length} функций
        </span>
        <span>
          <ShieldCheck size={13} /> Источник доступен для каждой строки
        </span>
      </div>
    </section>
  );
}

function Findings({
  analysis,
  onSelect,
  compact = false,
  onAll,
}: {
  analysis: AnalysisResult;
  onSelect: (finding: Finding) => void;
  compact?: boolean;
  onAll?: () => void;
}) {
  const [filter, setFilter] = useState("ALL");
  const filtered = analysis.findings.filter(
    (f) => filter === "ALL" || f.type === filter,
  );
  const rows = compact
    ? [...analysis.findings]
        .sort(
          (a, b) =>
            Number(b.severity === "HIGH") - Number(a.severity === "HIGH"),
        )
        .slice(0, 3)
    : filtered;
  return (
    <section
      className={`panel findings-panel ${compact ? "compact-findings" : ""}`}
    >
      <div className="panel-heading">
        <div>
          <h2>
            {compact ? "Требуют внимания" : "Риски и выводы"}{" "}
            <span className="count-badge">{analysis.findings.length}</span>
          </h2>
          <p>
            {compact
              ? "Проверьте критичные изменения в первую очередь"
              : "Каждый вывод связан с фрагментами исходных документов"}
          </p>
        </div>
        {compact && (
          <button className="text-button" onClick={onAll}>
            Все выводы <ArrowRight size={15} />
          </button>
        )}
      </div>
      {!compact && (
        <div className="filter-tabs finding-filters" aria-label="Тип вывода">
          {[["ALL", "Все"], ...Object.entries(findingLabels)].map(
            ([key, label]) => (
              <button
                key={key}
                className={filter === key ? "active" : ""}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ),
          )}
        </div>
      )}
      <div className="finding-list">
        {rows.map((finding) => (
          <button
            className={`finding-card finding-${finding.type.toLowerCase()}`}
            key={finding.id}
            onClick={() => onSelect(finding)}
          >
            <span className="finding-icon">
              {finding.type === "DUPLICATED" ? (
                <Copy size={20} />
              ) : finding.type === "MOVED" ? (
                <ArrowUpRight size={20} />
              ) : (
                <TriangleAlert size={20} />
              )}
            </span>
            <span className="finding-body">
              <span className="finding-meta">
                <span>{findingLabels[finding.type]}</span>
                <span className="finding-id">{finding.id}</span>
              </span>
              <strong>{finding.title}</strong>
              {!compact && (
                <span className="finding-explanation">
                  {finding.explanation}
                </span>
              )}
              <span
                className={`verification-label ${finding.verification_status === "VERIFIED" ? "" : "needs-review"}`}
              >
                {finding.verification_status === "VERIFIED" ? (
                  <CheckCheck size={12} />
                ) : (
                  <TriangleAlert size={12} />
                )}
                {finding.verification_status === "VERIFIED"
                  ? "Подтверждено источниками"
                  : "Требует проверки · вывод не подтверждён"}
              </span>
            </span>
            <span className="finding-end">
              <span
                className={`severity severity-${finding.severity.toLowerCase()}`}
              >
                {finding.severity === "HIGH"
                  ? "Высокий риск"
                  : finding.severity === "MEDIUM"
                    ? "Средний риск"
                    : "Информация"}
              </span>
              <ArrowUpRight size={18} />
            </span>
          </button>
        ))}
      </div>
      {!rows.length && (
        <div className="empty-state">
          <ShieldCheck size={30} />
          <h3>
            {analysis.findings.length
              ? "В этой категории нет выводов"
              : "Существенные риски не выявлены"}
          </h3>
          <p>
            {analysis.findings.length
              ? "Выберите другую категорию."
              : "В текущем ответе нет замечаний. Это не гарантирует отсутствия рисков — проверьте полноту документов."}
          </p>
        </div>
      )}
    </section>
  );
}

function Workspace() {
  const [view, setView] = useState<View>("documents");
  const [before, setBefore] = useState<FileSlot | null>(null);
  const [after, setAfter] = useState<FileSlot | null>(null);
  const [demo, setDemo] = useState(false);
  const [analysisDemo, setAnalysisDemo] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(-1);
  const [error, setError] = useState<{ title: string; message: string } | null>(
    null,
  );
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [generated, setGenerated] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  useEffect(() => () => controller.current?.abort(), []);
  const navigate = (next: View) => {
    setView(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const reset = () => {
    controller.current?.abort();
    controller.current = null;
    setBefore(null);
    setAfter(null);
    setDemo(false);
    setAnalysis(null);
    setAnalysisDemo(false);
    setLoading(false);
    setProgress(-1);
    setError(null);
    setDetail(null);
    setGenerated(false);
    setView("documents");
    setShowHelp(false);
  };
  const loadDemo = () => {
    setBefore({ name: "revision_8.docx", file: null });
    setAfter({ name: "revision_9.docx", file: null });
    setDemo(true);
    setError(null);
  };
  const selectFile = (side: "before" | "after", file: File) => {
    if (
      !/\.docx$/i.test(file.name) ||
      file.size === 0 ||
      file.size > 10 * 1024 * 1024
    ) {
      setError({
        title: "Проверьте документ",
        message: "Выберите непустой DOCX размером до 10 МБ.",
      });
      return;
    }
    if (demo) {
      setBefore(null);
      setAfter(null);
    }
    setDemo(false);
    setError(null);
    (side === "before" ? setBefore : setAfter)({ name: file.name, file });
  };
  const analyze = async () => {
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setLoading(true);
    setProgress(-1);
    setError(null);
    setAnalysis(null);
    setGenerated(false);
    try {
      const result = await analyzeDocuments({
        beforeFile: before?.file ?? null,
        afterFile: after?.file ?? null,
        demo,
        signal: active.signal,
        onProgress: setProgress,
      });
      if (active.signal.aborted) return;
      setAnalysis(result);
      setAnalysisDemo(demo);
      setView("overview");
      window.scrollTo(0, 0);
    } catch (cause) {
      if (active.signal.aborted) return;
      const kind = cause instanceof AnalysisError ? cause.kind : "unavailable";
      setError({
        title:
          kind === "malformed"
            ? "Ответ анализа имеет неверный формат"
            : kind === "validation"
              ? "Проверьте входные данные"
              : "Сервис анализа недоступен",
        message:
          cause instanceof Error
            ? cause.message
            : "Не удалось подключиться к сервису. Повторите попытку или запустите демосценарий.",
      });
    } finally {
      if (controller.current === active) setLoading(false);
    }
  };
  const showFinding = (finding: Finding) => setDetail(finding);
  const showFunction = (row: FunctionMatch) =>
    setDetail({ ...row, title: row.name });
  const showTransformation = (transformation: Transformation) =>
    setDetail({
      ...transformation,
      title: transformationLabels[transformation.type],
      recommendation:
        "Сверьте границы ответственности и актуальность указанных пунктов в обеих редакциях документа.",
    });
  const canAnalyze = Boolean(before && after && (demo || !USE_MOCK));
  const referenced =
    analysis?.findings.filter(
      (f) => f.before_evidence.length + f.after_evidence.length > 0,
    ).length ?? 0;
  const reviews =
    analysis?.findings.filter((f) => f.verification_status === "NEEDS_REVIEW")
      .length ?? 0;
  const headerTitles: Record<View, string> = {
    documents: "Документы для анализа",
    overview: "Обзор изменений",
    functions: "Сравнение функций",
    findings: "Риски и выводы",
    conclusion: "Аналитическое заключение",
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate(analysis ? "overview" : "documents");
          }}
          aria-label="OrgLens AI — главная"
        >
          <span className="brand-symbol">
            <Network size={25} />
          </span>
          <span>
            OrgLens<span className="brand-ai">AI</span>
          </span>
        </a>
        <div className="workspace-label">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <div className="workspace-card">
          <span className="company-icon">
            <Building2 size={19} />
          </span>
          <div>
            <strong>Казахтелеком</strong>
            <span>Организационная структура</span>
          </div>
        </div>
        <div className="navigation-label">АНАЛИЗ РЕОРГАНИЗАЦИИ</div>
        <nav aria-label="Разделы анализа">
          {navItems.map((item) => (
            <button
              key={item.id}
              disabled={loading || (item.id !== "documents" && !analysis)}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "findings" && analysis && (
                <span className="nav-count">{analysis.findings.length}</span>
              )}
              {item.id === "documents" && before && after && (
                <Check size={14} />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="explainable-card">
            <ShieldCheck size={23} />
            <strong>Каждый вывод объясним</strong>
            <p>От изменения в структуре до точной цитаты в документе.</p>
            <span>
              Explainable by design <ArrowUpRight size={13} />
            </span>
          </div>
          <button
            className="help-button"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
          >
            <CircleHelp size={17} /> Как показать демо{" "}
            <ChevronRight size={15} />
          </button>
          <div className="sidebar-footer">
            <span className="online-dot" /> HackAlem AI 2026 <span>v0.1</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Рабочее пространство</span>
            <ChevronRight size={13} />
            <strong>Реорганизация</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`mode-chip ${USE_MOCK || demo || analysisDemo ? "" : "api-chip"}`}
            >
              <span />
              {USE_MOCK || demo || analysisDemo ? "Демо-режим" : "Live API"}
            </span>
            <span className="profile-avatar" title="Аналитик">
              А
            </span>
          </div>
        </header>
        <main className="main-content">
          {showHelp && (
            <section className="help-banner">
              <div>
                <strong>Демо за 2 минуты</strong>
                <p>
                  Загрузите демодокументы → запустите анализ → откройте связь на
                  графе → проверьте потерю функции → сформируйте заключение.
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setShowHelp(false)}
                aria-label="Закрыть подсказку"
              >
                <X size={18} />
              </button>
            </section>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                EXPLAINABLE ORGANIZATIONAL CHANGE AGENT
              </div>
              <h1>{loading ? "Анализируем изменения" : headerTitles[view]}</h1>
              <p>
                {view === "documents"
                  ? "Две редакции документов. Полная картина изменений."
                  : "Что изменилось, где возник риск и на чём основан каждый вывод."}
              </p>
            </div>
            {(before || after || analysis || loading) && (
              <button className="button secondary reset-button" onClick={reset}>
                <RotateCcw size={15} /> Сбросить демо
              </button>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={23} />
              <div>
                <strong>{error.title}</strong>
                <p>{error.message}</p>
                <div className="error-actions">
                  <button className="text-button" onClick={loadDemo}>
                    Загрузить демодокументы <ArrowRight size={14} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setError(null)}
                  >
                    Закрыть
                  </button>
                </div>
              </div>
            </div>
          )}
          {loading ? (
            <section className="activity-panel panel">
              <div className="activity-visual">
                <div className="activity-orbit">
                  <Network size={40} />
                </div>
                <span className="status-pill verified">
                  <LoaderCircle size={13} className="spin" />{" "}
                  {demo
                    ? "Демонстрация работы агента"
                    : "Ожидаем ответ сервиса"}
                </span>
                <h2>
                  Связываем изменения
                  <br />с их основаниями
                </h2>
                <p>
                  {demo
                    ? "Показываем этапы на подготовленном наборе данных. Это имитация обработки для демонстрации."
                    : "Документы отправляются в API. Промежуточный ход обработки неизвестен."}
                </p>
                <div className="activity-docs">
                  <FileText size={15} />
                  {before?.name}
                  <ArrowRight size={14} />
                  {after?.name}
                </div>
              </div>
              <div className="activity-trace">
                <div className="trace-heading">
                  <span>AGENT ACTIVITY</span>
                  <strong>
                    {demo
                      ? `${Math.max(0, Math.min(progress, ACTIVITY_STEPS.length))} / ${ACTIVITY_STEPS.length}`
                      : "API"}
                  </strong>
                </div>
                {demo ? (
                  <ol>
                    {ACTIVITY_STEPS.map((step, i) => (
                      <li
                        key={step}
                        className={
                          i < progress
                            ? "done"
                            : i === progress
                              ? "current"
                              : ""
                        }
                      >
                        <span>
                          {i < progress ? (
                            <Check size={13} />
                          ) : i === progress ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            String(i + 1).padStart(2, "0")
                          )}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="api-wait">
                    <LoaderCircle className="spin" size={28} />
                    <p>Анализ документов на сервере…</p>
                    <small>
                      Вы можете отменить запрос кнопкой «Сбросить демо».
                    </small>
                  </div>
                )}
                <div className="activity-progress">
                  <span
                    style={{
                      width: demo
                        ? `${Math.max(3, ((progress + 1) / ACTIVITY_STEPS.length) * 100)}%`
                        : "25%",
                    }}
                  />
                </div>
                <small className="trace-note">
                  {demo
                    ? "Журнал действий · симуляция в demo mode"
                    : "Запрос к API · без имитации этапов"}
                </small>
              </div>
            </section>
          ) : view === "documents" ? (
            <>
              <section className="upload-panel panel">
                <div className="upload-panel-heading">
                  <div>
                    <span className="step-number">01</span>
                    <h2>Сравните две редакции</h2>
                  </div>
                  <span className="subtle-label">
                    <ShieldCheck size={15} />{" "}
                    {demo || USE_MOCK
                      ? "Демо работает локально"
                      : "Файлы передаются в API"}
                  </span>
                </div>
                <div className="upload-grid">
                  <UploadCard
                    side="before"
                    value={before}
                    onFile={(file) => selectFile("before", file)}
                    onRemove={() => setBefore(null)}
                    demo={demo}
                  />
                  <div className="upload-arrow">
                    <ArrowRight size={21} />
                  </div>
                  <UploadCard
                    side="after"
                    value={after}
                    onFile={(file) => selectFile("after", file)}
                    onRemove={() => setAfter(null)}
                    demo={demo}
                  />
                </div>
                <div className="upload-bottom">
                  <div className="upload-status">
                    {before && after ? (
                      <>
                        <CheckCheck size={19} />
                        <span>
                          <strong>Обе редакции выбраны</strong>
                          <small>
                            {demo
                              ? "Готов демонстрационный набор revision 8 → revision 9"
                              : USE_MOCK
                                ? "Для анализа содержимого файлов подключите API"
                                : "Готовы к анализу"}
                          </small>
                        </span>
                      </>
                    ) : (
                      <>
                        <FileText size={20} />
                        <span>
                          <strong>Выберите документы до и после</strong>
                          <small>
                            или начните с подготовленного примера ниже
                          </small>
                        </span>
                      </>
                    )}
                  </div>
                  <button
                    className="button primary analyze-button"
                    disabled={!canAnalyze}
                    onClick={analyze}
                  >
                    <Sparkles size={17} /> Анализировать изменения{" "}
                    <ArrowRight size={16} />
                  </button>
                </div>
              </section>
              <section className="demo-banner">
                <div className="demo-banner-icon">
                  <Play size={23} />
                </div>
                <div className="demo-banner-copy">
                  <div className="eyebrow">ГОТОВЫЙ СЦЕНАРИЙ</div>
                  <h3>Увидеть изменения — за один анализ</h3>
                  <p>
                    3 → 4 подразделения, передача ответственности и скрытые
                    риски.
                    <br />
                    Синтетические документы. Работает без подключения к серверу.
                  </p>
                </div>
                <button className="button demo-button" onClick={loadDemo}>
                  {demo ? <Check size={16} /> : <Play size={16} />}
                  {demo ? "Демодокументы загружены" : "Загрузить демодокументы"}
                </button>
              </section>
              {USE_MOCK && !demo && (before || after) && (
                <div className="inline-notice">
                  <TriangleAlert size={17} />
                  <p>
                    В демо-режиме содержимое ваших файлов не анализируется. Для
                    демонстрации загрузите подготовленный набор; анализ
                    собственных документов доступен при подключении API.
                  </p>
                </div>
              )}
              <div className="value-grid">
                <div>
                  <span className="value-icon">
                    <Network size={21} />
                  </span>
                  <h3>Структура в движении</h3>
                  <p>
                    Сохранение, разделение и создание подразделений на одной
                    карте.
                  </p>
                </div>
                <div>
                  <span className="value-icon">
                    <ShieldCheck size={21} />
                  </span>
                  <h3>Риски на поверхности</h3>
                  <p>
                    Потерянные функции, дублирование и потенциальные конфликты.
                  </p>
                </div>
                <div>
                  <span className="value-icon">
                    <FileCheck2 size={21} />
                  </span>
                  <h3>Доказательства рядом</h3>
                  <p>
                    Документ, пункт и точная цитата для проверки каждого вывода.
                  </p>
                </div>
              </div>
            </>
          ) : (
            analysis && (
              <>
                <div className="analysis-context">
                  <div>
                    <span className="success-dot" />
                    <strong>Анализ завершён</strong>
                    <span className="context-divider" />
                    <FileText size={14} />
                    <span>{analysis.before_document}</span>
                    <ArrowRight size={13} />
                    <span>{analysis.after_document}</span>
                  </div>
                  <span>
                    {analysisDemo ? "Синтетический набор" : "Результат API"} ·{" "}
                    {analysis.analysis_id}
                  </span>
                </div>
                {view === "overview" && (
                  <>
                    <div className="summary-grid">
                      {[
                        {
                          label: "Подразделений до",
                          value: analysis.summary.units_before,
                          icon: Building2,
                          tone: "neutral",
                          hint: "Исходная структура",
                        },
                        {
                          label: "Подразделений после",
                          value: analysis.summary.units_after,
                          icon: Building2,
                          tone: "neutral",
                          hint: "Новая структура",
                        },
                        {
                          label: "Создано",
                          value: analysis.summary.created_units,
                          icon: Plus,
                          tone: "green",
                          hint: "Новых подразделений",
                        },
                        {
                          label: "Передано функций",
                          value: analysis.summary.moved_functions,
                          icon: ArrowUpRight,
                          tone: "blue",
                          hint: "Сменился владелец",
                        },
                        {
                          label: "Потеряно функций",
                          value: analysis.summary.lost_functions,
                          icon: ArrowDownToLine,
                          tone: "red",
                          hint: "Требуют проверки",
                        },
                        {
                          label: "Дублирований",
                          value: analysis.summary.duplications,
                          icon: Copy,
                          tone: "amber",
                          hint: "Несколько владельцев",
                        },
                        {
                          label: "Потенц. конфликтов",
                          value: analysis.summary.potential_conflicts,
                          icon: TriangleAlert,
                          tone: "red",
                          hint: "Гипотезы, не факты",
                        },
                      ].map((card) => (
                        <div
                          className={`summary-card tone-${card.tone}`}
                          key={card.label}
                        >
                          <div>
                            <span>{card.label}</span>
                            <card.icon size={16} />
                          </div>
                          <strong>
                            {card.value.toString().padStart(2, "0")}
                          </strong>
                          <small>{card.hint}</small>
                        </div>
                      ))}
                    </div>
                    <TransformationGraph
                      analysis={analysis}
                      onSelect={showTransformation}
                    />
                    <Findings
                      analysis={analysis}
                      onSelect={showFinding}
                      compact
                      onAll={() => navigate("findings")}
                    />
                    <div className="overview-bottom">
                      <div>
                        <ShieldCheck size={20} />
                        <span>
                          <strong>
                            {referenced} из {analysis.findings.length} выводов с
                            источниками
                          </strong>
                          <small>{reviews} требуют экспертной проверки</small>
                        </span>
                      </div>
                      <button
                        className="button primary"
                        onClick={() => navigate("conclusion")}
                      >
                        Перейти к заключению <ArrowRight size={16} />
                      </button>
                    </div>
                  </>
                )}
                {view === "functions" && (
                  <FunctionTable analysis={analysis} onSelect={showFunction} />
                )}
                {view === "findings" && (
                  <>
                    <div className="risk-notice">
                      <TriangleAlert size={19} />
                      <p>
                        <strong>
                          Потенциальный риск — повод для проверки.
                        </strong>{" "}
                        Потеря функции и конфликт интересов не считаются
                        установленными фактами без оценки экспертом.
                      </p>
                    </div>
                    <Findings analysis={analysis} onSelect={showFinding} />
                  </>
                )}
                {view === "conclusion" && (
                  <Conclusion
                    analysis={analysis}
                    generated={generated}
                    onGenerate={() => setGenerated(true)}
                    onEvidence={showFinding}
                    onTransformation={showTransformation}
                    demo={analysisDemo}
                  />
                )}
              </>
            )
          )}
          <footer className="page-footer">
            <span>
              OrgLens AI <span>·</span> От структуры к ясности
            </span>
            <span>
              <Layers3 size={13} /> HackAlem 2026 / Казахтелеком
            </span>
          </footer>
        </main>
      </div>
      {detail && (
        <EvidenceDrawer
          detail={detail}
          onClose={closeDetail}
          demo={analysisDemo}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Workspace />
    </ErrorBoundary>
  );
}
