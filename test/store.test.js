const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, mergeVideoPatch } = require('../src/lib/store');
const { redactText } = require('../src/lib/security');

test('选题库可加入、更新并移出，且不受视频列表清空影响', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-test-'));
  let store;
  let reopened;
  try {
    store = new JsonStore(directory, { skipAutoBackup: true });
    store.addTopic({ id: '1', title: '测试选题', play: 100 });
    store.addTopic({ id: '1', transcript: '识别文案' });
    store.saveRewrite('1', { id: 'rewrite-1', text: '改写结果', model: 'deepseek-v4-pro', createdAt: new Date().toISOString() });
    store.state.videos = [];
    store.save();
    store.close();
    store = null;
    reopened = new JsonStore(directory, { skipAutoBackup: true });
    assert.equal(reopened.state.topics.length, 1);
    assert.equal(reopened.state.topics[0].title, '测试选题');
    assert.equal(reopened.state.topics[0].transcript, '识别文案');
    assert.equal(reopened.state.topics[0].latestRewrite, '改写结果');
    assert.equal(reopened.state.topics[0].rewrites.length, 1);
    reopened.removeTopic('1');
    assert.equal(reopened.state.topics.length, 0);
  } finally {
    store?.close();
    reopened?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧版设置升级后自动补上 DeepSeek 地址和默认提示词', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-migrate-'));
  let store;
  try {
    fs.writeFileSync(path.join(directory, 'radar-data.json'), JSON.stringify({ settings: { demoMode: false }, videos: [] }), 'utf8');
    store = new JsonStore(directory, { skipAutoBackup: true });
    assert.equal(store.state.settings.demoMode, false);
    assert.equal(store.state.settings.deepseekBaseUrl, 'https://api.deepseek.com');
    assert.match(store.state.settings.rewriteSystemPrompt, /短视频爆款文案改写专家/);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('读取规范的大写 TikHub 环境变量并兼容旧变量', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-env-'));
  const previousUpper = process.env.TIKHUB_API_KEY;
  const previousLower = process.env.tikhub_api_key;
  let store;
  try {
    delete process.env.TIKHUB_API_KEY;
    delete process.env.tikhub_api_key;
    process.env.TIKHUB_API_KEY = 'uppercase-test-key';
    store = new JsonStore(directory, { skipAutoBackup: true });
    assert.equal(store.getSecret('tikhub'), 'uppercase-test-key');
    delete process.env.TIKHUB_API_KEY;
    process.env.tikhub_api_key = 'legacy-test-key';
    assert.equal(store.getSecret('tikhub'), 'legacy-test-key');
  } finally {
    store?.close();
    if (previousUpper === undefined) delete process.env.TIKHUB_API_KEY;
    else process.env.TIKHUB_API_KEY = previousUpper;
    if (previousLower === undefined) delete process.env.tikhub_api_key;
    else process.env.tikhub_api_key = previousLower;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('统计数据局部更新不会清空已有标题、作者和发布时间', () => {
  const merged = mergeVideoPatch({
    id: 'video-1', title: '原视频标题', nickname: '原作者', createdAt: '2026-01-01T00:00:00.000Z', play: 100, like: 10
  }, { id: 'video-1', source: 'stats', title: '', nickname: '', createdAt: '', play: 200, like: 30 });
  assert.equal(merged.title, '原视频标题');
  assert.equal(merged.nickname, '原作者');
  assert.equal(merged.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(merged.play, 200);
  assert.equal(merged.likeRate, 0.15);
});

test('旧 JSON 数据完整迁移到 SQLite，且原文件和迁移备份均保留', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-full-migrate-'));
  let store;
  try {
    const legacy = {
      settings: { demoMode: false }, secrets: { tikhub: 'encrypted-value' },
      videos: [{ id: 'v1', title: '作品' }], authors: [{ secUserId: 'a1', nickname: '作者' }],
      topics: [{ id: 'v1', transcript: '原文', rewrites: [{ id: 'r1', text: '改写' }] }],
      searches: [{ id: 's1' }], collection: { secUserId: 'a1', cursor: 9, complete: false }
    };
    fs.writeFileSync(path.join(directory, 'radar-data.json'), JSON.stringify(legacy), 'utf8');
    store = new JsonStore(directory, { skipAutoBackup: true });
    assert.equal(store.state.videos.length, 1);
    assert.equal(store.state.authors.length, 1);
    assert.equal(store.state.topics[0].rewrites.length, 1);
    assert.equal(store.state.searches.length, 1);
    assert.equal(store.getCollection('a1').cursor, 9);
    assert.equal(store.state.secrets.tikhub, 'encrypted-value');
    assert.equal(fs.existsSync(path.join(directory, 'radar-data.json')), true);
    assert.equal(fs.readdirSync(path.join(directory, 'backups')).some((name) => name.startsWith('legacy-radar-data-')), true);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('数据库备份和恢复可往返，恢复前自动留下安全备份', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-backup-'));
  let store;
  try {
    store = new JsonStore(directory, { skipAutoBackup: true });
    store.upsertVideos([{ id: 'before', title: '备份前' }]);
    const backupFile = path.join(directory, 'manual.sqlite');
    store.createBackup(backupFile);
    assert.equal(fs.existsSync(`${backupFile}-wal`), false);
    assert.equal(fs.existsSync(`${backupFile}-shm`), false);
    store.upsertVideos([{ id: 'after', title: '备份后' }]);
    const result = store.restoreBackup(backupFile);
    assert.deepEqual(store.state.videos.map((item) => item.id), ['before']);
    assert.equal(fs.existsSync(result.safetyBackup), true);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('损坏的旧 JSON 不会被静默替换成空数据', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-corrupt-'));
  try {
    fs.writeFileSync(path.join(directory, 'radar-data.json'), '{bad json', 'utf8');
    assert.throws(() => new JsonStore(directory, { skipAutoBackup: true }), /旧版数据文件无法读取/);
    assert.equal(fs.readFileSync(path.join(directory, 'radar-data.json'), 'utf8'), '{bad json');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('自定义接口地址必须明确确认风险，且日志会隐藏密钥和链接参数', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-endpoint-'));
  let store;
  try {
    store = new JsonStore(directory, { skipAutoBackup: true });
    assert.throws(() => store.updateSettings({ tikhubBaseUrl: 'https://proxy.example.com' }), /勾选风险确认/);
    const settings = store.updateSettings({ tikhubBaseUrl: 'https://proxy.example.com', customEndpointConsent: true });
    assert.equal(settings.usesCustomEndpoints, true);
    const redacted = redactText('Bearer secret-value https://cdn.example/video.mp4?token=abc&x=1', ['secret-value']);
    assert.doesNotMatch(redacted, /secret-value|token=abc/);
    assert.match(redacted, /已隐藏|参数已隐藏/);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
