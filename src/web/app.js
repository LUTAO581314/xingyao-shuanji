const $ = (selector) => document.querySelector(selector)
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const date = (value) => new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const uuid = () => crypto.randomUUID()
const statusNames = {ready:'准备开始',running:'正在处理',waiting:'待核实',verifying:'等待验收',completed:'已完成',failed:'执行失败',cancelled:'已取消'}
const kindNames = {preference:'偏好',fact:'事实',inference:'待验证认识',episode:'经历',commitment:'承诺'}
const titles = {chat:'对话与任务',memory:'记忆',knowledge:'知识库',skills:'经验技能',sleep:'睡眠整理',files:'文件管家',system:'系统中心'}
const token = location.hash.startsWith('#token=') ? decodeURIComponent(location.hash.slice(7)) : sessionStorage.getItem('xingyao-token')
if (token) sessionStorage.setItem('xingyao-token', token)
history.replaceState(null, '', location.pathname)
let state, selectedTask = null, view = 'chat', memories = [], taskSignature = '', permissionSignature = ''
let refreshing = false

async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api${path}`, {method,headers:{authorization:`Bearer ${token ?? ''}`,...(data !== undefined ? {'content-type':'application/json'} : {})},body:data === undefined ? undefined : JSON.stringify(data)})
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '请求失败')
  return result
}
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').className = `notice${error ? ' error' : ''}` }
async function action(fn) { try { await fn() } catch (error) { notice(error.message, true) } }
async function navigate(next) {
  view = next
  document.querySelectorAll('.view').forEach(item => item.classList.toggle('hidden', item.id !== `view-${view}`))
  document.querySelectorAll('.nav').forEach(item => item.classList.toggle('active', item.dataset.view === view))
  $('#page-title').textContent = titles[view]
  await refreshView()
}
document.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]')
  if (nav) action(() => navigate(nav.dataset.view))
  const suggestion = event.target.closest('[data-suggestion]')
  if (suggestion) { $('#prompt').value = suggestion.dataset.suggestion; $('#prompt').focus() }
})

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    state = await api('/state')
    $('#version').textContent = `V ${state.version}`
    $('#sync-state').textContent = state.checkpointError ? '同步需要处理' : state.checkpointing ? '正在同步' : state.unsynced ? '有未同步变化' : '已同步到 U 盘'
    $('#sync-state').className = `badge${state.unsynced ? ' warn' : ''}`
    $('#checkpoint').disabled = state.checkpointing
    $('#toggle-seal').textContent = state.sealed ? '解除封存' : '封存记忆'
    $('#task-list').innerHTML = state.tasks.length ? state.tasks.map(task => `<button class="task-item${task.id === selectedTask ? ' selected' : ''}" data-task="${escape(task.id)}"><strong>${escape(task.title)}</strong><small>${statusNames[task.status]} · ${date(task.updatedAt)}</small></button>`).join('') : '<p class="empty">暂时没有任务。<br>发送第一条消息，就能开始。</p>'
    if (selectedTask && view === 'chat') await refreshTask()
    if (view === 'sleep') renderSleep()
    if (view === 'system') await renderSystem()
    if (state.busy.length && view === 'chat') await refreshPermissions()
    else if (permissionSignature) { permissionSignature = ''; $('#permissions').innerHTML = '' }
  } finally { refreshing = false }
}
async function refreshView() {
  if (view === 'memory') await refreshMemories()
  if (view === 'knowledge') await refreshKnowledge()
  if (view === 'sleep') renderSleep()
  if (view === 'files') await refreshFiles()
  if (view === 'skills') await refreshSkills()
  if (view === 'system') await renderSystem()
  if (view === 'chat' && selectedTask) await refreshTask()
}
async function refreshTask() {
  const task = await api(`/tasks/${selectedTask}`)
  const signature = JSON.stringify(task)
  if (signature === taskSignature) return
  taskSignature = signature
  $('#task-title').textContent = task.title
  $('#task-subtitle').textContent = `${statusNames[task.status]} · 范围：${task.scope}`
  $('#task-controls').innerHTML = (task.status === 'running' ? '<button class="secondary" data-task-action="abort">停止</button>' : '') + (task.status === 'waiting' || task.status === 'failed' ? '<button class="secondary" data-task-action="reconcile">核实结果</button>' : '') + (task.status === 'verifying' ? '<button data-task-action="complete">确认完成</button>' : '')
  const nearBottom = $('#messages').scrollHeight - $('#messages').scrollTop - $('#messages').clientHeight < 90
  $('#messages').innerHTML = task.messages.map(message => `<div class="message ${escape(message.role)}"><div class="who">${message.role === 'user' ? '你' : message.role === 'assistant' ? '星杳' : '工作记录'} · ${date(message.createdAt)}</div><div class="body">${escape(message.text)}</div></div>`).join('') + (task.error ? `<div class="message system"><div class="body">${escape(task.error)}</div></div>` : '') + (task.status === 'running' ? '<div class="message"><div class="who">星杳正在处理…</div></div>' : '') + (task.actions.length ? `<details class="empty"><summary>执行依据 · ${task.actions.length} 项</summary>${task.actions.map(item => `<p><strong>${escape(item.tool)} · ${escape(item.status)}</strong><br>${escape(item.text)}</p>`).join('')}</details>` : '')
  if (nearBottom || task.messages.length < 3) $('#messages').scrollTop = $('#messages').scrollHeight
  $('#send').disabled = task.status === 'running' || task.status === 'waiting'
}
$('#task-list').addEventListener('click', event => action(async () => { const item = event.target.closest('[data-task]'); if (!item) return; selectedTask = item.dataset.task; taskSignature = ''; await refresh() }))
$('#task-controls').addEventListener('click', event => action(async () => { const item = event.target.closest('[data-task-action]'); if (!item) return; await api(`/tasks/${selectedTask}/${item.dataset.taskAction}`, {}); await refresh() }))
$('#new-task').onclick = () => { selectedTask = null; taskSignature = ''; $('#task-title').textContent = '开始一件新的事'; $('#task-subtitle').textContent = '给我一个明确的目标'; $('#messages').innerHTML = '<p class="empty">发送消息后会建立独立任务。</p>'; $('#task-controls').innerHTML = ''; $('#send').disabled = false; $('#prompt').focus(); action(refresh) }
$('#chat-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const input = $('#prompt').value.trim(); if (!input) return
  $('#send').disabled = true
  try {
    if (!selectedTask) selectedTask = (await api('/tasks', {key:uuid(),title:input.slice(0,45),scope:'global'})).id
    const modelValue = $('#model').value
    const model = modelValue ? JSON.parse(modelValue) : undefined
    await api(`/tasks/${selectedTask}/chat`, {key:uuid(),text:input,model})
    $('#prompt').value = ''; await refresh()
  } finally { if (!state?.busy.includes(selectedTask)) $('#send').disabled = false }
}) }
$('#prompt').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#chat-form').requestSubmit() } }

async function refreshPermissions() {
  const permissions = await api('/permissions')
  const signature = JSON.stringify(permissions)
  if (signature === permissionSignature) return
  permissionSignature = signature
  $('#permissions').innerHTML = permissions.map(item => `<div class="permission"><strong>需要你的授权：${escape(item.permission)}</strong><pre>${escape(item.patterns.join('\n'))}</pre><button data-permission="${escape(item.id)}" data-reply="once">允许这一次</button><button class="secondary" data-permission="${escape(item.id)}" data-reply="reject">拒绝</button></div>`).join('')
}
$('#permissions').onclick = event => action(async () => { const item = event.target.closest('[data-permission]'); if (!item) return; await api('/permissions/reply', {id:item.dataset.permission,reply:item.dataset.reply}); await refreshPermissions() })

async function refreshMemories() {
  memories = await api(`/memories?q=${encodeURIComponent($('#memory-search').value)}&private=${$('#private-memories').checked}`)
  $('#memory-list').innerHTML = memories.length ? memories.map(memory => `<article class="memory-card"><div class="card-meta"><span class="tag">${kindNames[memory.kind]}</span><span>${escape(memory.scope)}</span>${memory.pinned ? '<span>固定保留</span>' : ''}${memory.private ? '<span>私密</span>' : ''}<span>${date(memory.updatedAt)}</span></div><p>${escape(memory.text)}</p><div class="card-meta">来源 #${memory.sourceIds.join('、#')} · 修订 ${memory.revision}</div><div class="card-actions"><button class="secondary" data-edit-memory="${escape(memory.id)}">纠正</button><button class="secondary" data-forget-memory="${escape(memory.id)}">忘记</button></div></article>`).join('') : '<p class="empty">还没有匹配的记忆。你可以在左侧明确告诉我一件值得记住的事。</p>'
}
$('#memory-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api('/memories', {key:uuid(),text:form.get('text'),scope:form.get('scope'),kind:form.get('kind'),pinned:form.has('pinned'),private:form.has('private')}); event.target.elements.text.value = ''; notice('已保存记忆，并保留来源。'); await refreshMemories(); await refresh() }) }
$('#memory-search').oninput = () => action(refreshMemories)
$('#private-memories').onchange = () => action(refreshMemories)
$('#memory-list').onclick = event => action(async () => {
  const edit = event.target.closest('[data-edit-memory]'), forget = event.target.closest('[data-forget-memory]')
  if (edit) { const memory = memories.find(item => item.id === edit.dataset.editMemory); const form = $('#edit-form'); form.elements.id.value = memory.id; form.elements.revision.value = memory.revision; form.elements.text.value = memory.text; $('#edit-dialog').showModal() }
  if (forget) { const memory = memories.find(item => item.id === forget.dataset.forgetMemory); if (!confirm('删除这条记忆及其派生记录？已有备份、引擎会话和原始资料不在本次删除范围内。')) return; const result = await api(`/memories/${memory.id}`, {revision:memory.revision}, 'DELETE'); notice(result.backupNotice); await refreshMemories(); await refresh() }
})
$('#cancel-edit').onclick = () => $('#edit-dialog').close()
$('#edit-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api(`/memories/${form.get('id')}`, {revision:Number(form.get('revision')),text:form.get('text')}, 'PATCH'); $('#edit-dialog').close(); notice('纠正已生效，相关旧结论已失效。'); await refreshMemories(); await refresh() }) }

async function refreshKnowledge() {
  const documents = await api('/knowledge')
  $('#document-list').innerHTML = documents.length ? documents.map(item => `<article class="document-card"><h3>${escape(item.name)}</h3><p>${escape(item.path)}</p><div class="card-meta"><span>${escape(item.scope)}</span><span>${item.chunkCount} 个片段</span><span>版本 ${item.revision}</span></div><div class="card-actions"><button class="secondary" data-refresh-document="${escape(item.id)}">刷新资料</button><button class="secondary" data-remove-document="${escape(item.id)}">移除索引</button></div></article>`).join('') : '<p class="empty">导入第一份资料后，它会出现在这里。</p>'
}
$('#knowledge-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); const result = await api('/knowledge', {path:form.get('path'),scope:form.get('scope')}); notice(`已导入 ${result.name}，共 ${result.chunkCount} 个片段。`); await refreshKnowledge(); await refresh() }) }
$('#document-list').onclick = event => action(async () => { const item = event.target.closest('[data-refresh-document],[data-remove-document]'); if (!item) return; if (item.dataset.refreshDocument) await api(`/knowledge/${item.dataset.refreshDocument}`, {}); else await api(`/knowledge/${item.dataset.removeDocument}`, undefined, 'DELETE'); await refreshKnowledge(); $('#knowledge-results').innerHTML = ''; await refresh() })
$('#search-knowledge').onclick = () => action(async () => { const hits = await api(`/knowledge/search?q=${encodeURIComponent($('#knowledge-search').value)}`); $('#knowledge-results').innerHTML = hits.length ? hits.map(hit => `<div class="memory-card"><div class="card-meta">${escape(hit.name)} · 第 ${hit.startLine}–${hit.endLine} 行</div><p>${escape(hit.text)}</p></div>`).join('') : '<p class="empty">没有找到相关资料。</p>' })
function renderSleep() { if (!state) return; $('#sleep-reports').innerHTML = state.sleep.length ? state.sleep.map(report => `<article class="report-card"><div class="card-meta"><span class="tag">${report.status === 'completed' ? '整理完成' : '已暂停'}</span><span>${date(report.finishedAt)}</span></div><p>检查 ${report.examined} 条新经历，归档 ${report.created} 条记忆。<br>${escape(report.detail)}</p></article>`).join('') : '<p class="empty">完成一些任务后，在这里整理新的经历。</p>' }
$('#run-sleep').onclick = () => action(async () => { const report = await api('/sleep', {}); notice(`整理完成：处理 ${report.examined} 条新经历，归档 ${report.created} 条。`); await refresh() })
$('#toggle-seal').onclick = () => action(async () => { await api('/seal', {sealed:!state.sealed}); await refresh(); notice(state.sealed ? '已封存：个人记忆暂停参与对话和学习。' : '已解除封存。') })

async function refreshFiles() {
  const plans = await api('/files')
  $('#file-plans').innerHTML = plans.length ? plans.map(plan => `<article class="file-plan"><h3>${escape(plan.directory)}</h3><p>状态：${escape(plan.status)} · ${plan.items.length} 个文件。原件保留供撤销，会占用额外空间。</p>${plan.error ? `<p>${escape(plan.error)}</p>` : ''}<table><thead><tr><th>文件</th><th>目标分类</th><th>状态</th></tr></thead><tbody>${plan.items.map(item => `<tr><td>${escape(item.name)}</td><td>${escape(item.category)}</td><td>${escape(item.error ?? item.status)}</td></tr>`).join('')}</tbody></table><div class="card-actions">${['preview','partial'].includes(plan.status) ? `<button data-apply-plan="${escape(plan.id)}">按清单整理</button>` : ''}${['completed','partial'].includes(plan.status) ? `<button class="secondary" data-undo-plan="${escape(plan.id)}">撤销整理</button>` : ''}</div></article>`).join('') : '<p class="empty">输入一个目录，先查看整理预览。</p>'
}
$('#files-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api('/files', {directory:form.get('directory')}); await refreshFiles() }) }
$('#file-plans').onclick = event => action(async () => { const item = event.target.closest('[data-apply-plan],[data-undo-plan]'); if (!item) return; item.disabled = true; await api(`/files/${item.dataset.applyPlan ?? item.dataset.undoPlan}/${item.dataset.applyPlan ? 'apply' : 'undo'}`, {}); await refreshFiles(); await refresh() })

async function refreshSkills() {
  const [skills, sources] = await Promise.all([api('/skills'), api('/skills/sources')])
  $('#skill-sources').innerHTML = sources.length ? sources.slice(-30).reverse().map(source => `<label class="check"><input type="checkbox" name="source" value="${source.sourceId}">#${source.sourceId} ${escape(source.tool)} · ${escape(source.outcome)} · ${escape(source.scope)}</label>`).join('') : '<p class="empty">完成实际工具任务后，证据会出现在这里。</p>'
  const labels = {draft:'待验证',active:'已启用',needs_review:'需要复核',retracted:'已撤回'}
  $('#skill-list').innerHTML = skills.length ? skills.map(skill => `<article class="memory-card"><div class="card-meta"><span class="tag">${labels[skill.status]}</span><span>${escape(skill.scope)}</span></div><h3>${escape(skill.title)}</h3><p>适用：${escape(skill.when)}<br>${skill.steps.map(escape).join('<br>')}</p><p>不适用：${skill.avoid.map(escape).join('；') || '尚未补充'}</p><div class="card-meta">${skill.evaluation.independentSources} 个独立结果 · ${skill.evaluation.successes} 次成功 / ${skill.evaluation.failures} 次失败</div><p>${escape(skill.evaluation.reason)}</p><div class="card-actions">${skill.status !== 'active' && skill.status !== 'retracted' ? `<button data-promote-skill="${escape(skill.id)}" data-revision="${skill.revision}">验证后启用</button>` : ''}${skill.status !== 'retracted' ? `<button class="secondary" data-retract-skill="${escape(skill.id)}">撤回方法</button>` : ''}</div></article>`).join('') : '<p class="empty">这里保留可复用的方法。没有足够证据时，会明确保持待验证。</p>'
}
$('#skill-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api('/skills', {title:form.get('title'),scope:form.get('scope'),when:form.get('when'),steps:form.get('steps'),avoid:form.get('avoid'),sourceIds:form.getAll('source').map(Number)}); notice('方法已保存为候选，尚未自动启用。'); await refreshSkills(); await refresh() }) }
$('#skill-list').onclick = event => action(async () => { const promote = event.target.closest('[data-promote-skill]'), retract = event.target.closest('[data-retract-skill]'); if (promote) { const manualCheck = prompt('你验证了什么？请写下方法的适用条件与实际结果。'); if (manualCheck === null) return; await api(`/skills/${promote.dataset.promoteSkill}/promote`, {revision:Number(promote.dataset.revision),manualCheck}) } if (retract) await api(`/skills/${retract.dataset.retractSkill}`, undefined, 'DELETE'); await refreshSkills(); await refresh() })

let engineHealth
async function renderSystem() {
  if (!state) return
  const emotion = state.affect.emotion
  const feeling = emotion[0] > .04 ? '轻快，愿意继续推进' : emotion[0] < -.04 ? '略有挫败，正在恢复' : '平稳，准备好一起工作'
  $('#system-cards').innerHTML = `<article class="system-card"><h3>此刻状态</h3><div class="value">${state.sealed ? '已封存' : feeling}</div><p>${escape(state.affect.reason)}</p></article><article class="system-card"><h3>执行引擎</h3><div class="value">${engineHealth?.ok ? '已连接' : '待连接'}</div><p>${escape(engineHealth?.version ?? engineHealth?.reason ?? '检查中')}</p></article><article class="system-card"><h3>便携检查点</h3><div class="value">${state.unsynced ? '需要同步' : '已同步'}</div><p>当前变化 ${state.revision} / 已同步 ${Math.max(0,state.checkpointRevision)}<br>${escape(state.checkpointGeneration ?? '尚未创建检查点')}</p></article><article class="system-card"><h3>身份连续性</h3><div class="value small">${escape(state.identityId)}</div><p>本机活动库＋U 盘校验快照。当前主机可能保留恢复数据。</p></article>`
}
async function loadEngine() {
  engineHealth = await api('/engine')
  const providers = await api('/providers').catch(() => ({all:[],connected:[]}))
  const previous = $('#model').value
  $('#model').innerHTML = '<option value="">使用引擎默认模型</option>' + providers.all.filter(item => providers.connected.includes(item.id)).flatMap(provider => provider.models.map(model => `<option value="${escape(JSON.stringify({providerID:provider.id,modelID:model.id}))}">${escape(provider.name)} / ${escape(model.name)}</option>`)).join('')
  if ([...$('#model').options].some(option => option.value === previous)) $('#model').value = previous
  $('#engine-config').innerHTML = `<p>${providers.connected.length ? `已配置：${escape(providers.connected.join('、'))}。发送一个简短任务，可验证模型服务是否可用。` : '还没有配置模型。请在上方填写服务商提供的接口地址、模型名称和密钥。'}</p><p>配置只保存在这台电脑；更换电脑后需要重新设置。</p>`
  if (!engineHealth.ok) notice(`执行引擎暂不可用：${engineHealth.reason}`, true)
  if (view === 'system') await renderSystem()
}
$('#refresh-engine').onclick = () => action(loadEngine)
$('#model-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api('/settings/model', {baseURL:form.get('baseURL'),model:form.get('model'),apiKey:form.get('apiKey')}); event.target.elements.apiKey.value = ''; notice('模型配置已保存。请发送一个简短任务验证服务是否可用。'); await loadEngine() }) }
$('#checkpoint').onclick = () => action(async () => { $('#checkpoint').disabled = true; try { await api('/checkpoint', {}); notice('检查点已验证并保存到 U 盘。'); await refresh() } finally { $('#checkpoint').disabled = false } })
$('#shutdown').onclick = () => action(async () => { const result = await api('/shutdown', {}); clearInterval(timer); notice(result.message); document.querySelectorAll('button').forEach(button => button.disabled = true) })
await action(async () => { await refresh(); await loadEngine() })
const timer = setInterval(() => action(refresh), 2500)
