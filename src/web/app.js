const $ = (selector) => document.querySelector(selector)
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const date = (value) => new Date(value).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const uuid = () => crypto.randomUUID()
const statusNames = {ready:'准备开始',running:'正在处理',waiting:'待核实',verifying:'等待验收',completed:'已完成',failed:'执行失败',cancelled:'已取消'}
const kindNames = {preference:'偏好',fact:'事实',inference:'待验证认识',episode:'经历',commitment:'承诺'}
const titles = {chat:'对话与任务',memory:'记忆',knowledge:'知识库',graph:'知识图谱',skills:'经验技能',sleep:'睡眠整理',files:'文件管家',system:'系统中心'}
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
  if (view === 'graph') await refreshGraph()
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
