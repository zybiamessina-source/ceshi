const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = { videos: [], authors: [], topics: [], lowFans: [], settings: {}, busy: false };
const titles = { collect: '作者作品采集', videos: '视频数据库', lowfans: '低粉爆款榜', topics: '选题库', transcripts: '视频文案识别', settings: '设置与安全' };

function toast(message, error = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.className = 'toast', 3500);
}

function unwrap(result) {
  if (!result?.ok) throw new Error([result?.error, result?.details].filter(Boolean).join('：'));
  return result.data;
}

function num(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function pct(value) { return value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(2)}%`; }
function date(value) { return value ? new Date(value).toLocaleDateString('zh-CN') : '—'; }
function safe(value) { const el = document.createElement('span'); el.textContent = String(value ?? ''); return el.innerHTML; }

function showPage(name) {
  $$('.nav').forEach((node) => node.classList.toggle('active', node.dataset.page === name));
  $$('.page').forEach((node) => node.classList.toggle('active', node.id === `page-${name}`));
  $('#pageTitle').textContent = titles[name];
}

function renderMetrics(collection) {
  $('#metricVideos').textContent = num(state.videos.length);
  $('#metricPage').textContent = collection?.page || '—';
  $('#metricStats').textContent = num(state.videos.filter((v) => Number(v.play) > 0).length);
  $('#metricTranscript').textContent = num(state.videos.filter((v) => v.transcript).length);
  $('#progressCount').textContent = `${state.videos.length} 条`;
}

function renderAuthors() {
  const historyValue = $('#authorHistory').value;
  const filterValue = $('#authorFilter').value;
  const options = state.authors.map((author) => `<option value="${safe(author.secUserId || author.url)}" data-url="${safe(author.url)}">${safe(author.nickname || '未知作者')} · ${num(author.videoCount)} 条</option>`).join('');
  $('#authorHistory').innerHTML = `<option value="">新作者 / 手动输入</option>${options}`;
  $('#authorFilter').innerHTML = `<option value="">全部作者</option>${options}`;
  if ([...$('#authorHistory').options].some((option) => option.value === historyValue)) $('#authorHistory').value = historyValue;
  if ([...$('#authorFilter').options].some((option) => option.value === filterValue)) $('#authorFilter').value = filterValue;
}

function rateClass(value) { return Number(value) >= .05 ? 'rate hot' : 'rate'; }

function renderVideos() {
  const query = $('#videoFilter').value.trim().toLowerCase();
  const authorKey = $('#authorFilter').value;
  const selectedAuthor = state.authors.find((author) => String(author.secUserId || author.url) === authorKey);
  const rows = state.videos.filter((v) => (!authorKey || v.authorKey === authorKey || (selectedAuthor?.nickname && v.nickname === selectedAuthor.nickname)) && `${v.title} ${v.nickname} ${v.id}`.toLowerCase().includes(query));
  $('#videoTable').innerHTML = rows.map((v) => `<tr>
    <td><input class="row-check" type="checkbox" value="${safe(v.id)}"></td>
    <td><div class="video-cell"><div class="thumb">▶</div><div><strong title="${safe(v.title)}">${safe(v.title || '无标题')}</strong><small>${safe(v.nickname || '未知作者')} · ${safe(v.id)}</small></div></div></td>
    <td><strong>${num(v.play)}</strong></td><td class="${rateClass(v.likeRate)}">${pct(v.likeRate)}</td><td class="rate">${pct(v.collectRate)}</td><td class="rate">${pct(v.shareRate)}</td><td>${date(v.createdAt)}</td>
    <td><div class="action-group"><button class="action primary-action add-topic" data-id="${safe(v.id)}">${state.topics.some((topic) => String(topic.id) === String(v.id)) ? '已在选题库' : '加入选题库'}</button><button class="action transcribe-one" data-id="${safe(v.id)}">识别文案</button></div></td></tr>`).join('');
  $('#videoEmpty').style.display = rows.length ? 'none' : 'block';
  renderTranscripts();
}

function renderTranscripts() {
  $('#transcriptTable').innerHTML = state.videos.map((v) => `<tr><td><div class="video-cell"><div class="thumb">♪</div><div><strong>${safe(v.title || v.id)}</strong><small>${safe(v.nickname || '')}</small></div></div></td><td>${v.transcript ? '<span class="badge">已完成</span>' : '<span class="badge warn">未识别</span>'}</td><td><div class="transcript-preview" title="${safe(v.transcript || '')}">${safe(v.transcript || '—')}</div></td><td><button class="action transcribe-one" data-id="${safe(v.id)}">${v.transcript ? '重新识别' : '开始识别'}</button></td></tr>`).join('');
  $('#transcriptEmpty').style.display = state.videos.length ? 'none' : 'block';
}

function renderLowFans() {
  $('#lowFanGrid').innerHTML = state.lowFans.map((v, i) => `<article class="hot-card"><div class="topline"><span>#${i + 1} · ${safe(v.nickname || '未知作者')}</span><span>${num(v.fans)} 粉丝</span></div><h3>${safe(v.title || '无标题')}</h3><span class="big">${num(v.play)}</span><small> 播放</small><div class="stats"><div><small>点赞率</small><strong>${pct(v.likeRate)}</strong></div><div><small>收藏率</small><strong>${pct(v.collectRate)}</strong></div><div><small>分享率</small><strong>${pct(v.shareRate)}</strong></div></div><button class="action primary-action add-topic" data-id="${safe(v.id)}">${state.topics.some((topic) => String(topic.id) === String(v.id)) ? '已在选题库' : '加入选题库'}</button></article>`).join('');
  $('#lowEmpty').style.display = state.lowFans.length ? 'none' : 'block';
}

function renderTopics() {
  const query = $('#topicFilter').value.trim().toLowerCase();
  const rows = state.topics.filter((v) => `${v.title} ${v.nickname} ${v.id}`.toLowerCase().includes(query));
  $('#topicCount').textContent = num(state.topics.length);
  $('#topicTable').innerHTML = rows.map((v) => `<tr>
    <td><div class="video-cell"><div class="thumb">◇</div><div><strong>${safe(v.title || '无标题')}</strong><small>${safe(v.nickname || '未知作者')} · ${safe(v.id)}</small></div></div></td>
    <td><div class="copy-block"><div class="copy-text${v.transcript ? '' : ' empty'}">${safe(v.transcript || '尚未获取文案；点击一键改写时会先自动识别。')}</div><div class="copy-actions"><button class="action primary-action rewrite-topic" data-id="${safe(v.id)}">一键改写</button><button class="action view-rewrites" data-id="${safe(v.id)}" ${v.rewrites?.length ? '' : 'disabled'}>查看改写结果${v.rewrites?.length ? `<span class="rewrite-badge">${v.rewrites.length}</span>` : ''}</button></div></div></td>
    <td><strong>${num(v.play)}</strong><small> 播放</small><br><span class="rate">${pct(v.likeRate)} 点赞率</span></td><td>${date(v.topicAddedAt)}</td>
    <td><div class="action-group"><button class="action transcribe-one" data-id="${safe(v.id)}">${v.transcript ? '重新识别' : '获取文案'}</button><button class="action remove-action remove-topic" data-id="${safe(v.id)}">移出</button></div></td></tr>`).join('');
  $('#topicEmpty').style.display = rows.length ? 'none' : 'block';
}

function renderSettings() {
  const s = state.settings;
  $('#tikhubBaseUrl').value = s.tikhubBaseUrl || '';
  $('#dashscopeBaseUrl').value = s.dashscopeBaseUrl || '';
  $('#deepseekBaseUrl').value = s.deepseekBaseUrl || 'https://api.deepseek.com';
  $('#rewriteSystemPrompt').value = s.rewriteSystemPrompt || '';
  $('#retryCount').value = s.retryCount || 30;
  $('#retryDelayMs').value = s.retryDelayMs || 1000;
  $('#region').value = s.region || 'CN';
  $('#demoMode').checked = Boolean(s.demoMode);
  $('#autoStats').checked = Boolean(s.autoStats);
  $('#tikhubState').textContent = s.hasTikhubKey ? '（已保存）' : '（未填写）';
  $('#dashscopeState').textContent = s.hasDashscopeKey ? '（已保存）' : '（未填写）';
  $('#deepseekState').textContent = s.hasDeepseekKey ? '（已保存）' : '（未填写）';
  $('#modeLabel').textContent = s.demoMode ? '演示模式' : '真实接口模式';
  const ready = s.hasTikhubKey && s.hasDashscopeKey && s.hasDeepseekKey;
  $('#keyBadge').textContent = ready ? '密钥已配置' : '密钥待配置';
  $('#keyBadge').className = `badge${ready ? '' : ' warn'}`;
}

function logEvent(message) {
  const line = document.createElement('div');
  line.innerHTML = `<time>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</time><span>${safe(message)}</span>`;
  $('#eventLog').prepend(line);
}

async function reload() {
  const data = unwrap(await window.radar.listVideos());
  state.videos = data.videos || [];
  state.authors = data.authors || [];
  state.topics = unwrap(await window.radar.listTopics()) || [];
  renderAuthors();
  renderMetrics(data.collection);
  renderVideos();
  renderTopics();
}

async function collect() {
  if (state.busy) return;
  state.busy = true;
  $('#collectBtn').disabled = true;
  $('#stopBtn').classList.remove('hidden');
  $('#progressText').textContent = '正在采集…';
  $('#progressBar').style.width = '12%';
  try {
    const data = unwrap(await window.radar.collectAuthor({ url: $('#authorUrl').value, mode: $('#collectMode').value, pages: Number($('#pageCount').value) }));
    toast(`采集完成，本次新增 ${data.count} 条`);
    $('#progressText').textContent = data.stopped ? '任务已停止，进度已保存' : '全部采集完成';
    $('#progressBar').style.width = '100%';
    await reload();
  } catch (error) { toast(error.message, true); $('#progressText').textContent = '采集失败'; }
  finally { state.busy = false; $('#collectBtn').disabled = false; $('#stopBtn').classList.add('hidden'); }
}

function selectedIds() { return $$('.row-check:checked').map((node) => node.value); }

async function refreshStats() {
  const ids = selectedIds();
  if (!confirm(`将调用收费统计接口，${ids.length ? `补全选中的 ${ids.length} 条` : '补全全部视频'}，是否继续？`)) return;
  try { unwrap(await window.radar.refreshStats(ids)); toast('播放数据补全完成'); await reload(); } catch (error) { toast(error.message, true); }
}

async function transcribe(id) {
  try {
    toast('正在重新获取直链并提交识别…');
    const result = unwrap(await window.radar.transcribe(id));
    if (state.topics.some((topic) => String(topic.id) === String(id))) await window.radar.addTopic({ id, transcript: result.transcript, transcriptStatus: '完成' });
    toast('文案识别完成'); await reload();
  }
  catch (error) { toast(error.message, true); }
}

async function searchLowFans() {
  try {
    $('#lowSearchBtn').disabled = true;
    state.lowFans = unwrap(await window.radar.searchLowFans({ keyword: $('#lowKeyword').value.trim(), page: 1, pageSize: 20, dateWindow: Number($('#dateWindow').value) }));
    renderLowFans(); toast(`找到 ${state.lowFans.length} 条结果`);
  } catch (error) { toast(error.message, true); }
  finally { $('#lowSearchBtn').disabled = false; }
}

async function addTopic(id) {
  const video = [...state.videos, ...state.lowFans].find((item) => String(item.id) === String(id));
  if (!video) return toast('没有找到这条视频', true);
  try { unwrap(await window.radar.addTopic(video)); toast('已加入选题库'); await reload(); }
  catch (error) { toast(error.message, true); }
}

async function removeTopic(id) {
  try { unwrap(await window.radar.removeTopic(id)); toast('已移出选题库'); await reload(); }
  catch (error) { toast(error.message, true); }
}

async function rewriteTopic(id) {
  const button = document.querySelector(`.rewrite-topic[data-id="${CSS.escape(String(id))}"]`);
  try {
    if (button) { button.disabled = true; button.textContent = '正在改写…'; }
    toast('正在准备原文并调用 DeepSeek-V4-Pro…');
    unwrap(await window.radar.rewriteTopic(id));
    await reload();
    toast('爆款文案改写完成');
    viewRewrites(id);
  } catch (error) { toast(error.message, true); }
  finally { if (button?.isConnected) { button.disabled = false; button.textContent = '一键改写'; } }
}

function viewRewrites(id) {
  const topic = state.topics.find((item) => String(item.id) === String(id));
  if (!topic) return toast('没有找到这个选题', true);
  $('#rewriteModalTitle').textContent = topic.title || '改写结果';
  const rewrites = Array.isArray(topic.rewrites) ? topic.rewrites : [];
  $('#rewriteModalBody').innerHTML = `<div class="rewrite-source"><strong>原始文案</strong><div class="rewrite-content">${safe(topic.transcript || '暂无原始文案')}</div></div>${rewrites.length ? rewrites.map((item, index) => `<article class="rewrite-item"><header><strong>改写版本 ${rewrites.length - index}</strong><span>${safe(item.model || 'deepseek-v4-pro')} · ${new Date(item.createdAt).toLocaleString('zh-CN')}</span></header><div class="rewrite-content">${safe(item.text)}</div></article>`).join('') : '<div class="empty-result">还没有改写结果。</div>'}`;
  $('#rewriteModal').classList.remove('hidden');
}

function closeRewriteModal() { $('#rewriteModal').classList.add('hidden'); }

async function saveSettings() {
  try {
    state.settings = unwrap(await window.radar.saveSettings({
      tikhubKey: $('#tikhubKey').value, dashscopeKey: $('#dashscopeKey').value, deepseekKey: $('#deepseekKey').value,
      tikhubBaseUrl: $('#tikhubBaseUrl').value.trim(), dashscopeBaseUrl: $('#dashscopeBaseUrl').value.trim(), deepseekBaseUrl: $('#deepseekBaseUrl').value.trim(),
      rewriteSystemPrompt: $('#rewriteSystemPrompt').value.trim(),
      retryCount: Math.min(30, Math.max(1, Number($('#retryCount').value))), retryDelayMs: Math.max(1000, Number($('#retryDelayMs').value)),
      region: $('#region').value, demoMode: $('#demoMode').checked, autoStats: $('#autoStats').checked
    }));
    $('#tikhubKey').value = ''; $('#dashscopeKey').value = ''; $('#deepseekKey').value = ''; renderSettings(); toast('设置已安全保存');
  } catch (error) { toast(error.message, true); }
}

$$('.nav').forEach((node) => node.addEventListener('click', () => showPage(node.dataset.page)));
$('#collectBtn').addEventListener('click', collect);
$('#stopBtn').addEventListener('click', () => window.radar.stopCollection());
$('#refreshBtn').addEventListener('click', reload);
$('#videoFilter').addEventListener('input', renderVideos);
$('#authorFilter').addEventListener('change', renderVideos);
$('#authorHistory').addEventListener('change', (event) => { const option = event.target.selectedOptions[0]; if (option?.dataset.url) $('#authorUrl').value = option.dataset.url; });
$('#collectMode').addEventListener('change', (event) => {
  $('#pageCountWrap').classList.toggle('hidden', event.target.value !== 'pages');
  $('#collectBtn').textContent = event.target.value === 'latest' ? '采集最新' : '开始采集';
});
$('#topicFilter').addEventListener('input', renderTopics);
$('#statsBtn').addEventListener('click', refreshStats);
$('#lowSearchBtn').addEventListener('click', searchLowFans);
$('#saveSettingsBtn').addEventListener('click', saveSettings);
$('#promptSaveBtn').addEventListener('click', saveSettings);
$('#closeRewriteModal').addEventListener('click', closeRewriteModal);
$('#rewriteModal').addEventListener('click', (event) => { if (event.target.id === 'rewriteModal') closeRewriteModal(); });
$('#selectAll').addEventListener('change', (event) => $$('.row-check').forEach((node) => node.checked = event.target.checked));
document.addEventListener('click', (event) => {
  const transcribeButton = event.target.closest('.transcribe-one');
  const addButton = event.target.closest('.add-topic');
  const removeButton = event.target.closest('.remove-topic');
  const rewriteButton = event.target.closest('.rewrite-topic');
  const viewButton = event.target.closest('.view-rewrites');
  if (transcribeButton) transcribe(transcribeButton.dataset.id);
  else if (addButton) addTopic(addButton.dataset.id);
  else if (removeButton) removeTopic(removeButton.dataset.id);
  else if (rewriteButton) rewriteTopic(rewriteButton.dataset.id);
  else if (viewButton) viewRewrites(viewButton.dataset.id);
});
$('#exportVideosBtn').addEventListener('click', async () => { try { const result = unwrap(await window.radar.exportCsv(state.videos, '作者视频数据')); if (!result.canceled) toast('CSV 已导出'); } catch (e) { toast(e.message, true); } });
$('#exportLowBtn').addEventListener('click', async () => { try { const result = unwrap(await window.radar.exportCsv(state.lowFans, '低粉爆款数据')); if (!result.canceled) toast('CSV 已导出'); } catch (e) { toast(e.message, true); } });
$('#exportTopicsBtn').addEventListener('click', async () => { try { const result = unwrap(await window.radar.exportCsv(state.topics, '选题库')); if (!result.canceled) toast('选题库已导出'); } catch (e) { toast(e.message, true); } });
$('#clearBtn').addEventListener('click', async () => { if (confirm('确定清空本机采集数据吗？密钥和设置不会被删除。')) { unwrap(await window.radar.clearData()); await reload(); toast('本地数据已清空'); } });
window.radar.onProgress((event) => { logEvent(event.message || '任务更新'); $('#progressText').textContent = event.message || '处理中'; if (event.count) { $('#progressCount').textContent = `${event.count} 条`; $('#progressBar').style.width = `${Math.min(90, 15 + event.page * 8)}%`; } });

(async () => {
  try { state.settings = unwrap(await window.radar.getSettings()); renderSettings(); await reload(); }
  catch (error) { toast(error.message, true); }
})();
