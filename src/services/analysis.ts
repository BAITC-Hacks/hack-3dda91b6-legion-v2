import demoData from '../data/demo.json'
import type { AnalysisResult, Evidence } from '../types'

export const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
// CORE allows 120 seconds without retries; leave time for parsing and evidence checks.
export const API_TIMEOUT_MS = 150_000

export const ACTIVITY_STEPS = [
  'Parsing BEFORE document',
  'Parsing AFTER document',
  'Extracting organizational units',
  'Extracting functions',
  'Matching organizational units',
  'Comparing functions',
  'Checking lost functions',
  'Checking duplicated responsibilities',
  'Verifying documentary evidence',
  'Building analytical conclusion',
]

export class AnalysisError extends Error {
  readonly kind: 'unavailable' | 'malformed' | 'validation'

  constructor(kind: AnalysisError['kind'], message: string) {
    super(message)
    this.name = 'AnalysisError'
    this.kind = kind
  }
}

type RecordValue = Record<string, unknown>
const fail = (path: string, reason: string): never => {
  throw new AnalysisError('malformed', `Некорректный ответ сервера: ${path} — ${reason}.`)
}
const object = (value: unknown, path: string): RecordValue => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'ожидался объект')
  return value as RecordValue
}
const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'ожидалась непустая строка')
  return value as string
}
const array = (value: unknown, path: string): unknown[] => {
  if (!Array.isArray(value)) fail(path, 'ожидался массив')
  return value as unknown[]
}
const enumeration = <T extends string>(value: unknown, options: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(path, 'неизвестное значение')
  return value as T
}
const confidence = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(path, 'ожидалось число от 0 до 1')
  return value as number
}
const count = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(path, 'ожидалось целое неотрицательное число')
  return value as number
}
const uniqueId = (value: unknown, seen: Set<string>, path: string): string => {
  const id = string(value, path)
  if (seen.has(id)) fail(path, 'идентификатор повторяется')
  seen.add(id)
  return id
}
const evidence = (value: unknown, document: string, path: string, core = false): Evidence[] => array(value, path).map((item, index) => {
  const sourcePath = `${path}[${index}]`
  const source = object(item, sourcePath)
  const sourceDocument = string(source.document, `${sourcePath}.document`)
  if (sourceDocument !== document) fail(`${sourcePath}.document`, 'источник не соответствует редакции документа')
  return {
    document: sourceDocument,
    section: source.section === null ? null : string(source.section, `${sourcePath}.section`),
    text: string(source.text, `${sourcePath}.text`),
    ...(core || source.clause_id !== undefined ? { clause_id: string(source.clause_id, `${sourcePath}.clause_id`) } : {}),
  }
})
const verification = (value: unknown, path: string) => enumeration(value, ['VERIFIED', 'NEEDS_REVIEW'] as const, path)

/** Validates every field consumed by the UI, including IDs, evidence and totals. */
function validateViewResponse(value: unknown, coreCounts?: Map<string, number>): AnalysisResult {
  const result = object(value, 'response')
  string(result.analysis_id, 'analysis_id')
  const beforeDocument = string(result.before_document, 'before_document')
  const afterDocument = string(result.after_document, 'after_document')
  for (const key of ['agent_trace', 'warnings']) {
    if (key in result) array(result[key], key).forEach((item, index) => string(item, `${key}[${index}]`))
  }
  for (const key of ['clauses_before', 'clauses_after']) {
    if (key in result) count(result[key], key)
  }
  const unitIds = new Set<string>()
  const unitRevision = new Map<string, 'before' | 'after'>()
  const expectedFunctionCounts = new Map<string, number>()
  const incompleteEvidence = new Set<string>()
  const requireEvidence = (sources: Evidence[], path: string, status: unknown) => {
    if (sources.length) {
      if (coreCounts && status === 'VERIFIED' && sources.some(source => source.section === null)) fail(path, 'подтверждённый источник должен содержать проверенный номер пункта')
      return
    }
    if (coreCounts && status === 'NEEDS_REVIEW') {
      incompleteEvidence.add(path)
      return
    }
    fail(path, 'нет документального подтверждения')
  }

  const units = array(result.units, 'units').map((item, index) => {
    const path = `units[${index}]`
    const unit = object(item, path)
    const id = uniqueId(unit.id, unitIds, `${path}.id`)
    string(unit.name, `${path}.name`)
    const revision = enumeration(unit.revision, ['before', 'after'] as const, `${path}.revision`)
    count(unit.functions_count, `${path}.functions_count`)
    unitRevision.set(id, revision)
    expectedFunctionCounts.set(id, 0)
    return unit
  })

  const unitReference = (value: unknown, revision: 'before' | 'after', path: string): string => {
    const id = string(value, path)
    if (unitRevision.get(id) !== revision) fail(path, 'неизвестное подразделение или неверная редакция')
    return id
  }

  const transformationIds = new Set<string>()
  const createdUnitIds = new Set<string>()
  const removedUnitIds = new Set<string>()
  array(result.transformations, 'transformations').forEach((item, index) => {
    const path = `transformations[${index}]`
    const change = object(item, path)
    uniqueId(change.id, transformationIds, `${path}.id`)
    const type = enumeration(change.type, ['PRESERVED', 'CREATED', 'REMOVED', 'RENAMED', 'SPLIT', 'MERGED'] as const, `${path}.type`)
    confidence(change.confidence, `${path}.confidence`)
    string(change.explanation, `${path}.explanation`)
    verification(change.verification_status, `${path}.verification_status`)
    if (coreCounts && change.verification_status === 'VERIFIED' && type !== 'PRESERVED') fail(path, 'CORE подтверждает только наблюдение сохранения подразделения')
    const beforeEvidence = evidence(change.before_evidence, beforeDocument, `${path}.before_evidence`, !!coreCounts)
    const afterEvidence = evidence(change.after_evidence, afterDocument, `${path}.after_evidence`, !!coreCounts)
    if (type === 'CREATED') {
      if (change.before_unit !== null) fail(`${path}.before_unit`, 'для CREATED ожидался null')
    } else {
      unitReference(change.before_unit, 'before', `${path}.before_unit`)
      requireEvidence(beforeEvidence, `${path}.before_evidence`, change.verification_status)
    }
    if (type === 'REMOVED') {
      if (change.after_unit !== null) fail(`${path}.after_unit`, 'для REMOVED ожидался null')
      removedUnitIds.add(change.before_unit as string)
      if (!afterEvidence.length && change.verification_status === 'VERIFIED') fail(path, 'удаление без прямого подтверждения требует проверки')
    } else {
      const afterId = unitReference(change.after_unit, 'after', `${path}.after_unit`)
      requireEvidence(afterEvidence, `${path}.after_evidence`, change.verification_status)
      if ((coreCounts ? ['CREATED'] : ['CREATED', 'SPLIT', 'MERGED']).includes(type)) createdUnitIds.add(afterId)
    }
  })

  const functionIds = new Set<string>()
  const functionStatuses = new Map<string, string>()
  const statusCounts: Record<string, number> = { MOVED: 0, LOST: 0, DUPLICATED: 0 }
  array(result.function_matches, 'function_matches').forEach((item, index) => {
    const path = `function_matches[${index}]`
    const match = object(item, path)
    const id = uniqueId(match.id, functionIds, `${path}.id`)
    string(match.name, `${path}.name`)
    const status = enumeration(match.status, ['PRESERVED', 'MOVED', 'CHANGED', 'LOST', 'DUPLICATED'] as const, `${path}.status`)
    functionStatuses.set(id, status)
    if (status in statusCounts) statusCounts[status] += 1
    confidence(match.confidence, `${path}.confidence`)
    string(match.explanation, `${path}.explanation`)
    string(match.recommendation, `${path}.recommendation`)
    const verified = verification(match.verification_status, `${path}.verification_status`)
    if (coreCounts && verified === 'VERIFIED' && status !== 'PRESERVED') fail(path, 'CORE подтверждает только наблюдение сохранения функции')
    const beforeEvidence = evidence(match.before_evidence, beforeDocument, `${path}.before_evidence`, !!coreCounts)
    const afterEvidence = evidence(match.after_evidence, afterDocument, `${path}.after_evidence`, !!coreCounts)
    const owners = (revision: 'before' | 'after') => {
      const ownerPath = `${path}.${revision}_owner`
      const ids = array(match[`${revision}_owner`], ownerPath).map((owner, ownerIndex) => unitReference(owner, revision, `${ownerPath}[${ownerIndex}]`))
      if (new Set(ids).size !== ids.length) fail(ownerPath, 'владелец повторяется')
      ids.forEach(owner => expectedFunctionCounts.set(owner, expectedFunctionCounts.get(owner)! + 1))
      return ids
    }
    const beforeOwners = owners('before')
    const afterOwners = owners('after')
    if (!beforeOwners.length) fail(path, 'функции требуется владелец BEFORE')
    requireEvidence(beforeEvidence, `${path}.before_evidence`, verified)
    if (status === 'LOST') {
      if (afterOwners.length) fail(`${path}.after_owner`, 'у LOST не должно быть владельца AFTER')
      if (!afterEvidence.length && verified === 'VERIFIED') fail(path, 'отсутствие функции без прямого подтверждения требует проверки')
    } else {
      if (!afterOwners.length) fail(path, 'функции требуется владелец AFTER')
      requireEvidence(afterEvidence, `${path}.after_evidence`, verified)
    }
    if (status === 'DUPLICATED' && afterOwners.length < 2) fail(path, 'для DUPLICATED требуется минимум два владельца AFTER')
  })
  units.forEach((unit, index) => {
    if (unit.functions_count !== (coreCounts ?? expectedFunctionCounts).get(unit.id as string)) fail(`units[${index}].functions_count`, 'число не соответствует таблице функций')
  })

  const findingIds = new Set<string>()
  let conflictCount = 0
  array(result.findings, 'findings').forEach((item, index) => {
    const path = `findings[${index}]`
    const finding = object(item, path)
    uniqueId(finding.id, findingIds, `${path}.id`)
    const type = enumeration(finding.type, ['LOST', 'MOVED', 'DUPLICATED', 'OVERLAP', 'CONFLICT', 'CREATED'] as const, `${path}.type`)
    enumeration(finding.severity, ['INFO', 'MEDIUM', 'HIGH'] as const, `${path}.severity`)
    string(finding.title, `${path}.title`)
    string(finding.explanation, `${path}.explanation`)
    string(finding.recommendation, `${path}.recommendation`)
    confidence(finding.confidence, `${path}.confidence`)
    const verified = verification(finding.verification_status, `${path}.verification_status`)
    if (coreCounts && verified !== 'NEEDS_REVIEW') fail(path, 'вывод CORE требует экспертной проверки')
    const beforeEvidence = evidence(finding.before_evidence, beforeDocument, `${path}.before_evidence`, !!coreCounts)
    const afterEvidence = evidence(finding.after_evidence, afterDocument, `${path}.after_evidence`, !!coreCounts)
    requireEvidence([...beforeEvidence, ...afterEvidence], `${path}.evidence`, verified)
    if ((coreCounts ? ['MOVED'] : ['MOVED', 'DUPLICATED']).includes(type)) {
      requireEvidence(beforeEvidence, `${path}.before_evidence`, verified)
      requireEvidence(afterEvidence, `${path}.after_evidence`, verified)
    }
    if (['DUPLICATED', 'OVERLAP', 'CREATED'].includes(type)) requireEvidence(afterEvidence, `${path}.after_evidence`, verified)
    if (type === 'LOST') {
      requireEvidence(beforeEvidence, `${path}.before_evidence`, verified)
      if (!afterEvidence.length && verified === 'VERIFIED') fail(path, 'отсутствие функции требует статуса проверки')
    }
    if (type === 'CONFLICT') {
      conflictCount += 1
      if (verified !== 'NEEDS_REVIEW') fail(path, 'потенциальный конфликт требует проверки специалистом')
      requireEvidence(afterEvidence, `${path}.after_evidence`, verified)
    }
    const references = array(finding.function_ids, `${path}.function_ids`).map((reference, referenceIndex) => {
      const id = string(reference, `${path}.function_ids[${referenceIndex}]`)
      if (!functionIds.has(id)) fail(`${path}.function_ids`, 'ссылка на неизвестную функцию')
      if (!coreCounts && ['LOST', 'MOVED', 'DUPLICATED'].includes(type) && functionStatuses.get(id) !== type) fail(`${path}.function_ids`, 'статус функции не соответствует выводу')
      return id
    })
    if (new Set(references).size !== references.length) fail(`${path}.function_ids`, 'ссылка повторяется')
    if (!coreCounts && type !== 'CREATED' && !references.length) fail(`${path}.function_ids`, 'выводу требуется ссылка на функцию')
  })

  const summary = object(result.summary, 'summary')
  if (summary.conclusion !== undefined) string(summary.conclusion, 'summary.conclusion')
  if ('analytical_note' in summary && summary.analytical_note !== null) string(summary.analytical_note, 'summary.analytical_note')
  const noteSources = 'note_evidence' in summary ? array(summary.note_evidence, 'summary.note_evidence') : []
  noteSources.forEach((item, index) => {
    const path = `summary.note_evidence[${index}]`
    const source = object(item, path)
    if (source.document !== beforeDocument && source.document !== afterDocument) fail(path, 'неизвестный документ источника')
    evidence([source], source.document as string, path, !!coreCounts)
  })
  if ('note_verification_status' in summary) {
    const status = verification(summary.note_verification_status, 'summary.note_verification_status')
    if (status === 'VERIFIED' && (!summary.analytical_note || !noteSources.length)) fail('summary.note_verification_status', 'подтверждённой оценке требуются текст и исходные фрагменты')
  }
  for (const key of ['overlaps', 'verified_findings', 'needs_review_findings']) {
    if (key in summary) count(summary[key], `summary.${key}`)
  }
  const expectedSummary = {
    units_before: units.filter(unit => unit.revision === 'before').length,
    units_after: units.filter(unit => unit.revision === 'after').length,
    created_units: createdUnitIds.size,
    removed_units: removedUnitIds.size,
    moved_functions: coreCounts ? new Set(array(result.function_matches, 'function_matches').map(m => object(m, 'match')).filter(m => m.status === 'MOVED').map(m => m.before_function)).size : statusCounts.MOVED,
    lost_functions: coreCounts ? new Set(array(result.function_matches, 'function_matches').map(m => object(m, 'match')).filter(m => m.status === 'LOST').map(m => m.before_function)).size : statusCounts.LOST,
    duplications: coreCounts ? array(result.findings, 'findings').filter(f => object(f, 'finding').type === 'DUPLICATED').length : statusCounts.DUPLICATED,
    potential_conflicts: conflictCount,
  }
  Object.entries(expectedSummary).forEach(([key, expected]) => {
    if (count(summary[key], `summary.${key}`) !== expected) fail(`summary.${key}`, 'итог не соответствует деталям анализа')
  })
  if (coreCounts) {
    const findings = array(result.findings, 'findings').map((item, index) => object(item, `findings[${index}]`))
    const extraTotals = {
      overlaps: findings.filter(finding => finding.type === 'OVERLAP').length,
      verified_findings: findings.filter(finding => finding.verification_status === 'VERIFIED').length,
      needs_review_findings: findings.filter(finding => finding.verification_status === 'NEEDS_REVIEW').length,
    }
    Object.entries(extraTotals).forEach(([key, expected]) => {
      if (count(summary[key], `summary.${key}`) !== expected) fail(`summary.${key}`, 'итог не соответствует выводам анализа')
    })
  }
  if (incompleteEvidence.size) {
    return { ...result, warnings: [...(result.warnings as string[]), `Неполное покрытие источниками: ${incompleteEvidence.size} полей с основаниями пусты. Связанные наблюдения остаются NEEDS_REVIEW; проверьте исходные документы.`] } as unknown as AnalysisResult
  }
  return result as unknown as AnalysisResult
}

/** Keep the CORE wire schema intact; adapt only the UI's existing view model. */
export function validateAnalysisResponse(value: unknown): AnalysisResult {
  const raw = object(value, 'response')
  if (!('analysis_mode' in raw)) return validateViewResponse(value)
  enumeration(raw.analysis_mode, ['deterministic', 'semantic'] as const, 'analysis_mode')
  array(raw.agent_trace, 'agent_trace').forEach((item, index) => string(item, `agent_trace[${index}]`))
  const warnings = array(raw.warnings, 'warnings').map((item, index) => string(item, `warnings[${index}]`))
  count(raw.clauses_before, 'clauses_before')
  count(raw.clauses_after, 'clauses_after')
  const before = string(raw.before_document, 'before_document')
  const after = string(raw.after_document, 'after_document')
  if (before === after) fail('after_document', 'имена источников должны различать редакции')
  const summary = object(raw.summary, 'summary')
  string(summary.conclusion, 'summary.conclusion')
  if (summary.analytical_note !== null) string(summary.analytical_note, 'summary.analytical_note')
  if (verification(summary.note_verification_status, 'summary.note_verification_status') !== 'NEEDS_REVIEW') fail('summary.note_verification_status', 'аналитическое заключение CORE требует экспертной проверки')
  const noteEvidence = array(summary.note_evidence, 'summary.note_evidence')
  noteEvidence.forEach((item, index) => {
    const source = object(item, `summary.note_evidence[${index}]`)
    if (source.document !== before && source.document !== after) fail(`summary.note_evidence[${index}]`, 'неизвестный документ источника')
    evidence([source], source.document as string, `summary.note_evidence[${index}]`, true)
  })
  if (summary.analytical_note !== null && (!noteEvidence.some(item => object(item, 'note source').document === before) || !noteEvidence.some(item => object(item, 'note source').document === after))) {
    warnings.push('Аналитическая записка не содержит источников обеих редакций и требует проверки по исходным документам.')
  }
  const counts = new Map<string, number>()
  const functions = new Map<string, { owner: string; document: string; name: string; clause: string }>()
  const units = array(raw.units, 'units').map((item, index) => {
    const path = `units[${index}]`
    const unit = object(item, path)
    const id = string(unit.id, `${path}.id`)
    const document = string(unit.document, `${path}.document`)
    if (document !== before && document !== after) fail(path, 'неизвестный документ подразделения')
    const items = array(unit.functions, `${path}.functions`)
    counts.set(id, items.length)
    items.forEach((item, functionIndex) => {
      const functionPath = `${path}.functions[${functionIndex}]`
      const entry = object(item, functionPath)
      const functionId = string(entry.id, `${functionPath}.id`)
      if (functions.has(functionId)) fail(functionPath, 'идентификатор функции повторяется')
      if (entry.document !== document) fail(functionPath, 'функция принадлежит другой редакции')
      functions.set(functionId, {
        owner: id, document, name: string(entry.normalized_function, `${functionPath}.normalized_function`),
        clause: string(entry.clause_id, `${functionPath}.clause_id`),
      })
    })
    return { ...unit, revision: document === before ? 'before' : 'after', functions_count: items.length }
  })
  const transformations = array(raw.transformations, 'transformations').map((item, index) => {
    const path = `transformations[${index}]`
    const change = object(item, path)
    const sources = array(change.evidence, `${path}.evidence`).map(e => object(e, `${path}.evidence`))
    if (sources.some(e => e.document !== before && e.document !== after)) fail(path, 'неизвестный документ источника')
    return {
      ...change, id: `core-transformation-${index}`,
      before_evidence: sources.filter(e => e.document === before),
      after_evidence: sources.filter(e => e.document === after),
    }
  })
  const matches = array(raw.function_matches, 'function_matches').map((item, index) => {
    const path = `function_matches[${index}]`
    const match = object(item, path)
    const aid = string(match.before_function, `${path}.before_function`)
    const a = functions.get(aid)
    if (!a || a.document !== before) fail(path, 'неизвестная функция BEFORE')
    const b = match.after_function === null ? undefined : functions.get(string(match.after_function, `${path}.after_function`))
    if (match.after_function !== null && (!b || b.document !== after)) fail(path, 'неизвестная функция AFTER')
    if (match.verification_status === 'VERIFIED') {
      const beforeSources = evidence(match.before_evidence, before, `${path}.before_evidence`, true)
      const afterSources = evidence(match.after_evidence, after, `${path}.after_evidence`, true)
      if (!beforeSources.some(source => source.clause_id === a!.clause) || !b || !afterSources.some(source => source.clause_id === b.clause)) fail(path, 'подтверждение не содержит исходных пунктов сопоставляемых функций')
    }
    return {
      ...match, id: `core-function-${index}`, before_function: aid,
      after_function: match.after_function as string | null, name: a!.name,
      before_owner: [a!.owner], after_owner: b ? [b.owner] : [],
      recommendation: 'Проверить назначение ответственного по приведённым исходным пунктам.',
    }
  })
  const findings = array(raw.findings, 'findings').map((item, index) => {
    const path = `findings[${index}]`
    const finding = object(item, path)
    // Link only primary function clauses, not shared headings/assignment context.
    const beforeSources = evidence(finding.before_evidence, before, `${path}.before_evidence`, true)
    const afterSources = evidence(finding.after_evidence, after, `${path}.after_evidence`, true)
    const references = matches.filter(m => {
      const a = functions.get(m.before_function)!
      const b = m.after_function ? functions.get(m.after_function) : undefined
      return beforeSources.some(e => e.clause_id === a.clause) || (b && afterSources.some(e => e.clause_id === b.clause))
    }).map(m => m.id)
    return { ...finding, function_ids: references }
  })
  return validateViewResponse({ ...raw, warnings, units, transformations, function_matches: matches, findings }, counts)
}

async function apiResponseError(response: Response): Promise<AnalysisError> {
  let code: unknown
  try {
    const payload: unknown = await response.json()
    if (payload && typeof payload === 'object' && 'error' in payload) {
      const error = payload.error
      if (error && typeof error === 'object' && 'code' in error) code = error.code
    }
  } catch { /* Untrusted error bodies are never shown to the user. */ }
  if (response.status === 422) return new AnalysisError('validation', 'Сервис не смог обработать документы или параметры запроса. Проверьте, что оба файла — непустые корректные DOCX.')
  if (response.status === 413) return new AnalysisError('validation', 'Документы превышают допустимый размер анализа. Уменьшите объём файлов и повторите запрос.')
  if (code === 'semantic_invalid_output') return new AnalysisError('malformed', 'Семантический сервис не вернул завершённый результат. Повторите анализ.')
  if (code === 'semantic_not_configured' || code === 'invalid_configuration') return new AnalysisError('unavailable', 'Режим анализа не настроен на сервере. Проверьте конфигурацию CORE или откройте учебный пример.')
  if (code === 'semantic_authentication_failed') return new AnalysisError('unavailable', 'Сервис ИИ не прошёл авторизацию. Администратору нужно проверить ключ API на сервере. Можно открыть учебный пример.')
  if (code === 'semantic_model_unavailable') return new AnalysisError('unavailable', 'Выбранная модель ИИ недоступна серверу. Администратору нужно проверить модель и права доступа. Можно открыть учебный пример.')
  if (code === 'semantic_rate_limited') return new AnalysisError('unavailable', 'Достигнут лимит запросов или исчерпана квота сервиса ИИ. Повторите позже или откройте учебный пример.')
  if (code === 'semantic_timeout') return new AnalysisError('unavailable', 'Сервис ИИ не ответил за 120 секунд. Повторите анализ или откройте учебный пример.')
  if (code === 'semantic_unavailable') return new AnalysisError('unavailable', 'Семантический сервис временно недоступен. Повторите запрос или откройте учебный пример.')
  return new AnalysisError('unavailable', `Сервис анализа вернул HTTP ${response.status}. Попробуйте ещё раз или откройте учебный пример.`)
}

const timeoutError = () => new AnalysisError('unavailable', `Сервис анализа не ответил за ${API_TIMEOUT_MS / 1000} секунд. Попробуйте ещё раз или откройте учебный пример.`)

const abortError = () => new DOMException('Анализ отменён', 'AbortError')
const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError()
}
const waitForMockStep = (duration: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return }
  const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, duration)
  signal?.addEventListener('abort', onAbort, { once: true })
})

export interface AnalyzeDocumentsOptions {
  beforeFile: File | null
  afterFile: File | null
  demo: boolean
  signal?: AbortSignal
  /** Number of completed demo stages; real API reports only 0 and 10. */
  onProgress?: (step: number) => void
}

export async function analyzeDocuments({ beforeFile, afterFile, demo, signal, onProgress }: AnalyzeDocumentsOptions): Promise<AnalysisResult> {
  throwIfAborted(signal)
  if (demo) {
    onProgress?.(0)
    for (let step = 0; step < ACTIVITY_STEPS.length; step += 1) {
      await waitForMockStep(400, signal)
      throwIfAborted(signal)
      onProgress?.(step + 1)
    }
    throwIfAborted(signal)
    return validateAnalysisResponse(structuredClone(demoData))
  }
  if (USE_MOCK) {
    throw new AnalysisError('validation', 'Сейчас включён деморежим. Загруженные файлы не анализируются: запустите учебный пример или подключите API через VITE_USE_MOCK=false.')
  }
  if (!beforeFile || !afterFile) {
    throw new AnalysisError('validation', 'Выберите оба документа: редакцию BEFORE и редакцию AFTER.')
  }
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, API_TIMEOUT_MS)
  try {
    const body = new FormData()
    body.append('before_file', beforeFile)
    body.append('after_file', afterFile)
    onProgress?.(0)
    const response = await fetch(`${API_BASE_URL}/api/analyze`, { method: 'POST', body, signal: controller.signal })
    if (!response.ok) {
      throw await apiResponseError(response)
    }
    let payload: unknown
    try { payload = await response.json() }
    catch { throw new AnalysisError('malformed', 'Сервис вернул ответ, который не является корректным JSON.') }
    throwIfAborted(signal)
    if (timedOut) throw timeoutError()
    const result = validateAnalysisResponse(payload)
    onProgress?.(ACTIVITY_STEPS.length)
    throwIfAborted(signal)
    return result
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (timedOut) throw timeoutError()
    if (error instanceof AnalysisError) throw error
    throw new AnalysisError('unavailable', 'Не удалось связаться с сервисом анализа. Проверьте подключение или откройте учебный пример.')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}
