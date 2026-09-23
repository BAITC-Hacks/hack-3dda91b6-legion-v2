import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import demoData from '../data/demo.json'
import { AnalysisError, validateAnalysisResponse } from './analysis'

const freshDemo = () => structuredClone(demoData)

// Synthetic CORE wire response, deliberately different from the demo view model.
function coreResponse() {
  const source = (document: string, clause_id: string, text: string) => ({ document, clause_id, section: '5.1', text })
  const b = source('before.docx', 'bc', '5.1. Проверяет отчёт.')
  const a = source('after.docx', 'ac', '5.1. Проверяет отчёт.')
  const a2 = source('after.docx', 'ac2', '5.2. Подготавливает план.')
  return {
    analysis_id: 'core-synthetic', analysis_mode: 'deterministic',
    before_document: 'before.docx', after_document: 'after.docx',
    units: [
      { id: 'bu', name: 'Контроль', document: 'before.docx', functions: [{ id: 'bf', document: 'before.docx', normalized_function: 'проверяет отчёт', clause_id: 'bc' }] },
      { id: 'au', name: 'Контроль', document: 'after.docx', functions: [
        { id: 'af', document: 'after.docx', normalized_function: 'проверяет отчёт', clause_id: 'ac' },
        { id: 'af2', document: 'after.docx', normalized_function: 'подготавливает план', clause_id: 'ac2' },
      ] },
    ],
    transformations: [{ before_unit: 'bu', after_unit: 'au', type: 'PRESERVED', confidence: 1,
      explanation: 'Название совпадает.', verification_status: 'VERIFIED', evidence: [b, a] }],
    function_matches: [{ before_function: 'bf', after_function: 'af', status: 'PRESERVED', confidence: 1,
      before_evidence: [b], after_evidence: [a], explanation: 'Текст совпадает.', verification_status: 'VERIFIED' }],
    findings: [{ id: 'finding', type: 'DUPLICATED', severity: 'MEDIUM', title: 'Возможное дублирование',
      explanation: 'Проверить распределение ответственности.', recommendation: 'Уточнить полномочия.',
      confidence: 0.8, verification_status: 'NEEDS_REVIEW', before_evidence: [], after_evidence: [a, a2] }],
    summary: { units_before: 1, units_after: 1, created_units: 0, removed_units: 0,
      moved_functions: 0, lost_functions: 0, duplications: 1, potential_conflicts: 0, conclusion: 'Требуется проверка.' },
  }
}

describe('CORE to existing UI adapter', () => {
  it('keeps CORE sources, verification and counts without changing demo semantics', () => {
    const raw = coreResponse()
    const result = validateAnalysisResponse(raw)
    expect(result.units.map(u => u.revision)).toEqual(['before', 'after'])
    expect(result.units[1].functions_count).toBe(2)
    expect(result.function_matches).toHaveLength(1)
    expect(result.function_matches[0].before_owner).toEqual(['bu'])
    expect(result.transformations[0].before_evidence).toEqual(raw.transformations[0].evidence.slice(0, 1))
    expect(result.findings[0].after_evidence).toEqual(raw.findings[0].after_evidence)
    expect(result.findings[0].verification_status).toBe('NEEDS_REVIEW')
    expect(result.summary).toEqual(raw.summary)
    expect(raw.units[0]).not.toHaveProperty('revision')
  })

  it('preserves AFTER-only overlap findings without inventing BEFORE evidence', () => {
    const raw = coreResponse()
    raw.findings[0].type = 'OVERLAP'
    raw.summary.duplications = 0
    expect(validateAnalysisResponse(raw).findings[0]).toMatchObject({ type: 'OVERLAP', before_evidence: [] })
  })

  it('counts a moved before function once across multiple semantic edges', () => {
    const raw = coreResponse()
    raw.function_matches[0].status = 'MOVED'
    raw.function_matches.push({ ...raw.function_matches[0], after_function: 'af2' })
    raw.summary.moved_functions = 1
    expect(validateAnalysisResponse(raw).summary.moved_functions).toBe(1)
  })

  it.each(['reference', 'document', 'count', 'duplicate'])( 'rejects invalid CORE %s', kind => {
    const raw = coreResponse()
    if (kind === 'reference') raw.function_matches[0].after_function = 'missing'
    if (kind === 'document') raw.units[1].functions[0].document = 'before.docx'
    if (kind === 'count') raw.summary.duplications = 0
    if (kind === 'duplicate') raw.units[1].functions[1].id = 'af'
    expect(() => validateAnalysisResponse(raw)).toThrow(AnalysisError)
  })
})

describe('analysis response validation', () => {
  it('accepts the internally consistent documentary demo', () => {
    const result = validateAnalysisResponse(freshDemo())
    expect(result.summary).toEqual({
      units_before: 3, units_after: 4, created_units: 2, removed_units: 0,
      moved_functions: 5, lost_functions: 1, duplications: 2, potential_conflicts: 1,
    })
    expect(result.function_matches).toHaveLength(13)
  })

  it('accepts an empty findings response', () => {
    const result = freshDemo()
    result.findings = []
    result.summary.potential_conflicts = 0
    expect(validateAnalysisResponse(result).findings).toEqual([])
  })

  it('counts each created split target once even with an explicit CREATED edge', () => {
    const data = freshDemo()
    const result = validateAnalysisResponse({
      ...data,
      transformations: [...data.transformations, {
        ...data.transformations[1], id: 'T-CREATED-IT', before_unit: null, type: 'CREATED', before_evidence: [],
      }],
    })
    expect(result.summary.created_units).toBe(2)
    expect(result.summary.removed_units).toBe(0)
  })

  it('counts a new merged unit once across both incoming edges', () => {
    const source = (document: string, text: string) => [{ document, section: '2.1', text }]
    const result = validateAnalysisResponse({
      analysis_id: 'merge-case', before_document: 'before.docx', after_document: 'after.docx',
      units: [
        { id: 'B-1', name: 'ИТ', revision: 'before', functions_count: 0 },
        { id: 'B-2', name: 'Продукты', revision: 'before', functions_count: 0 },
        { id: 'A-1', name: 'Цифровое развитие', revision: 'after', functions_count: 0 },
      ],
      transformations: ['B-1', 'B-2'].map((id, index) => ({
        id: `T-${index}`, before_unit: id, after_unit: 'A-1', type: 'MERGED', confidence: 0.99,
        explanation: 'Два подразделения объединены в новое.', verification_status: 'VERIFIED',
        before_evidence: source('before.docx', 'В структуру входят ИТ и Продукты.'),
        after_evidence: source('after.docx', 'ИТ и Продукты объединяются в новое подразделение Цифровое развитие.'),
      })),
      function_matches: [], findings: [],
      summary: { units_before: 2, units_after: 1, created_units: 1, removed_units: 0, moved_functions: 0, lost_functions: 0, duplications: 0, potential_conflicts: 0 },
    })
    expect(result.summary.created_units).toBe(1)
  })

  it.each([
    ['null response', () => null],
    ['invalid enum', () => { const data = freshDemo(); data.function_matches[0].status = 'UNKNOWN'; return data }],
    ['out-of-range confidence', () => { const data = freshDemo(); data.findings[0].confidence = 1.4; return data }],
    ['non-finite confidence', () => { const data = freshDemo(); data.function_matches[0].confidence = Number.NaN; return data }],
    ['missing source text', () => { const data = freshDemo(); data.findings[0].before_evidence[0].text = ''; return data }],
    ['wrong source document', () => { const data = freshDemo(); data.function_matches[0].after_evidence[0].document = 'unrelated.docx'; return data }],
    ['unknown owner', () => { const data = freshDemo(); data.function_matches[0].after_owner = ['missing-unit']; return data }],
    ['wrong owner revision', () => { const data = freshDemo(); data.function_matches[0].after_owner = ['B-NET']; return data }],
    ['duplicate function ID', () => { const data = freshDemo(); data.function_matches[1].id = data.function_matches[0].id; return data }],
    ['unknown finding reference', () => { const data = freshDemo(); data.findings[0].function_ids = ['missing-function']; return data }],
    ['inconsistent summary', () => { const data = freshDemo(); data.summary.moved_functions = 99; return data }],
    ['inconsistent unit count', () => { const data = freshDemo(); data.units[0].functions_count = 99; return data }],
    ['lost function marked confirmed without evidence', () => { const data = freshDemo(); data.function_matches[7].verification_status = 'VERIFIED'; return data }],
    ['potential conflict marked confirmed', () => { const data = freshDemo(); data.findings[3].verification_status = 'VERIFIED'; return data }],
    ['missing transformation evidence', () => { const data = freshDemo(); data.transformations[0].before_evidence = []; return data }],
    ['finding without any evidence', () => { const data = freshDemo(); data.findings[1].before_evidence = []; data.findings[1].after_evidence = []; return data }],
    ['duplicate finding without AFTER evidence', () => { const data = freshDemo(); data.findings[1].after_evidence = []; return data }],
    ['move finding without BEFORE evidence', () => { const data = freshDemo(); data.findings[4].before_evidence = []; return data }],
    ['created finding without AFTER evidence', () => { const data = freshDemo(); data.findings[5].after_evidence = []; return data }],
  ])('rejects %s with an actionable malformed error', (_name, makePayload) => {
    expect(() => validateAnalysisResponse(makePayload())).toThrow(AnalysisError)
    try { validateAnalysisResponse(makePayload()) } catch (error) {
      expect(error).toMatchObject({ kind: 'malformed' })
    }
  })
})

describe('analysis adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_USE_MOCK', 'true')
    vi.stubEnv('VITE_API_BASE_URL', '')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('uses the real API by default when VITE_USE_MOCK is absent', async () => {
    vi.stubEnv('VITE_USE_MOCK', undefined)
    const { USE_MOCK } = await import('./analysis')
    expect(USE_MOCK).toBe(false)
  })

  it('runs ten demo stages without a backend and returns a fresh result', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { analyzeDocuments } = await import('./analysis')
    const progress = vi.fn()
    const promise = analyzeDocuments({ beforeFile: null, afterFile: null, demo: true, onProgress: progress })
    await vi.advanceTimersByTimeAsync(4000)
    const result = await promise
    expect(result.analysis_id).toBe('demo-001')
    expect(progress.mock.calls.map(call => call[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(fetchMock).not.toHaveBeenCalled()
    result.function_matches[0].name = 'mutated by a consumer'
    expect(demoData.function_matches[0].name).not.toBe('mutated by a consumer')
  })

  it('cancels a demo before any further progress', async () => {
    vi.useFakeTimers()
    const { analyzeDocuments } = await import('./analysis')
    const controller = new AbortController()
    const progress = vi.fn()
    const promise = analyzeDocuments({ beforeFile: null, afterFile: null, demo: true, signal: controller.signal, onProgress: progress })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(400)
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(5000)
    expect(progress.mock.calls.map(call => call[0])).toEqual([0, 1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors cancellation from the final demo progress update', async () => {
    vi.useFakeTimers()
    const { analyzeDocuments } = await import('./analysis')
    const controller = new AbortController()
    const promise = analyzeDocuments({ beforeFile: null, afterFile: null, demo: true, signal: controller.signal, onProgress: step => { if (step === 10) controller.abort() } })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(4000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not represent uploaded files as having been analyzed in mock mode', async () => {
    const { analyzeDocuments } = await import('./analysis')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(analyzeDocuments({ beforeFile: new File(['before'], 'user-before.docx'), afterFile: new File(['after'], 'user-after.docx'), demo: false })).rejects.toMatchObject({ kind: 'validation' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the demo available when the real API is configured', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_USE_MOCK', 'false')
    const { analyzeDocuments, USE_MOCK } = await import('./analysis')
    expect(USE_MOCK).toBe(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const promise = analyzeDocuments({ beforeFile: null, afterFile: null, demo: true })
    await vi.advanceTimersByTimeAsync(4000)
    expect((await promise).analysis_id).toBe('demo-001')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts both real files with the agreed multipart names', async () => {
    vi.stubEnv('VITE_USE_MOCK', 'false')
    vi.stubEnv('VITE_API_BASE_URL', 'https://example.test/')
    const { analyzeDocuments } = await import('./analysis')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(demoData), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const beforeFile = new File(['before content'], 'before.docx')
    const afterFile = new File(['after content'], 'after.docx')
    const progress = vi.fn()
    const result = await analyzeDocuments({ beforeFile, afterFile, demo: false, onProgress: progress })
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.test/api/analyze')
    expect(request.method).toBe('POST')
    expect(request.body.get('before_file')).toBe(beforeFile)
    expect(request.body.get('after_file')).toBe(afterFile)
    expect(request.headers).toBeUndefined()
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(result.summary.moved_functions).toBe(5)
    expect(progress.mock.calls.map(call => call[0])).toEqual([0, 10])
  })

  it('cleans up after cancellation from the final real progress update', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_USE_MOCK', 'false')
    const { analyzeDocuments } = await import('./analysis')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(demoData))))
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(analyzeDocuments({
      beforeFile: new File(['b'], 'before.docx'), afterFile: new File(['a'], 'after.docx'), demo: false,
      signal: controller.signal, onProgress: step => { if (step === 10) controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['HTTP failure', () => Promise.resolve(new Response('service unavailable', { status: 503 })), 'unavailable'],
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'unavailable'],
    ['invalid JSON', () => Promise.resolve(new Response('<html>error</html>', { status: 200 })), 'malformed'],
    ['incomplete JSON', () => Promise.resolve(new Response(JSON.stringify({ summary: {} }), { status: 200 })), 'malformed'],
  ])('classifies %s for the error screen', async (_name, response, kind) => {
    vi.stubEnv('VITE_USE_MOCK', 'false')
    const { analyzeDocuments } = await import('./analysis')
    vi.stubGlobal('fetch', vi.fn(response))
    await expect(analyzeDocuments({ beforeFile: new File(['b'], 'before.docx'), afterFile: new File(['a'], 'after.docx'), demo: false })).rejects.toMatchObject({ kind })
  })

  it('aborts a pending real request when the user resets', async () => {
    vi.stubEnv('VITE_USE_MOCK', 'false')
    const { analyzeDocuments } = await import('./analysis')
    const controller = new AbortController()
    const fetchMock = vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const promise = analyzeDocuments({ beforeFile: new File(['b'], 'before.docx'), afterFile: new File(['a'], 'after.docx'), demo: false, signal: controller.signal })
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true)
  })

  it('ends a stalled real request after 45 seconds', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_USE_MOCK', 'false')
    const { analyzeDocuments } = await import('./analysis')
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
    const promise = analyzeDocuments({ beforeFile: new File(['b'], 'before.docx'), afterFile: new File(['a'], 'after.docx'), demo: false })
    const rejection = expect(promise).rejects.toMatchObject({ kind: 'unavailable', message: expect.stringContaining('45') })
    await vi.advanceTimersByTimeAsync(45_000)
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})
