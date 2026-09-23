import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { Evidence } from '../src/types'

const semanticSmoke = process.env.LIVE_SEMANTIC_SMOKE === '1'
const fixtureDirectory = resolve('artifacts/e2e-robustness')
const beforeFile = join(fixtureDirectory, 'known-before.docx')
const afterFile = join(fixtureDirectory, 'known-after.docx')
const corruptFile = join(fixtureDirectory, 'corrupt.docx')
const dutyText = 'Проверяет исполнение договоров поставщиками.'
const permissionCases = [
  { name: 'right', kind: 'RIGHT', text: 'Имеет право утверждать договоры закупок.' },
  { name: 'prohibition', kind: 'PROHIBITION', text: 'Не имеет права утверждать договоры закупок.' },
] as const

interface CoreFunction {
  id: string
  unit_name: string
  normalized_function: string
  source_text: string
  section: string
  document: string
  kind: 'FUNCTION' | 'RIGHT' | 'PROHIBITION'
}

interface CoreResult {
  analysis_id: string
  analysis_mode: string
  before_document: string
  after_document: string
  units: { functions: CoreFunction[] }[]
  transformations: { type: string; evidence: Evidence[] }[]
  function_matches: { before_function: string; after_function: string | null; status: string; verification_status: string; before_evidence: Evidence[]; after_evidence: Evidence[] }[]
  findings: { type: string }[]
  summary: { units_before: number; units_after: number; created_units: number; removed_units: number; moved_functions: number; lost_functions: number; duplications: number; potential_conflicts: number; conclusion: string }
}

async function upload(page: Page, before: string, after: string) {
  await page.goto('/')
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles(before)
  await page.getByLabel('Документ после реорганизации', { exact: true }).setInputFiles(after)
}

async function submit(page: Page) {
  // No routes or response fixtures: every upload reaches the deterministic CORE server.
  const pending = page.waitForResponse(response => response.url().endsWith('/api/analyze') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  return pending
}

async function expectOverview(page: Page, result: CoreResult) {
  expect(result.analysis_mode).toBe('deterministic')
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
  await expect(page.locator('.graph-unit--before')).toHaveCount(result.summary.units_before)
  await expect(page.locator('.graph-unit--after')).toHaveCount(result.summary.units_after)
  await expect(page.locator('.graph-column-heading').first()).toContainText(result.before_document)
  await expect(page.locator('.graph-column-heading--after')).toContainText(result.after_document)
  await expect(page.locator('.analysis-context')).toContainText(`${result.before_document}`)
  await expect(page.locator('.analysis-context')).toContainText(`${result.after_document}`)
}

async function checkFunctionSources(page: Page, result: CoreResult, testInfo: TestInfo, prefix: string, matchIndex: number) {
  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(result.function_matches.length)
  await page.locator('tbody .function-name').nth(matchIndex).click()
  const drawer = page.getByRole('dialog')
  const match = result.function_matches[matchIndex]
  for (const [index, evidence, document] of [
    [0, match.before_evidence, result.before_document],
    [1, match.after_evidence, result.after_document],
  ] as const) {
    expect(evidence.length).toBeGreaterThan(0)
    expect(evidence.every(source => source.document === document)).toBe(true)
    const block = drawer.locator('.source-block').nth(index)
    await expect(block.locator('blockquote').first()).toHaveText(`«${evidence[0].text}»`)
    await expect(block.locator('.source-meta strong').first()).toHaveText(document)
    await expect(block.locator('.source-meta span').first()).toHaveText(`п. ${evidence[0].section}`)
  }
  await page.screenshot({ path: testInfo.outputPath(`${prefix}-sources.png`), animations: 'disabled' })
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
}

async function checkSourcesAndDownload(page: Page, result: CoreResult, testInfo: TestInfo, prefix: string, matchIndex: number) {
  await checkFunctionSources(page, result, testInfo, prefix, matchIndex)
  await page.getByRole('button', { name: 'Заключение', exact: true }).click()
  await page.getByRole('button', { name: 'Сформировать заключение', exact: true }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать заключение', exact: true }).click()
  const download = await pending
  const reportPath = testInfo.outputPath(`${prefix}-conclusion.md`)
  await download.saveAs(reportPath)
  const report = await readFile(reportPath, 'utf8')
  const exportedSource = result.transformations.flatMap(change => change.evidence)[0]
  expect(exportedSource).toBeDefined()
  for (const value of [result.analysis_id, result.before_document, result.after_document, result.summary.conclusion, exportedSource.text]) expect(report).toContain(value)
}

test.describe('real deterministic DOCX robustness', () => {
  test.skip(semanticSmoke, 'These synthetic robustness checks never run against the paid semantic backend.')

  test.beforeAll(() => {
    if (semanticSmoke) return
    mkdirSync(fixtureDirectory, { recursive: true })
    const python = resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    execFileSync(python, ['-c', 'from pathlib import Path; import sys; from scripts.smoke_known_answer import generate_pair; generate_pair(Path(sys.argv[1]))', fixtureDirectory], { cwd: resolve('.') })
    execFileSync(python, ['-c', [
      'from pathlib import Path',
      'from docx import Document',
      'import json, sys',
      'for fixture in json.loads(sys.stdin.buffer.read().decode("utf-8")):',
      '    doc = Document()',
      '    for paragraph in fixture["paragraphs"]:',
      '        doc.add_paragraph(paragraph)',
      '    doc.save(Path(sys.argv[1]) / (fixture["name"] + ".docx"))',
    ].join('\n'), fixtureDirectory], {
      cwd: resolve('.'),
      input: JSON.stringify(permissionCases.map(fixture => ({
        name: fixture.name,
        paragraphs: [
          '1.1. БК является функциональным блоком компании.',
          '3.1. БК состоит из следующих структурных подразделений:',
          'а. Департамент закупок (ДЗ).',
          'б. Департамент контроля (ДК).',
          '5.1. Директор ДК:',
          `5.1.1. ${fixture.text}`,
          `5.1.2. ${dutyText}`,
        ],
      }))),
    })
    writeFileSync(corruptFile, 'Synthetic invalid DOCX: this file is not a ZIP archive.', 'utf8')
  })

  test('same physical DOCX has no fabricated changes and preserves distinct evidence labels', async ({ page }, testInfo) => {
    await upload(page, beforeFile, beforeFile)
    const response = await submit(page)
    expect(response.status()).toBe(200)
    const result = await response.json() as CoreResult
    expect(result.before_document).toBe('BEFORE_known-before.docx')
    expect(result.after_document).toBe('AFTER_known-before.docx')
    expect(result.summary).toMatchObject({ units_before: 4, units_after: 4, created_units: 0, removed_units: 0, moved_functions: 0, lost_functions: 0, duplications: 0, potential_conflicts: 0 })
    expect(result.transformations.map(change => change.type)).toEqual(Array(4).fill('PRESERVED'))
    expect(result.function_matches.map(match => match.status)).toEqual(Array(4).fill('PRESERVED'))
    expect(result.findings.filter(finding => ['LOST', 'MOVED', 'CREATED'].includes(finding.type))).toHaveLength(0)
    await expectOverview(page, result)
    for (const label of ['Создано', 'Передано функций', 'Потеряно функций']) {
      await expect(page.locator('.summary-card').filter({ hasText: label }).locator('strong')).toHaveText('00')
    }
    await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
    await expect(page.locator('tbody .status-preserved')).toHaveCount(4)
    await expect(page.locator('tbody .status-lost, tbody .status-moved')).toHaveCount(0)
    await checkSourcesAndDownload(page, result, testInfo, 'same-file', 0)
  })

  test('swapped DOCX keeps BEFORE/AFTER names, counts and original source clauses in the correct direction', async ({ page }, testInfo) => {
    await upload(page, afterFile, beforeFile)
    const response = await submit(page)
    expect(response.status()).toBe(200)
    const result = await response.json() as CoreResult
    expect(result.before_document).toBe('known-after.docx')
    expect(result.after_document).toBe('known-before.docx')
    expect([result.summary.units_before, result.summary.units_after]).toEqual([5, 4])
    await expectOverview(page, result)
    await expect(page.locator('.summary-card').filter({ hasText: 'Подразделений до' }).locator('strong')).toHaveText('05')
    await expect(page.locator('.summary-card').filter({ hasText: 'Подразделений после' }).locator('strong')).toHaveText('04')
    const movedReport = result.function_matches.findIndex(match => match.status === 'MOVED'
      && match.before_evidence.some(source => source.section === '5.2.2')
      && match.after_evidence.some(source => source.section === '5.1.2'))
    expect(movedReport).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: testInfo.outputPath('swapped-overview.png'), fullPage: true, animations: 'disabled' })
    const functions = new Map(result.units.flatMap(unit => unit.functions).map(item => [item.id, item]))
    const retainedControl = result.function_matches.findIndex(match => {
      const before = functions.get(match.before_function)
      return before?.section === '5.2.1' && before.unit_name === 'Департамент контроля'
    })
    expect(retainedControl).toBeGreaterThanOrEqual(0)
    const control = result.function_matches[retainedControl]
    expect(control).toMatchObject({ status: 'PRESERVED', verification_status: 'VERIFIED' })
    for (const [id, document] of [[control.before_function, result.before_document], [control.after_function, result.after_document]] as const) {
      expect(functions.get(id!)).toMatchObject({ unit_name: 'Департамент контроля', document, section: '5.2.1', source_text: `5.2.1. ${dutyText}`, kind: 'FUNCTION' })
    }
    for (const [evidence, document] of [[control.before_evidence, result.before_document], [control.after_evidence, result.after_document]] as const) {
      expect(evidence[0]).toMatchObject({ document, section: '5.2.1', text: `5.2.1. ${dutyText}` })
    }
    await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
    const controlRow = page.locator('tbody tr').nth(retainedControl)
    await expect(controlRow.locator('.function-name')).toHaveText('проверяет исполнение договоров поставщиками')
    await expect(controlRow.locator('.status-preserved')).toHaveText('Сохранена')
    await expect(controlRow.locator('td').nth(1)).toHaveText('Департамент контроля')
    await expect(controlRow.locator('td').nth(2)).toHaveText('Департамент контроля')
    await checkFunctionSources(page, result, testInfo, 'swapped-preserved-control', retainedControl)
    await checkSourcesAndDownload(page, result, testInfo, 'swapped', movedReport)
  })

  for (const fixture of permissionCases) {
    test(`mixed list keeps ${fixture.kind} separate from the following FUNCTION without a false conflict`, async ({ page }, testInfo) => {
      const file = join(fixtureDirectory, `${fixture.name}.docx`)
      await upload(page, file, file)
      const response = await submit(page)
      expect(response.status()).toBe(200)
      const result = await response.json() as CoreResult
      const functions = result.units.flatMap(unit => unit.functions)
      expect(functions).toHaveLength(4)
      for (const document of [result.before_document, result.after_document]) {
        const items = functions.filter(item => item.document === document)
        expect(items).toHaveLength(2)
        expect(items.find(item => item.section === '5.1.1')).toMatchObject({ kind: fixture.kind, unit_name: 'Департамент контроля', source_text: `5.1.1. ${fixture.text}` })
        expect(items.find(item => item.section === '5.1.2')).toMatchObject({ kind: 'FUNCTION', unit_name: 'Департамент контроля', source_text: `5.1.2. ${dutyText}` })
      }
      expect(result.function_matches).toHaveLength(2)
      expect(result.function_matches.map(match => match.status)).toEqual(['PRESERVED', 'PRESERVED'])
      expect(result.findings.filter(finding => finding.type === 'CONFLICT')).toHaveLength(0)
      expect(result.summary.potential_conflicts).toBe(0)
      await expectOverview(page, result)
      await expect(page.locator('.summary-card').filter({ hasText: 'Потенц. конфликтов' }).locator('strong')).toHaveText('00')
      await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
      for (const [index, match] of result.function_matches.entries()) {
        const before = functions.find(item => item.id === match.before_function)!
        const after = functions.find(item => item.id === match.after_function)!
        expect(after).toMatchObject({ document: result.after_document, section: before.section, kind: before.kind, source_text: before.source_text })
        expect(match.before_evidence[0]).toMatchObject({ document: result.before_document, section: before.section, text: before.source_text })
        expect(match.after_evidence[0]).toMatchObject({ document: result.after_document, section: after.section, text: after.source_text })
        const row = page.locator('tbody tr').nth(index)
        await expect(row.locator('.function-name')).toHaveText(before.normalized_function)
        await expect(row.locator('.status-preserved')).toHaveText('Сохранена')
        await checkFunctionSources(page, result, testInfo, `${fixture.name}-${before.kind.toLowerCase()}`, index)
      }
    })
  }

  test('corrupt DOCX gets a real 422 and replacing the file succeeds on the same page without reset', async ({ page }, testInfo) => {
    let analysisRequests = 0
    page.on('request', request => { if (request.url().endsWith('/api/analyze') && request.method() === 'POST') analysisRequests += 1 })
    await upload(page, corruptFile, afterFile)
    await page.evaluate(() => { Object.defineProperty(window, '__robustnessMarker', { value: 'same-page-after-422', configurable: true }) })
    let navigations = 0
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations += 1 })
    const rejected = await submit(page)
    expect(rejected.status()).toBe(422)
    expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_document' } })
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('непустые корректные DOCX')
    await expect(page.getByText('LIVE ANALYSIS', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('corrupt-422.png'), animations: 'disabled' })

    // Keep AFTER and the current document intact: no reset, reload or page.goto here.
    await page.getByLabel('Документ до реорганизации', { exact: true }).setInputFiles(beforeFile)
    await expect(alert).toHaveCount(0)
    const recovered = await submit(page)
    expect(recovered.status()).toBe(200)
    const result = await recovered.json() as CoreResult
    expect([result.summary.units_before, result.summary.units_after]).toEqual([4, 5])
    await expectOverview(page, result)
    expect(await page.evaluate(() => Reflect.get(window, '__robustnessMarker'))).toBe('same-page-after-422')
    expect(navigations).toBe(0)
    expect(analysisRequests).toBe(2)
    await page.screenshot({ path: testInfo.outputPath('recovered-same-page.png'), animations: 'disabled' })
  })
})
