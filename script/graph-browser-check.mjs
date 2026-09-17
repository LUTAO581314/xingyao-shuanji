import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dir, '..')
const { version } = await Bun.file(join(root, 'package.json')).json()
const executable = resolve(process.argv[2] ?? join(root, 'dist', `xingyao-${version}`, 'xingyao.exe'))
const fixture = await mkdtemp(join(tmpdir(), 'xingyao-graph-browser-'))
const host = join(fixture, 'host'), portable = join(fixture, 'portable')
const reportDir = join(root, 'reports')
await mkdir(reportDir, { recursive: true })
const child = Bun.spawn([executable, '--portable-root', portable, '--host-root', host, '--offline', '--no-open'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
let runtime, browser
const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${runtime.origin}/api${path}`, { method, headers: { authorization: `Bearer ${decodeURIComponent(runtime.hash.slice(7))}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${result.error}`)
  return result
}
try {
  const until = Date.now() + 25000
  while (!runtime && Date.now() < until) {
    if (child.exitCode !== null) throw new Error('Isolated compiled graph product exited before becoming ready')
    const record = await readFile(join(host, 'running.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (record?.url) runtime = new URL(record.url)
    else await Bun.sleep(40)
  }
  if (!runtime) throw new Error('Isolated compiled graph product did not become ready')
  const notes = join(fixture, '资料')
  await mkdir(notes)
  const documents = []
  for (const [name, body, scope, privateValue] of [
    ['星杳设计.md', '# 星杳设计\n[[记忆来源]]\n[说明](记忆来源.md)\n[[尚未导入]]\n<img src=x onerror="globalThis.graphXss=1">\n' + Array.from({ length: 170 }, (_, i) => `来源正文第 ${i + 6} 行`).join('\n'), 'global', false],
    ['记忆来源.md', '# 记忆来源\n长期记忆保留来源、修订与有效范围。', 'global', false],
    ['私密笔记.md', 'PRIVATE_GRAPH_FIXTURE', 'global', true],
    ['其他项目.md', 'FOREIGN_GRAPH_FIXTURE', 'different-project', false],
  ]) {
    const path = join(notes, name)
    await writeFile(path, body, 'utf8')
    documents.push(await api('/knowledge', { path, scope, private: privateValue }))
  }
  const preference = await api('/memories', { key: 'graph-ui-preference', text: '温暖、有主见、稳定；重要结论保留来源。', kind: 'preference', scope: 'global' })
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 })
  const pageErrors = [], cspErrors = [], externalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (/violates.*Content Security Policy|Refused to .*policy/i.test(message.text())) cspErrors.push(message.text()) })
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === runtime.origin) return route.continue()
    externalRequests.push(route.request().url().split('?')[0]); return route.abort()
  })
  await page.goto(runtime.href)
  await page.locator('.nav[data-view="graph"]').click()
  await expect(page.locator('#graph-status')).toContainText('已加载 4 个节点、3 条关系')
  await expect(page.locator('#graph-canvas canvas').first()).toBeVisible()
  expect(await page.evaluate(() => window.cytoscape.version)).toBe('3.34.3')
  await expect(page.locator('#graph-files')).not.toContainText('私密笔记')
  await expect(page.locator('#graph-files')).not.toContainText('其他项目')
  const selectDoc = () => page.locator(`[data-graph-node="document:${documents[0].id}"]`).click()
  await selectDoc()
  await expect(page.locator('#graph-detail')).toContainText('导入修订')
  await expect(page.locator('#graph-detail .graph-source-lines')).toContainText('<img src=x onerror="globalThis.graphXss=1">')
  expect(await page.evaluate(() => window.graphXss)).toBeUndefined()
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.graph-pagination')).toContainText('81–160')
  await page.getByRole('button', { name: '上一页', exact: true }).click()
  await expect(page.locator('.graph-pagination')).toContainText('1–80')
  await page.locator('#graph-detail .graph-relation-button').filter({ hasText: '双向链接语法' }).click()
  await expect(page.locator('#graph-detail')).toContainText('第 2 行，第 1 列')
  await page.getByRole('button', { name: '阅读这段来源', exact: true }).click()
  await expect(page.locator('#graph-detail .graph-source-lines')).toContainText('[[记忆来源]]')
  await page.locator('#graph-local').click()
  await expect(page.locator('#graph-count')).toContainText('2 个节点 / 2 条关系')
  await page.locator('#graph-all').click()
  await expect(page.locator('#graph-count')).toContainText('4 个节点 / 3 条关系')
  await page.locator('#graph-search').fill('记忆来源.md')
  await expect(page.locator('#graph-count')).toContainText('1 个节点 / 0 条关系')
  await page.locator('#graph-search').fill('')
  await page.locator('[data-graph-kind="experience"]').uncheck()
  await expect(page.locator('#graph-count')).toContainText('3 个节点 / 2 条关系')
  await page.locator('[data-graph-kind="experience"]').check()
  await page.locator('#graph-unresolved-title').click()
  await expect(page.locator('#graph-unresolved-list')).toContainText('尚未导入')
  await page.locator('#graph-private').check()
  await expect(page.locator('#graph-detail')).not.toContainText('导入修订')
  await page.locator('#graph-refresh').click()
  await expect(page.locator('#graph-status')).toContainText('已加载 5 个节点')
  await expect(page.locator('#graph-files')).toContainText('私密笔记')
  await page.locator('#graph-private').uncheck()
  await expect(page.locator('#graph-files')).not.toContainText('私密笔记')
  await page.locator('#graph-refresh').click()
  await expect(page.locator('#graph-status')).toContainText('已加载 4 个节点')
  await page.locator(`[data-graph-node="memory:${preference.id}"]`).click()
  await expect(page.locator('#graph-detail')).toContainText('温暖、有主见、稳定')
  const corrected = await api(`/memories/${preference.id}`, { revision: preference.revision, text: '温暖、有主见、稳定；回答要有清楚的依据。' }, 'PATCH')
  await page.locator('#graph-refresh').click()
  await expect(page.locator(`[data-graph-node="memory:${preference.id}"]`)).toHaveCount(0)
  await page.locator(`[data-graph-node="memory:${corrected.id}"]`).click()
  await expect(page.locator('#graph-detail')).toContainText('回答要有清楚的依据')
  await selectDoc()
  await page.locator('#graph-unresolved-title').click()
  await page.evaluate(() => window.scrollTo(0,0))
  await page.screenshot({ path: join(root, '../design/xingyao-knowledge-graph.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#graph-fit').click()
  await page.evaluate(() => window.scrollTo(0,0))
  await page.screenshot({ path: join(root, '../design/xingyao-knowledge-graph-mobile.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.setViewportSize({ width: 1600, height: 1050 })
  await writeFile(documents[0].path, '资料已在图谱打开期间更新。', 'utf8')
  await api(`/knowledge/${documents[0].id}`, {})
  await selectDoc()
  await expect(page.locator('#graph-detail')).toContainText('资料已更新')
  expect(pageErrors).toEqual([])
  expect(cspErrors).toEqual([])
  expect(externalRequests).toEqual([])
  const report = { version, executableSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex'), browser: 'Microsoft Edge', result: 'passed', checked: ['local rendering','scope/privacy','source evidence','untrusted text rendering','pagination','local neighbors','search/type filters','unresolved links','correction refresh','stale revision detection','mobile layout'], pageErrors: 0, cspErrors: 0, externalRequests: 0, createdAt: new Date().toISOString() }
  await Bun.write(join(reportDir, `graph-browser-${version}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
} finally {
  await browser?.close()
  if (runtime && child.exitCode === null) await api('/shutdown', {}).catch(() => {})
  if (child.exitCode === null) await Promise.race([child.exited, Bun.sleep(8000)])
  if (child.exitCode === null) { child.kill(); await child.exited }
  const actual = await realpath(fixture), tempRoot = await realpath(tmpdir())
  if (!actual.toLowerCase().startsWith((tempRoot + sep).toLowerCase()) || !actual.split(sep).at(-1).startsWith('xingyao-graph-browser-')) throw new Error('Unexpected fixture cleanup location')
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
