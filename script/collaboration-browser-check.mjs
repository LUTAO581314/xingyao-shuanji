import { chromium, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const { version } = await Bun.file(join(root, 'package.json')).json()
const executable = resolve(process.argv[2] ?? join(root, 'dist', `xingyao-${version}`, 'xingyao.exe'))
const fixture = await mkdtemp(join(tmpdir(), 'xingyao-collaboration-browser-'))
const host = join(fixture, 'host'), portable = join(fixture, 'portable'), project = join(fixture, 'project')
const fakeEngine = join(fixture, 'opencode-fixture.exe'), reports = join(root, 'reports')
await Promise.all([host, portable, project, reports].map(path => mkdir(path, { recursive: true })))
let child, browser, runtime
const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${runtime.origin}/api${path}`, { method, headers: { authorization: `Bearer ${decodeURIComponent(runtime.hash.slice(7))}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${result.error}`)
  return result
}
try {
  const built = await Bun.build({ entrypoints: [join(root, 'script/fixtures/collaboration-engine.ts')], compile: { target: 'bun-windows-x64', outfile: fakeEngine }, minify: true })
  if (!built.success) throw new AggregateError(built.logs, 'fixture engine build failed')
  child = Bun.spawn([executable, '--portable-root', portable, '--host-root', host, '--project', project, '--engine', fakeEngine, '--no-open'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('compiled product exited before readiness')
    const record = await readFile(join(host, 'running.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (record?.url) { runtime = new URL(record.url); return true }
  }, 30_000, 'compiled collaboration product readiness')
  const task = await api('/tasks', { key: 'collaboration-browser', title: '协作浏览器验收', scope: 'global' })
  await api(`/tasks/${task.id}/chat`, { key: 'delegate-browser', text: '请分派并核对这项工作。' })
  const finished = await waitFor(async () => { const value = await api(`/tasks/${task.id}`); return value.status !== 'running' ? value : undefined }, 10_000, 'root task response')
  expect(finished.status).toBe('verifying')
  const before = JSON.stringify({ task: await api(`/tasks/${task.id}`), memories: await api('/memories') })
  const view = await api(`/tasks/${task.id}/collaboration`)
  expect(view.sessions).toHaveLength(3)
  expect(view.sessions.map(session => [session.sessionID, session.parentSessionID, session.depth, session.status.type])).toEqual([
    ['ses_review', 'ses_root', 1, 'busy'], ['ses_compat', 'ses_root', 1, 'idle'], ['ses_nested', 'ses_review', 2, 'retry'],
  ])
  for (const secret of ['private-command-marker', 'private-output-marker', 'private-auth-marker', 'private-status-marker', 'private-retry-marker']) expect(JSON.stringify(view)).not.toContain(secret)
  expect(JSON.stringify({ task: await api(`/tasks/${task.id}`), memories: await api('/memories') })).toBe(before)

  browser = await chromium.launch({ ...(process.env.XINGYAO_BROWSER_EXECUTABLE ? { executablePath: process.env.XINGYAO_BROWSER_EXECUTABLE } : { channel: 'msedge' }), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = [], cspErrors = [], externalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (/Content Security Policy|Refused to/i.test(message.text())) cspErrors.push(message.text()) })
  await page.route('**/*', route => { if (new URL(route.request().url()).origin === runtime.origin) return route.continue(); externalRequests.push(route.request().url()); return route.abort() })
  await page.goto(runtime.href)
  await page.locator('.nav[data-view="collaboration"]').click()
  await expect(page.locator('.collaboration-card')).toHaveCount(3)
  await expect(page.locator('#collaboration-count')).toContainText('3 个子智能体')
  await expect(page.locator('.collaboration-card.depth-2')).toContainText('核对来源隔离')
  await expect(page.locator('.collaboration-tool')).toHaveText(/bash.*shell-exit-zero.*退出码 0/)
  expect(await page.locator('#view-collaboration img').count()).toBe(0)
  expect(await page.evaluate(() => window.collaborationXss)).toBeUndefined()
  await page.screenshot({ path: join(reports, `collaboration-browser-${version}-desktop.png`), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.collaboration-card')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await page.screenshot({ path: join(reports, `collaboration-browser-${version}-mobile.png`), fullPage: true })
  expect(pageErrors).toEqual([]); expect(cspErrors).toEqual([]); expect(externalRequests).toEqual([])
  const sha256 = new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex')
  await Bun.write(join(reports, `collaboration-browser-${version}.json`), JSON.stringify({ result: 'passed', version, executable, sha256, sessions: 3, pageErrors, cspErrors, externalRequests }, null, 2))
  console.log(JSON.stringify({ result: 'passed', version, sessions: 3, desktop: join(reports, `collaboration-browser-${version}-desktop.png`), mobile: join(reports, `collaboration-browser-${version}-mobile.png`) }))
} finally {
  await browser?.close()
  if (runtime) await fetch(`${runtime.origin}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${decodeURIComponent(runtime.hash.slice(7))}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => {})
  if (child?.exitCode === null) child.kill()
  await child?.exited
  if (resolve(dirname(fixture)) !== resolve(tmpdir())) throw new Error('refusing cleanup outside temp')
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function waitFor(sample, timeout, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await sample(); if (value) return value; await Bun.sleep(100) }
  throw new Error(`Timed out waiting for ${label}`)
}
