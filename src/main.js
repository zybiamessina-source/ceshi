const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { JsonStore } = require('./lib/store');
const { ApiClient, TaskCancelledError } = require('./lib/api');
const { redactText } = require('./lib/security');

let mainWindow;
let store;
const activeTasks = new Map();

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:progress', payload);
}

function publicError(error) {
  const secrets = store?.secretValues?.() || [];
  return {
    ok: false,
    error: redactText(error?.message || '操作失败', secrets),
    details: redactText(error?.details || '', secrets),
    cancelled: error instanceof TaskCancelledError
  };
}

async function guarded(action) {
  try { return { ok: true, data: await action() }; }
  catch (error) {
    console.error(`[safe-error] ${error?.name || 'Error'}: ${redactText(error?.message || 'unknown', store?.secretValues?.() || [])}`);
    return publicError(error);
  }
}

async function runTask(type, target, action) {
  const id = `${type}:${String(target || 'current')}`;
  if (activeTasks.has(id)) throw new Error('这个任务已经在运行，请等待完成或先取消');
  const controller = new AbortController();
  activeTasks.set(id, controller);
  store.upsertTask({ id, type, target: String(target || ''), status: 'running', startedAt: new Date().toISOString() });
  sendProgress({ type: 'task', taskId: id, taskType: type, target: String(target || ''), status: 'running', message: '任务已开始' });
  try {
    const data = await action(controller.signal);
    store.upsertTask({ id, type, target: String(target || ''), status: 'completed', completedAt: new Date().toISOString() });
    return data;
  } catch (error) {
    const cancelled = error instanceof TaskCancelledError || controller.signal.aborted;
    store.upsertTask({ id, type, target: String(target || ''), status: cancelled ? 'cancelled' : 'failed', error: redactText(error?.message || '任务失败', store.secretValues()), completedAt: new Date().toISOString() });
    if (cancelled && !(error instanceof TaskCancelledError)) throw new TaskCancelledError();
    throw error;
  } finally {
    activeTasks.delete(id);
    sendProgress({ type: 'task', taskId: id, taskType: type, target: String(target || ''), status: 'idle', message: '任务已结束' });
  }
}

function cancelTasks(type = '', target = '') {
  let cancelled = 0;
  for (const [id, controller] of activeTasks) {
    const [taskType, ...rest] = id.split(':');
    const taskTarget = rest.join(':');
    if ((!type || taskType === type) && (!target || taskTarget === String(target))) {
      controller.abort();
      cancelled += 1;
    }
  }
  return cancelled;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#ffffff',
    title: '抖音爆款雷达',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function registerHandlers() {
  ipcMain.handle('settings:get', () => guarded(() => store.publicSettings()));
  ipcMain.handle('settings:save', (_event, settings) => guarded(() => store.updateSettings(settings || {})));
  ipcMain.handle('settings:clear-secret', (_event, name) => guarded(() => store.clearSecret(String(name || ''))));
  ipcMain.handle('videos:list', () => guarded(() => ({
    videos: store.state.videos,
    authors: store.state.authors,
    collection: store.state.collection,
    searches: store.state.searches,
    tasks: store.state.tasks
  })));
  ipcMain.handle('author:collect', (_event, request) => guarded(async () => {
    const input = typeof request === 'string' ? { url: request } : (request || {});
    const url = String(input.url || '').trim();
    if (!/^https?:\/\/(www\.)?douyin\.com\//i.test(String(url || ''))) throw new Error('请输入有效的抖音作者主页链接');
    return runTask('collection', url, (signal) => new ApiClient(store, sendProgress, { signal }).collectAuthor(url, {
        mode: ['all', 'pages', 'latest'].includes(input.mode) ? input.mode : 'all',
        pages: Math.max(1, Math.min(999, Number(input.pages) || 1))
      }));
  }));
  ipcMain.handle('author:stop', () => ({ ok: true, data: { cancelled: cancelTasks('collection') } }));
  ipcMain.handle('tasks:cancel', (_event, request) => ({ ok: true, data: { cancelled: cancelTasks(String(request?.type || ''), String(request?.target || '')) } }));
  ipcMain.handle('tasks:list', () => guarded(() => store.state.tasks));
  ipcMain.handle('videos:stats', (_event, ids) => guarded(() => runTask('stats', 'current', (signal) => new ApiClient(store, sendProgress, { signal }).refreshStats(Array.isArray(ids) ? ids : []))));
  ipcMain.handle('videos:transcribe', (_event, id) => guarded(() => runTask('asr', String(id), (signal) => new ApiClient(store, sendProgress, { signal }).transcribe(String(id)))));
  ipcMain.handle('lowfans:search', (_event, query) => guarded(() => runTask('lowfans', 'current', (signal) => new ApiClient(store, sendProgress, { signal }).searchLowFans(query || {}))));
  ipcMain.handle('topics:list', () => guarded(() => store.state.topics));
  ipcMain.handle('topics:add', (_event, video) => guarded(() => store.addTopic(video)));
  ipcMain.handle('topics:remove', (_event, id) => guarded(() => store.removeTopic(id)));
  ipcMain.handle('topics:rewrite', (_event, id) => guarded(() => runTask('rewrite', String(id), (signal) => new ApiClient(store, sendProgress, { signal }).rewriteTopic(String(id)))));
  ipcMain.handle('data:clear', () => guarded(() => {
    if (activeTasks.size) throw new Error('请先取消正在运行的任务，再清空数据');
    store.clearCollectedData();
    return true;
  }));
  ipcMain.handle('data:backup', async () => guarded(async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '备份全部本地数据',
      defaultPath: `抖音爆款雷达备份-${new Date().toISOString().slice(0, 10)}.sqlite`,
      filters: [{ name: '抖音爆款雷达数据库', extensions: ['sqlite'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return store.createBackup(result.filePath, 'manual');
  }));
  ipcMain.handle('data:restore', async () => guarded(async () => {
    if (activeTasks.size) throw new Error('请先取消正在运行的任务，再恢复备份');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择抖音爆款雷达备份',
      properties: ['openFile'],
      filters: [{ name: '抖音爆款雷达数据库', extensions: ['sqlite', 'db'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return store.restoreBackup(result.filePaths[0]);
  }));
  ipcMain.handle('export:csv', async (_event, rows, suggestedName) => guarded(async () => {
    if (!Array.isArray(rows) || !rows.length) throw new Error('没有可导出的数据');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出数据',
      defaultPath: `${suggestedName || '抖音数据'}.csv`,
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const columns = [
      ['id', '视频ID'], ['title', '标题'], ['nickname', '作者'], ['fans', '粉丝数'], ['play', '播放量'],
      ['like', '点赞量'], ['likeRate', '点赞率'], ['collect', '收藏量'], ['collectRate', '收藏率'],
      ['share', '分享量'], ['shareRate', '分享率'], ['comment', '评论量'], ['commentRate', '评论率'],
      ['createdAt', '发布时间'], ['shareUrl', '视频链接'], ['transcript', '识别文案']
    ];
    const csv = '\uFEFF' + [columns.map(([, label]) => csvCell(label)).join(','), ...rows.map((row) => columns.map(([key]) => csvCell(row[key])).join(','))].join('\r\n');
    fs.writeFileSync(result.filePath, csv, 'utf8');
    return { path: result.filePath };
  }));
}

async function resumePendingAsrTasks() {
  if (store.state.settings.demoMode || !store.getSecret('dashscope')) return;
  for (const task of store.pendingAsrTasks()) {
    try {
      await runTask('asr', task.awemeId, (signal) => new ApiClient(store, sendProgress, { signal }).transcribe(task.awemeId));
    } catch (error) {
      console.error(`[safe-error] ASR resume: ${redactText(error?.message || 'unknown', store.secretValues())}`);
    }
  }
}

app.whenReady().then(() => {
  try {
    store = new JsonStore(app.getPath('userData'));
    registerHandlers();
    createWindow();
    setTimeout(() => { void resumePendingAsrTasks(); }, 1500);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  } catch (error) {
    dialog.showErrorBox('抖音爆款雷达无法启动', redactText(error?.message || '本地数据初始化失败'));
    app.quit();
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const controller of activeTasks.values()) controller.abort(); store?.close?.(); });
