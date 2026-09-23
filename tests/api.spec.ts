import { expect, test, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { AnalysisResult } from '../src/types'

const demoData = JSON.parse(readFileSync('src/data/demo.json', 'utf8')) as AnalysisResult

const emptyResult = (id = 'api-empty-001') => ({
  analysis_id: id, before_document: 'before.docx', after_document: 'after.docx',
  units: [], transformations: [], function_matches: [], findings: [],
  summary: { units_before: 0, units_after: 0, created_units: 0, removed_units: 0, moved_functions: 0, lost_functions: 0, duplications: 0, potential_conflicts: 0 },
})

const evidenceResult = () => JSON.parse(JSON.stringify(demoData)
  .replaceAll('revision_8.docx', 'before.docx').replaceAll('revision_9.docx', 'after.docx')) as typeof demoData

function unverifiedCoreResponse() {
  const unit = (id: string, document: string, functionId: string, clause: string) => ({
    id, name: 'Контроль', document, section: '5.1', parent: null, aliases: [], evidence: [],
    functions: [{ id: functionId, unit_name: 'Контроль', document, clause_id: clause,
      normalized_function: 'проверяет отчёт', source_text: '5.1. Проверяет отчёт.', section: '5.1',
      kind: 'FUNCTION', ownership_evidence: [], ownership_status: 'NEEDS_REVIEW' }],
  })
  return {
    analysis_id: 'unverified-core', analysis_mode: 'deterministic', before_document: 'before.docx', after_document: 'after.docx',
    agent_trace: ['Verifying documentary evidence'], warnings: [], clauses_before: 1, clauses_after: 1,
    units: [unit('bu', 'before.docx', 'bf', 'bc'), unit('au', 'after.docx', 'af', 'ac')],
    transformations: [{ before_unit: 'bu', after_unit: 'au', type: 'PRESERVED', confidence: 0.5,
      explanation: 'Наблюдение без достаточных источников.', verification_status: 'NEEDS_REVIEW', evidence: [] }],
    function_matches: [{ before_function: 'bf', after_function: 'af', status: 'PRESERVED', confidence: 0.5,
      before_evidence: [], after_evidence: [], explanation: 'Необходимо проверить исходные документы.', verification_status: 'NEEDS_REVIEW' }],
    findings: [], summary: { ...emptyResult().summary, units_before: 1, units_after: 1, overlaps: 0,
      verified_findings: 0, needs_review_findings: 0, conclusion: 'Наблюдения требуют проверки.',
      analytical_note: null, note_evidence: [], note_verification_status: 'NEEDS_REVIEW' },
  }
}

async function selectRealDocuments(page: Page, navigate = true) {
  if (navigate) await page.goto('/')
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  const analyze = page.getByRole('button', { name: 'Анализировать изменения', exact: true })
  await expect(analyze).toBeDisabled()
  await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles({
    name: 'before.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('BEFORE document: исходная структура'),
  })
  await expect(analyze).toBeDisabled()
  await page.getByLabel('Документ после реорганизации', { exact: true }).setInputFiles({
    name: 'after.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('AFTER document: новая структура'),
  })
  await expect(analyze).toBeEnabled()
}

test('API unavailable: HTTP 503 is actionable and the explicit demo remains available', async ({ page }, testInfo) => {
  let requestCount = 0
  await page.route('**/api/analyze', async route => {
    requestCount += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Service unavailable' }) })
  })
  await selectRealDocuments(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  const alert = page.getByRole('alert')
  await expect(alert.getByText('Сервис анализа недоступен', { exact: true })).toBeVisible()
  await expect(alert.getByText(/HTTP 503/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('api-unavailable.png') })

  await alert.getByRole('button', { name: 'Загрузить демодокументы', exact: true }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.getByText('DEMO DATA', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await expect(page.getByText('DEMO DATA', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Документы', exact: true }).click()
  await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles({
    name: 'new-real.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('New selected document'),
  })
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Обзор изменений', exact: true }).click()
  await expect(page.getByText('DEMO DATA', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Документы', exact: true }).click()
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  expect(requestCount).toBe(1)
})

for (const scenario of [
  { name: 'non-JSON body', body: '<html>Unexpected upstream response</html>', detail: 'не является корректным JSON' },
  { name: 'invalid response schema', body: JSON.stringify({ analysis_id: 'broken-001' }), detail: 'before_document' },
  { name: 'partial result missing function_matches', body: JSON.stringify({ ...emptyResult(), function_matches: undefined }), detail: 'function_matches' },
  { name: 'VERIFIED function without documentary evidence', body: JSON.stringify((() => {
    const result = evidenceResult()
    result.function_matches[0].before_evidence = []
    result.function_matches[0].after_evidence = []
    return result
  })()), detail: 'function_matches' },
]) {
  test(`API malformed: ${scenario.name} does not enter the results view`, async ({ page }) => {
    await page.route('**/api/analyze', route => route.fulfill({ status: 200, contentType: 'application/json', body: scenario.body }))
    await selectRealDocuments(page)
    await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
    const alert = page.getByRole('alert')
    await expect(alert.getByText('Ответ анализа имеет неверный формат', { exact: true })).toBeVisible()
    await expect(alert).toContainText(scenario.detail)
    await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Анализировать изменения', exact: true })).toBeEnabled()
  })
}

test('API sends both files and a valid empty result renders honest empty states', async ({ page }) => {
  let postedBody = ''
  let postedMethod = ''
  let postedContentType = ''
  await page.route('**/api/analyze', async route => {
    const request = route.request()
    postedBody = request.postData() ?? ''
    postedMethod = request.method()
    postedContentType = request.headers()['content-type'] ?? ''
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyResult()) })
  })
  await selectRealDocuments(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  expect(postedMethod).toBe('POST')
  expect(postedContentType).toContain('multipart/form-data; boundary=')
  expect(postedBody).toContain('name="before_file"; filename="before.docx"')
  expect(postedBody).toContain('name="after_file"; filename="after.docx"')
  expect(postedBody).toContain('BEFORE document:')
  expect(postedBody).toContain('AFTER document:')
  await expect(page.getByText('Карта пока пуста', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Функции не найдены', exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^Риски и выводы/ }).click()
  await expect(page.getByRole('heading', { name: 'Существенные риски не выявлены', exact: true })).toBeVisible()
  await expect(page.getByText(/Это не гарантирует отсутствия рисков/)).toBeVisible()
  await page.getByRole('button', { name: 'Заключение', exact: true }).click()
  await page.getByRole('button', { name: 'Сформировать заключение', exact: true }).click()
  await expect(page.getByText('Покрытие источниками: 0 из 0 выводов', { exact: true })).toBeVisible()
})

test('NEEDS_REVIEW without source fragments stays explicit in the evidence drawer', async ({ page }) => {
  const result = unverifiedCoreResponse()
  await page.route('**/api/analyze', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) }))
  await selectRealDocuments(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await page.getByRole('button', { name: 'проверяет отчёт', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('Требует проверки · NEEDS REVIEW', { exact: true })).toBeVisible()
  await expect(drawer.locator('.source-empty')).toHaveCount(2)
  await expect(drawer.locator('blockquote')).toHaveCount(0)
  await expect(drawer).toContainText('Отсутствие источника само по себе не доказывает потерю функции')
})

test('API timeout aborts a stalled request and offers a retry without fabricated results', async ({ page }) => {
  await page.clock.install()
  let stalledRoute: Route | undefined
  await page.route('**/api/analyze', route => { stalledRoute = route })
  await selectRealDocuments(page)
  const posted = page.waitForRequest(request => request.url().endsWith('/api/analyze'))
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await posted
  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/analyze'))
  // CORE's request + retry budget is 270 s. Advance virtual browser time, never wait five minutes.
  await page.clock.runFor(300_000)
  await expect(page.getByRole('alert')).toContainText('не ответил')
  expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED')
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Анализировать изменения', exact: true })).toBeEnabled()
  await stalledRoute?.abort().catch(() => { /* The browser already cancelled this request. */ })
})

test('rapid analyze clicks send one request, repeated reset cancels it, and a fresh request succeeds', async ({ page }) => {
  let requests = 0
  const stalledRoutes: Route[] = []
  await page.route('**/api/analyze', async route => {
    requests += 1
    if (requests < 3) stalledRoutes.push(route)
    else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyResult('fresh-after-reset')) })
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await selectRealDocuments(page, attempt === 0)
    await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click({ clickCount: 2 })
    await expect.poll(() => requests).toBe(attempt + 1)
    await expect(page.getByRole('heading', { name: 'Анализируем изменения', exact: true })).toBeVisible()
    const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/analyze'))
    await page.getByRole('button', { name: 'Сбросить демо', exact: true }).click()
    expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED')
    await stalledRoutes[attempt].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyResult(`stale-${attempt}`)) }).catch(() => { /* A cancelled connection may reject the late response. */ })
    await expect(page.getByRole('heading', { name: 'Документы для анализа', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
  }
  await selectRealDocuments(page, false)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await expect(page.locator('.analysis-context')).toContainText('fresh-after-reset')
  expect(requests).toBe(3)
})
