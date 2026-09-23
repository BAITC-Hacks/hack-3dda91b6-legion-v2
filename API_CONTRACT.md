# Контракт frontend ↔ CORE

API CORE описан в [docs/API.md](docs/API.md) и `backend/schemas.py`. Существующий сервис `validateAnalysisResponse` в [src/services/analysis.ts](src/services/analysis.ts) принимает этот ответ и преобразует его в модель UI из [src/types.ts](src/types.ts). Backend wire format сохранён.

## Адаптация CORE в checkpoint-1

| Поле CORE | Представление в UI |
| --- | --- |
| `units[].document`, `functions` | `revision` по имени документа; `functions_count` равен числу реально извлечённых функций/полномочий, включая новые функции без соответствия BEFORE |
| `transformations[].evidence` | Разделение источников по BEFORE/AFTER; стабильный в пределах результата ID строки |
| `function_matches[].before_function / after_function` | Разрешение ID через `units[].functions`, названия функций и владельцы; ID строки для навигации UI |
| `findings` | Сохранение всех типов, включая `OVERLAP`; источники, confidence и verification_status не изменяются |
| `findings` без `function_ids` | Ссылки на строки сопоставления добавляются только по совпадению основного `clause_id`; пустой список допустим для новых функций и самостоятельных семантических выводов |
| `summary` | Числа CORE сохраняются: created_units только CREATED; moved/lost по уникальным BEFORE function ID; duplications по findings DUPLICATED |
| `summary.conclusion` | Существующий блок резюме и скачиваемый Markdown используют исходное заключение backend |

`DUPLICATED`, `OVERLAP` и `CONFLICT` могут иметь только AFTER evidence; отсутствие BEFORE не заполняется выдуманной цитатой. `section=null` отображается как «Без номера пункта». Неизвестные ID, неверная сторона источника и несогласованные счётчики отклоняются. Адаптер не повышает `NEEDS_REVIEW` до `VERIFIED`.

Описанные далее строгие связи и счётчики относятся к **внутренней модели PRODUCT/demo**, которая продолжает поддерживаться без изменения данных. Полный пример — [src/data/demo.json](src/data/demo.json); все документы и цитаты в нём синтетические. Применение этих правил напрямую к CORE без адаптации неверно.

## Запрос и режимы

`POST {VITE_API_BASE_URL}/api/analyze`, тело `multipart/form-data`: файлы `before_file` и `after_file`. Заголовок `Content-Type` с boundary устанавливает браузер. UI допускает непустые `.docx` размером не более `10 * 1024 * 1024` байт каждый; это проверка расширения и размера, не содержимого.

- По умолчанию включён реальный API; только `VITE_USE_MOCK=true` включает автономный mock. `VITE_API_BASE_URL` по умолчанию пуст: текущий origin с Vite dev/preview proxy на `http://127.0.0.1:8000`. Например, `http://localhost:8000` даёт `http://localhost:8000/api/analyze`.
- «Загрузить демодокументы» всегда выбирает локальный JSON, включая API-режим. Обычные пользовательские файлы в mock не анализируются, кнопка запуска отключена.
- Успех: HTTP 2xx и **сам объект `AnalysisResult`** в JSON, без оболочки `data`. Асинхронные job ID, polling и streaming не поддерживаются. Таймаут — 45 секунд; сброс отменяет запрос.
- HTTP не-2xx и сетевые ошибки показываются как недоступность сервиса. Невалидный JSON или нарушение контракта — как некорректный ответ. Тело ошибки сервера отдельно не разбирается. Авторизационные заголовки адаптер не добавляет; для отдельного origin серверу нужен CORS.

## Точные типы ответа

Все перечисленные поля обязательны. Массивы передаются как `[]`, не `null`. Исключение для `null` — стороны преобразования, описанные ниже.

```ts
type VerificationStatus = 'VERIFIED' | 'NEEDS_REVIEW'
type TransformationType = 'PRESERVED' | 'CREATED' | 'REMOVED' | 'RENAMED' | 'SPLIT' | 'MERGED'
type FunctionStatus = 'PRESERVED' | 'MOVED' | 'CHANGED' | 'LOST' | 'DUPLICATED'
type FindingType = 'LOST' | 'MOVED' | 'DUPLICATED' | 'OVERLAP' | 'CONFLICT' | 'CREATED'
type Severity = 'INFO' | 'MEDIUM' | 'HIGH'

interface Evidence {
  document: string
  section: string | null
  text: string
}
interface Unit {
  id: string
  name: string
  revision: 'before' | 'after'
  functions_count: number
}
interface Transformation {
  id: string
  before_unit: string | null
  after_unit: string | null
  type: TransformationType
  confidence: number
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  explanation: string
  verification_status: VerificationStatus
}
interface FunctionMatch {
  id: string
  name: string
  before_owner: string[]
  after_owner: string[]
  status: FunctionStatus
  confidence: number
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  explanation: string
  recommendation: string
  verification_status: VerificationStatus
}
interface Finding {
  id: string
  type: FindingType
  severity: Severity
  title: string
  explanation: string
  confidence: number
  verification_status: VerificationStatus
  before_evidence: Evidence[]
  after_evidence: Evidence[]
  recommendation: string
  function_ids: string[]
}
interface AnalysisSummary {
  units_before: number
  units_after: number
  created_units: number
  removed_units: number
  moved_functions: number
  lost_functions: number
  duplications: number
  potential_conflicts: number
}
interface AnalysisResult {
  analysis_id: string
  before_document: string
  after_document: string
  units: Unit[]
  transformations: Transformation[]
  function_matches: FunctionMatch[]
  findings: Finding[]
  summary: AnalysisSummary
}
```

В сравнении с исходным эскизом контракта UI требует дополнительные поля: ID, основания, объяснение и статус проверки у преобразований; полную структуру подразделений и сопоставлений функций; `function_ids` у выводов. `before_unit` / `after_unit` и массивы владельцев содержат **ID подразделений**, не их названия. Вывод ссылается на `FunctionMatch.id`.

## Что проверяет валидатор

Все строки непустые после `trim`; значения enum чувствительны к регистру. `confidence` — конечное число в `[0, 1]`; счётчики — безопасные целые неотрицательные числа. ID уникален внутри каждого из четырёх массивов сущностей; ID подразделений уникальны сразу для обеих редакций. Ссылки на подразделения должны существовать и соответствовать стороне `before` / `after`.

Каждая цитата имеет непустые `document`, `section`, `text`. В `before_evidence` имя документа точно равно `before_document`, в `after_evidence` — `after_document`. UI не проверяет текст цитаты по исходному файлу — это ответственность CORE.

| Сущность | Обязательные связи и основания |
| --- | --- |
| `Transformation: CREATED` | `before_unit: null`; существующий `after_unit` и непустой `after_evidence`. `before_evidence` может быть пустым. |
| `Transformation: REMOVED` | Существующий `before_unit`, непустой `before_evidence`, `after_unit: null`. При пустом `after_evidence` разрешён только `NEEDS_REVIEW`. |
| Остальные преобразования | Существующие ID и непустые основания с обеих сторон. `SPLIT` передаётся несколькими рёбрами от одного BEFORE к разным AFTER, `MERGED` — от разных BEFORE к одному AFTER. |
| Любой `FunctionMatch` | Минимум один владелец BEFORE и одна цитата BEFORE. ID владельцев не повторяются внутри каждой стороны. |
| `FunctionMatch: LOST` | `after_owner: []`. Если `after_evidence: []`, статус только `NEEDS_REVIEW`. |
| Остальные функции | Минимум один владелец и одна цитата AFTER; для `DUPLICATED` минимум два разных владельца AFTER. |
| Любой `Finding` | Хотя бы одна цитата суммарно; `function_ids` содержит существующие ID без повторов. У всех типов, кроме `CREATED`, нужна хотя бы одна ссылка на функцию. |
| `Finding: MOVED / DUPLICATED` | Непустые основания с обеих сторон; статус каждой связанной функции равен типу вывода. |
| `Finding: LOST` | Непустой BEFORE; при пустом AFTER — только `NEEDS_REVIEW`; каждая связанная функция имеет статус `LOST`. |
| `Finding: CONFLICT` | Непустой AFTER и всегда `NEEDS_REVIEW`; статусы связанных функций могут различаться. |
| `Finding: CREATED` | Непустой AFTER; `function_ids` допускает `[]`. |

У таблицы функций нет статуса `CREATED`: текущий контракт требует BEFORE для каждой строки. Для новых объектов предусмотрен вывод `CREATED`; отдельное сопоставление совершенно новой функции потребует расширения контракта.

## Правила счётчиков

| Поле | Точное правило |
| --- | --- |
| `units[].functions_count` | Число строк `function_matches`, где ID подразделения присутствует в массиве владельцев своей редакции. Дублируемая функция учитывается у каждого владельца. |
| `summary.units_before / units_after` | Число элементов `units` с соответствующей `revision`. |
| `summary.created_units` | Число уникальных `after_unit` среди преобразований `CREATED`, `SPLIT`, `MERGED`. Поэтому разделение на два подразделения даёт `2`, даже без рёбер `CREATED`. |
| `summary.removed_units` | Число уникальных `before_unit` только среди преобразований `REMOVED`. Источники `SPLIT` и `MERGED` автоматически сюда не входят. |
| `summary.moved_functions / lost_functions / duplications` | Число строк функций со статусом `MOVED` / `LOST` / `DUPLICATED`. Это не число выводов и не число владельцев. |
| `summary.potential_conflicts` | Число выводов `findings` с типом `CONFLICT`. |

Любое расхождение со счётчиками делает весь ответ некорректным. Пустые массивы допустимы при согласованных нулевых итогах. Дополнительные поля не запрещены. Валидатор проверяет структуру и согласованность, но не полноту анализа, смысл цитат или доказанность выводов; число рёбер `SPLIT` / `MERGED` отдельно не проверяется.

В заключении «Покрытие источниками» — число выводов хотя бы с одной цитатой; `VERIFIED` подсчитывается отдельно. Поскольку валидатор требует источник у каждого вывода, валидный непустой ответ имеет полное покрытие цитатами, но может содержать `NEEDS_REVIEW`. Для проверки адаптера используйте `npm test`; для полного потока — `npm run build` и `npm run test:e2e`. Backend входит в текущий проект.
