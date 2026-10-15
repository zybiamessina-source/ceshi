const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { JsonStore } = require('./lib/store');
const { ApiClient } = require('./lib/api');

let mainWindow;
let store;
let stopRequested = false;

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('task:progress', payload);
}

function publicError(error) {
  return { ok: false, error: error?.message || '操作失败', details: error?.details || '' };
}

async function guarded(action) {
  try { return { ok: true, data: await action() }; }
  catch (error) {
    console.error(`[safe-error] ${error?.name || 'Error'}: ${error?.message || 'unknown'}`);
    return publicError(error);
  }
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
  ipcMain.handle('videos:list', () => guarded(() => ({ videos: store.state.videos, authors: store.state.authors, collection: store.state.collection })));
  ipcMain.handle('author:collect', (_event, request) => guarded(async () => {
    const input = typeof request === 'string' ? { url: request } : (request || {});
    const url = String(input.url || '').trim();
    if (!/^https?:\/\/(www\.)?douyin\.com\//i.test(String(url || ''))) throw new Error('请输入有效的抖音作者主页链接');
    stopRequested = false;
    return new ApiClient(store, sendProgress).collectAuthor(url, {
      mode: ['all', 'pages', 'latest'].includes(input.mode) ? input.mode : 'all',
      pages: Math.max(1, Math.min(999, Number(input.pages) || 1))
    }, () => stopRequested);
  }));
  ipcMain.handle('author:stop', () => { stopRequested = true; return { ok: true }; });
  ipcMain.handle('videos:stats', (_event, ids) => guarded(() => new ApiClient(store, sendProgress).refreshStats(Array.isArray(ids) ? ids : [])));
  ipcMain.handle('videos:transcribe', (_event, id) => guarded(() => new ApiClient(store, sendProgress).transcribe(String(id))));
  ipcMain.handle('lowfans:search', (_event, query) => guarded(() => new ApiClient(store, sendProgress).searchLowFans(query || {})));
  ipcMain.handle('topics:list', () => guarded(() => store.state.topics));
  ipcMain.handle('topics:add', (_event, video) => guarded(() => store.addTopic(video)));
  ipcMain.handle('topics:remove', (_event, id) => guarded(() => store.removeTopic(id)));
  ipcMain.handle('topics:rewrite', (_event, id) => guarded(() => new ApiClient(store, sendProgress).rewriteTopic(String(id))));
  ipcMain.handle('data:clear', () => guarded(() => {
    store.state.videos = [];
    store.state.searches = [];
    store.state.collection = null;
    store.save();
    return true;
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

app.whenReady().then(() => {
  store = new JsonStore(app.getPath('userData'));
  registerHandlers();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
