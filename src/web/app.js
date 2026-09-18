const $ = (selector) => document.querySelector(selector)
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const date = (value) => new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const uuid = () => crypto.randomUUID()
const statusNames = {ready:'准备开始',running:'正在处理',waiting:'待核实',verifying:'等待验收',completed:'已完成',failed:'执行失败',cancelled:'已取消'}
const kindNames = {preference:'偏好',fact:'事实',inference:'待验证认识',episode:'经历',commitment:'承诺'}
const titles = {chat:'对话与任务',collaboration:'协作',workspace:'项目文件',memory:'记忆',knowledge:'知识库',graph:'知识图谱',skills:'经验技能',sleep:'睡眠整理',files:'文件管家',system:'系统中心'}
const token = location.hash.startsWith('#token=') ? decodeURIComponent(location.hash.slice(7)) : sessionStorage.getItem('xingyao-token')
if (token) sessionStorage.setItem('xingyao-token', token)
history.replaceState(null, '', location.pathname)
let state, selectedTask = null, view = 'chat', memories = [], taskSignature = '', permissionSignature = ''
let refreshing = false

async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(`/api${path}`, {method,headers:{authorization:`Bearer ${token ?? ''}`,...(data !== undefined ? {'content-type':'application/json'} : {})},body:data === undefined ? undefined : JSON.stringify(data)})
  const result = await response.json()
  if (!response.ok) { const error = new Error(result.error ?? '请求失败'); error.status = response.status; error.kind = result.kind; error.recoveryDirectory = result.recoveryDirectory; error.backupPath = result.backupPath; throw error }
  return result
}
function notice(message, error = false) { $('#notice').textContent = message; $('#notice').className = `notice${error ? ' error' : ''}` }
async function action(fn) { try { await fn() } catch (error) { notice(error.message, true) } }
async function navigate(next) {
  if (view === 'workspace' && next === view) { if (!workspaceUI.file && !workspaceUI.loading && !workspaceUI.busy) await refreshWorkspace(); return }
  if (view === 'workspace' && next !== 'workspace') {
    if (!await workspaceCanLeave('离开项目文件')) return
    workspaceLeave()
  }
  if (view === 'graph' && next !== 'graph') resetGraph('重新打开时会读取最新资料。')
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
    if (view === 'collaboration') renderCollaborationTasks()
    if (selectedTask && view === 'chat') await refreshTask()
    if (view === 'sleep') { renderSleep(); await refreshMemoryReview() }
    if (view === 'system') await renderSystem()
    if ((state.busy.length || state.delegationBusy?.length) && ['chat','collaboration'].includes(view)) await refreshPermissions()
    else if (permissionSignature) { permissionSignature = ''; $('#permissions').innerHTML = ''; $('#collaboration-permissions').innerHTML = '' }
  } finally { refreshing = false }
}
async function refreshView() {
  if (view === 'workspace') await refreshWorkspace()
  if (view === 'collaboration') await refreshCollaboration()
  if (view === 'memory') await refreshMemories()
  if (view === 'knowledge') await refreshKnowledge()
  if (view === 'graph') await refreshGraph()
  if (view === 'sleep') { renderSleep(); await refreshMemoryReview() }
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
$('#task-list').addEventListener('click', event => action(async () => { const item = event.target.closest('[data-task]'); if (!item) return; selectedTask = item.dataset.task; collaborationUI.taskId = selectedTask; collaborationUI.lastLoaded = 0; taskSignature = ''; await refresh() }))
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

const collaborationStatusNames = {idle:'空闲',busy:'正在工作',retry:'等待重试'}
const delegationStateNames = {creating:'正在创建',running:'正在执行',stop_requested:'正在停止',paused:'已暂停',waiting:'待核对或交回',merged:'已交回主任务',failed:'执行失败'}
const collaborationUI = {taskId:'',request:0,loading:false,hasActive:false,lastLoaded:0,agents:[],agentsLoaded:false,data:null,followups:new Map()}
function renderCollaborationTasks() {
  if (!state) return
  const tasks = state.tasks.filter(task => task.sessionId)
  if (!tasks.some(task => task.id === collaborationUI.taskId)) {
    collaborationUI.taskId = tasks.some(task => task.id === selectedTask) ? selectedTask : tasks[0]?.id ?? ''
  }
  const select = $('#collaboration-task')
  select.replaceChildren(graphElement('option','选择已有执行会话的任务'))
  select.firstElementChild.value = ''
  for (const task of tasks) {
    const option = graphElement('option',`${task.title} · ${statusNames[task.status] ?? task.status}`)
    option.value = task.id; select.append(option)
  }
  select.value = collaborationUI.taskId
  const enabled = !!collaborationUI.taskId && collaborationUI.agents.length > 0 && !collaborationUI.loading
  for (const field of $('#delegation-form').elements) field.disabled = !enabled
  const agents = $('#delegation-agent'), selected = agents.value
  agents.replaceChildren(graphElement('option',collaborationUI.agents.length ? '选择子智能体' : '没有可用的 OpenCode 子智能体'))
  agents.firstElementChild.value = ''
  for (const agent of collaborationUI.agents) { const option = graphElement('option',agent.description ? `${agent.name} · ${agent.description}` : agent.name); option.value = agent.name; agents.append(option) }
  if (collaborationUI.agents.some(agent => agent.name === selected)) agents.value = selected
}
async function refreshCollaboration(force = true) {
  renderCollaborationTasks()
  const taskId = collaborationUI.taskId
  if (!taskId) {
    collaborationUI.hasActive = false
    $('#collaboration-count').textContent = '尚未选择任务'
    $('#collaboration-status').textContent = '先在“对话与任务”中开始一项工作。'
    $('#collaboration-tree').innerHTML = '<p class="empty">任务建立执行会话后，委派的子智能体会显示在这里。</p>'
    return
  }
  if (collaborationUI.loading || !force && Date.now() - collaborationUI.lastLoaded < 4000) return
  const request = ++collaborationUI.request
  collaborationUI.loading = true; $('#collaboration-refresh').disabled = true
  $('#collaboration-status').textContent = '正在核对 OpenCode 子会话与来源…'
  try {
    const [result,agents] = await Promise.all([api(`/tasks/${taskId}/collaboration`),collaborationUI.agentsLoaded ? Promise.resolve(collaborationUI.agents) : api('/collaboration/agents')])
    if (request !== collaborationUI.request || taskId !== collaborationUI.taskId || view !== 'collaboration') return
    collaborationUI.agents = agents; collaborationUI.agentsLoaded = true; collaborationUI.data = result
    collaborationUI.lastLoaded = Date.now()
    collaborationUI.hasActive = result.sessions.some(session => session.status.type === 'busy' || session.status.type === 'retry') || result.delegations.some(item => ['creating','running','stop_requested'].includes(item.state))
    $('#collaboration-count').textContent = `${result.sessions.length} 个子会话 · ${result.delegations.length} 项星杳委派${collaborationUI.hasActive ? ' · 进行中' : ''}`
    $('#collaboration-status').textContent = result.truncated ? `已加载 ${result.sessions.length} 个子会话；达到安全读取上限，仍有记录未显示。` : result.sessions.length ? '来源与所有权已核对。子智能体结果需显式交回，并由主任务重新判断。' : result.delegations.length ? '委派账本已加载，子会话仍需核对。' : '这个任务尚未建立子会话。'
    renderCollaboration(result)
  } catch (error) {
    if (request !== collaborationUI.request || taskId !== collaborationUI.taskId) return
    collaborationUI.hasActive = false
    $('#collaboration-status').textContent = `协作记录暂时不可用：${error.message}`
    $('#collaboration-tree').innerHTML = '<p class="empty">主任务记录没有改变；稍后可以重新核对。</p>'
  } finally {
    if (request === collaborationUI.request) { collaborationUI.loading = false; $('#collaboration-refresh').disabled = false; renderCollaborationTasks() }
  }
}
function addDelegationControls(card,delegation,session) {
  if (delegation.error) card.append(graphElement('p',delegation.error,'delegation-error'))
  const controls = graphElement('div',undefined,'delegation-controls')
  const idle = session?.status.type === 'idle'
  if (session && idle && !['creating','running','stop_requested'].includes(delegation.state)) {
    const label = graphElement('label','继续说明')
    const textarea = graphElement('textarea'); textarea.dataset.delegationFollowup = delegation.id; textarea.maxLength = 24000; textarea.placeholder = '补充要求，继续使用同一个子会话'
    textarea.value = collaborationUI.followups.get(delegation.id) ?? ''
    label.append(textarea); controls.append(label)
  }
  if (session && ['running','stop_requested'].includes(delegation.state)) {
    const stop = graphElement('button',delegation.state === 'stop_requested' ? '再次核对停止状态' : '暂停','secondary'); stop.type = 'button'; stop.dataset.delegationAction = delegation.state === 'stop_requested' ? 'reconcile' : 'stop'; stop.dataset.delegationId = delegation.id; controls.append(stop)
  }
  if (!['creating','running','stop_requested'].includes(delegation.state) && session && idle) {
    const resume = graphElement('button','继续','secondary'); resume.type = 'button'; resume.dataset.delegationAction = 'continue'; resume.dataset.delegationId = delegation.id; controls.append(resume)
  }
  const reconcile = graphElement('button','核对','secondary'); reconcile.type = 'button'; reconcile.dataset.delegationAction = 'reconcile'; reconcile.dataset.delegationId = delegation.id; controls.append(reconcile)
  const source = session?.messages.filter(message => message.role === 'assistant' && message.status === 'completed' && !message.tools.some(tool => tool.status === 'unknown')).at(-1)
  if (source && idle && !['creating','running','stop_requested'].includes(delegation.state)) {
    const merge = graphElement('button','交回主任务'); merge.type = 'button'; merge.dataset.delegationAction = 'merge'; merge.dataset.delegationId = delegation.id; merge.dataset.messageId = source.messageID; controls.append(merge)
  }
  card.append(controls)
}
function renderCollaboration(result) {
  const host = $('#collaboration-tree'); host.replaceChildren()
  const bySession = new Map(result.delegations.filter(item => item.sessionId).map(item => [item.sessionId,item]))
  for (const delegation of result.delegations.filter(item => !item.sessionId)) {
    const card = graphElement('article',undefined,'collaboration-card delegation-owned delegation-pending')
    card.dataset.delegationId = delegation.id
    const heading = graphElement('div',undefined,'collaboration-heading'), title = graphElement('div')
    title.append(graphElement('span',`星杳委派 · @${delegation.agent}`,'eyebrow'),graphElement('h3',delegation.title))
    heading.append(title,graphElement('span',delegationStateNames[delegation.state] ?? delegation.state,'badge'))
    card.append(heading,graphElement('p',`委派 ${delegation.id} · 子会话身份尚未绑定`,'collaboration-source'))
    addDelegationControls(card,delegation,null); host.append(card)
  }
  for (const session of result.sessions) {
    const delegation = bySession.get(session.sessionID)
    const card = graphElement('article',undefined,`collaboration-card depth-${Math.min(session.depth,4)} ${delegation ? 'delegation-owned' : 'delegation-unowned'}`)
    card.dataset.collaborationSession = session.sessionID
    const heading = graphElement('div',undefined,'collaboration-heading')
    const title = graphElement('div')
    title.append(graphElement('span',`${delegation ? '星杳委派' : 'OpenCode 只读会话'} · 第 ${session.depth} 层 · ${session.agent ? '@'+session.agent : '未标明角色'}`,'eyebrow'),graphElement('h3',session.title))
    const state = graphElement('div',undefined,'delegation-state')
    if (delegation) state.append(graphElement('span',delegationStateNames[delegation.state] ?? delegation.state,'badge'))
    state.append(graphElement('span',collaborationStatusNames[session.status.type] ?? session.status.type,`badge collaboration-${session.status.type}`))
    heading.append(title,state)
    card.append(heading)
    const meta = graphElement('p',`会话 ${session.sessionID} · 父会话 ${session.parentSessionID} · 更新于 ${date(session.updatedAt)}`,'collaboration-source')
    card.append(meta)
    if (session.status.type === 'retry') card.append(graphElement('p',`第 ${session.status.attempt} 次重试；预计 ${new Date(session.status.next).toLocaleTimeString('zh-CN')} 后继续。`,'collaboration-retry'))
    const transcript = graphElement('div',undefined,'collaboration-transcript')
    for (const message of session.messages) {
      const item = graphElement('div',undefined,`collaboration-message ${message.role}`)
      item.append(graphElement('div',`${message.role === 'assistant' ? '子智能体' : '委派内容'} · ${date(message.createdAt)} · ${message.status}`,'who'))
      if (message.text) item.append(graphElement('p',message.text,'body'))
      for (const tool of message.tools) {
        const exit = tool.execution.exitCode === undefined ? '' : ` · 退出码 ${tool.execution.exitCode ?? '未知'}`
        item.append(graphElement('p',`${tool.tool} · ${tool.status} · ${tool.execution.basis}${exit}`,'collaboration-tool'))
      }
      transcript.append(item)
    }
    if (!session.messages.length) transcript.append(graphElement('p','这个子会话还没有可显示的对话。','empty'))
    if (session.transcriptTruncated) transcript.prepend(graphElement('p',`较早记录未在本页展开；引擎会话仍保留完整历史。当前显示 ${session.messages.length} / ${session.messageCount} 条。`,'collaboration-warning'))
    card.append(transcript)
    if (delegation) addDelegationControls(card,delegation,session)
    host.append(card)
  }
  if (!result.sessions.length && !result.delegations.length) host.append(graphElement('p','没有发现属于这个任务的子会话。','empty'))
}
$('#collaboration-task').onchange = () => { collaborationUI.taskId = $('#collaboration-task').value; collaborationUI.lastLoaded = 0; action(refreshCollaboration) }
$('#collaboration-refresh').onclick = () => action(refreshCollaboration)
$('#delegation-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const taskId = collaborationUI.taskId
  if (!taskId) throw new Error('请先选择一个已有执行会话的任务。')
  $('#delegation-create').disabled = true
  try {
    await api(`/tasks/${taskId}/delegations`,{key:uuid(),title:$('#delegation-title').value.trim(),instruction:$('#delegation-instruction').value.trim(),agent:$('#delegation-agent').value})
    $('#delegation-title').value = ''; $('#delegation-instruction').value = ''; collaborationUI.lastLoaded = 0
    notice('委派已记录，正在建立 OpenCode 子会话。'); await refreshCollaboration()
  } finally { $('#delegation-create').disabled = false }
}) }
$('#collaboration-tree').onclick = event => { const button = event.target.closest('[data-delegation-action]'); if (!button) return; action(async () => {
  button.disabled = true
  const card = button.closest('.collaboration-card'), operation = button.dataset.delegationAction
  const input = {key:uuid()}
  if (operation === 'continue') { const value = card.querySelector('[data-delegation-followup]')?.value.trim(); if (!value) throw new Error('请填写继续说明。'); input.instruction = value }
  if (operation === 'merge') input.messageId = button.dataset.messageId
  await api(`/tasks/${collaborationUI.taskId}/delegations/${button.dataset.delegationId}/${operation}`,input)
  if (operation === 'continue') collaborationUI.followups.delete(button.dataset.delegationId)
  collaborationUI.lastLoaded = 0; notice(operation === 'merge' ? '来源已交回主任务，星杳正在核对汇总。' : operation === 'stop' ? '已发送暂停请求，仍需核对已经发生的操作。' : '委派状态已更新。'); await refreshCollaboration(); await refresh()
}) }
$('#collaboration-tree').oninput = event => { const field = event.target.closest('[data-delegation-followup]'); if (field) collaborationUI.followups.set(field.dataset.delegationFollowup,field.value) }

async function refreshPermissions() {
  const permissions = await api('/permissions')
  const signature = JSON.stringify(permissions)
  if (signature === permissionSignature) return
  permissionSignature = signature
  const markup = permissions.map(item => `<div class="permission"><strong>需要你的授权：${escape(item.permission)}</strong><pre>${escape(item.patterns.join('\n'))}</pre><button data-permission="${escape(item.id)}" data-reply="once">允许这一次</button><button class="secondary" data-permission="${escape(item.id)}" data-reply="reject">拒绝</button></div>`).join('')
  $('#permissions').innerHTML = markup; $('#collaboration-permissions').innerHTML = markup
}
for (const host of [$('#permissions'),$('#collaboration-permissions')]) host.onclick = event => action(async () => { const item = event.target.closest('[data-permission]'); if (!item) return; await api('/permissions/reply', {id:item.dataset.permission,reply:item.dataset.reply}); permissionSignature = ''; await refreshPermissions() })

async function refreshMemories() {
  memories = await api(`/memories?q=${encodeURIComponent($('#memory-search').value)}&private=${$('#private-memories').checked}`)
  $('#memory-list').innerHTML = memories.length ? memories.map(memory => `<article class="memory-card"><div class="card-meta"><span class="tag">${kindNames[memory.kind]}</span><span>${escape(memory.scope)}</span>${memory.pinned ? '<span>固定保留</span>' : ''}${memory.private ? '<span>私密</span>' : ''}<span>${date(memory.updatedAt)}</span></div><p>${escape(memory.text)}</p>${memoryClaimMarkup(memory)}<div class="card-meta">来源 #${memory.sourceIds.map(escape).join('、#')} · 修订 ${memory.revision}</div><div class="card-actions"><button class="secondary" data-edit-memory="${escape(memory.id)}">纠正</button><button class="secondary" data-forget-memory="${escape(memory.id)}">忘记</button></div></article>`).join('') : '<p class="empty">还没有匹配的记忆。你可以在左侧明确告诉我一件值得记住的事。</p>'
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
function renderSleep() { if (!state) return; $('#run-sleep').disabled = state.sealed || state.busy.length > 0; renderMemoryReviewHeader(); $('#sleep-reports').innerHTML = state.sleep.length ? state.sleep.map(report => `<article class="report-card"><div class="card-meta"><span class="tag">${report.status === 'completed' ? '整理完成' : '已暂停'}</span><span>${date(report.finishedAt)}</span></div><p>检查 ${report.examined} 条新经历，归档 ${report.created} 条记忆。<br>${escape(report.detail)}</p></article>`).join('') : '<p class="empty">完成一些任务后，在这里整理新的经历。</p>' }
$('#run-sleep').onclick = () => action(async () => { const report = await api('/sleep', {}); notice(`整理完成：处理 ${report.examined} 条新经历，归档 ${report.created} 条。`); await refresh() })
$('#toggle-seal').onclick = () => action(async () => { await api('/seal', {sealed:!state.sealed}); await refresh(); notice(state.sealed ? '已封存：个人记忆暂停参与对话和学习。' : '已解除封存。') })

// Candidate forms are kept as DOM nodes. Background polling updates their status
// and evidence availability, never the owner's text, dates, selection or focus.
const attributionNames = {user_statement:'用户陈述',reported:'转述他人或资料',inference:'待验证推断'}
const reviewBatchNames = {running:'正在提取',completed:'提取完成',failed:'提取失败',interrupted:'提取中断',redacted:'来源已删除'}
const reviewCandidateNames = {pending:'等待审阅',accepted:'已保存为记忆',rejected:'已决定不保存',invalidated:'来源或候选已失效',erased:'来源已删除'}
const memoryReviewUI = {taskId:'',data:null,drafts:new Map(),request:0,loading:false,starting:false,operation:null,tasksSignature:'',batchSignature:'',message:'',requestKey:null,submittedBatch:null}
const memoryReviewAuto = {loaded:false,loading:false,saving:false,dirty:false,model:null}
for (const id of ['#memory-review-auto-enabled','#memory-review-auto-limit']) $(id).oninput = () => { memoryReviewAuto.dirty = true }
$('#memory-review-auto-form').onsubmit = event => {
  event.preventDefault()
  action(async () => {
    memoryReviewAuto.saving = true; renderMemoryReviewHeader()
    try {
      const saved = await api('/memory-review/settings',{automatic:$('#memory-review-auto-enabled').checked,dailyBatchLimit:Number($('#memory-review-auto-limit').value),model:memoryReviewAuto.model})
      memoryReviewAuto.dirty = false
      $('#memory-review-auto-status').textContent = saved.automatic ? `已启用；自动整理最多 ${saved.dailyBatchLimit} 批 / 滚动 24 小时。` : '已关闭自动提取；仍可手动整理。'
    } finally { memoryReviewAuto.saving = false; renderMemoryReviewHeader() }
  })
}
async function loadMemoryReviewSettings() {
  if (memoryReviewAuto.loaded || memoryReviewAuto.loading) return
  memoryReviewAuto.loading = true
  try {
    const settings = await api('/memory-review/settings')
    if (!memoryReviewAuto.dirty) { $('#memory-review-auto-enabled').checked = settings.automatic; $('#memory-review-auto-limit').value = settings.dailyBatchLimit }
    memoryReviewAuto.model = settings.model
    $('#memory-review-auto-status').textContent = settings.automatic ? `已启用；自动整理最多 ${settings.dailyBatchLimit} 批 / 滚动 24 小时。` : '自动提取当前关闭。'
    memoryReviewAuto.loaded = true
  } catch (error) { $('#memory-review-auto-status').textContent = `读取设置失败：${error.message}` }
  finally { memoryReviewAuto.loading = false; renderMemoryReviewHeader() }
}
function claimDate(value) { return new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) }
function memoryClaimMarkup(memory) {
  if (!memory.claim) return ''
  const claim = memory.claim, now = Date.now()
  const expired = claim.validUntil !== null && claim.validUntil <= now
  const future = claim.validFrom !== null && claim.validFrom > now
  const label = expired ? '已到期 · 不参与当前对话' : future ? '尚未生效 · 不参与当前对话' : '当前有效'
  const period = claim.validFrom === null && claim.validUntil === null ? '长期' : `${claim.validFrom === null ? '不限起始时间' : claimDate(claim.validFrom)} 至 ${claim.validUntil === null ? '不限结束时间' : claimDate(claim.validUntil)+'（该时刻起失效）'}`
  return `<div class="memory-claim"><div class="card-meta"><span class="tag${expired || future ? ' inactive' : ''}">${escape(label)}</span><span>主体：${escape(claim.subject)}</span><span>${escape(attributionNames[claim.attribution] ?? claim.attribution)}</span></div><p>有效期：${escape(period)}</p></div>`
}
function renderMemoryReviewHeader() {
  const settingsDisabled = !memoryReviewAuto.loaded || memoryReviewAuto.saving || state?.sealed
  for (const id of ['#memory-review-auto-save','#memory-review-auto-enabled','#memory-review-auto-limit']) $(id).disabled = settingsDisabled
  const ui = memoryReviewUI, tasks = state?.tasks ?? [], selected = tasks.find(task => task.id === ui.taskId)
  const signature = JSON.stringify(tasks.map(task => [task.id,task.title,task.scope,task.status]))
  if (signature !== ui.tasksSignature) {
    ui.tasksSignature = signature
    $('#memory-review-task').innerHTML = '<option value="">选择一段已结束的对话</option>' + tasks.map(task => `<option value="${escape(task.id)}">${escape(task.title)} · ${escape(task.scope)} · ${escape(statusNames[task.status] ?? task.status)}</option>`).join('')
    $('#memory-review-task').value = ui.taskId
  }
  const running = ui.data?.batches.some(batch => batch.status === 'running') ?? false
  const busy = ui.starting || !!ui.operation
  $('#memory-review-task').disabled = busy
  $('#memory-review-model').disabled = busy
  $('#memory-review-start').disabled = !selected || !ui.data || state?.sealed || !!state?.busy.length || ['running','waiting'].includes(selected?.status) || running || busy || ui.loading
  $('#memory-review-start').textContent = ui.starting ? '提交提取…' : running ? '正在提取…' : '开始提取'
  $('#memory-review-refresh').disabled = !selected || busy || ui.loading
  $('#memory-review-refresh').textContent = ui.loading ? '正在刷新…' : '刷新状态与依据'
  const pending = ui.data?.candidates.filter(candidate => candidate.status === 'pending').length ?? 0
  $('#memory-review-count').textContent = selected ? `${pending} 条待审阅` : '尚未选择对话'
  const status = state?.sealed ? '已封存：暂停提取与采纳。可以查看已有候选，或决定不保存。' : ui.message || (!selected ? '先选择一段对话。' : running ? '模型正在提取，完成后会显示候选。你可以继续查看其他页面。' : ui.loading && !ui.data ? '正在读取已有提取记录…' : ['running','waiting'].includes(selected.status) ? '请等待这段对话结束，并核实执行结果后提取。' : '逐条核对来源与有效期，确认后才保存为记忆。')
  $('#memory-review-status').textContent = status
  for (const draft of ui.drafts.values()) updateReviewDraftControls(draft)
}
async function refreshMemoryReview({review = false,force = false} = {}) {
  await loadMemoryReviewSettings()
  const ui = memoryReviewUI
  renderMemoryReviewHeader()
  if (!ui.taskId || ui.loading && !review && !force) return
  const taskId = ui.taskId, request = ++ui.request
  ui.loading = true; renderMemoryReviewHeader()
  try {
    const data = await api(`/memory-review?taskId=${encodeURIComponent(taskId)}`)
    if (request !== ui.request || taskId !== ui.taskId) return
    ui.data = data
    const submitted = data.batches.find(batch => batch.id === ui.submittedBatch)
    if (submitted && submitted.status !== 'running') {
      ui.message = submitted.status === 'completed' ? '提取已完成。请逐条核对候选；没有候选时，本次不会新增记忆。' : `${reviewBatchNames[submitted.status] ?? '提取已结束'}${submitted.error ? `：${submitted.error}` : ''}。请检查提取记录。`
      ui.submittedBatch = null
    }
    if (review) ui.message = '依据已刷新，编辑稿已保留。请重新核对引用、替代关系与有效期，再勾选确认。'
    renderMemoryReview(data,review)
  } catch (error) {
    if (request === ui.request) { ui.message = `读取失败：${error.message}。当前编辑稿仍保留，请刷新重试。`; renderMemoryReviewHeader() }
  } finally { if (request === ui.request) { ui.loading = false; renderMemoryReviewHeader() } }
}
function renderMemoryReview(data,review) {
  const ui = memoryReviewUI
  const signature = JSON.stringify(data.batches)
  if (signature !== ui.batchSignature) {
    ui.batchSignature = signature
    $('#memory-review-batches').innerHTML = data.batches.length ? `<details ${data.batches.some(batch => ['running','failed','interrupted'].includes(batch.status)) ? 'open' : ''}><summary>提取记录 · ${data.batches.length} 次</summary>${data.batches.map(batch => `<div class="memory-review-batch"><div class="card-meta"><span class="tag">${escape(reviewBatchNames[batch.status] ?? batch.status)}</span><span>${date(batch.createdAt)}</span><span>${batch.sourceIds.length} 条来源</span>${batch.cleanup === 'pending' ? '<span class="tag">临时会话待清理 · 空闲时重试</span>' : ''}</div>${batch.error ? `<p>${escape(batch.error)}</p>` : ''}</div>`).join('')}</details>` : ''
  }
  const host = $('#memory-review-candidates'), wanted = new Set(data.candidates.map(candidate => candidate.id))
  for (const child of [...host.children]) if (!wanted.has(child.dataset.candidateId)) child.remove()
  for (const candidate of data.candidates) {
    let draft = ui.drafts.get(candidate.id)
    if (candidate.status !== 'pending') {
      if (draft) { draft.card.remove(); ui.drafts.delete(candidate.id) }
      let card = [...host.children].find(child => child.dataset.candidateId === candidate.id)
      if (!card) { card = document.createElement('article'); card.className = 'memory-review-result'; card.dataset.candidateId = candidate.id; host.append(card) }
      card.innerHTML = `<span class="tag">${escape(reviewCandidateNames[candidate.status] ?? candidate.status)}</span>${candidate.status === 'erased' ? '' : `<p>${candidate.status === 'accepted' ? '原候选：' : ''}${escape(candidate.text)}</p>`}${candidate.status === 'accepted' ? '<button type="button" class="secondary" data-view="memory">查看审阅后保存的记忆</button>' : ''}`
      continue
    }
    if (!draft) {
      draft = makeReviewDraft(candidate,data)
      ui.drafts.set(candidate.id,draft)
    } else if (review) {
      draft.candidate = candidate; draft.reviewRevision = data.revision; draft.needsRefresh = false; draft.error = ''
      draft.card.querySelector('[name="confirmed"]').checked = false
      updateReviewEvidence(draft)
      updateReplacementOptions(draft,data.memories)
    } else if (draft.reviewRevision !== data.revision || draft.candidate.revision !== candidate.revision) draft.needsRefresh = true
    if (draft.card.parentElement !== host) host.append(draft.card)
    updateReviewDraftControls(draft)
  }
  if (!data.candidates.length) {
    const empty = document.createElement('p'); empty.className = 'empty'
    empty.textContent = data.batches.some(batch => batch.status === 'running') ? '正在等待模型返回候选…' : data.batches.some(batch => batch.status === 'completed') ? '本段对话没有新的待审阅候选。之后有新的对话内容时，可以再次提取。' : '开始提取后，在这里逐条审阅来源、归属与有效期。'
    host.replaceChildren(empty)
  }
}
function makeReviewDraft(candidate,data) {
  const card = document.createElement('article'); card.className = 'memory-review-card'; card.dataset.candidateId = candidate.id
  card.innerHTML = `<div class="memory-review-card-heading"><h4>审阅一条候选</h4><span class="tag">等待审阅</span></div><div class="memory-review-evidence"></div><form class="memory-review-form"><fieldset class="memory-review-fields"><legend class="sr-only">编辑记忆候选</legend><label>准备保存的记忆<textarea name="text" maxlength="2000" rows="3" required></textarea></label><div class="form-row"><label>主体：关于谁或哪个项目<input name="subject" maxlength="200" required></label><label>记忆类型<select name="kind">${Object.entries(kindNames).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div><label>这条认识的归属<select name="attribution">${Object.entries(attributionNames).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><div class="memory-review-period"><label>明确有效期<select name="validity" required><option value="">请选择有效期</option><option value="long">长期</option><option value="range">日期范围</option></select></label><div class="memory-review-dates hidden"><div class="form-row"><label>从哪一天开始<input type="date" name="validFrom" min="1970-01-01"></label><label>到哪一天结束<input type="date" name="validUntil" min="1970-01-01"></label></div><p class="memory-review-help">起止日期均包含当天，按本机时区。模型的时间提示不会自动填入日期。</p></div></div><label>与已有记忆的关系<select name="resolution" required><option value="">请选择处理方式</option><option value="add">新增并存，保留已有记忆</option><option value="replace">替代同一范围的一条记忆</option></select></label><div class="memory-review-replacement hidden"><label>选择要替代的记忆<select name="replacement"><option value="">请选择已有记忆</option></select></label><div class="memory-review-existing"></div><p class="memory-review-help">替代后，旧记忆保留为历史记录。范围必须一致，请核对旧内容是否确实已改变。</p></div><div class="memory-review-privacy"><label class="check"><input name="private" type="checkbox">私密，仅在记忆管理中查看</label><label class="check"><input name="pinned" type="checkbox">固定保留</label></div><label class="check memory-review-confirm"><input name="confirmed" type="checkbox" required>我已核对原话、主体归属、有效期及与已有记忆的关系</label></fieldset><div class="memory-review-draft-status" role="status" aria-live="polite"></div><div class="memory-review-actions"><button type="submit" data-review-accept>确认保存记忆</button><button type="button" class="secondary" data-review-reject>不保存这条</button><button type="button" class="secondary" data-review-rebase>刷新依据，保留编辑</button></div></form>`
  const draft = {card,candidate,reviewRevision:data.revision,memories:[],needsRefresh:false,error:'',dirty:false,busy:false}
  const form = card.querySelector('form')
  form.elements.text.value = candidate.text
  form.elements.subject.value = candidate.subject
  form.elements.kind.value = candidate.kind
  form.elements.attribution.value = candidate.attribution
  updateReviewEvidence(draft); updateReplacementOptions(draft,data.memories)
  form.addEventListener('input',event => {
    draft.dirty = true; draft.error = ''
    if (event.target.name !== 'confirmed') form.elements.confirmed.checked = false
    if (event.target.name === 'attribution' && form.elements.attribution.value === 'inference') form.elements.kind.value = 'inference'
    syncReviewForm(draft); updateReviewDraftControls(draft)
  })
  form.addEventListener('change',() => syncReviewForm(draft))
  form.onsubmit = event => { event.preventDefault(); action(() => acceptReviewDraft(draft)) }
  card.querySelector('[data-review-reject]').onclick = () => action(() => rejectReviewDraft(draft))
  card.querySelector('[data-review-rebase]').onclick = () => action(() => refreshMemoryReview({review:true}))
  syncReviewForm(draft)
  return draft
}
function updateReviewEvidence(draft) {
  const candidate = draft.candidate
  draft.card.querySelector('.memory-review-evidence').innerHTML = `<div class="card-meta"><span>范围：${escape(candidate.scope)}</span><span>原候选主体：${escape(candidate.subject)}</span><span>${escape(attributionNames[candidate.attribution] ?? candidate.attribution)}</span><span>${escape(kindNames[candidate.kind] ?? candidate.kind)}</span></div><div class="memory-review-quotes"><strong>引用的原话</strong>${candidate.evidence.map(source => `<figure><figcaption>来源 #${escape(source.sourceId)}</figcaption><blockquote>${escape(source.quote)}</blockquote></figure>`).join('')}</div><p class="memory-review-time-note"><strong>原文时间提示：</strong>${escape(candidate.timeNote || '没有明确时间提示，请自行确认有效期。')}</p>`
}
function updateReplacementOptions(draft,memories) {
  const select = draft.card.querySelector('[name="replacement"]'), previous = select.value
  draft.memories = memories.filter(memory => memory.scope === draft.candidate.scope && memory.status === 'active')
  select.innerHTML = '<option value="">请选择已有记忆</option>' + draft.memories.map(memory => `<option value="${escape(memory.id)}">${draft.candidate.relatedMemoryIds.includes(memory.id) ? '候选关联 · ' : ''}${escape(memory.text.slice(0,90))} · 修订 ${memory.revision}</option>`).join('')
  if (draft.memories.some(memory => memory.id === previous)) select.value = previous
  else if (previous) draft.error = '之前选择的替代记忆已不可用，请重新选择处理方式。'
  syncReviewForm(draft)
}
function syncReviewForm(draft) {
  const form = draft.card.querySelector('form'), range = form.elements.validity.value === 'range', replace = form.elements.resolution.value === 'replace'
  draft.card.querySelector('.memory-review-dates').classList.toggle('hidden',!range)
  for (const name of ['validFrom','validUntil']) { form.elements[name].required = range; form.elements[name].disabled = !range }
  draft.card.querySelector('.memory-review-replacement').classList.toggle('hidden',!replace)
  form.elements.replacement.required = replace; form.elements.replacement.disabled = !replace
  const memory = draft.memories.find(item => item.id === form.elements.replacement.value)
  draft.card.querySelector('.memory-review-existing').innerHTML = memory ? `<p>${escape(memory.text)}</p><div class="card-meta">${escape(memory.scope)} · ${escape(kindNames[memory.kind])} · 修订 ${memory.revision}${memory.private ? ' · 私密' : ''}</div>${memoryClaimMarkup(memory)}` : '<p class="memory-review-help">请选择同一范围内的记忆。</p>'
}
function updateReviewDraftControls(draft) {
  const disabled = draft.busy || !!memoryReviewUI.operation
  draft.card.querySelector('fieldset').disabled = disabled
  draft.card.querySelector('[data-review-accept]').disabled = disabled || state?.sealed || draft.needsRefresh
  draft.card.querySelector('[data-review-reject]').disabled = disabled
  draft.card.querySelector('[data-review-rebase]').disabled = disabled || memoryReviewUI.loading
  const status = draft.card.querySelector('.memory-review-draft-status')
  status.textContent = draft.error || (draft.busy ? '正在提交审阅…' : draft.needsRefresh ? '后台候选或记忆已有变化。编辑稿已保留，请刷新依据并重新核对。' : state?.sealed ? '记忆已封存，暂不能采纳。' : draft.dirty ? '本页编辑稿尚未保存为记忆。' : '请明确选择有效期和处理方式，核对后确认。')
  status.classList.toggle('warning',!!draft.error || draft.needsRefresh)
}
function reviewPeriod(form) {
  if (form.elements.validity.value === 'long') return {validFrom:null,validUntil:null}
  if (form.elements.validity.value !== 'range') throw new Error('请明确选择长期或日期范围。')
  const from = new Date(`${form.elements.validFrom.value}T00:00:00`), until = new Date(`${form.elements.validUntil.value}T00:00:00`)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || from.getTime() < 0 || until < from) throw new Error('请填写有效的起止日期，结束日期不能早于开始日期。')
  until.setDate(until.getDate()+1)
  if (!Number.isSafeInteger(until.getTime()) || until <= from) throw new Error('结束日期超出支持范围，请选择较早日期。')
  return {validFrom:from.getTime(),validUntil:until.getTime()}
}
async function acceptReviewDraft(draft) {
  if (draft.busy || memoryReviewUI.operation) return
  if (state?.sealed) throw new Error('记忆已封存，解除封存后才能采纳。')
  if (draft.needsRefresh) throw new Error('请刷新依据并重新审阅，编辑稿会保留。')
  const form = draft.card.querySelector('form')
  if (!form.reportValidity()) return
  const period = reviewPeriod(form)
  const replacement = draft.memories.find(memory => memory.id === form.elements.replacement.value)
  const resolution = form.elements.resolution.value === 'add' ? {type:'add'} : form.elements.resolution.value === 'replace' && replacement ? {type:'replace',memoryId:replacement.id,revision:replacement.revision} : null
  if (!resolution) throw new Error('请选择新增并存，或选择要替代的已有记忆。')
  if (form.elements.attribution.value === 'inference' && form.elements.kind.value !== 'inference') throw new Error('推断应保留为待验证认识，请调整类型。')
  const input = {revision:draft.candidate.revision,reviewRevision:draft.reviewRevision,text:form.elements.text.value,subject:form.elements.subject.value,kind:form.elements.kind.value,attribution:form.elements.attribution.value,...period,private:form.elements.private.checked,pinned:form.elements.pinned.checked,resolution}
  await submitReviewDraft(draft,'accept',input)
}
async function rejectReviewDraft(draft) {
  if (draft.busy || memoryReviewUI.operation) return
  if (draft.dirty && !confirm('决定不保存这条候选？本页对它的编辑稿也会关闭。')) return
  await submitReviewDraft(draft,'reject',{revision:draft.candidate.revision})
}
async function submitReviewDraft(draft,operation,input) {
  draft.busy = true; draft.error = ''; memoryReviewUI.operation = draft.candidate.id; renderMemoryReviewHeader()
  try {
    await api(`/memory-review/${encodeURIComponent(draft.candidate.id)}/${operation}`,input)
    draft.dirty = false
    memoryReviewUI.message = operation === 'accept' ? '这条记忆已保存，并保留审阅结果与来源。' : '已决定不保存这条候选。'
    await refreshMemoryReview({force:true})
    await refresh()
  } catch (error) {
    if (error.status === 409) { draft.needsRefresh = true; draft.card.querySelector('[name="confirmed"]').checked = false }
    draft.error = error.status === 409 ? `${error.message}。编辑稿已保留，请刷新依据并重新审阅。` : `${error.message}。未确认保存成功，编辑稿仍保留。`
    updateReviewDraftControls(draft)
  } finally { draft.busy = false; memoryReviewUI.operation = null; renderMemoryReviewHeader() }
}
$('#memory-review-task').onchange = () => action(async () => {
  memoryReviewUI.taskId = $('#memory-review-task').value; memoryReviewUI.data = null; memoryReviewUI.request++; memoryReviewUI.loading = false; memoryReviewUI.message = ''; memoryReviewUI.batchSignature = ''; memoryReviewUI.requestKey = null; memoryReviewUI.submittedBatch = null
  $('#memory-review-candidates').replaceChildren(); $('#memory-review-batches').replaceChildren()
  await refreshMemoryReview()
})
$('#memory-review-refresh').onclick = () => action(() => refreshMemoryReview({review:true}))
$('#memory-review-start-form').onsubmit = event => { event.preventDefault(); action(async () => {
  const ui = memoryReviewUI
  if ($('#memory-review-start').disabled) return
  const model = $('#memory-review-model').value ? JSON.parse($('#memory-review-model').value) : undefined
  const signature = JSON.stringify([ui.taskId,model])
  if (ui.requestKey?.signature !== signature) ui.requestKey = {signature,key:uuid()}
  ui.starting = true; ui.message = ''; renderMemoryReviewHeader()
  try {
    const result = await api('/memory-review',{taskId:ui.taskId,key:ui.requestKey.key,...(model ? {model} : {})})
    if (!result.batchId) throw new Error('提取返回缺少批次，请刷新状态核实。')
    ui.requestKey = null; ui.submittedBatch = result.batchId; ui.message = '提取请求已提交。候选返回后，请逐条审阅。'
    await refreshMemoryReview({force:true})
  } catch (error) { ui.message = `${error.message}。可刷新核实状态后重试。` }
  finally { ui.starting = false; renderMemoryReviewHeader() }
}) }
window.addEventListener('beforeunload',event => { if (memoryReviewUI.operation || [...memoryReviewUI.drafts.values()].some(draft => draft.dirty)) { event.preventDefault(); event.returnValue = '' } })

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

// File editing is explicit, revision checked, and independent from knowledge import.
const workspaceUI = {roots:[],rootId:null,path:'',entries:[],file:null,baseline:'',request:0,loading:false,busy:null,draft:null,draftRevision:0,draftManaged:true,draftSaved:null,draftPromise:null,draftTimer:null,draftError:null}
const workspaceText = value => String(value ?? '').replace(/\r\n?/g,'\n')
let workspaceDraftPending = null, workspaceDraftConflict = null
async function workspaceFlushDraft() {
  clearTimeout(workspaceUI.draftTimer); workspaceUI.draftTimer = null
  if (workspaceUI.draftPromise) return workspaceUI.draftPromise
  if (!workspaceUI.file || !workspaceUI.draftManaged) return
  const file = workspaceUI.file
  const work = (async () => {
    while (workspaceUI.file === file) {
      const value = $('#workspace-text').value
      if (!workspaceDraftPending && (workspaceUI.draftSaved === value || !workspaceUI.draft && value === workspaceUI.baseline)) return
      const input = workspaceDraftPending ?? {rootId:file.rootId,path:file.path,revision:workspaceUI.draftRevision,key:uuid(),baseSha256:workspaceUI.draft?.baseSha256 ?? file.sha256,text:value}
      workspaceDraftPending = input
      const state = await api('/workspace/draft',input,'PUT')
      workspaceUI.draft = state.draft; workspaceUI.draftRevision = state.draftRevision; workspaceUI.draftSaved = input.text; workspaceUI.draftError = null
      workspaceDraftPending = null; workspaceDraftConflict = null
      workspaceRenderDraft()
    }
  })()
  workspaceUI.draftPromise = work; workspaceControls()
  try { await work }
  catch (error) { workspaceUI.draftError = error.message; workspaceRenderDraft(); throw error }
  finally { workspaceUI.draftPromise = null; workspaceControls() }
}
function workspaceDraftPreview(parent,text,label) {
  const details = graphElement('details'), summary = graphElement('summary',label), preview = graphElement('textarea')
  preview.readOnly = true; preview.value = text; preview.rows = 8; preview.className = 'workspace-draft-preview'
  details.append(summary,preview); parent.append(details)
}
function workspaceRenderDraft() {
  const host = $('#workspace-draft-panel'), draft = workspaceUI.draft, file = workspaceUI.file
  host.replaceChildren(); host.classList.toggle('hidden',!draft && !workspaceUI.draftError)
  if (!file) return
  if (workspaceUI.draftError) {
    host.append(graphElement('p',`草稿尚未确认保存：${workspaceUI.draftError}。当前编辑保留。`,'workspace-error'))
    host.append(graphButton('重试保存草稿',workspaceFlushDraft),graphButton('读取最新草稿并对照',async () => {
      const latest = await api(`/workspace/draft?${new URLSearchParams({rootId:file.rootId,path:file.path})}`)
      if (workspaceUI.file !== file) return
      workspaceDraftConflict = latest
      workspaceRenderDraft()
    }))
    if (workspaceDraftConflict) {
      workspaceDraftPreview(host,workspaceDraftConflict.draft?.text ?? '该草稿已被丢弃。','服务器当前草稿（只读）')
      workspaceDraftPreview(host,file.text,'当前已读取的磁盘正文（只读）')
      host.append(graphButton('已核对：保存当前编辑作为合并稿',async () => {
        const input = {rootId:file.rootId,path:file.path,revision:workspaceDraftConflict.draftRevision,key:uuid(),baseSha256:file.sha256,text:$('#workspace-text').value}
        const state = await api('/workspace/draft',input,workspaceDraftConflict.draft ? 'PATCH' : 'PUT')
        if (workspaceUI.file !== file) return
        workspaceUI.draft = state.draft; workspaceUI.draftRevision = state.draftRevision; workspaceUI.draftSaved = input.text; workspaceUI.draftError = null
        workspaceDraftPending = null; workspaceDraftConflict = null; workspaceRenderDraft(); workspaceControls()
      }))
    }
    return
  }
  if (!draft) return
  host.append(graphElement('p',`${workspaceUI.draftManaged ? '编辑草稿' : '发现可恢复的草稿'} · ${date(draft.updatedAt)} · 修订 ${draft.revision}。草稿没有自动写入文件。`))
  if (!workspaceUI.draftManaged) {
    workspaceDraftPreview(host,draft.text,'预览草稿（只读）')
    host.append(graphButton('恢复草稿到编辑器',() => {
      $('#workspace-text').value = draft.text; workspaceUI.draftManaged = true; workspaceUI.draftSaved = draft.text
      workspaceRenderDraft(); workspaceControls(); workspaceMessage('草稿已恢复到编辑器；点击保存文件后才写入磁盘。')
    }))
  }
  if (draft.baseSha256 !== file.sha256) {
    host.append(graphElement('p','磁盘版本与草稿的原始版本不同。请对照、合并后明确确认基础版本；保存文件暂不可用。','workspace-error'))
    workspaceDraftPreview(host,file.text,'已读取的磁盘正文（只读）')
    if (workspaceUI.draftManaged) host.append(graphButton('已核对：以当前磁盘版本继续编辑',async () => {
      await workspaceFlushDraft()
      if (workspaceUI.file !== file) return
      const input = {rootId:file.rootId,path:file.path,revision:workspaceUI.draftRevision,key:uuid(),baseSha256:file.sha256,text:$('#workspace-text').value}
      const state = await api('/workspace/draft',input,'PATCH')
      if (workspaceUI.file !== file) return
      workspaceUI.draft = state.draft; workspaceUI.draftRevision = state.draftRevision; workspaceUI.draftSaved = input.text
      workspaceRenderDraft(); workspaceControls()
    }))
  }
  host.append(graphButton('丢弃这份草稿',async () => {
    if (!confirm('丢弃这份编辑草稿？磁盘文件保持当前内容。')) return
    clearTimeout(workspaceUI.draftTimer); await workspaceUI.draftPromise
    if (workspaceUI.file !== file) return
    const beforeDiscard = $('#workspace-text').value
    const state = await api('/workspace/draft',{rootId:file.rootId,path:file.path,revision:workspaceUI.draftRevision,key:uuid()},'DELETE')
    if (workspaceUI.file !== file) return
    if ($('#workspace-text').value !== beforeDiscard) {
      // A late delete acknowledgement must not erase typing after the decision.
      workspaceUI.draft = null; workspaceUI.draftRevision = state.draftRevision; workspaceUI.draftSaved = null
      workspaceUI.draftError = '丢弃请求期间出现了新输入，当前内容已保留，请重试保存草稿'
      workspaceDraftPending = null; workspaceDraftConflict = null; workspaceRenderDraft(); workspaceControls()
    } else { workspaceDraftPending = null; workspaceDraftConflict = null; workspaceDisplayFile({...file,...state}) }
    await workspaceRefreshDrafts()
  }))
}
async function workspaceRefreshDrafts() {
  const result = await api('/workspace/drafts'), host = $('#workspace-drafts')
  host.replaceChildren()
  host.append(graphElement('p',`${result.drafts.length} / ${result.countLimit} 份草稿 · ${workspaceBytes(result.totalBytes)} / ${workspaceBytes(result.byteLimit)}`,'workspace-hint'))
  for (const draft of result.drafts) {
    const row = graphElement('div',undefined,'workspace-draft-row')
    row.dataset.workspaceDraftId = draft.id
    const preview = graphElement('div')
    row.append(graphButton('查看草稿（只读）',async () => {
      const saved = await api(`/workspace/draft?${new URLSearchParams({id:draft.id})}`)
      preview.replaceChildren()
      if (!saved.draft) { preview.append(graphElement('p','这份草稿已被丢弃，请刷新列表。')); return }
      workspaceDraftPreview(preview,saved.draft.text,'草稿正文（可复制）')
      preview.querySelector('details').open = true
    }))
    row.append(graphElement('span',`${draft.rootPath} / ${draft.path}`),graphButton('选择目录并打开',async () => {
      if (!await workspaceCanLeave('打开这份草稿')) return
      const root = await api('/workspace/roots',{directory:draft.rootPath})
      workspaceUI.roots = [...workspaceUI.roots.filter(item => item.id !== root.id),root]
      const directory = draft.path.split('/').slice(0,-1).join('/')
      await workspaceBrowse(root.id,directory,{confirmed:true})
      if (workspaceUI.rootId === root.id && workspaceUI.path === directory) await workspaceOpenFile(draft.path)
      // Missing source files still retain their draft in the identity database.
      if (!workspaceUI.file || workspaceUI.file.path !== draft.path) {
        const saved = await api(`/workspace/draft?${new URLSearchParams({rootId:root.id,path:draft.path})}`)
        const panel = $('#workspace-draft-panel'); panel.replaceChildren(); panel.classList.remove('hidden')
        panel.append(graphElement('p','磁盘文件当前不可用；已保留的草稿可在下面复制。重新建立文件后再选择它。'))
        workspaceDraftPreview(panel,saved.draft?.text ?? '草稿已变化，请刷新。','查看可恢复正文（只读）')
      }
    }))
    row.append(preview); host.append(row)
  }
}
function workspaceDirty() { return Boolean(workspaceUI.file && $('#workspace-text').value !== workspaceUI.baseline) }
function workspaceMessage(text,error = false) {
  $('#workspace-status').textContent = text
  $('#workspace-status').classList.toggle('workspace-error',error)
}
async function workspaceCanLeave(actionName) {
  if (workspaceUI.busy) { workspaceMessage('正在保存或导入，请等待当前操作完成后再切换。'); return false }
  try {
    await workspaceFlushDraft()
    if (workspaceUI.busy) { workspaceMessage('正在保存或导入，请等待当前操作完成后再切换。'); return false }
    return true
  } catch (error) { workspaceMessage(`草稿尚未保存：${error.message}。请保留当前页面，处理后再${actionName}。`,true); return false }
}
function workspaceClearFile() {
  workspaceDraftPending = null; workspaceDraftConflict = null
  clearTimeout(workspaceUI.draftTimer); workspaceUI.draftTimer = null
  workspaceUI.draft = null; workspaceUI.draftRevision = 0; workspaceUI.draftManaged = true; workspaceUI.draftSaved = null; workspaceUI.draftError = null
  $('#workspace-draft-panel').replaceChildren(); $('#workspace-draft-panel').classList.add('hidden')
  workspaceUI.file = null; workspaceUI.baseline = ''
  $('#workspace-text').value = ''
  $('#workspace-file-name').textContent = '选择一个文本文件'
  $('#workspace-file-path').textContent = '打开 Markdown、代码或其他受支持的文本文件。'
  $('#workspace-file-info').textContent = ''
  $('#workspace-backup').textContent = '修改已有文件时，保存结果会显示备份位置。'
  $('#workspace-import-result').textContent = ''
  $('#workspace-conflict').replaceChildren(); $('#workspace-conflict').classList.add('hidden')
  workspaceControls()
}
function workspaceLeave() {
  workspaceUI.request++; workspaceUI.loading = false
  workspaceClearFile()
}
function workspaceControls() {
  const file = workspaceUI.file, busy = Boolean(workspaceUI.busy), dirty = workspaceDirty(), unavailable = busy || workspaceUI.loading
  const awaitingDraft = !!workspaceUI.draft && !workspaceUI.draftManaged
  const baseChanged = workspaceUI.draftManaged && workspaceUI.draft && workspaceUI.draft.baseSha256 !== file?.sha256
  $('#workspace-save').disabled = !file || !dirty || unavailable || awaitingDraft || baseChanged
  $('#workspace-save').textContent = workspaceUI.busy === 'save' ? '正在保存…' : '保存文件'
  $('#workspace-reload').disabled = !file || unavailable
  $('#workspace-import').disabled = !file || dirty || unavailable
  $('#workspace-import').textContent = workspaceUI.busy === 'import' ? '正在导入…' : '导入知识库'
  $('#workspace-text').readOnly = !file || unavailable || awaitingDraft
  $('#workspace-root').disabled = busy || !workspaceUI.roots.length
  $('#workspace-add-root').disabled = unavailable
  $('#workspace-add-root').textContent = workspaceUI.busy === 'root' ? '正在添加…' : '添加并打开'
  $('#workspace-directory').disabled = busy
  $('#workspace-up').disabled = !workspaceUI.rootId || !workspaceUI.path || unavailable
  $('#workspace-refresh-tree').disabled = !workspaceUI.rootId || unavailable
  $('#workspace-import-scope').disabled = busy
  $('#workspace-import-private').disabled = busy
  $('#workspace-dirty').textContent = !file ? '未打开文件' : workspaceUI.busy === 'save' ? '保存中' : workspaceUI.draftPromise ? '正在保存草稿' : dirty ? workspaceUI.draftSaved === $('#workspace-text').value ? '草稿已保存 · 文件未保存' : '草稿待保存' : '已读取 / 已保存'
  $('#workspace-dirty').classList.toggle('warn',dirty)
  document.querySelectorAll('[data-workspace-entry],[data-workspace-crumb]').forEach(button => { button.disabled = busy || button.dataset.workspaceEditable === 'false' })
  document.querySelectorAll('[data-workspace-entry]').forEach(button => button.classList.toggle('selected',file?.path === button.dataset.workspaceEntry && file?.rootId === workspaceUI.rootId))
}
function workspaceRenderRoots() {
  const select = $('#workspace-root'); select.replaceChildren()
  if (!workspaceUI.roots.length) select.append(graphElement('option','请先添加项目目录'))
  for (const root of workspaceUI.roots) {
    const option = graphElement('option',`${root.label} · ${root.path}`)
    option.value = root.id; select.append(option)
  }
  if (workspaceUI.rootId) select.value = workspaceUI.rootId
  workspaceControls()
}
async function refreshWorkspace() {
  const request = ++workspaceUI.request
  workspaceUI.loading = true; workspaceControls(); workspaceMessage('正在读取项目目录…')
  try {
    const result = await api('/workspace/roots')
    await workspaceRefreshDrafts()
    if (request !== workspaceUI.request || view !== 'workspace') return
    workspaceUI.roots = result.roots
    const nextRoot = result.roots.some(root => root.id === workspaceUI.rootId) ? workspaceUI.rootId : result.defaultRootId ?? result.roots[0]?.id ?? null
    const nextPath = nextRoot === workspaceUI.rootId ? workspaceUI.path : ''
    workspaceRenderRoots()
    if (!nextRoot) {
      workspaceUI.rootId = null; workspaceUI.path = ''; workspaceUI.entries = []; workspaceClearFile()
      $('#workspace-tree').replaceChildren(); $('#workspace-breadcrumbs').replaceChildren()
      $('#workspace-tree-status').textContent = '输入一个明确的绝对目录路径，建立项目文件入口。'
      workspaceMessage(result.error ? `默认目录不能打开：${result.error}。请添加其他项目目录。` : '尚未选择项目目录。添加目录后再浏览文件。',Boolean(result.error)); return
    }
    await workspaceBrowse(nextRoot,nextPath,{confirmed:true})
  } catch (error) {
    if (request === workspaceUI.request && view === 'workspace') workspaceMessage(`读取目录失败：${error.message}。可重新打开“项目文件”或添加目录重试。`,true)
  } finally { if (request === workspaceUI.request) { workspaceUI.loading = false; workspaceControls() } }
}
async function workspaceBrowse(rootId,path,options = {}) {
  if (!options.confirmed && !options.keepFile && !await workspaceCanLeave('切换目录')) { $('#workspace-root').value = workspaceUI.rootId ?? ''; return }
  const request = ++workspaceUI.request
  workspaceUI.loading = true; workspaceControls(); workspaceMessage('正在读取目录…')
  try {
    const params = new URLSearchParams({rootId,path})
    const result = await api(`/workspace/list?${params}`)
    if (request !== workspaceUI.request || view !== 'workspace') return
    workspaceUI.rootId = result.rootId; workspaceUI.path = result.path; workspaceUI.entries = result.entries
    if (!options.keepFile) workspaceClearFile()
    workspaceRenderRoots(); workspaceRenderTree(result.truncated)
    await workspaceRefreshRecovery(result.rootId)
    workspaceMessage(result.truncated ? '目录项目较多，本轮列表已截断。可进入子目录逐层浏览。' : '点击目录逐层浏览，点击受支持的文本文件阅读或编辑。')
  } catch (error) {
    if (request !== workspaceUI.request || view !== 'workspace') return
    $('#workspace-root').value = workspaceUI.rootId ?? ''
    workspaceMessage(`目录读取失败：${error.message}。当前编辑内容已保留。`,true)
  } finally { if (request === workspaceUI.request) { workspaceUI.loading = false; workspaceControls() } }
}
function workspaceRenderTree(truncated = false) {
  const root = workspaceUI.roots.find(item => item.id === workspaceUI.rootId)
  const crumbs = $('#workspace-breadcrumbs'); crumbs.replaceChildren()
  const addCrumb = (label,path) => {
    const button = graphButton(label,() => workspaceBrowse(workspaceUI.rootId,path),'workspace-crumb')
    button.dataset.workspaceCrumb = path; crumbs.append(button)
  }
  addCrumb(root?.label ?? '项目根目录','')
  const parts = workspaceUI.path.replaceAll('\\','/').split('/').filter(Boolean)
  parts.forEach((part,index) => { crumbs.append(graphElement('span','/')); addCrumb(part,parts.slice(0,index + 1).join('/')) })
  crumbs.title = `${root?.path ?? ''}${workspaceUI.path ? `/${workspaceUI.path}` : ''}`
  $('#workspace-tree-status').textContent = `${workspaceUI.entries.length} 项${truncated ? ' · 列表已截断' : ''}。灰色文件暂不支持在此编辑。`
  const container = $('#workspace-tree'); container.replaceChildren()
  const entries = [...workspaceUI.entries].sort((a,b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name,'zh-CN'))
  for (const entry of entries) {
    const directory = entry.kind === 'directory'
    const button = graphButton('',() => directory ? workspaceBrowse(workspaceUI.rootId,entry.path) : workspaceOpenFile(entry.path),'workspace-entry')
    button.dataset.workspaceEntry = entry.path
    button.dataset.workspaceEditable = String(directory || entry.editable)
    button.title = entry.name
    button.append(graphElement('span',directory ? '▥' : '▤','workspace-entry-icon'),graphElement('span',entry.name,'workspace-entry-name'))
    button.append(graphElement('small',directory ? '目录 ›' : !entry.editable ? '暂不可编辑' : typeof entry.size === 'number' ? workspaceBytes(entry.size) : '文本'))
    container.append(button)
  }
  if (!entries.length) container.append(graphElement('p','这个目录中没有可列出的文件。','workspace-hint'))
  workspaceControls()
}
async function workspaceRefreshRecovery(rootId) {
  const result = await api(`/workspace/recovery?${new URLSearchParams({rootId})}`)
  if (workspaceUI.rootId !== rootId || view !== 'workspace') return
  const panel = $('#workspace-recovery-panel'), entries = result.entries.filter(entry => entry.status !== 'committed' && entry.status !== 'unchanged')
  panel.replaceChildren(); panel.classList.toggle('hidden',!entries.length && !result.truncated && !result.warnings?.length)
  if (!entries.length && !result.truncated && !result.warnings?.length) return
  panel.append(graphElement('h3','文件保存恢复记录'))
  for (const warning of result.warnings ?? []) panel.append(graphElement('p',warning,'workspace-error'))
  const labels = {pending:'可以恢复',restored:'原件已恢复',conflict:'需要核对',busy:'仍在操作',manual:'需要手工核对'}
  for (const entry of entries) {
    const row = graphElement('div',undefined,'workspace-recovery-entry')
    row.append(graphElement('strong',`${labels[entry.status] ?? entry.status} · ${entry.path ?? '未核实的路径'}`),graphElement('p',entry.message),graphElement('p',`保留位置：${entry.recoveryDirectory}`,'workspace-hint'))
    panel.append(row)
  }
  if (result.truncated) panel.append(graphElement('p','恢复目录较多，本轮列表已截断；未加载的记录尚未核查。','workspace-error'))
  if (entries.some(entry => entry.status === 'pending' || entry.status === 'busy')) panel.append(graphButton('重试恢复可核实的保存',async () => {
    await api('/workspace/recovery',{rootId}); await workspaceRefreshRecovery(rootId); await workspaceBrowse(rootId,workspaceUI.path,{keepFile:true})
  }))
}
function workspaceBytes(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB` }
function workspaceDisplayFile(file) {
  clearTimeout(workspaceUI.draftTimer); workspaceDraftPending = null; workspaceDraftConflict = null
  workspaceUI.file = file; workspaceUI.baseline = workspaceText(file.text)
  workspaceUI.draft = file.draft ?? null; workspaceUI.draftRevision = file.draftRevision ?? 0
  workspaceUI.draftManaged = !workspaceUI.draft; workspaceUI.draftSaved = null; workspaceUI.draftError = null
  $('#workspace-text').value = workspaceUI.baseline
  $('#workspace-file-name').textContent = file.path.replaceAll('\\','/').split('/').at(-1) || file.path
  $('#workspace-file-path').textContent = file.absolutePath
  const ending = String(file.lineEnding ?? '').toUpperCase()
  $('#workspace-file-info').textContent = `${workspaceBytes(file.bytes)} · UTF-8${file.bom ? ' BOM' : ''} · ${ending || '无换行'}${ending === 'MIXED' ? ' · 混合换行，保存后按编辑器内容更新换行。' : ''}`
  $('#workspace-conflict').replaceChildren(); $('#workspace-conflict').classList.add('hidden')
  $('#workspace-import-result').textContent = ''
  workspaceRenderDraft()
  workspaceControls()
}
async function workspaceOpenFile(path,reload = false) {
  if (!workspaceUI.rootId || !await workspaceCanLeave(reload ? '重新读取磁盘文件' : '打开另一个文件')) return
  const request = ++workspaceUI.request, rootId = workspaceUI.rootId
  workspaceUI.loading = true; workspaceControls(); workspaceMessage('正在读取文件…')
  try {
    const file = await api(`/workspace/file?${new URLSearchParams({rootId,path})}`)
    if (request !== workspaceUI.request || view !== 'workspace') return
    workspaceDisplayFile(file)
    $('#workspace-backup').textContent = '修改已有文件时，保存结果会显示备份位置。'
    workspaceMessage('文件已读取。修改后点击“保存文件”，或按 Ctrl / ⌘ + S。')
  } catch (error) {
    if (request === workspaceUI.request && view === 'workspace') workspaceMessage(`文件读取失败：${error.message}。原编辑内容已保留。`,true)
  } finally { if (request === workspaceUI.request) { workspaceUI.loading = false; workspaceControls() } }
}
async function workspaceSave() {
  if (!workspaceUI.file || !workspaceDirty() || workspaceUI.busy || workspaceUI.loading) return
  if (!workspaceUI.draftManaged || workspaceUI.draft && workspaceUI.draft.baseSha256 !== workspaceUI.file.sha256) return
  const request = ++workspaceUI.request, file = workspaceUI.file
  workspaceUI.busy = 'save'; workspaceControls(); workspaceMessage('正在校验磁盘版本并保存…')
  try {
    await workspaceFlushDraft()
    if (request !== workspaceUI.request || workspaceUI.file !== file) return
    const text = $('#workspace-text').value, draftRevision = workspaceUI.draftRevision
    const result = await api('/workspace/file',{rootId:file.rootId,path:file.path,expectedSha256:file.sha256,text},'PUT')
    if (request !== workspaceUI.request || view !== 'workspace') return
    let remaining = {draft:result.draft,draftRevision:result.draftRevision}, draftWarning = ''
    try { remaining = await api('/workspace/draft',{rootId:file.rootId,path:file.path,revision:draftRevision,key:uuid()},'DELETE') }
    catch (error) { draftWarning = `磁盘文件已保存；草稿清理未完成：${error.message}` }
    workspaceDisplayFile({...result,...remaining})
    const backup = $('#workspace-backup'); backup.replaceChildren()
    backup.append(graphElement('p',result.changed ? '文件已保存。' : '内容与磁盘一致，无需写入。'))
    if (result.backupPath) backup.append(graphElement('p',`修改前备份：${result.backupPath}`))
    if (result.knowledge?.refreshed) backup.append(graphElement('p',`已刷新 ${result.knowledge.refreshed} 份资料索引，保留原导入范围与私密设置。`))
    for (const warning of result.knowledge?.warnings ?? []) backup.append(graphElement('p',warning,'workspace-error'))
    if (draftWarning) backup.append(graphElement('p',draftWarning,'workspace-error'))
    try { await workspaceRefreshDrafts() }
    catch (error) { backup.append(graphElement('p',`文件已保存；草稿列表刷新失败：${error.message}`,'workspace-error')) }
    workspaceMessage(result.knowledge?.warnings?.length ? '文件已保存，部分知识库索引需要处理；请查看保存记录。' : result.changed ? '文件已保存，修改前版本的备份位置见右侧记录。' : '内容与磁盘一致，无需写入。')
  } catch (error) {
    if (request !== workspaceUI.request || view !== 'workspace') return
    workspaceMessage(`保存未完成：${error.message}。你的编辑内容仍保留在此处。`,true)
    const conflict = $('#workspace-conflict'); conflict.replaceChildren()
    conflict.append(graphElement('p','此处编辑内容已保留。重新读取前会先保存草稿，随后可以对照磁盘内容并恢复编辑。'))
    if (error.recoveryDirectory) conflict.append(graphElement('p',`恢复记录：${error.recoveryDirectory}`))
    if (error.backupPath) conflict.append(graphElement('p',`原件位置：${error.backupPath}`))
    conflict.append(graphButton('重新读取磁盘',() => workspaceOpenFile(file.path,true)))
    conflict.classList.remove('hidden')
  } finally { if (request === workspaceUI.request) { workspaceUI.busy = null; workspaceControls() } }
}
async function workspaceImport() {
  if (!workspaceUI.file || workspaceDirty() || workspaceUI.busy || workspaceUI.loading) return
  const scope = $('#workspace-import-scope').value.trim()
  if (!scope) { workspaceMessage('请填写导入资料的范围。',true); return }
  const request = ++workspaceUI.request, file = workspaceUI.file
  workspaceUI.busy = 'import'; workspaceControls(); workspaceMessage('正在导入已保存的文件…')
  try {
    const result = await api('/workspace/import',{rootId:file.rootId,path:file.path,scope,private:$('#workspace-import-private').checked})
    if (request !== workspaceUI.request || view !== 'workspace') return
    $('#workspace-import-result').textContent = `已导入 ${result.name ?? file.path} · 范围 ${result.scope ?? scope} · ${result.private ? '私密资料' : '可用于所选范围'}。在知识库与知识图谱中查看。`
    workspaceMessage('资料已导入。后续保存此文件会刷新已导入内容，并保留原资料范围与私密设置。')
  } catch (error) {
    if (request === workspaceUI.request && view === 'workspace') workspaceMessage(`导入失败：${error.message}。文件内容没有改变。`,true)
  } finally { if (request === workspaceUI.request) { workspaceUI.busy = null; workspaceControls() } }
}
$('#workspace-root-form').onsubmit = event => { event.preventDefault(); action(async () => {
  if (workspaceUI.busy || workspaceUI.loading) return
  const directory = $('#workspace-directory').value.trim()
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(directory)) { workspaceMessage('请输入 Windows 绝对目录路径，例如 F:\\项目\\我的工作。',true); return }
  if (!await workspaceCanLeave('打开新的项目目录')) return
  const request = ++workspaceUI.request
  workspaceUI.busy = 'root'; workspaceControls(); workspaceMessage('正在登记所选目录…')
  try {
    const root = await api('/workspace/roots',{directory})
    if (request !== workspaceUI.request || view !== 'workspace') return
    workspaceUI.roots = [...workspaceUI.roots.filter(item => item.id !== root.id),root]
    workspaceUI.busy = null; workspaceRenderRoots()
    $('#workspace-directory').value = ''
    await workspaceBrowse(root.id,'',{confirmed:true})
  } catch (error) {
    if (request === workspaceUI.request && view === 'workspace') workspaceMessage(`添加目录失败：${error.message}。当前编辑内容已保留。`,true)
  } finally { if (request === workspaceUI.request) { workspaceUI.busy = null; workspaceControls() } }
}) }
$('#workspace-root').onchange = () => action(() => workspaceBrowse($('#workspace-root').value,''))
$('#workspace-up').onclick = () => action(() => workspaceBrowse(workspaceUI.rootId,workspaceUI.path.replaceAll('\\','/').split('/').slice(0,-1).join('/')))
$('#workspace-refresh-tree').onclick = () => action(() => workspaceBrowse(workspaceUI.rootId,workspaceUI.path,{keepFile:true}))
$('#workspace-save').onclick = () => action(workspaceSave)
$('#workspace-reload').onclick = () => action(() => workspaceOpenFile(workspaceUI.file.path,true))
$('#workspace-import-form').onsubmit = event => { event.preventDefault(); action(workspaceImport) }
$('#workspace-text').oninput = () => {
  workspaceControls(); workspaceMessage(workspaceDirty() ? '编辑会自动保存为草稿；点击保存文件后才写入磁盘。' : '编辑内容与上次读取或保存一致。')
  clearTimeout(workspaceUI.draftTimer)
  if (!workspaceUI.draftError) workspaceUI.draftTimer = setTimeout(() => { void workspaceFlushDraft().catch(error => workspaceMessage(`草稿尚未保存：${error.message}。请保留当前页面。`,true)) },400)
}
document.addEventListener('keydown',event => { if (view === 'workspace' && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); action(workspaceSave) } })
window.addEventListener('beforeunload',event => {
  const unsent = workspaceUI.file && workspaceUI.draftManaged && $('#workspace-text').value !== workspaceUI.draftSaved && (workspaceDirty() || workspaceUI.draft)
  if (unsent || workspaceUI.draftPromise || workspaceUI.busy) { event.preventDefault(); event.returnValue = '' }
})

// The graph is a read-only projection. Source content is rendered as text, never HTML.
const graphKinds = {document:'资料',memory:'记忆',experience:'来源经历'}
const graphExperienceNames = {user_message:'用户消息',assistant_message:'助理消息',tool_success:'工具成功结果',tool_failure:'工具失败结果',tool_unknown:'待核实的工具结果',preference:'明确告知的偏好',correction:'纠正记录',observation:'观察记录'}
const graphEdgeNames = {wikilink:'双向链接语法',markdown_link:'Markdown 链接',memory_source:'记忆来源'}
const graphReasons = {missing:'目标未导入或不可见',ambiguous:'同名目标不唯一',external:'外部链接',unsupported:'暂不支持的链接',index_limit:'资料索引达到本轮上限',node_limit:'目标超出节点上限'}
const graphUI = {data:null,cy:null,selected:null,local:null,request:0,sourceRequest:0,script:null,visible:new Set(),folders:new Map()}
function graphElement(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = String(text)
  if (className) element.className = className
  return element
}
function graphButton(text, handler, className = 'secondary') {
  const button = graphElement('button', text, className)
  button.type = 'button'
  button.addEventListener('click', () => action(handler))
  return button
}
function graphField(parent, label, value) {
  if (value === undefined || value === null || value === '') return
  const item = graphElement('div', undefined, 'graph-field')
  item.append(graphElement('span', label), graphElement('div', value))
  parent.append(item)
}
function resetGraph(message = '正在读取最新图谱…') {
  graphUI.request++; graphUI.sourceRequest++
  graphUI.data = null; graphUI.selected = null; graphUI.local = null; graphUI.visible.clear()
  if (graphUI.cy) graphUI.cy.elements().remove()
  $('#graph-files').replaceChildren(); $('#graph-records').replaceChildren(); $('#graph-unresolved-list').replaceChildren()
  $('#graph-count').textContent = ''; $('#graph-local').disabled = true
  $('#graph-unresolved-title').textContent = '未解析的链接'
  $('#graph-status').textContent = message
  $('#graph-status').classList.remove('graph-warning')
  $('#graph-empty').textContent = message; $('#graph-empty').classList.remove('hidden')
  $('#graph-detail').replaceChildren(graphElement('h3', '查看依据'), graphElement('p', '选择节点或连线，查看正文、来源和修订。', 'empty'))
}
async function loadGraphLibrary() {
  if (typeof window.cytoscape === 'function') return
  if (!graphUI.script) graphUI.script = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '/vendor/cytoscape.min.js'
    script.onload = () => typeof window.cytoscape === 'function' ? resolve() : reject(new Error('图谱组件未正确加载'))
    script.onerror = () => { script.remove(); reject(new Error('本地图谱组件加载失败，请重试或检查当前发行包')) }
    document.head.append(script)
  }).catch(error => { graphUI.script = null; throw error })
  await graphUI.script
}
async function refreshGraph() {
  resetGraph()
  const request = graphUI.request
  const scope = $('#graph-scope').value.trim()
  $('#graph-refresh').disabled = true
  try {
    if (!scope) throw new Error('请填写资料范围')
    const params = new URLSearchParams({scope,private:String($('#graph-private').checked),maxNodes:$('#graph-limit').value,maxEdges:'1000'})
    const [data] = await Promise.all([api(`/graph?${params}`), loadGraphLibrary()])
    if (request !== graphUI.request || view !== 'graph') return
    graphUI.data = data
    ensureGraphCanvas()
    renderGraph()
    renderGraphUnresolved()
    const cutNames = {nodes:'节点',edges:'关系',unresolved:'未解析链接',index:'资料索引',content:'正文扫描'}
    const cuts = Object.entries(data.truncation ?? {}).filter(([,cut]) => cut).map(([key]) => cutNames[key] ?? key)
    $('#graph-status').textContent = `范围：${data.scope} · ${data.includePrivate ? '包含私密' : '不含私密'} · 已加载 ${data.nodes.length} 个节点、${data.edges.length} 条关系。${cuts.length ? `本轮已截断：${cuts.join('、')}。可扩大节点上限或缩小资料范围；当前图不代表全部关联。` : '连线来自资料中的明确链接或已保存的记忆来源。'}`
    $('#graph-status').classList.toggle('graph-warning', Boolean(data.truncated))
  } catch (error) {
    if (request !== graphUI.request || view !== 'graph') return
    $('#graph-status').textContent = error.message
    $('#graph-empty').textContent = `${error.message}。可点击“刷新图谱”重试。`
    $('#graph-status').classList.add('graph-warning')
  } finally { $('#graph-refresh').disabled = false }
}
function ensureGraphCanvas() {
  if (graphUI.cy) return
  graphUI.cy = window.cytoscape({container:$('#graph-canvas'),elements:[],minZoom:.08,maxZoom:4,wheelSensitivity:.22,boxSelectionEnabled:false,
    style:[
      {selector:'node',style:{'label':'data(shortLabel)','background-color':'#8baa9a','color':'#243a3b','font-family':'Segoe UI, Microsoft YaHei, sans-serif','font-size':11,'text-wrap':'ellipsis','text-max-width':115,'text-valign':'bottom','text-margin-y':7,'width':28,'height':28,'border-width':2,'border-color':'#fffefa'}},
      {selector:'node[kind="memory"]',style:{'background-color':'#bda376','shape':'round-rectangle'}},
      {selector:'node[kind="experience"]',style:{'background-color':'#94a6ba','shape':'diamond','width':24,'height':24}},
      {selector:'edge',style:{'width':1.5,'line-color':'#bccbc1','target-arrow-color':'#97ad9d','target-arrow-shape':'triangle','curve-style':'bezier','arrow-scale':.7}},
      {selector:'edge[type="memory_source"]',style:{'line-style':'dashed','line-color':'#b7ac97','target-arrow-color':'#b7ac97'}},
      {selector:':selected',style:{'border-width':4,'border-color':'#335f55','line-color':'#335f55','target-arrow-color':'#335f55','width':4}},
      {selector:'node:selected',style:{'width':34,'height':34,'font-weight':'bold'}}
    ]})
  graphUI.cy.on('tap','node',event => action(() => selectGraphNode(event.target.id())))
  graphUI.cy.on('tap','edge',event => showGraphEdge(event.target.id()))
  new ResizeObserver(() => {
    if (view !== 'graph') return
    graphUI.cy.resize()
    if (graphUI.cy.nodes().length) graphUI.cy.fit(undefined,38)
  }).observe($('#graph-canvas'))
}
function filteredGraphNodes() {
  if (!graphUI.data) return []
  const kinds = new Set([...document.querySelectorAll('[data-graph-kind]:checked')].map(input => input.dataset.graphKind))
  const query = $('#graph-search').value.trim().toLocaleLowerCase()
  let neighborhood = null
  if (graphUI.local) {
    neighborhood = new Set([graphUI.local])
    for (const edge of graphUI.data.edges) if (edge.from === graphUI.local || edge.to === graphUI.local) { neighborhood.add(edge.from); neighborhood.add(edge.to) }
  }
  return graphUI.data.nodes.filter(node => kinds.has(node.kind) && (!neighborhood || neighborhood.has(node.id)) && (!query || `${node.label} ${node.path ?? ''} ${node.memoryKind ? kindNames[node.memoryKind] : ''}`.toLocaleLowerCase().includes(query)))
}
function renderGraph() {
  if (!graphUI.data || !graphUI.cy) return
  const nodes = filteredGraphNodes(), ids = new Set(nodes.map(node => node.id))
  const edges = graphUI.data.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to))
  graphUI.visible = ids
  if (graphUI.selected && !ids.has(graphUI.selected)) clearGraphSelection()
  graphUI.cy.batch(() => {
    graphUI.cy.elements().remove()
    graphUI.cy.add([...nodes.map(node => ({data:{id:node.id,kind:node.kind,shortLabel:Array.from(node.label).slice(0,22).join('')}})), ...edges.map(edge => ({data:{id:edge.id,source:edge.from,target:edge.to,type:edge.type}}))])
    if (graphUI.selected) graphUI.cy.getElementById(graphUI.selected).select()
  })
  renderGraphFiles(nodes.filter(node => node.kind === 'document'))
  const records = $('#graph-records'); records.replaceChildren()
  for (const node of nodes.filter(node => node.kind !== 'document')) records.append(graphNodeButton(node))
  if (!records.childElementCount) records.append(graphElement('p','当前筛选没有记忆或经历。','graph-hint'))
  $('#graph-count').textContent = `${graphUI.local ? '已加载的相邻视图 · ' : ''}${nodes.length} 个节点 / ${edges.length} 条关系`
  $('#graph-all').disabled = !graphUI.local
  $('#graph-local').disabled = !graphUI.selected
  $('#graph-empty').classList.toggle('hidden', nodes.length > 0)
  $('#graph-empty').textContent = graphUI.data.nodes.length ? '当前筛选没有匹配节点。调整搜索或类型，或返回全图。' : '还没有可显示的资料或记忆。先在“知识库”导入文件，或在“记忆”中保存内容。'
  requestAnimationFrame(() => {
    if (view !== 'graph' || !graphUI.data) return
    graphUI.cy.resize()
    if (nodes.length) graphUI.cy.layout({name:nodes.length > 600 ? 'grid' : 'cose',animate:false,fit:true,padding:38,randomize:true,nodeDimensionsIncludeLabels:true,nodeRepulsion:16000,nodeOverlap:20,idealEdgeLength:120,numIter:700,componentSpacing:95}).run()
  })
}
function graphNodeButton(node) {
  const button = graphButton(node.kind === 'document' ? node.label : `${graphKinds[node.kind]} · ${node.label}`, () => selectGraphNode(node.id), 'graph-node-button')
  button.dataset.graphNode = node.id
  button.classList.toggle('selected', graphUI.selected === node.id)
  button.title = node.path ?? node.label
  return button
}
function renderGraphFiles(nodes) {
  const container = $('#graph-files'); container.replaceChildren()
  if (!nodes.length) { container.append(graphElement('p','当前筛选没有已导入资料。','graph-hint')); return }
  const root = {directories:new Map(),nodes:[]}
  for (const node of nodes) {
    const parts = (node.path ?? node.label).replaceAll('\\','/').split('/').filter(Boolean)
    parts.pop()
    let branch = root
    for (const part of parts) {
      if (!branch.directories.has(part)) branch.directories.set(part,{directories:new Map(),nodes:[]})
      branch = branch.directories.get(part)
    }
    branch.nodes.push(node)
  }
  const count = branch => branch.nodes.length + [...branch.directories.values()].reduce((total, child) => total + count(child),0)
  const append = (parent, branch, prefix = '', depth = 0) => {
    for (const [firstName, firstDirectory] of [...branch.directories].sort(([a],[b]) => a.localeCompare(b,'zh-CN'))) {
      let name = firstName, directory = firstDirectory
      while (!directory.nodes.length && directory.directories.size === 1) {
        const [childName, childDirectory] = directory.directories.entries().next().value
        name += `/${childName}`; directory = childDirectory
      }
      const path = `${prefix}/${name}`, item = graphElement('details',undefined,'graph-directory')
      item.open = Boolean($('#graph-search').value.trim()) || (graphUI.folders.get(path) ?? (depth === 0 || count(directory) <= 8))
      const pieces = name.split('/'), label = name.length > 38 && pieces.length > 2 ? `${pieces[0]}/…/${pieces.at(-1)}` : name
      const summary = graphElement('summary',`${label} (${count(directory)})`)
      summary.title = path; item.append(summary)
      item.addEventListener('toggle', () => graphUI.folders.set(path,item.open))
      append(item,directory,path,depth + 1); parent.append(item)
    }
    for (const node of branch.nodes.sort((a,b) => a.label.localeCompare(b.label,'zh-CN'))) parent.append(graphNodeButton(node))
  }
  append(container,root)
}
function clearGraphSelection() {
  graphUI.selected = null; graphUI.sourceRequest++
  $('#graph-local').disabled = true
  if (graphUI.cy) graphUI.cy.elements().unselect()
  $('#graph-detail').replaceChildren(graphElement('h3','查看依据'),graphElement('p','选择节点或连线，查看正文、来源和修订。','empty'))
}
function markGraphSelection(id) {
  graphUI.selected = id
  $('#graph-local').disabled = !id
  document.querySelectorAll('[data-graph-node]').forEach(button => button.classList.toggle('selected',button.dataset.graphNode === id))
  if (graphUI.cy) { graphUI.cy.elements().unselect(); if (id) graphUI.cy.getElementById(id).select() }
}
async function selectGraphNode(id, startLine = 1) {
  if (!graphUI.data) return
  const node = graphUI.data.nodes.find(item => item.id === id)
  if (!node) return
  markGraphSelection(id)
  const request = ++graphUI.sourceRequest, graphRequest = graphUI.request
  const detail = $('#graph-detail'); detail.replaceChildren(graphElement('h3',node.label),graphElement('p','正在读取来源…','graph-hint'))
  try {
    const params = new URLSearchParams({id,scope:graphUI.data.scope,private:String(graphUI.data.includePrivate),startLine:String(startLine),lineLimit:'80'})
    const source = await api(`/graph/source?${params}`)
    if (request !== graphUI.sourceRequest || graphRequest !== graphUI.request || view !== 'graph') return
    const changedDocument = source.kind === 'document' && (source.contentHash !== node.contentHash || source.revision !== node.revision)
    const changedMemory = source.kind === 'memory' && source.memory?.revision !== node.revision
    if (changedDocument || changedMemory) {
      markGraphSelection(null)
      detail.replaceChildren(graphElement('h3','资料已更新，请刷新图谱'),graphElement('p','当前图中的关系来自较早修订。刷新后再查看正文与来源，避免将旧关系配到新内容。','graph-hint'),graphButton('刷新图谱',refreshGraph))
      return
    }
    detail.replaceChildren(graphElement('span',graphKinds[node.kind],'tag'),graphElement('h3',source.label ?? node.label))
    graphField(detail,'范围',source.scope ?? node.scope)
    if (source.private ?? node.private) graphField(detail,'可见性','私密')
    if (source.kind === 'document') {
      graphField(detail,'原始路径',source.path)
      graphField(detail,'导入修订',source.revision)
      graphField(detail,'内容校验',source.contentHash)
      detail.append(graphElement('p','下方是导入时保存的正文；源文件变化后，请在知识库刷新资料。','graph-hint'))
      const pre = graphElement('div',undefined,'graph-source-lines')
      for (const line of source.lines ?? []) {
        const row = graphElement('div',undefined,'graph-source-line')
        row.append(graphElement('span',line.number,'graph-line-number'),graphElement('code',`${line.text}${line.truncated ? ' …（本行已截断）' : ''}`))
        pre.append(row)
      }
      if (!pre.childElementCount) pre.append(graphElement('p','这一页没有正文。','graph-hint'))
      detail.append(pre)
      if (source.lines?.some(line => line.truncated)) detail.append(graphElement('p','超长行只显示前段；下一页从下一原始行开始，不续接本行。','graph-hint'))
      else if (source.truncated && source.endLine < source.startLine) detail.append(graphElement('p','这一页的导入正文不完整，请刷新资料索引后重试。','graph-hint'))
      const pages = graphElement('div',undefined,'graph-pagination')
      const previous = graphButton('上一页',() => selectGraphNode(id,Math.max(1,source.startLine - 80)))
      const next = graphButton('下一页',() => selectGraphNode(id,source.endLine + 1))
      previous.disabled = source.startLine <= 1
      next.disabled = source.endLine >= source.totalLines || source.endLine < source.startLine
      pages.append(previous,graphElement('span',source.totalLines ? `${source.startLine}–${source.endLine} / ${source.totalLines} 行` : '空文档'),next); detail.append(pages)
    } else {
      const record = source.memory ?? source.experience ?? source.record ?? {}
      graphField(detail,'类型',source.kind === 'memory' ? kindNames[record.kind] ?? record.kind : graphExperienceNames[record.kind] ?? record.kind)
      detail.append(graphElement('p',record.text ?? '', 'graph-record-text'))
      graphField(detail,'修订',record.revision)
      graphField(detail,'来源编号',record.sourceIds?.join('、'))
      graphField(detail,'来源键',record.sourceKey)
      graphField(detail,'记录时间',record.updatedAt || record.recordedAt ? date(record.updatedAt ?? record.recordedAt) : undefined)
      if (source.truncated) detail.append(graphElement('p','较长内容已截断显示。','graph-hint'))
    }
    appendGraphRelations(detail,node)
  } catch (error) {
    if (request !== graphUI.sourceRequest || graphRequest !== graphUI.request || view !== 'graph') return
    markGraphSelection(null)
    detail.replaceChildren(graphElement('h3','来源暂不可用'),graphElement('p',`${error.message}。资料可能已被纠正、移除或改变可见范围，请刷新图谱。`,'graph-hint'),graphButton('刷新图谱',refreshGraph))
  }
}
function appendGraphRelations(parent,node) {
  const relations = graphUI.data.edges.filter(edge => edge.from === node.id || edge.to === node.id)
  parent.append(graphElement('h4',`已加载的关系 · ${relations.length}`))
  if (!relations.length) parent.append(graphElement('p','当前已加载图谱中没有明确关系。','graph-hint'))
  for (const edge of relations) {
    const other = graphUI.data.nodes.find(item => item.id === (edge.from === node.id ? edge.to : edge.from))
    parent.append(graphButton(`${graphEdgeNames[edge.type]} → ${other?.label ?? '相关节点'}`,() => showGraphEdge(edge.id),'graph-relation-button'))
  }
}
function showGraphEdge(id) {
  const edge = graphUI.data?.edges.find(item => item.id === id)
  if (!edge) return
  graphUI.sourceRequest++; markGraphSelection(null)
  graphUI.cy?.getElementById(edge.id).select()
  const detail = $('#graph-detail'), evidence = edge.evidence
  detail.replaceChildren(graphElement('span','关系依据','tag'),graphElement('h3',graphEdgeNames[edge.type]))
  for (const [label,nodeID] of [['起点',edge.from],['终点',edge.to]]) {
    const node = graphUI.data.nodes.find(item => item.id === nodeID)
    detail.append(graphElement('h4',label),graphButton(node?.label ?? nodeID,() => selectGraphNode(nodeID),'graph-relation-button'))
  }
  appendGraphEvidence(detail,evidence)
}
function appendGraphEvidence(parent,evidence) {
  parent.append(graphElement('h4','原始依据'),graphElement('p',evidence.snippet,'graph-record-text'))
  if (evidence.kind === 'document') {
    graphField(parent,'所在文件',evidence.path)
    graphField(parent,'位置',`第 ${evidence.line} 行，第 ${evidence.column} 列`)
    graphField(parent,'原始链接',evidence.rawTarget)
    graphField(parent,'锚点',evidence.anchor)
    graphField(parent,'内容校验',evidence.contentHash)
    parent.append(graphButton('阅读这段来源',() => selectGraphNode(`document:${evidence.documentId}`,Math.max(1,evidence.line - 8))))
  } else {
    graphField(parent,'来源编号',evidence.experienceId)
    graphField(parent,'来源键',evidence.sourceKey)
    parent.append(graphButton('阅读来源经历',() => selectGraphNode(`experience:${evidence.experienceId}`)))
  }
}
function renderGraphUnresolved() {
  const items = graphUI.data?.unresolved ?? [], container = $('#graph-unresolved-list')
  container.replaceChildren()
  $('#graph-unresolved-title').textContent = `未解析的链接 · ${items.length}${graphUI.data?.truncation.unresolved ? '（还有未显示项）' : ''}`
  for (const item of items) {
    const row = graphElement('div',undefined,'graph-unresolved-item')
    row.append(graphElement('span',graphReasons[item.reason] ?? item.reason,'tag'),graphElement('span',item.evidence.rawTarget),graphButton(`${item.evidence.path} · 第 ${item.evidence.line} 行`,() => selectGraphNode(item.from,Math.max(1,item.evidence.line - 8)),'graph-relation-button'))
    container.append(row)
  }
  if (!items.length) container.append(graphElement('p','本轮扫描未记录未解析链接。','graph-hint'))
}
$('#graph-query').onsubmit = event => { event.preventDefault(); action(refreshGraph) }
$('#graph-scope').oninput = () => resetGraph('范围已改变，点击“刷新图谱”应用。')
$('#graph-private').onchange = () => resetGraph('私密范围已改变，点击“刷新图谱”应用。')
$('#graph-limit').onchange = () => resetGraph('节点上限已改变，点击“刷新图谱”应用。')
$('#graph-search').oninput = () => { clearGraphSelection(); renderGraph() }
document.querySelectorAll('[data-graph-kind]').forEach(input => input.onchange = () => { clearGraphSelection(); renderGraph() })
$('#graph-local').onclick = () => { if (graphUI.selected) { graphUI.local = graphUI.selected; renderGraph() } }
$('#graph-all').onclick = () => { graphUI.local = null; renderGraph() }
$('#graph-fit').onclick = () => { if (graphUI.cy) { graphUI.cy.resize(); graphUI.cy.fit(undefined,38) } }

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
  const reviewModel = $('#memory-review-model'), previousReviewModel = reviewModel.value
  reviewModel.replaceChildren(...[...$('#model').options].map(option => option.cloneNode(true)))
  reviewModel.value = [...reviewModel.options].some(option => option.value === previousReviewModel) ? previousReviewModel : ''
  $('#engine-config').innerHTML = `<p>${providers.connected.length ? `已配置：${escape(providers.connected.join('、'))}。发送一个简短任务，可验证模型服务是否可用。` : '还没有配置模型。请在上方填写服务商提供的接口地址、模型名称和密钥。'}</p><p>配置只保存在这台电脑；更换电脑后需要重新设置。</p>`
  if (!engineHealth.ok) notice(`执行引擎暂不可用：${engineHealth.reason}`, true)
  if (view === 'system') await renderSystem()
}
$('#refresh-engine').onclick = () => action(loadEngine)
$('#model-form').onsubmit = event => { event.preventDefault(); action(async () => { const form = new FormData(event.target); await api('/settings/model', {baseURL:form.get('baseURL'),model:form.get('model'),apiKey:form.get('apiKey')}); event.target.elements.apiKey.value = ''; notice('模型配置已保存。请发送一个简短任务验证服务是否可用。'); await loadEngine() }) }
$('#checkpoint').onclick = () => action(async () => { $('#checkpoint').disabled = true; try { await api('/checkpoint', {}); notice('检查点已验证并保存到 U 盘。'); await refresh() } finally { $('#checkpoint').disabled = false } })
$('#shutdown').onclick = () => action(async () => { const result = await api('/shutdown', {}); clearInterval(timer); clearInterval(collaborationTimer); notice(result.message); document.querySelectorAll('button').forEach(button => button.disabled = true) })
await action(async () => { await refresh(); await loadEngine() })
const timer = setInterval(() => action(refresh), 2500)
const collaborationTimer = setInterval(() => { if (view === 'collaboration' && collaborationUI.hasActive) action(() => refreshCollaboration(false)) }, 5000)
