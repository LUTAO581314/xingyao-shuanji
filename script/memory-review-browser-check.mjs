import { chromium, expect } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

// Runs the actual compiled product and selected OpenCode engine. Only the model
// provider is a deterministic loopback fixture; candidates are never DB-seeded.
const root = resolve(import.meta.dir, '..')
const { version } = await Bun.file(join(root, 'package.json')).json()
const executable = resolve(process.argv[2] ?? join(root, 'dist', `xingyao-${version}`, 'xingyao.exe'))
const engine = resolve(process.argv[3] ?? join(dirname(executable), 'opencode.exe'))
const fixture = await mkdtemp(join(tmpdir(), 'xingyao-memory-review-browser-'))
const host = join(fixture, 'host'), portable = join(fixture, 'portable'), project = join(fixture, 'project')
const reportDir = join(root, 'reports')
await Promise.all([host, portable, project, reportDir].map(path => mkdir(path, { recursive: true })))
const marker = '<img src=x onerror="globalThis.memoryReviewXss=1">'
const original = `我是临时验收用户，我现在喜欢喝茶；2020 年参加过课程；2100 年计划再学习；测试原文包含 ${marker}。`
const names = ['长期偏好', '已经到期的课程', '未来学习计划', '替代旧偏好', '暂不保存的认识']
const captured = [], checks = []
let extractionRequests = 0, runtime, browser, child
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Unexpected fixture route', { status: 404 })
  const body = await request.json()
  captured.push(body)
  const texts = (body.messages ?? []).filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
  const input = texts.map(text => { try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) } catch { return null } }).find(value => value?.policy === 'conversation-memory-v1' && Array.isArray(value.sources))
  if (!input) return completion(body, '已收到这段临时验收对话。')
  extractionRequests++
  if (body.tools?.length) throw new Error('Extraction unexpectedly exposed model tools')
  const source = input.sources.find(source => source.speaker === 'user' && source.text === original)
  if (!source) throw new Error('Extraction did not contain the actual product chat source')
  const existing = input.existingMemories.find(memory => memory.text === '过去的偏好：喝咖啡。')
  if (!existing) throw new Error('Extraction missing real existing-memory context')
  return completion(body, JSON.stringify({ candidates: names.map((name, index) => ({
    text: `${name}：${marker}`, subject: `临时验收用户 ${marker}`, kind: index === 4 ? 'inference' : 'fact', attribution: index === 4 ? 'inference' : 'user_statement',
    timeNote: index === 1 ? '2020 年，仍须主人确认具体日期' : index === 2 ? '2100 年，仍须主人确认具体日期' : `原文没有长期授权 ${marker}`,
    evidence: [{ sourceId: source.id, quote: source.text }], relatedMemoryIds: index === 3 ? [existing.id] : [],
  })) }))
} })
const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${runtime.origin}/api${path}`, { method, headers: { authorization: `Bearer ${decodeURIComponent(runtime.hash.slice(7))}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(`${path}: ${response.status} ${result.error}`)
  return result
}
try {
  await writeFile(join(host, 'engine-config.json'), JSON.stringify({ model: 'xingyao-local/test-model', small_model: 'xingyao-local/test-model', enabled_providers: ['xingyao-local'],
    provider: { 'xingyao-local': { name: 'Loopback memory-review browser fixture', npm: '@ai-sdk/openai-compatible', env: [],
      options: { baseURL: `${provider.url.origin}/v1`, apiKey: 'fixture-only-not-a-real-secret', timeout: 10000, maxRetries: 0 },
      models: { 'test-model': { name: 'Local fixture', tool_call: true, reasoning: false, attachment: false, temperature: false, limit: { context: 64000, output: 4096 }, cost: { input: 0, output: 0 } } },
    } },
  }))
  child = Bun.spawn([executable, '--portable-root', portable, '--host-root', host, '--project', project, '--engine', engine, '--no-open'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error('Isolated compiled product exited before readiness')
    const record = await readFile(join(host, 'running.json'), 'utf8').then(JSON.parse).catch(() => null)
    if (record?.url) { runtime = new URL(record.url); return true }
  }, 35000, 'compiled product readiness')
  const old = await api('/memories', { key: 'old-preference', text: '过去的偏好：喝咖啡。', kind: 'preference', scope: 'global' })
  await api('/memories', { key: 'foreign-memory', text: '其他项目不应成为替代选项', kind: 'fact', scope: 'foreign-project' })
  const task = await api('/tasks', { key: 'review-conversation', title: '对话记忆浏览器验收', scope: 'global' })
  await api(`/tasks/${task.id}/chat`, { key: 'review-source', text: original })
  const finished = await waitFor(async () => { const value = await api(`/tasks/${task.id}`); return value.status !== 'running' ? value : undefined }, 30000, 'actual engine chat')
  expect(finished.status).toBe('verifying')
  await api(`/tasks/${task.id}/complete`, {})
  browser = await chromium.launch({ ...(process.env.XINGYAO_BROWSER_EXECUTABLE ? { executablePath: process.env.XINGYAO_BROWSER_EXECUTABLE } : { channel: 'msedge' }), headless: true })
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 })
  const pageErrors = [], cspErrors = [], externalRequests = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (/violates.*Content Security Policy|Refused to .*policy/i.test(message.text())) cspErrors.push(message.text()) })
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === runtime.origin) return route.continue()
    externalRequests.push(route.request().url().split('?')[0]); return route.abort()
  })
  await page.goto(runtime.href)
  await page.locator('.nav[data-view="sleep"]').click()
  await page.locator('.memory-review-auto summary').click()
  await expect(page.locator('#memory-review-auto-save')).toBeEnabled()
  await expect(page.locator('#memory-review-auto-enabled')).not.toBeChecked()
  await page.locator('#memory-review-auto-enabled').check()
  await page.locator('#memory-review-auto-limit').fill('2')
  await page.locator('#memory-review-auto-save').click()
  await expect(page.locator('#memory-review-auto-status')).toContainText('已启用')
  expect(await api('/memory-review/settings')).toEqual({automatic:true,dailyBatchLimit:2,model:null})
  await page.locator('#memory-review-auto-enabled').uncheck()
  await page.locator('#memory-review-auto-save').click()
  await expect(page.locator('#memory-review-auto-status')).toContainText('已关闭')
  await page.locator('.memory-review-auto summary').click()
  checks.push('automatic extraction starts disabled; explicit UI opt-in/limit/opt-out persist through the real settings API')
  await page.locator('#memory-review-task').selectOption(task.id)
  await expect(page.locator('#memory-review-start')).toBeEnabled()
  const extracting = page.waitForResponse(response => response.url().endsWith('/api/memory-review') && response.request().method() === 'POST')
  await page.locator('#memory-review-start').click()
  expect((await extracting).status()).toBe(202)
  await expect(page.locator('.memory-review-card')).toHaveCount(5, { timeout: 30000 })
  await expect(page.locator('#memory-review-status')).toContainText('提取已完成')
  expect(extractionRequests).toBe(1)
  expect((await api('/memories')).length).toBe(2)
  checks.push('actual chat → real extraction API → engine → local fixture model → pending candidates; no automatic memory')
  const view = await api(`/memory-review?taskId=${task.id}`)
  const byName = name => view.candidates.find(candidate => candidate.text.startsWith(name))
  const card = name => page.locator(`[data-candidate-id="${byName(name).id}"]`)
  await expect(card(names[0]).locator('blockquote')).toHaveText(original)
  await expect(card(names[0]).locator('.memory-review-evidence')).toContainText(`来源 #${byName(names[0]).evidence[0].sourceId}`)
  expect(await page.evaluate(() => window.memoryReviewXss)).toBeUndefined()
  expect(await page.locator('#memory-review img').count()).toBe(0)
  await expect(card(names[1]).locator('[name="validity"]')).toHaveValue('')
  await expect(card(names[1]).locator('[name="validFrom"]')).toHaveValue('')
  await expect(card(names[1]).locator('[name="validUntil"]')).toHaveValue('')
  expect(await card(names[0]).locator('form').evaluate(form => form.checkValidity())).toBe(false)
  checks.push('source IDs/quotes/subject/attribution/time hint displayed literally; XSS inert; validity explicitly required')
  const draft = card(names[0]), edited = '长期偏好：主人审阅后的正文。'
  const sameTextarea = await draft.locator('[name="text"]').elementHandle()
  await draft.locator('[name="text"]').fill(edited)
  await draft.locator('[name="validity"]').selectOption('long')
  await draft.locator('[name="resolution"]').selectOption('add')
  const polled = page.waitForResponse(response => response.url().includes('/api/memory-review?') && response.request().method() === 'GET')
  await draft.locator('[name="text"]').focus()
  await polled
  await expect(draft.locator('[name="text"]')).toHaveValue(edited)
  expect(await sameTextarea.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
  checks.push('background polling retains edited DOM node, text, validity choice and focus')
  await api('/seal', { sealed: true })
  await expect(page.locator('#memory-review-start')).toBeDisabled()
  await expect(draft.locator('[data-review-accept]')).toBeDisabled()
  await expect(page.locator('#memory-review-status')).toContainText('已封存')
  await card(names[4]).locator('[data-review-reject]').click()
  await expect(card(names[4])).toContainText('已决定不保存')
  await api('/seal', { sealed: false })
  await expect(page.locator('#memory-review-status')).not.toContainText('已封存')
  await page.locator('#memory-review-refresh').click()
  await expect(draft.locator('[data-review-accept]')).toBeEnabled()
  await expect(draft.locator('[name="text"]')).toHaveValue(edited)
  checks.push('sealed state disables extraction/acceptance, permits rejection, and preserves drafts')
  const reviewedRevision = (await api(`/memory-review?taskId=${task.id}`)).revision
  let conflictPayload
  await page.route('**/api/memory-review/*/accept', async route => {
    conflictPayload = route.request().postDataJSON()
    await api('/memories', { key: 'concurrent-revision', text: '另一个窗口的真实并发变更', kind: 'fact', scope: 'global' })
    await route.continue()
  }, { times: 1 })
  await draft.locator('[name="confirmed"]').check()
  const conflictResponse = page.waitForResponse(response => response.url().endsWith('/accept'))
  await draft.locator('[data-review-accept]').click()
  expect((await conflictResponse).status()).toBe(409)
  expect(conflictPayload.validFrom).toBeNull()
  expect(conflictPayload.validUntil).toBeNull()
  expect(conflictPayload.reviewRevision).toBe(reviewedRevision)
  await expect(draft.locator('.memory-review-draft-status')).toContainText('编辑稿已保留')
  await expect(draft.locator('[name="text"]')).toHaveValue(edited)
  await expect(draft.locator('[data-review-accept]')).toBeDisabled()
  await draft.locator('[data-review-rebase]').click()
  await expect(draft.locator('[data-review-accept]')).toBeEnabled()
  await expect(draft.locator('[name="confirmed"]')).not.toBeChecked()
  await expect(draft.locator('[name="text"]')).toHaveValue(edited)
  await draft.locator('[name="confirmed"]').check()
  await draft.locator('[data-review-accept]').click()
  await expect(card(names[0])).toContainText('已保存为记忆')
  checks.push('real concurrent mutation produces HTTP 409; explicit refresh keeps draft and requires renewed confirmation')
  for (const [name, from, until] of [[names[1], '2020-01-01', '2020-12-31'], [names[2], '2100-01-01', '2100-12-31']]) {
    const target = card(name)
    await target.locator('[data-review-rebase]').click()
    await expect(target.locator('[data-review-accept]')).toBeEnabled()
    await target.locator('[name="validity"]').selectOption('range')
    await target.locator('[name="validFrom"]').fill(from)
    await target.locator('[name="validUntil"]').fill(until)
    await target.locator('[name="resolution"]').selectOption('add')
    await target.locator('[name="confirmed"]').check()
    await target.locator('[data-review-accept]').click()
    await expect(card(name)).toContainText('已保存为记忆')
  }
  const replacement = card(names[3])
  await replacement.locator('[data-review-rebase]').click()
  await expect(replacement.locator('[data-review-accept]')).toBeEnabled()
  await replacement.locator('[name="validity"]').selectOption('long')
  await replacement.locator('[name="resolution"]').selectOption('replace')
  await expect(replacement.locator('[name="replacement"]')).not.toContainText('其他项目')
  await replacement.locator('[name="replacement"]').selectOption(old.id)
  await expect(replacement.locator('.memory-review-existing')).toContainText(old.text)
  await expect(replacement.locator('.memory-review-existing')).toContainText(`修订 ${old.revision}`)
  await replacement.locator('[name="confirmed"]').check()
  await page.screenshot({ path: join(reportDir, 'xingyao-memory-review.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: join(reportDir, 'xingyao-memory-review-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1600, height: 1050 })
  await replacement.locator('[data-review-accept]').click()
  await expect(card(names[3])).toContainText('已保存为记忆')
  const saved = await api('/memories')
  expect(saved.some(memory => memory.id === old.id)).toBe(false)
  expect(saved.find(memory => memory.text === edited).claim).toMatchObject({ subject: `临时验收用户 ${marker}`, attribution: 'user_statement', validFrom: null, validUntil: null })
  expect(saved.filter(memory => memory.claim).length).toBe(4)
  checks.push('long-term and explicit date-range claims persist; same-scope replacement submits current revision and retires old memory')
  await page.locator('.nav[data-view="memory"]').click()
  await expect(page.locator('.memory-card').filter({ hasText: names[1] })).toContainText('已到期 · 不参与当前对话')
  await expect(page.locator('.memory-card').filter({ hasText: names[2] })).toContainText('尚未生效 · 不参与当前对话')
  await expect(page.locator('.memory-card').filter({ hasText: edited })).toContainText('主体：临时验收用户')
  await expect(page.locator('.memory-card').filter({ hasText: edited })).toContainText('有效期：长期')
  expect(await page.evaluate(() => window.memoryReviewXss)).toBeUndefined()
  expect(pageErrors).toEqual([]); expect(cspErrors).toEqual([]); expect(externalRequests).toEqual([])
  checks.push('memory management shows reviewed subject/attribution/validity, expired and future states; responsive layout; no browser/CSP/external-network errors')
  const report = { result: 'passed', productVersion: version, executable, sha256: new Bun.CryptoHasher('sha256').update(await Bun.file(executable).arrayBuffer()).digest('hex'), engine,
    engineSha256: new Bun.CryptoHasher('sha256').update(await Bun.file(engine).arrayBuffer()).digest('hex'), browser: browser.version(), model: 'deterministic localhost provider fixture; no public model used',
    date: new Date().toISOString(), extractionRequests, totalModelRequests: captured.length, checks, pageErrors, cspErrors, externalRequests }
  await writeFile(join(reportDir, 'memory-review-browser-check.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser?.close()
  if (runtime) await api('/shutdown', {}).catch(() => {})
  if (child && child.exitCode === null) {
    await Promise.race([child.exited, Bun.sleep(5000)])
    if (child.exitCode === null) { child.kill(); await child.exited }
  }
  await provider.stop(true)
  const physical = await realpath(fixture), temp = await realpath(tmpdir())
  if (!physical.toLowerCase().startsWith(`${temp}${sep}`.toLowerCase()) || !physical.includes('xingyao-memory-review-browser-')) throw new Error('Unexpected temporary browser directory')
  await rm(physical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
async function waitFor(sample, timeout, label) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await sample(); if (value !== undefined) return value; await Bun.sleep(50) }
  throw new Error(`Timed out waiting for ${label}`)
}
function completion(request, content) {
  const common = { id: `chatcmpl_${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model: 'test-model' }
  if (request.stream !== true) return Response.json({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  const chunks = [
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
  ]
  return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
}
