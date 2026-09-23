import {
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ArrowRight,
  Building2,
  GitBranch,
  Info,
  MousePointer2,
  Network,
} from "lucide-react";
import type { AnalysisResult, Transformation, Unit } from "../types";
import "./TransformationGraph.css";

type ChangeType = Transformation["type"];

const changeStyles: Record<
  ChangeType,
  { label: string; color: string; background: string }
> = {
  PRESERVED: {
    label: "Без изменений",
    color: "#679583",
    background: "#edf4f0",
  },
  CREATED: { label: "Создано", color: "#239872", background: "#e8f7ef" },
  REMOVED: { label: "Удалено", color: "#c3726b", background: "#fcf0ee" },
  RENAMED: { label: "Переименовано", color: "#6a88bd", background: "#edf2fc" },
  SPLIT: { label: "Разделено", color: "#ad8a44", background: "#fbf4e5" },
  MERGED: { label: "Объединено", color: "#9075af", background: "#f3eef9" },
};

const changeTypes = Object.keys(changeStyles) as ChangeType[];

function matchesUnit(reference: string | null, unit: Unit) {
  return (
    reference !== null && (reference === unit.id || reference === unit.name)
  );
}

function functionLabel(count: number) {
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "функций";
  if (count % 10 === 1) return "функция";
  if (count % 10 >= 2 && count % 10 <= 4) return "функции";
  return "функций";
}

export interface TransformationGraphProps {
  analysis: AnalysisResult;
  onSelect: (transformation: Transformation) => void;
}

export default function TransformationGraph({
  analysis,
  onSelect,
}: TransformationGraphProps) {
  const graphId = useId().replace(/:/g, "");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ChangeType | null>(null);
  const beforeUnits = useMemo(
    () => analysis.units.filter((unit) => unit.revision === "before"),
    [analysis.units],
  );
  const afterUnits = useMemo(
    () => analysis.units.filter((unit) => unit.revision === "after"),
    [analysis.units],
  );
  const rowCount = Math.max(beforeUnits.length, afterUnits.length, 1);
  const canvasHeight = Math.max(280, rowCount * 94 + 10);
  const counts = useMemo(() => {
    const result = Object.fromEntries(
      changeTypes.map((type) => [type, 0]),
    ) as Record<ChangeType, number>;
    analysis.transformations.forEach((transformation) => {
      result[transformation.type] += 1;
    });
    return result;
  }, [analysis.transformations]);

  const position = (index: number, count: number) =>
    count <= 1
      ? canvasHeight / 2
      : 58 + (index * (canvasHeight - 116)) / (count - 1);

  const select = (transformation: Transformation) => {
    setSelectedId(transformation.id);
    onSelect(transformation);
  };

  const handleEdgeKey = (
    event: KeyboardEvent<SVGGElement>,
    transformation: Transformation,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(transformation);
    }
  };

  const renderUnit = (unit: Unit, index: number, sideUnits: Unit[]) => {
    const related = analysis.transformations.filter((transformation) =>
      matchesUnit(
        unit.revision === "before"
          ? transformation.before_unit
          : transformation.after_unit,
        unit,
      ),
    );
    const visibleRelated = typeFilter
      ? related.filter((transformation) => transformation.type === typeFilter)
      : related;
    const primary =
      visibleRelated.find(
        (transformation) => transformation.id === selectedId,
      ) ?? visibleRelated[0];
    const selected = related.some(
      (transformation) => transformation.id === selectedId,
    );
    const dimmed = typeFilter !== null && visibleRelated.length === 0;
    const color = primary ? changeStyles[primary.type].color : "#83968e";

    return (
      <button
        key={`${unit.revision}-${unit.id}`}
        type="button"
        className={`graph-unit graph-unit--${unit.revision}${selected ? " graph-unit--selected" : ""}${dimmed ? " graph-unit--dimmed" : ""}`}
        style={
          {
            top: position(index, sideUnits.length) - 40,
            "--graph-unit-color": color,
          } as CSSProperties
        }
        onClick={() => primary && select(primary)}
        disabled={!primary}
        aria-label={`${unit.name}, ${unit.functions_count} ${functionLabel(unit.functions_count)}${primary ? ". Посмотреть доказательства изменения" : ". Нет сопоставлений"}`}
        aria-pressed={selected}
      >
        <span className="graph-unit-icon">
          <Building2 size={17} strokeWidth={1.65} />
        </span>
        <span className="graph-unit-copy">
          <span className="graph-unit-name">{unit.name}</span>
          <span className="graph-unit-meta">
            <Network size={12} strokeWidth={1.7} />
            {unit.functions_count} {functionLabel(unit.functions_count)}
            {unit.revision === "after" &&
              primary &&
              ["CREATED", "SPLIT", "MERGED"].includes(primary.type) && (
                <span className="graph-new-badge">Новое</span>
              )}
          </span>
        </span>
        <span className="graph-unit-indicator" aria-hidden="true" />
      </button>
    );
  };

  const hasUnits = analysis.units.length > 0;

  return (
    <section
      className="transformation-panel"
      aria-labelledby={`${graphId}-title`}
    >
      <div className="transformation-header">
        <div className="transformation-heading">
          <span className="transformation-heading-icon">
            <GitBranch size={20} strokeWidth={1.75} />
          </span>
          <div>
            <h2 id={`${graphId}-title`}>Карта изменений</h2>
            <p>Как изменилась организационная структура</p>
          </div>
        </div>
        <span className="transformation-live-label">
          <span />
          Интерактивная схема
        </span>
      </div>

      {hasUnits ? (
        <div
          className="graph-scroll"
          tabIndex={0}
          role="region"
          aria-label="Граф изменений структуры. На небольшом экране доступна горизонтальная прокрутка."
        >
          <div className="graph-content">
            <div className="graph-columns">
              <div className="graph-column-heading">
                <span className="graph-revision-label">
                  BEFORE{" "}
                  <span title={analysis.before_document}>
                    {analysis.before_document}
                  </span>
                </span>
                <span className="graph-unit-count">{beforeUnits.length}</span>
              </div>
              <div className="graph-direction" aria-hidden="true">
                <ArrowRight size={18} strokeWidth={1.5} />
              </div>
              <div className="graph-column-heading graph-column-heading--after">
                <span className="graph-revision-label">
                  AFTER{" "}
                  <span title={analysis.after_document}>
                    {analysis.after_document}
                  </span>
                </span>
                <span className="graph-unit-count">{afterUnits.length}</span>
              </div>
            </div>
            <div className="graph-canvas" style={{ height: canvasHeight }}>
              <svg
                className="graph-connections"
                viewBox={`0 0 1000 ${canvasHeight}`}
                preserveAspectRatio="none"
                aria-label="Связи между подразделениями"
              >
                {analysis.transformations.map((transformation) => {
                  const beforeIndex = beforeUnits.findIndex((unit) =>
                    matchesUnit(transformation.before_unit, unit),
                  );
                  const afterIndex = afterUnits.findIndex((unit) =>
                    matchesUnit(transformation.after_unit, unit),
                  );
                  if (beforeIndex < 0 && afterIndex < 0) return null;
                  const beforeY =
                    beforeIndex >= 0
                      ? position(beforeIndex, beforeUnits.length)
                      : position(afterIndex, afterUnits.length);
                  const afterY =
                    afterIndex >= 0
                      ? position(afterIndex, afterUnits.length)
                      : beforeY;
                  const x1 = beforeIndex >= 0 ? 336 : 420;
                  const x2 = afterIndex >= 0 ? 664 : 580;
                  const path = `M ${x1} ${beforeY} C ${x1 + (x2 - x1) * 0.48} ${beforeY}, ${x2 - (x2 - x1) * 0.48} ${afterY}, ${x2} ${afterY}`;
                  const middleY = (beforeY + afterY) / 2;
                  const middleX = (x1 + x2) / 2;
                  const appearance = changeStyles[transformation.type];
                  const isSelected = transformation.id === selectedId;
                  const isDimmed =
                    typeFilter !== null && transformation.type !== typeFilter;
                  const labelWidth = appearance.label.length * 7 + 24;
                  const from =
                    beforeIndex >= 0
                      ? beforeUnits[beforeIndex].name
                      : "Новое подразделение";
                  const to =
                    afterIndex >= 0
                      ? afterUnits[afterIndex].name
                      : "Подразделение упразднено";
                  return (
                    <g
                      key={transformation.id}
                      className={`graph-edge${isSelected ? " graph-edge--selected" : ""}${isDimmed ? " graph-edge--dimmed" : ""}`}
                      role="button"
                      tabIndex={isDimmed ? -1 : 0}
                      aria-label={`${appearance.label}: ${from} → ${to}. Посмотреть доказательства`}
                      aria-pressed={isSelected}
                      onClick={() => !isDimmed && select(transformation)}
                      onKeyDown={(event) =>
                        handleEdgeKey(event, transformation)
                      }
                      style={
                        {
                          "--graph-edge-color": appearance.color,
                        } as CSSProperties
                      }
                    >
                      <title>{`${from} → ${to}: ${appearance.label}`}</title>
                      <path className="graph-edge-hitbox" d={path} />
                      <path
                        className="graph-edge-line"
                        d={path}
                        stroke={appearance.color}
                        strokeDasharray={
                          transformation.type === "REMOVED" ||
                          transformation.type === "CREATED"
                            ? "5 5"
                            : undefined
                        }
                      />
                      <circle
                        className="graph-edge-endpoint"
                        cx={x1}
                        cy={beforeY}
                        r={3.5}
                        fill="white"
                        stroke={appearance.color}
                        strokeWidth={1.7}
                      />
                      <circle
                        className="graph-edge-endpoint"
                        cx={x2}
                        cy={afterY}
                        r={3.5}
                        fill="white"
                        stroke={appearance.color}
                        strokeWidth={1.7}
                      />
                      <rect
                        className="graph-edge-label-background"
                        x={middleX - labelWidth / 2}
                        y={middleY - 12}
                        width={labelWidth}
                        height={24}
                        rx={12}
                        fill={appearance.background}
                        stroke={appearance.color}
                        strokeOpacity={0.14}
                      />
                      <text
                        className="graph-edge-label"
                        x={middleX}
                        y={middleY + 0.5}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill={appearance.color}
                      >
                        {appearance.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
              {beforeUnits.map((unit, index) =>
                renderUnit(unit, index, beforeUnits),
              )}
              {afterUnits.map((unit, index) =>
                renderUnit(unit, index, afterUnits),
              )}
              {beforeUnits.length === 0 && (
                <div className="graph-side-empty graph-side-empty--before">
                  Нет подразделений
                  <br />
                  <span>в исходной редакции</span>
                </div>
              )}
              {afterUnits.length === 0 && (
                <div className="graph-side-empty graph-side-empty--after">
                  Нет подразделений
                  <br />
                  <span>в новой редакции</span>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="graph-empty">
          <Network size={32} strokeWidth={1.4} />
          <strong>Карта пока пуста</strong>
          <span>Подразделения появятся здесь после анализа документов.</span>
        </div>
      )}

      <div className="graph-legend" aria-label="Фильтр по типу изменения">
        <span className="graph-legend-label">Типы связей</span>
        <div className="graph-legend-items">
          {changeTypes.map((type) => (
            <button
              type="button"
              key={type}
              className={`graph-legend-item${typeFilter === type ? " graph-legend-item--active" : ""}`}
              style={
                {
                  "--graph-legend-color": changeStyles[type].color,
                  "--graph-legend-background": changeStyles[type].background,
                } as CSSProperties
              }
              aria-pressed={typeFilter === type}
              aria-label={`${changeStyles[type].label}: ${counts[type]}. ${typeFilter === type ? "Сбросить фильтр" : "Показать связи этого типа"}`}
              disabled={counts[type] === 0}
              onClick={() =>
                setTypeFilter((current) => (current === type ? null : type))
              }
            >
              <span className="graph-legend-dot" />
              {changeStyles[type].label}
              <span className="graph-legend-count">{counts[type]}</span>
            </button>
          ))}
        </div>
        {typeFilter && (
          <button
            className="graph-reset-filter"
            type="button"
            onClick={() => setTypeFilter(null)}
          >
            Показать все
          </button>
        )}
      </div>
      <div className="graph-footer">
        <MousePointer2 size={13} strokeWidth={1.7} />
        <span>
          Нажмите на подразделение или связь, чтобы увидеть доказательства
        </span>
        <Info
          className="graph-footer-info"
          size={14}
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </div>
    </section>
  );
}
