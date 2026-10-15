const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  ipcMain.handle('settings:get', () => ({ ok: true, data: { demoMode: true, retryCount: 30, retryDelayMs: 1000, tikhubBaseUrl: 'https://api.tikhub.dev', dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', deepseekBaseUrl: 'https://api.deepseek.com', rewriteSystemPrompt: '你是一名专业的短视频爆款文案改写专家。', region: 'CN' } }));
  ipcMain.handle('videos:list', () => ({ ok: true, data: { videos: [], authors: [], collection: null } }));
  ipcMain.handle('topics:list', () => ({ ok: true, data: [{ id: 'sample-1', title: '值得参考的 AI 创意视频选题', nickname: '示例作者', play: 368000, likeRate: 0.086, transcript: '很多人以为创意需要复杂的技术，其实真正打动人的，是熟悉事物里的新角度。', rewrites: [{ id: 'rewrite-1', text: '你有没有发现，越好的创意，往往看起来越简单？', model: 'deepseek-v4-pro', createdAt: new Date().toISOString() }], topicAddedAt: new Date().toISOString() }] }));
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'smoke.png'), image.toPNG());
  await window.webContents.executeJavaScript("document.querySelector('[data-page=topics]').click()");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const topicImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-topics.png'), topicImage.toPNG());
  await window.webContents.executeJavaScript("document.querySelector('.view-rewrites').click()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const rewriteImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-rewrite.png'), rewriteImage.toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#closeRewriteModal').click(); document.querySelector('[data-page=settings]').click()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const settingsImage = await window.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'smoke-settings.png'), settingsImage.toPNG());
  console.log('SMOKE_OK');
  app.quit();
});
