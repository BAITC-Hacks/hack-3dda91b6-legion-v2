import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

async function loadDemo(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Загрузить демодокументы', exact: true }).click()
}

async function analyzeDemo(page: Page) {
  await loadDemo(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
}

test('demo: documents → changes → lost function evidence → risks → downloadable conclusion', async ({ page }, testInfo) => {
  const browserErrors: string[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  await page.goto('/')
  await page.screenshot({ path: testInfo.outputPath('upload-desktop.png') })
  await analyzeDemo(page)

  await expect(page.getByRole('heading', { name: 'Карта изменений', exact: true })).toBeVisible()
  await expect(page.locator('.graph-unit--before')).toHaveCount(3)
  await expect(page.locator('.graph-unit--after')).toHaveCount(4)
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png') })
  await page.screenshot({ path: testInfo.outputPath('overview-desktop-full.png'), fullPage: true })

  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await page.getByRole('button', { name: /^Потеряна/ }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.getByText('Не назначен', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /План аварийного восстановления/ }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByRole('heading', { name: 'План аварийного восстановления', exact: true })).toBeVisible()
  await expect(drawer.getByText('Требует проверки · NEEDS REVIEW', { exact: true })).toBeVisible()
  await expect(drawer.getByText('revision_8.docx', { exact: true })).toBeVisible()
  await expect(drawer.getByText('86%', { exact: true })).toBeVisible()
  await expect(drawer.getByText(/Подтверждающий фрагмент не найден/)).toBeVisible()
  await expect(drawer.getByText(/ежегодно проверяет план аварийного восстановления/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('evidence-desktop.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
  await expect(drawer).toHaveCount(0)

  await page.getByRole('button', { name: /^Риски и выводы/ }).click()
  await expect(page.getByText('Не найден владелец аварийного восстановления', { exact: true })).toBeVisible()
  await expect(page.getByText('Выбор поставщика и его проверка совмещены', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Заключение', exact: true }).click()
  await page.getByRole('button', { name: 'Сформировать заключение', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Аналитическое заключение', exact: true, level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'Эксплуатация сети → Эксплуатация сети', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Подразделение сохранено', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog').getByText('Подтверждено · VERIFIED', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('conclusion-desktop.png') })
  await page.screenshot({ path: testInfo.outputPath('conclusion-desktop-full.png'), fullPage: true })
  const downloadPending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Скачать заключение', exact: true }).click()
  const download = await downloadPending
  expect(download.suggestedFilename()).toBe('OrgLens-demo-001.md')
  const reportPath = await download.path()
  expect(reportPath).not.toBeNull()
  const report = await readFile(reportPath!, 'utf8')
  expect(report).toContain('# OrgLens AI — Аналитическое заключение')
  expect(report).toContain('ДЕМО: синтетические документы и цитаты')
  expect(report).toContain('revision_8.docx')
  expect(report).toContain('revision_9.docx')
  expect(report).toContain('NEEDS_REVIEW')
  expect(report).toContain('Источник AFTER отсутствует; вывод требует экспертной проверки.')
  expect(report).toContain('Проверить смежные регламенты')
  expect(browserErrors).toEqual([])
})

test('reset cancels an in-flight analysis and a fresh demo can finish', async ({ page }) => {
  await page.clock.install()
  await loadDemo(page)
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await page.clock.runFor(550)
  await page.getByRole('button', { name: 'Сбросить демо', exact: true }).click()

  // Advance past all ten 400 ms stages: an aborted result must not restore the dashboard.
  await page.clock.runFor(4_500)
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Загрузить демодокументы', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Загрузить демодокументы', exact: true }).click()
  await page.getByRole('button', { name: 'Анализировать изменения', exact: true }).click()
  await page.clock.runFor(4_500)
  await expect(page.getByRole('heading', { name: 'Обзор изменений', exact: true })).toBeVisible()
  await expect(page.locator('.graph-unit')).toHaveCount(7)
})

test('keyboard opens graph evidence, traps focus, and Escape restores focus', async ({ page }) => {
  await analyzeDemo(page)
  const splitConnection = page.getByRole('button', { name: /^Разделено:/ }).first()
  await splitConnection.focus()
  await splitConnection.press('Enter')
  await expect(page.getByRole('dialog')).toBeVisible()
  const close = page.getByRole('button', { name: 'Закрыть источники', exact: true })
  await expect(close).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(splitConnection).toBeFocused()

  const splitFilter = page.getByRole('button', { name: /^Разделено: 2\./ })
  await splitFilter.click()
  await expect(splitFilter).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.graph-edge:not(.graph-edge--dimmed)')).toHaveCount(2)
  await page.getByRole('button', { name: 'Показать все', exact: true }).click()
  await expect(page.locator('.graph-edge--dimmed')).toHaveCount(0)
})

test('mobile keeps the page within the viewport and lets the graph scroll internally', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await analyzeDemo(page)
  const widths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1)
  expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1)

  const scrollRegion = page.getByRole('region', { name: /^Граф изменений структуры/ })
  await expect(scrollRegion).toBeVisible()
  const graphWidths = await scrollRegion.evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }))
  expect(graphWidths.content).toBeGreaterThan(graphWidths.width)
  await scrollRegion.evaluate(element => { element.scrollLeft = element.scrollWidth })
  expect(await scrollRegion.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('overview-mobile.png') })
  await page.screenshot({ path: testInfo.outputPath('overview-mobile-full.png'), fullPage: true })

  await page.getByRole('button', { name: 'Сравнение функций', exact: true }).click()
  await page.getByRole('button', { name: /^Потеряна/ }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391)
  await page.getByRole('button', { name: /План аварийного восстановления/ }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toBeVisible()
  // Visibility starts at the beginning of the 200 ms slide animation; poll its final position.
  await expect.poll(async () => {
    const bounds = await drawer.boundingBox()
    return bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY
  }).toBeLessThanOrEqual(391)
  await drawer.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished))
  })
  const drawerBounds = await drawer.boundingBox()
  expect(drawerBounds).not.toBeNull()
  // Allow one CSS pixel of fractional browser layout rounding on both edges.
  expect(drawerBounds!.x).toBeGreaterThanOrEqual(-1)
  expect(drawerBounds!.x + drawerBounds!.width).toBeLessThanOrEqual(391)
  await testInfo.attach('mobile-layout.json', { contentType: 'application/json', body: JSON.stringify(await page.evaluate(() => {
    const bounds = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right } : null
    }
    return { viewport: window.innerWidth, scrollX: window.scrollX, scrollWidth: document.documentElement.scrollWidth, drawer: bounds('.evidence-drawer'), backdrop: bounds('.drawer-backdrop') }
  }), null, 2) })
  await page.screenshot({ path: testInfo.outputPath('evidence-mobile.png'), animations: 'disabled' })
  await page.getByRole('button', { name: 'Закрыть источники', exact: true }).click()
  await expect(drawer).toHaveCount(0)
})
