import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const repository = resolve('.')
const fixtureDirectory = join(repository, 'artifacts', 'e2e-documents')

test.beforeAll(() => {
  mkdirSync(fixtureDirectory, { recursive: true })
  const python = join(repository, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  if (!existsSync(python)) throw new Error('Live E2E requires the repository .venv with requirements-lock.txt installed.')
  const paragraphs = {
    before: [
      '1.1. БК является функциональным блоком компании.',
      '3.1. БК состоит из следующих структурных подразделений:',
      'а. Департамент закупок (ДЗ).', 'б. Департамент контроля (ДК).',
      ['5. Функции и обязанности', 'Heading 1'],
      '5.1. Директор ДЗ:', '5.1.1. Организует закупки оборудования.',
      '5.1.2. Подготавливает отчёт о рисках.',
      '5.2. Директор ДК:', '5.2.1. Проверяет закупки оборудования.',
      '5.2.2. Контролирует план аварийного восстановления.',
    ],
    after: [
      '1.1. БК является функциональным блоком компании.',
      '3.1. БК состоит из следующих структурных подразделений:',
      'а. Департамент закупок (ДЗ).', 'б. Департамент контроля (ДК).',
      'в. Департамент планирования (ДП).',
      ['5. Функции и обязанности', 'Heading 1'],
      '5.1. Директор ДЗ:', '5.1.1. Организует закупки оборудования.',
      '5.2. Директор ДК:', '5.2.1. Проверяет закупки оборудования.',
      '5.2.2. Подготавливает отчёт о рисках.',
      '5.3. Директор ДП:', '5.3.1. Проверяет закупки оборудования.',
    ],
    output: fixtureDirectory,
  }
  execFileSync(python, ['-c', [
    'import json, sys', 'from pathlib import Path', 'from docx import Document',
    'payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'for revision in ("before", "after"):',
    '    document = Document()',
    '    for item in payload[revision]:',
    '        if isinstance(item, list): document.add_paragraph(item[0], style=item[1])',
    '        else: document.add_paragraph(item)',
    '    document.save(Path(payload["output"]) / ("synthetic_" + revision + ".docx"))',
  ].join('\n')], { cwd: repository, input: JSON.stringify(paragraphs), encoding: 'utf8' })
})

test('real DOCX → CORE → production frontend → evidence → downloaded conclusion', async ({ page, request }, testInfo) => {
  test.setTimeout(90_000)
  const files = existsSync('data') ? readdirSync('data') : []
  const before = files.find(name => /_8_.*\.docx$/i.test(name))
  const after = files.find(name => /_9_.*\.docx$/i.test(name))
  const organizerPair = Boolean(before && after)
  const beforePath = organizerPair ? join(repository, 'data', before!) : join(fixtureDirectory, 'synthetic_before.docx')
  const afterPath = organizerPair ? join(repository, 'data', after!) : join(fixtureDirectory, 'synthetic_after.docx')
  await testInfo.attach('live-input-source', { body: organizerPair ? 'Organizer DOCX supplied inside repository data/.' : 'Generated synthetic DOCX: no organizer documents were supplied. Real backend request; no routes or mocked response.', contentType: 'text/plain' })
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  expect(await health.json()).toMatchObject({ ok: true })
  const browserErrors: string[] = []
  let analysisRequests = 0
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('request', request => { if (request.url().endsWith('/api/analyze') && request.method() === 'POST') analysisRequests += 1 })
  await page.goto('/')
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles(beforePath)
  await page.getByLabel('Документ после реорганизации', { exact: true }).setInputFiles(afterPath)
  // Deliberately no page.route(): the generated or supplied DOCX bytes reach CORE.
  const responsePending = page.waitForResponse(response => response.url().endsWith('/api/analyze') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  const response = await responsePending
  expect(response.status()).toBe(200)
  const result = await response.json()
  expect(result.analysis_mode).toBe('deterministic')
  expect(result.clauses_before).toBeGreaterThan(0)
  expect(result.clauses_after).toBeGreaterThan(0)
  if (!organizerPair) {
    expect(result.summary.units_before).toBe(3)
    expect(result.summary.units_after).toBe(4)
    expect(result.summary.moved_functions).toBeGreaterThan(0)
    expect(result.summary.lost_functions).toBeGreaterThan(0)
    expect(result.summary.duplications).toBeGreaterThan(0)
  }
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await expect(page.locator('.graph-unit--before')).toHaveCount(result.summary.units_before)
  await expect(page.locator('.graph-unit--after')).toHaveCount(result.summary.units_after)
  await expect(page.locator('.analysis-context')).toContainText(result.analysis_id)
  const metadata = page.getByRole('region', { name: 'Сведения о реальном анализе', exact: true })
  await expect(metadata.getByText('Детерминированный анализ', { exact: true })).toBeVisible()
  await expect(metadata.getByText(/^Действия сервиса/)).toContainText(`${result.agent_trace.length} завершено`)
  await page.screenshot({ path: testInfo.outputPath('live-overview.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(result.function_matches.length)
  await page.locator('tbody tr button').first().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  const firstEvidence = result.function_matches[0].before_evidence[0]
  expect(firstEvidence).toBeDefined()
  await expect(drawer.locator('.source-block').first().locator('blockquote').first()).toHaveText(`«${firstEvidence.text}»`)
  await page.screenshot({ path: testInfo.outputPath('live-evidence.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
  await page.getByRole('button', { name: /^Риски и выводы/ }).click()
  const reviewFinding = result.findings.find((finding: { verification_status: string }) => finding.verification_status === 'NEEDS_REVIEW')
  expect(reviewFinding).toBeDefined()
  await page.getByText(reviewFinding.title, { exact: true }).first().click()
  await expect(drawer.getByText('Требует проверки · NEEDS REVIEW', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
  await page.getByRole('button', { name: 'Заключение', exact: true }).click()
  await page.getByRole('button', { name: 'Сформировать заключение', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Аналитическое заключение', exact: true, level: 2 })).toBeVisible()
  await expect(page.locator('.executive-summary')).toContainText(result.summary.conclusion)
  const downloadPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать заключение', exact: true }).click()
  const download = await downloadPending
  const report = await readFile((await download.path())!, 'utf8')
  expect(report).toContain(result.analysis_id)
  expect(report).toContain(result.before_document)
  expect(report).toContain(result.after_document)
  expect(report).toContain(result.summary.conclusion)
  expect(report).toContain('NEEDS_REVIEW')
  expect(report).not.toContain('ДЕМО: синтетические документы')
  expect(analysisRequests).toBe(1)
  expect(browserErrors).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('integrated-live-result.png'), animations: 'disabled' })
})
