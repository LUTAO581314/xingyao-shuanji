import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { SoulStore } from '../src/store.ts'
import { OpenCodeAdapter } from '../src/adapter.ts'
import { startServer } from '../src/server.ts'

// A real Edge browser against the current source server and temporary identity.
// This deliberately does not claim compiled-release or real-engine coverage.
const root = resolve(import.meta.dir, '..'), reportDir = join(root, 'reports')
await mkdir(reportDir, { recursive: true })
const { version } = await Bun.file(join(root, 'package.json')).json()
const sourceHashes = Object.fromEntries(await Promise.all(['src/web/app.js','src/server.ts','src/workspace-drafts.ts'].map(async path => [path,new Bun.CryptoHasher('sha256').update(await readFile(join(root,path))).digest('hex')])))
const fixture = await mkdtemp(join(tmpdir(), 'xingyao-draft-browser-'))
const browser = await chromium.launch({ ...(process.env.XINGYAO_BROWSER_EXECUTABLE ? { executablePath: process.env.XINGYAO_BROWSER_EXECUTABLE } : { channel: 'msedge' }), headless: true })
const results = [], pageErrors = [], cspErrors = [], externalRequests = []
const token = 'isolated-draft-browser-fixture'
let scenarioNumber = 0

async function scenario(name, run) {
  const directory = join(fixture, String(++scenarioNumber)), project = join(directory, 'project')
  await mkdir(project, { recursive: true })
  await writeFile(join(project, 'a.md'), '磁盘 A 原文\n')
  await writeFile(join(project, 'b.md'), '磁盘 B 原文\n')
  const store = new SoulStore(join(directory, 'host', 'soul.db'))
  const app = startServer({ store, adapter: new OpenCodeAdapter({ baseURL: 'http://127.0.0.1:1', timeoutMs: 50 }), token, vaultDir: join(directory, 'vault'), workspaceDirectory: project })
  const origin = `http://127.0.0.1:${app.server.port}`, context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const value = await response.json()
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${value.error}`)
    return value
  }
  async function page() {
    const value = await context.newPage()
    value.on('pageerror', error => pageErrors.push({ scenario: name, error: error.message }))
    value.on('console', message => { if (/violates.*Content Security Policy|Refused to .*policy/i.test(message.text())) cspErrors.push({ scenario: name, error: message.text() }) })
    await value.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      externalRequests.push(new URL(route.request().url()).origin); return route.abort()
    })
    value.on('dialog', dialog => void dialog.dismiss())
    await value.goto(`${origin}/#token=${token}`)
    await value.locator('.nav[data-view="workspace"]').click()
    await expect(value.locator('[data-workspace-entry="a.md"]')).toBeVisible()
    return value
  }
  const pages = [], evidence = {}
  try {
    await run({ page: async () => { const p = await page(); pages.push(p); return p }, api, app, store, project, directory, evidence })
    results.push({ name, result: 'passed', evidence })
  } catch (error) {
    for (const [index, p] of pages.entries()) await p.screenshot({ path: join(reportDir, `draft-browser-failure-${scenarioNumber}-${index}.png`), fullPage: true }).catch(() => {})
    results.push({ name, result: 'failed', error: error.message, evidence })
  } finally {
    await context.close()
    await app.server.stop(true)
    await Promise.allSettled([...app.jobs.values(), ...app.reviewJobs.values()])
    store.close()
  }
}
const open = async (page, path = 'a.md') => { await page.locator(`[data-workspace-entry="${path}"]`).click(); await expect(page.locator('#workspace-file-name')).toHaveText(path) }
const savedDraft = async page => { await expect(page.locator('#workspace-dirty')).toContainText('草稿已保存') }

try {
  await scenario('autosave, reload recovery and two-window compare-and-swap retain both inputs', async ({ page, api, project, evidence }) => {
    const a = await page(), b = await page()
    await open(a); await open(b)
    await a.locator('#workspace-text').fill('窗口 A 的独立输入\n')
    await savedDraft(a)
    await b.locator('#workspace-text').fill('窗口 B 的独立输入\n')
    await expect(b.locator('#workspace-draft-panel')).toContainText('另一窗口更新或删除了草稿')
    await expect(b.locator('#workspace-text')).toHaveValue('窗口 B 的独立输入\n')
    await b.locator('[data-workspace-entry="b.md"]').click()
    await expect(b.locator('#workspace-file-name')).toHaveText('a.md')
    await expect(b.locator('#workspace-text')).toHaveValue('窗口 B 的独立输入\n')
    expect((await api('/workspace/drafts')).drafts).toHaveLength(1)
    await b.getByRole('button', { name: '读取最新草稿并对照', exact: true }).click()
    await expect(b.locator('#workspace-draft-panel textarea').first()).toHaveValue('窗口 A 的独立输入\n')
    await b.locator('#workspace-text').fill('明确合并 A 与 B 的输入\n')
    await b.getByRole('button', { name: '已核对：保存当前编辑作为合并稿', exact: true }).click()
    await savedDraft(b)
    expect(await readFile(join(project, 'a.md'), 'utf8')).toBe('磁盘 A 原文\n')
    await b.reload(); await b.locator('.nav[data-view="workspace"]').click(); await open(b)
    await expect(b.locator('#workspace-draft-panel')).toContainText('发现可恢复的草稿')
    await expect(b.locator('#workspace-text')).toHaveValue('磁盘 A 原文\n')
    await b.getByRole('button', { name: '恢复草稿到编辑器', exact: true }).click()
    await expect(b.locator('#workspace-text')).toHaveValue('明确合并 A 与 B 的输入\n')
    evidence.draftRevision = (await api('/workspace/drafts')).drafts[0].revision
    evidence.sourceFileWasNotChanged = true
  })

  await scenario('a lost save response retries the same operation and preserves newer typing', async ({ page, api, evidence }) => {
    const p = await page(); await open(p)
    let lost = false
    const requests = []
    await p.route('**/api/workspace/draft', async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      requests.push(route.request().postDataJSON())
      if (!lost) { lost = true; await route.fetch(); return route.abort('failed') }
      return route.continue()
    })
    await p.locator('#workspace-text').fill('第一份已提交但响应丢失的草稿\n')
    await expect(p.locator('#workspace-draft-panel')).toContainText('草稿尚未确认保存')
    await p.locator('#workspace-text').fill('错误后继续输入的最终草稿\n')
    await p.getByRole('button', { name: '重试保存草稿', exact: true }).click()
    await savedDraft(p)
    expect(requests[1]).toEqual(requests[0])
    expect(requests.at(-1).text).toBe('错误后继续输入的最终草稿\n')
    expect(requests.at(-1).key).not.toBe(requests[0].key)
    const item = (await api('/workspace/drafts')).drafts[0]
    const rootId = (await api('/workspace/roots')).roots[0].id
    const state = await api(`/workspace/draft?${new URLSearchParams({rootId,path:'a.md'})}`)
    expect(state.draft.text).toBe('错误后继续输入的最终草稿\n')
    evidence.requests = requests.map(({key,revision,text}) => ({key,revision,text}))
    evidence.finalRevision = item.revision
  })

  await scenario('failed autosave blocks both file switches and leaving the workspace', async ({ page, api, evidence }) => {
    const p = await page(); await open(p)
    await p.route('**/api/workspace/draft', route => route.request().method() === 'PUT' ? route.abort('failed') : route.continue())
    await p.locator('#workspace-text').fill('断网后绝不能丢失的输入\n')
    await expect(p.locator('#workspace-draft-panel')).toContainText('草稿尚未确认保存')
    await p.locator('[data-workspace-entry="b.md"]').click()
    await expect(p.locator('#workspace-file-name')).toHaveText('a.md')
    await p.locator('.nav[data-view="memory"]').click()
    await expect(p.locator('#view-workspace')).toBeVisible()
    await expect(p.locator('#workspace-text')).toHaveValue('断网后绝不能丢失的输入\n')
    expect((await api('/workspace/drafts')).drafts).toHaveLength(0)
    await p.unroute('**/api/workspace/draft')
    await p.getByRole('button', { name: '重试保存草稿', exact: true }).click()
    await savedDraft(p)
    await p.locator('[data-workspace-entry="b.md"]').click()
    await expect(p.locator('#workspace-file-name')).toHaveText('b.md')
    evidence.inputWasKeptAndEventuallySaved = true
  })

  await scenario('external disk change requires explicit draft rebase before writing the file', async ({ page, project, evidence }) => {
    const p = await page(); await open(p)
    await p.locator('#workspace-text').fill('用户尚未写入磁盘的版本\n'); await savedDraft(p)
    await writeFile(join(project, 'a.md'), '外部编辑器的新磁盘版本\n')
    await p.locator('#workspace-save').click()
    await expect(p.locator('#workspace-conflict')).toBeVisible()
    await expect(p.locator('#workspace-text')).toHaveValue('用户尚未写入磁盘的版本\n')
    expect(await readFile(join(project, 'a.md'), 'utf8')).toBe('外部编辑器的新磁盘版本\n')
    await p.locator('#workspace-reload').click()
    await expect(p.locator('#workspace-draft-panel')).toContainText('磁盘版本与草稿的原始版本不同')
    await p.getByRole('button', { name: '恢复草稿到编辑器', exact: true }).click()
    await expect(p.locator('#workspace-save')).toBeDisabled()
    await p.locator('#workspace-text').fill('主人核对磁盘后明确合并的版本\n')
    await p.getByRole('button', { name: '已核对：以当前磁盘版本继续编辑', exact: true }).click()
    await expect(p.locator('#workspace-save')).toBeEnabled()
    await p.locator('#workspace-save').click()
    await expect(p.locator('#workspace-status')).toContainText('文件已保存')
    expect(await readFile(join(project, 'a.md'), 'utf8')).toBe('主人核对磁盘后明确合并的版本\n')
    evidence.onlyExplicitRebaseEnabledWrite = true
  })

  await scenario('delayed rebase response cannot replace the draft of another opened file', async ({ page, api, project, evidence }) => {
    const p = await page(); await open(p)
    await p.locator('#workspace-text').fill('文件 A 的草稿\n'); await savedDraft(p)
    await writeFile(join(project, 'a.md'), 'A 的新磁盘基础\n')
    await p.locator('#workspace-reload').click()
    await p.getByRole('button', { name: '恢复草稿到编辑器', exact: true }).click()
    const requested = Promise.withResolvers(), release = Promise.withResolvers()
    await p.route('**/api/workspace/draft', async route => {
      if (route.request().method() !== 'PATCH') return route.continue()
      const response = await route.fetch(); requested.resolve(); await release.promise; return route.fulfill({response})
    })
    const returned = p.waitForResponse(response => response.url().endsWith('/api/workspace/draft') && response.request().method() === 'PATCH')
    await p.getByRole('button', { name: '已核对：以当前磁盘版本继续编辑', exact: true }).click()
    await requested.promise
    try {
      const entry = p.locator('[data-workspace-entry="b.md"]')
      if (await entry.isEnabled()) { await entry.click(); await expect(p.locator('#workspace-file-name')).toHaveText('b.md') }
    } finally { release.resolve() }
    await (await returned).finished()
    await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await p.unroute('**/api/workspace/draft')
    if (await p.locator('#workspace-file-name').textContent() === 'a.md') { await expect(p.locator('[data-workspace-entry="b.md"]')).toBeEnabled(); await open(p,'b.md') }
    await expect(p.locator('#workspace-file-name')).toHaveText('b.md')
    await expect(p.locator('#workspace-draft-panel')).toBeHidden()
    await p.locator('#workspace-text').fill('文件 B 的独立草稿\n'); await savedDraft(p)
    const rootId = (await api('/workspace/roots')).roots[0].id
    const b = await api(`/workspace/draft?${new URLSearchParams({rootId,path:'b.md'})}`)
    expect(b.draft.text).toBe('文件 B 的独立草稿\n')
    expect(b.draft.baseSha256).toBe(new Bun.CryptoHasher('sha256').update('磁盘 B 原文\n').digest('hex'))
    evidence.noCrossFileStateLeak = true
  })

  await scenario('draft text remains recoverable when the whole source root disappears', async ({ page, api, project, directory, evidence }) => {
    const p = await page(); await open(p)
    const input = '源目录整体不见后仍须能够提取的草稿正文\n'
    await p.locator('#workspace-text').fill(input); await savedDraft(p)
    await p.locator('.nav[data-view="memory"]').click()
    // Both paths are fixed children of this verified temporary scenario root.
    expect(resolve(project).startsWith(resolve(directory) + sep)).toBe(true)
    const disappeared = join(directory, 'source-now-unavailable')
    expect(resolve(disappeared).startsWith(resolve(directory) + sep)).toBe(true)
    await rename(project, disappeared)
    await p.reload(); await p.locator('.nav[data-view="workspace"]').click()
    const listed = (await api('/workspace/drafts')).drafts
    expect(listed).toHaveLength(1)
    evidence.storedDraftId = listed[0].id
    evidence.draftStillListed = true
    await expect(p.locator('#workspace-drafts')).toContainText('a.md')
    await p.getByText('可恢复的编辑草稿',{exact:true}).click()
    const direct = p.locator('#workspace-drafts').getByRole('button', { name: /查看.*草稿|提取.*草稿|复制.*草稿|查看.*正文|读取.*草稿/ })
    if (await direct.count()) { await direct.first().click(); await expect(p.locator('#workspace-drafts textarea')).toHaveValue(input) }
    else { await p.locator('#workspace-drafts').getByRole('button', { name: '选择目录并打开', exact: true }).click(); await expect(p.locator('#workspace-draft-panel textarea')).toHaveValue(input) }
    evidence.sourceIndependentRecovery = true
  })

  await scenario('delayed discard response cannot erase new input typed in another file', async ({ page, api, evidence }) => {
    const p = await page(); await open(p)
    await p.locator('#workspace-text').fill('A 的待丢弃草稿\n'); await savedDraft(p)
    p.removeAllListeners('dialog'); p.on('dialog', dialog => void dialog.accept())
    const requested = Promise.withResolvers(), release = Promise.withResolvers()
    await p.route('**/api/workspace/draft', async route => {
      if (route.request().method() !== 'DELETE') return route.continue()
      const response = await route.fetch(); requested.resolve(); await release.promise; return route.fulfill({response})
    })
    const returned = p.waitForResponse(response => response.url().endsWith('/api/workspace/draft') && response.request().method() === 'DELETE')
    await p.getByRole('button', { name: '丢弃这份草稿', exact: true }).click()
    await requested.promise
    let switched = false
    try {
      const entry = p.locator('[data-workspace-entry="b.md"]')
      if (await entry.isEnabled()) {
        await entry.click(); await expect(p.locator('#workspace-file-name')).toHaveText('b.md')
        await p.locator('#workspace-text').fill('B 的新输入，不得被 A 的旧响应清掉\n')
        switched = true
      }
    } finally { release.resolve() }
    await (await returned).finished()
    await p.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    await p.unroute('**/api/workspace/draft')
    if (!switched) {
      await expect(p.locator('[data-workspace-entry="b.md"]')).toBeEnabled(); await open(p,'b.md')
      await p.locator('#workspace-text').fill('B 的新输入，不得被 A 的旧响应清掉\n')
    }
    evidence.switchedWhileDiscardResponseWasPending = switched
    evidence.actualFileAfterDiscardResponse = await p.locator('#workspace-file-name').textContent()
    evidence.actualEditorAfterDiscardResponse = await p.locator('#workspace-text').inputValue()
    evidence.remainingDraftPaths = (await api('/workspace/drafts')).drafts.map(draft => draft.path)
    await expect(p.locator('#workspace-file-name')).toHaveText('b.md')
    await expect(p.locator('#workspace-text')).toHaveValue('B 的新输入，不得被 A 的旧响应清掉\n')
    await savedDraft(p)
    const rootId = (await api('/workspace/roots')).roots[0].id
    expect((await api(`/workspace/draft?${new URLSearchParams({rootId,path:'b.md'})}`)).draft.text).toBe('B 的新输入，不得被 A 的旧响应清掉\n')
    evidence.newInputRetained = true
  })
  await scenario('save and navigation waiting on the same draft cannot leave the editor permanently busy', async ({ page, project, evidence }) => {
    const p = await page(); await open(p)
    const requested = Promise.withResolvers(), release = Promise.withResolvers()
    await p.route('**/api/workspace/draft', async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      const response = await route.fetch(); requested.resolve(); await release.promise; return route.fulfill({response})
    })
    await p.locator('#workspace-text').fill('保存与导航同时等待的编辑\n')
    await requested.promise
    await p.locator('#workspace-save').click()
    await p.locator('.nav[data-view="memory"]').click()
    release.resolve()
    await expect.poll(() => readFile(join(project,'a.md'),'utf8')).toBe('保存与导航同时等待的编辑\n')
    await p.locator('.nav[data-view="workspace"]').click()
    await expect(p.locator('#workspace-root')).toBeEnabled()
    await expect(p.locator('[data-workspace-entry="b.md"]')).toBeEnabled()
    await open(p,'b.md')
    await expect(p.locator('#workspace-text')).toBeEditable()
    evidence.navigationDidNotStrandSaveState = true
  })
} finally {
  const report = { result: results.every(item => item.result === 'passed') && !pageErrors.length && !cspErrors.length && !externalRequests.length ? 'passed' : 'failed', productVersion: version,
    runtime: 'current TypeScript source server with temporary SQLite identity; no compiled product or OpenCode claims', browser: browser.version(), date: new Date().toISOString(),
    sourceHashes, sourceHashesAfterRun: Object.fromEntries(await Promise.all(['src/web/app.js','src/server.ts','src/workspace-drafts.ts'].map(async path => [path,new Bun.CryptoHasher('sha256').update(await readFile(join(root,path))).digest('hex')]))), results, pageErrors, cspErrors, externalRequests }
  await writeFile(join(reportDir,'draft-browser-check.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify(report,null,2))
  await browser.close()
  const physical = await realpath(fixture), temp = await realpath(tmpdir())
  if (!physical.toLowerCase().startsWith(`${temp}${sep}`.toLowerCase()) || !physical.includes('xingyao-draft-browser-')) throw new Error('Unexpected temporary draft browser directory')
  await rm(physical,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  if (report.result !== 'passed') process.exitCode = 1
}
