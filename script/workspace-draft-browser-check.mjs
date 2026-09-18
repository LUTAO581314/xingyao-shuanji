import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, relative, isAbsolute } from 'node:path'

// Actual compiled product, HTTP API and browser UI. Only network failures and
// request scheduling are injected; no success responses or draft records are mocked.
const root = resolve(import.meta.dir, '..')
const { version } = await Bun.file(join(root, 'package.json')).json()
const executable = resolve(process.argv[2] ?? join(root, 'dist', `xingyao-${version}`, 'xingyao.exe'))
const fixture = await mkdtemp(join(tmpdir(), 'xingyao-workspace-draft-browser-'))
const host = join(fixture, 'host'), portable = join(fixture, 'portable'), workspace = join(fixture, '项目文件')
const reportDir = join(root, 'reports')
await Promise.all([workspace, reportDir].map(path => mkdir(path, { recursive: true })))
const originals = { '恢复.md': '恢复场景磁盘原文\n', '冲突.md': '两个页面共有的磁盘原文\n', '磁盘.md': '外部修改之前的磁盘原文\n', '断网.md': '网络失败场景磁盘原文\n', '清理.md': '保存清理场景磁盘原文\n', '保存切页.md': '保存切页场景磁盘原文\n', '继续编辑.md': '保存切页之后另一个文件的原文\n' }
await Promise.all(Object.entries(originals).map(([name, content]) => writeFile(join(workspace, name), content)))
const checked = [], pageErrors = [], cspErrors = [], externalRequests = [], responses = []
let child, runtime, browser, activePage, selectedRoot
const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${runtime.origin}/api${path}`, { method,
    headers: { authorization: `Bearer ${decodeURIComponent(runtime.hash.slice(7))}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`Product API ${method} ${path} returned ${response.status}: ${result.error}`)
  return result
}
const draftState = (name, rootId = selectedRoot) => api(`/workspace/draft?${new URLSearchParams({ rootId, path: name })}`)
const isDraft = request => new URL(request.url()).pathname === '/api/workspace/draft'
const draftResponse = (page, method, name, content) => page.waitForResponse(response => {
  const request = response.request()
  if (!isDraft(request) || request.method() !== method) return false
  const body = request.postDataJSON()
  return body?.path === name && (content === undefined || body.text === content)
}, { timeout: 15000 })
async function start() {
  runtime = undefined
  child = Bun.spawn([executable, '--portable-root', portable, '--host-root', host, '--offline', '--no-open'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Isolated compiled product exited before readiness')
    const record = await readFile(join(host, 'running.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (record?.url) { runtime = new URL(record.url); return true }
  }, 30000, 'compiled product readiness')
}
async function stop() {
  if (runtime && child?.exitCode === null) await api('/shutdown', {}).catch(() => {})
  if (child?.exitCode === null) await Promise.race([child.exited, Bun.sleep(8000)])
  if (child?.exitCode === null) { child.kill(); await child.exited }
}
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (/violates.*Content Security Policy|Refused to .*policy/i.test(message.text())) cspErrors.push(message.text()) })
  page.on('response', response => { if (isDraft(response.request())) responses.push({ method: response.request().method(), status: response.status() }) })
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === runtime.origin) return route.continue()
    externalRequests.push(new URL(route.request().url()).origin); return route.abort()
  })
  // Avoid putting even temporary session tokens in navigation URLs or failure logs.
  await page.addInitScript(token => sessionStorage.setItem('xingyao-token', token), decodeURIComponent(runtime.hash.slice(7)))
  await page.goto(runtime.origin)
  await page.locator('.nav[data-view="workspace"]').click()
  await expect(page.locator('#workspace-directory')).toBeEnabled()
  activePage = page
  return page
}
async function addRoot(page, directory = workspace) {
  activePage = page
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace/roots' && response.request().method() === 'POST')
  await page.locator('#workspace-directory').fill(directory)
  await page.locator('#workspace-add-root').click()
  const result = await response
  expect(result.status()).toBe(201)
  const entry = await result.json()
  await expect(page.locator('#workspace-root')).toHaveValue(entry.id)
  return entry.id
}
async function open(page, name, rootId = selectedRoot) {
  activePage = page
  if (await page.locator('#workspace-root').inputValue() !== rootId) await page.locator('#workspace-root').selectOption(rootId)
  await page.locator(`[data-workspace-entry="${name}"]`).click()
  await expect(page.locator('#workspace-file-name')).toHaveText(name)
  await expect(page.locator('#workspace-reload')).toBeEnabled()
}
async function editConfirmed(page, name, content) {
  activePage = page
  const pending = draftResponse(page, 'PUT', name, content)
  await page.locator('#workspace-text').fill(content)
  expect((await pending).status()).toBe(200)
  await expect(page.locator('#workspace-dirty')).toHaveText('草稿已保存 · 文件未保存')
  expect((await draftState(name)).draft.text).toBe(content)
}
async function restore(page, content) {
  await expect(page.locator('#workspace-draft-panel')).toContainText('发现可恢复的草稿')
  await expect(page.locator('#workspace-text')).not.toBeEditable()
  await page.getByRole('button', { name: '恢复草稿到编辑器', exact: true }).click()
  await expect(page.locator('#workspace-text')).toHaveValue(content)
}
try {
  await start()
  browser = await chromium.launch({ ...(process.env.XINGYAO_BROWSER_EXECUTABLE ? { executablePath: process.env.XINGYAO_BROWSER_EXECUTABLE } : { channel: 'msedge' }), headless: true })
  let page = await newPage()
  selectedRoot = await addRoot(page)
  await open(page, '恢复.md')
  const recovered = '确认保存过的编辑草稿\n第二行依然存在。\n'
  await editConfirmed(page, '恢复.md', recovered)
  const beforeRestart = await draftState('恢复.md')
  expect(await readFile(join(workspace, '恢复.md'), 'utf8')).toBe(originals['恢复.md'])
  expect(await api('/knowledge')).toEqual([])
  expect(await api('/memories')).toEqual([])
  await page.reload()
  await page.locator('.nav[data-view="workspace"]').click()
  await open(page, '恢复.md')
  await expect(page.locator('#workspace-text')).toHaveValue(originals['恢复.md'])
  await restore(page, recovered)
  await page.close()
  await stop()
  await start()
  page = await newPage()
  const formerRoot = selectedRoot
  selectedRoot = await addRoot(page)
  expect(selectedRoot).not.toBe(formerRoot)
  await open(page, '恢复.md')
  await restore(page, recovered)
  expect(await draftState('恢复.md')).toEqual(beforeRestart)
  checked.push('acknowledged draft survives browser reload and compiled-product restart with a new directory capability; source, knowledge and memory remain unchanged')

  const second = await newPage()
  await open(page, '冲突.md')
  await open(second, '冲突.md')
  const firstEdit = '页面 A 已确认的草稿', secondEdit = '页面 B 尚未合并的编辑'
  await editConfirmed(page, '冲突.md', firstEdit)
  const collision = draftResponse(second, 'PUT', '冲突.md', secondEdit)
  await second.locator('#workspace-text').fill(secondEdit)
  expect((await collision).status()).toBe(409)
  await expect(second.locator('#workspace-draft-panel')).toContainText('当前编辑保留')
  await expect(second.locator('#workspace-text')).toHaveValue(secondEdit)
  expect((await draftState('冲突.md')).draft.text).toBe(firstEdit)
  expect(await readFile(join(workspace, '冲突.md'), 'utf8')).toBe(originals['冲突.md'])
  await second.getByRole('button', { name: '读取最新草稿并对照', exact: true }).click()
  const serverPreview = second.locator('#workspace-draft-panel details').filter({ has: second.locator('summary', { hasText: '服务器当前草稿（只读）' }) })
  await expect(serverPreview.locator('textarea')).toHaveValue(firstEdit)
  const merged = `${firstEdit}\n${secondEdit}\n主人明确合并。`
  await second.locator('#workspace-text').fill(merged)
  const combined = draftResponse(second, 'PATCH', '冲突.md', merged)
  await second.getByRole('button', { name: '已核对：保存当前编辑作为合并稿', exact: true }).click()
  expect((await combined).status()).toBe(200)
  await expect(second.locator('#workspace-draft-panel')).not.toContainText('草稿尚未确认保存')
  expect((await draftState('冲突.md')).draft.text).toBe(merged)
  await second.close()
  checked.push('two real pages receive HTTP 409 on a stale autosave; unsaved text is retained and explicit comparison/merge produces a new draft revision')

  await open(page, '磁盘.md')
  const oldDiskDraft = '先写下、尚未保存到文件的草稿'
  await editConfirmed(page, '磁盘.md', oldDiskDraft)
  const oldDiskState = await draftState('磁盘.md')
  const external = '由外部编辑器修改的磁盘正文。\n'
  await writeFile(join(workspace, '磁盘.md'), external)
  await page.locator('#workspace-reload').click()
  await expect(page.locator('#workspace-text')).toHaveValue(external)
  await expect(page.locator('#workspace-draft-panel')).toContainText('磁盘版本与草稿的原始版本不同')
  await restore(page, oldDiskDraft)
  await expect(page.locator('#workspace-save')).toBeDisabled()
  const diskMerge = `${external}${oldDiskDraft}\n已核对双方内容。`
  await editConfirmed(page, '磁盘.md', diskMerge)
  expect((await draftState('磁盘.md')).draft.baseSha256).toBe(oldDiskState.draft.baseSha256)
  await expect(page.locator('#workspace-save')).toBeDisabled()
  expect(await readFile(join(workspace, '磁盘.md'), 'utf8')).toBe(external)
  const rebased = draftResponse(page, 'PATCH', '磁盘.md', diskMerge)
  await page.getByRole('button', { name: '已核对：以当前磁盘版本继续编辑', exact: true }).click()
  expect((await rebased).status()).toBe(200)
  expect((await draftState('磁盘.md')).draft.baseSha256).toBe(new Bun.CryptoHasher('sha256').update(external).digest('hex'))
  await expect(page.locator('#workspace-save')).toBeEnabled()
  expect(await readFile(join(workspace, '磁盘.md'), 'utf8')).toBe(external)
  await page.locator('#workspace-save').click()
  await expect(page.locator('#workspace-status')).toContainText('文件已保存')
  expect(await readFile(join(workspace, '磁盘.md'), 'utf8')).toBe(diskMerge)
  expect((await draftState('磁盘.md')).draft).toBeNull()
  checked.push('external disk modification blocks save; editing retains old baseline until explicit rebase; only an explicit file save changes disk bytes')

  await open(page, '断网.md')
  const unsent = '网络失败期间仍然留在当前编辑器的输入'
  let blockedSaves = 0
  const failure = async route => {
    if (route.request().method() === 'PUT') { blockedSaves++; await route.abort('connectionfailed') }
    else await route.fallback()
  }
  await page.route('**/api/workspace/draft', failure)
  await page.locator('#workspace-text').fill(unsent)
  await expect(page.locator('#workspace-draft-panel')).toContainText('草稿尚未确认保存')
  await page.locator('.nav[data-view="chat"]').click()
  await expect(page.locator('#workspace-status')).toContainText('处理后再离开项目文件')
  await expect(page.locator('#view-workspace')).toBeVisible()
  await expect(page.locator('#workspace-text')).toHaveValue(unsent)
  await page.locator('[data-workspace-entry="恢复.md"]').click()
  await expect(page.locator('#workspace-status')).toContainText('处理后再打开另一个文件')
  await expect(page.locator('#workspace-file-name')).toHaveText('断网.md')
  await expect(page.locator('#workspace-text')).toHaveValue(unsent)
  expect(blockedSaves).toBeGreaterThanOrEqual(3)
  expect((await draftState('断网.md')).draft).toBeNull()
  expect(await readFile(join(workspace, '断网.md'), 'utf8')).toBe(originals['断网.md'])
  await page.unroute('**/api/workspace/draft', failure)
  const retried = draftResponse(page, 'PUT', '断网.md', unsent)
  await page.getByRole('button', { name: '重试保存草稿', exact: true }).click()
  expect((await retried).status()).toBe(200)
  await expect(page.locator('#workspace-dirty')).toHaveText('草稿已保存 · 文件未保存')
  checked.push('real network failure prevents both view and file navigation, retains editor text, and permits acknowledged retry after connectivity returns')

  await open(page, '清理.md')
  const saving = '页面 A 本次要保存的正文', racing = '页面 B 在保存之后新增的草稿'
  await editConfirmed(page, '清理.md', saving)
  const racingPage = await newPage()
  await open(racingPage, '清理.md')
  await restore(racingPage, saving)
  const reachedCleanup = Promise.withResolvers(), releaseCleanup = Promise.withResolvers()
  let cleanupReleased = false
  const delayedCleanup = async route => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    reachedCleanup.resolve()
    await releaseCleanup.promise
    await route.continue()
  }
  await page.route('**/api/workspace/draft', delayedCleanup)
  const cleanupResponse = draftResponse(page, 'DELETE', '清理.md')
  await page.locator('#workspace-save').click()
  try {
    await Promise.race([reachedCleanup.promise, Bun.sleep(15000).then(() => { throw new Error('File save did not reach draft cleanup') })])
    expect(await readFile(join(workspace, '清理.md'), 'utf8')).toBe(saving)
    await editConfirmed(racingPage, '清理.md', racing)
    releaseCleanup.resolve(); cleanupReleased = true
    expect((await cleanupResponse).status()).toBe(409)
    await expect(page.locator('#workspace-backup')).toContainText('草稿清理未完成')
    expect((await draftState('清理.md')).draft.text).toBe(racing)
    expect(await readFile(join(workspace, '清理.md'), 'utf8')).toBe(saving)
  } finally {
    if (!cleanupReleased) releaseCleanup.resolve()
    await page.unroute('**/api/workspace/draft', delayedCleanup)
  }
  await racingPage.close()
  activePage = page
  await page.locator('#workspace-reload').click()
  await expect(page.locator('#workspace-draft-panel')).toContainText('发现可恢复的草稿')
  await expect(page.locator('#workspace-draft-panel textarea.workspace-draft-preview').first()).toHaveValue(racing)
  await expect(page.locator('#workspace-text')).toHaveValue(saving)
  await page.screenshot({ path: join(reportDir, `xingyao-workspace-drafts-${version}.png`), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: join(reportDir, `xingyao-workspace-drafts-${version}-mobile.png`), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1050 })
  checked.push('a new draft from a second page after file publication survives stale cleanup DELETE 409 and can be recovered with original file bytes intact')

  await open(page, '保存切页.md')
  const navigatingSave = '保存与导航同时等待已提交草稿的编辑\n'
  const draftCommitted = Promise.withResolvers(), releaseDraftReply = Promise.withResolvers()
  let delayedPutStatus, delayedPutError
  const delayedPutReply = async route => {
    if (route.request().method() !== 'PUT' || route.request().postDataJSON()?.path !== '保存切页.md') return route.fallback()
    try {
      // Publish the real draft first; hold only its HTTP acknowledgement.
      const response = await route.fetch({ timeout: 15000 })
      delayedPutStatus = response.status(); draftCommitted.resolve()
      await releaseDraftReply.promise
      await route.fulfill({ response })
    } catch (error) { delayedPutError = error; draftCommitted.resolve(); await route.abort().catch(() => {}) }
  }
  await page.route('**/api/workspace/draft', delayedPutReply)
  try {
    await page.locator('#workspace-text').fill(navigatingSave)
    await Promise.race([draftCommitted.promise, Bun.sleep(15000).then(() => { throw new Error('Delayed draft PUT did not commit') })])
    if (delayedPutError) throw delayedPutError
    expect(delayedPutStatus).toBe(200)
    expect((await draftState('保存切页.md')).draft.text).toBe(navigatingSave)
    expect(await readFile(join(workspace, '保存切页.md'), 'utf8')).toBe(originals['保存切页.md'])
    await page.locator('#workspace-save').click()
    await page.locator('.nav[data-view="memory"]').click()
    releaseDraftReply.resolve()
    await expect.poll(() => readFile(join(workspace, '保存切页.md'), 'utf8'), { timeout: 15000 }).toBe(navigatingSave)
    await page.locator('.nav[data-view="workspace"]').click()
    await expect(page.locator('#workspace-root')).toBeEnabled({ timeout: 15000 })
    await expect(page.locator('[data-workspace-entry="继续编辑.md"]')).toBeEnabled()
    await open(page, '继续编辑.md')
    await expect(page.locator('#workspace-text')).toBeEditable()
    await expect(page.locator('#workspace-text')).toHaveValue(originals['继续编辑.md'])
    await editConfirmed(page, '继续编辑.md', '竞态结束后仍可正常输入和保存新草稿\n')
    expect(await readFile(join(workspace, '继续编辑.md'), 'utf8')).toBe(originals['继续编辑.md'])
    if (delayedPutError) throw delayedPutError
  } finally {
    releaseDraftReply.resolve()
    await page.unroute('**/api/workspace/draft', delayedPutReply)
  }
  checked.push('save and memory navigation during a delayed committed draft PUT acknowledgement write the requested file and leave directory selection, file switching, editing and subsequent draft saving usable')

  const missing = join(fixture, '稍后消失的目录'), relocated = join(fixture, '已移动的目录')
  await mkdir(missing)
  await writeFile(join(missing, '孤立草稿.md'), '目录尚可用时的磁盘正文')
  const missingRoot = await addRoot(page, missing)
  await open(page, '孤立草稿.md', missingRoot)
  const orphan = '目录消失后仍可复制的草稿。\n<img src=x onerror="globalThis.workspaceDraftXss=1">'
  const orphanResponse = draftResponse(page, 'PUT', '孤立草稿.md', orphan)
  await page.locator('#workspace-text').fill(orphan)
  expect((await orphanResponse).status()).toBe(200)
  await expect(page.locator('#workspace-dirty')).toHaveText('草稿已保存 · 文件未保存')
  const orphanState = await draftState('孤立草稿.md', missingRoot)
  await page.locator('.nav[data-view="chat"]').click()
  assertFixturePath(missing); assertFixturePath(relocated)
  await rename(missing, relocated)
  await page.locator('.nav[data-view="workspace"]').click()
  await page.locator('.workspace-draft-list > summary').click()
  const row = page.locator(`[data-workspace-draft-id="${orphanState.draft.id}"]`)
  await expect(row).toBeVisible()
  const byId = page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace/draft' && new URL(response.url()).searchParams.get('id') === orphanState.draft.id)
  await row.getByRole('button', { name: '查看草稿（只读）', exact: true }).click()
  expect((await byId).status()).toBe(200)
  await expect(row.locator('textarea')).toHaveValue(orphan)
  await expect(row.locator('textarea')).not.toBeEditable()
  expect(await page.evaluate(() => window.workspaceDraftXss)).toBeUndefined()
  expect(await row.locator('img').count()).toBe(0)
  const directRead = await api(`/workspace/draft?${new URLSearchParams({ id: orphanState.draft.id })}`)
  expect(directRead.draft.text).toBe(orphan)
  expect(await readFile(join(relocated, '孤立草稿.md'), 'utf8')).toBe('目录尚可用时的磁盘正文')
  checked.push('missing source directory still permits authenticated draft-ID read and read-only UI copy; source text remains literal and never becomes HTML')
  expect(await api('/knowledge')).toEqual([])
  expect(await api('/memories')).toEqual([])
  expect(pageErrors).toEqual([]); expect(cspErrors).toEqual([]); expect(externalRequests).toEqual([])
  checked.push('all drafts remain separate from knowledge and memories; desktop/mobile layout and browser/CSP/network checks pass')
  const report = { result: 'passed', version, executable, executableSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex'),
    browserVersion: browser.version(), offline: true, temporaryIdentityOnly: true, checked, draftHttpResponses: responses, pageErrors, cspErrors, externalRequests, createdAt: new Date().toISOString() }
  await writeFile(join(reportDir, `workspace-draft-browser-${version}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  await activePage?.screenshot({ path: join(reportDir, `workspace-draft-failure-${version}.png`), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await stop()
  const actual = await realpath(fixture), tempRoot = await realpath(tmpdir())
  if (!actual.toLowerCase().startsWith((tempRoot + sep).toLowerCase()) || !actual.split(sep).at(-1).startsWith('xingyao-workspace-draft-browser-')) throw new Error('Unexpected fixture cleanup location')
  await rm(actual, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
function assertFixturePath(path) {
  const rel = relative(resolve(fixture), resolve(path))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Fixture operation escaped the temporary test directory')
}
async function waitFor(sample, timeout, label) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await sample(); if (value !== undefined) return value; await Bun.sleep(50) }
  throw new Error(`Timed out waiting for ${label}`)
}
