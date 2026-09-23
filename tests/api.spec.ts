import { expect, test, type Page } from '@playwright/test'

async function selectRealDocuments(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Live API', { exact: true })).toBeVisible()
  const analyze = page.getByRole('button', { name: 'Анализировать изменения', exact: true })
  await expect(analyze).toBeDisabled()
  await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles({
    name: 'before.txt', mimeType: 'text/plain', buffer: Buffer.from('BEFORE document: исходная структура'),
  })
  await expect(analyze).toBeDisabled()
  await page.getByLabel('Документ после реорганизации', { exact: true }).setInputFiles({
    name: 'after.txt', mimeType: 'text/plain', buffer: Buffer.from('AFTER document: новая структура'),
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
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  expect(requestCount).toBe(1)
})

for (const scenario of [
  { name: 'non-JSON body', body: '<html>Unexpected upstream response</html>', detail: 'не является корректным JSON' },
  { name: 'invalid response schema', body: JSON.stringify({ analysis_id: 'broken-001' }), detail: 'before_document' },
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      analysis_id: 'api-empty-001', before_document: 'before.txt', after_document: 'after.txt',
      units: [], transformations: [], function_matches: [], findings: [],
      summary: { units_before: 0, units_after: 0, created_units: 0, removed_units: 0, moved_functions: 0, lost_functions: 0, duplications: 0, potential_conflicts: 0 },
    }) })
  })
  await selectRealDocuments(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  expect(postedMethod).toBe('POST')
  expect(postedContentType).toContain('multipart/form-data; boundary=')
  expect(postedBody).toContain('name="before_file"; filename="before.txt"')
  expect(postedBody).toContain('name="after_file"; filename="after.txt"')
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
