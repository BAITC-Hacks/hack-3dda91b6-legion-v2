import demoData from '../data/demo.json'
import type { AnalysisResult, Evidence } from '../types'

export const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false'
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
const API_TIMEOUT_MS = 45_000

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
const evidence = (value: unknown, document: string, path: string): Evidence[] => array(value, path).map((item, index) => {
  const sourcePath = `${path}[${index}]`
  const source = object(item, sourcePath)
  const sourceDocument = string(source.document, `${sourcePath}.document`)
  if (sourceDocument !== document) fail(`${sourcePath}.document`, 'источник не соответствует редакции документа')
  return {
    document: sourceDocument,
    section: string(source.section, `${sourcePath}.section`),
    text: string(source.text, `${sourcePath}.text`),
  }
})
const verification = (value: unknown, path: string) => enumeration(value, ['VERIFIED', 'NEEDS_REVIEW'] as const, path)

/** Validates every field consumed by the UI, including IDs, evidence and totals. */
export function validateAnalysisResponse(value: unknown): AnalysisResult {
  const result = object(value, 'response')
  string(result.analysis_id, 'analysis_id')
  const beforeDocument = string(result.before_document, 'before_document')
  const afterDocument = string(result.after_document, 'after_document')
  const unitIds = new Set<string>()
  const unitRevision = new Map<string, 'before' | 'after'>()
  const expectedFunctionCounts = new Map<string, number>()

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
    const beforeEvidence = evidence(change.before_evidence, beforeDocument, `${path}.before_evidence`)
    const afterEvidence = evidence(change.after_evidence, afterDocument, `${path}.after_evidence`)
    if (type === 'CREATED') {
      if (change.before_unit !== null) fail(`${path}.before_unit`, 'для CREATED ожидался null')
    } else {
      unitReference(change.before_unit, 'before', `${path}.before_unit`)
      if (!beforeEvidence.length) fail(`${path}.before_evidence`, 'нет исходного подтверждения')
    }
    if (type === 'REMOVED') {
      if (change.after_unit !== null) fail(`${path}.after_unit`, 'для REMOVED ожидался null')
      removedUnitIds.add(change.before_unit as string)
      if (!afterEvidence.length && change.verification_status === 'VERIFIED') fail(path, 'удаление без прямого подтверждения требует проверки')
    } else {
      const afterId = unitReference(change.after_unit, 'after', `${path}.after_unit`)
      if (!afterEvidence.length) fail(`${path}.after_evidence`, 'нет подтверждения новой редакции')
      if (['CREATED', 'SPLIT', 'MERGED'].includes(type)) createdUnitIds.add(afterId)
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
    const beforeEvidence = evidence(match.before_evidence, beforeDocument, `${path}.before_evidence`)
    const afterEvidence = evidence(match.after_evidence, afterDocument, `${path}.after_evidence`)
    const owners = (revision: 'before' | 'after') => {
      const ownerPath = `${path}.${revision}_owner`
      const ids = array(match[`${revision}_owner`], ownerPath).map((owner, ownerIndex) => unitReference(owner, revision, `${ownerPath}[${ownerIndex}]`))
      if (new Set(ids).size !== ids.length) fail(ownerPath, 'владелец повторяется')
      ids.forEach(owner => expectedFunctionCounts.set(owner, expectedFunctionCounts.get(owner)! + 1))
      return ids
    }
    const beforeOwners = owners('before')
    const afterOwners = owners('after')
    if (!beforeOwners.length || !beforeEvidence.length) fail(path, 'функции требуется владелец и источник BEFORE')
    if (status === 'LOST') {
      if (afterOwners.length) fail(`${path}.after_owner`, 'у LOST не должно быть владельца AFTER')
      if (!afterEvidence.length && verified === 'VERIFIED') fail(path, 'отсутствие функции без прямого подтверждения требует проверки')
    } else if (!afterOwners.length || !afterEvidence.length) {
      fail(path, 'функции требуется владелец и источник AFTER')
    }
    if (status === 'DUPLICATED' && afterOwners.length < 2) fail(path, 'для DUPLICATED требуется минимум два владельца AFTER')
  })
  units.forEach((unit, index) => {
    if (unit.functions_count !== expectedFunctionCounts.get(unit.id as string)) fail(`units[${index}].functions_count`, 'число не соответствует таблице функций')
  })

  const findingIds = new Set<string>()
  let conflictCount = 0
  array(result.findings, 'findings').forEach((item, index) => {
    const path = `findings[${index}]`
    const finding = object(item, path)
    uniqueId(finding.id, findingIds, `${path}.id`)
    const type = enumeration(finding.type, ['LOST', 'MOVED', 'DUPLICATED', 'CONFLICT', 'CREATED'] as const, `${path}.type`)
    enumeration(finding.severity, ['INFO', 'MEDIUM', 'HIGH'] as const, `${path}.severity`)
    string(finding.title, `${path}.title`)
    string(finding.explanation, `${path}.explanation`)
    string(finding.recommendation, `${path}.recommendation`)
    confidence(finding.confidence, `${path}.confidence`)
    const verified = verification(finding.verification_status, `${path}.verification_status`)
    const beforeEvidence = evidence(finding.before_evidence, beforeDocument, `${path}.before_evidence`)
    const afterEvidence = evidence(finding.after_evidence, afterDocument, `${path}.after_evidence`)
    if (!beforeEvidence.length && !afterEvidence.length) fail(path, 'существенному выводу требуется источник')
    if (['MOVED', 'DUPLICATED'].includes(type) && (!beforeEvidence.length || !afterEvidence.length)) fail(path, 'сопоставлению функции требуются источники BEFORE и AFTER')
    if (type === 'CREATED' && !afterEvidence.length) fail(path, 'созданию подразделения требуется источник AFTER')
    if (type === 'LOST' && (!beforeEvidence.length || (!afterEvidence.length && verified === 'VERIFIED'))) fail(path, 'отсутствие функции требует источника BEFORE и статуса проверки')
    if (type === 'CONFLICT') {
      conflictCount += 1
      if (verified !== 'NEEDS_REVIEW') fail(path, 'потенциальный конфликт требует проверки специалистом')
      if (!afterEvidence.length) fail(path, 'потенциальному конфликту требуется источник AFTER')
    }
    const references = array(finding.function_ids, `${path}.function_ids`).map((reference, referenceIndex) => {
      const id = string(reference, `${path}.function_ids[${referenceIndex}]`)
      if (!functionIds.has(id)) fail(`${path}.function_ids`, 'ссылка на неизвестную функцию')
      if (['LOST', 'MOVED', 'DUPLICATED'].includes(type) && functionStatuses.get(id) !== type) fail(`${path}.function_ids`, 'статус функции не соответствует выводу')
      return id
    })
    if (new Set(references).size !== references.length) fail(`${path}.function_ids`, 'ссылка повторяется')
    if (type !== 'CREATED' && !references.length) fail(`${path}.function_ids`, 'выводу требуется ссылка на функцию')
  })

  const summary = object(result.summary, 'summary')
  const expectedSummary = {
    units_before: units.filter(unit => unit.revision === 'before').length,
    units_after: units.filter(unit => unit.revision === 'after').length,
    created_units: createdUnitIds.size,
    removed_units: removedUnitIds.size,
    moved_functions: statusCounts.MOVED,
    lost_functions: statusCounts.LOST,
    duplications: statusCounts.DUPLICATED,
    potential_conflicts: conflictCount,
  }
  Object.entries(expectedSummary).forEach(([key, expected]) => {
    if (count(summary[key], `summary.${key}`) !== expected) fail(`summary.${key}`, 'итог не соответствует деталям анализа')
  })
  return result as unknown as AnalysisResult
}

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
      throw new AnalysisError('unavailable', `Сервис анализа вернул HTTP ${response.status}. Попробуйте ещё раз или откройте учебный пример.`)
    }
    let payload: unknown
    try { payload = await response.json() }
    catch { throw new AnalysisError('malformed', 'Сервис вернул ответ, который не является корректным JSON.') }
    throwIfAborted(signal)
    if (timedOut) throw new AnalysisError('unavailable', 'Сервис анализа не ответил за 45 секунд. Попробуйте ещё раз или откройте учебный пример.')
    const result = validateAnalysisResponse(payload)
    onProgress?.(ACTIVITY_STEPS.length)
    throwIfAborted(signal)
    return result
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (timedOut) throw new AnalysisError('unavailable', 'Сервис анализа не ответил за 45 секунд. Попробуйте ещё раз или откройте учебный пример.')
    if (error instanceof AnalysisError) throw error
    throw new AnalysisError('unavailable', 'Не удалось связаться с сервисом анализа. Проверьте подключение или откройте учебный пример.')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}
