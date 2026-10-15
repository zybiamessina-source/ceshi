const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../src/lib/store');

test('选题库可加入、更新并移出，且不受视频列表清空影响', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-test-'));
  try {
    const store = new JsonStore(directory);
    store.addTopic({ id: '1', title: '测试选题', play: 100 });
    store.addTopic({ id: '1', transcript: '识别文案' });
    store.saveRewrite('1', { id: 'rewrite-1', text: '改写结果', model: 'deepseek-v4-pro', createdAt: new Date().toISOString() });
    store.state.videos = [];
    store.save();
    const reopened = new JsonStore(directory);
    assert.equal(reopened.state.topics.length, 1);
    assert.equal(reopened.state.topics[0].title, '测试选题');
    assert.equal(reopened.state.topics[0].transcript, '识别文案');
    assert.equal(reopened.state.topics[0].latestRewrite, '改写结果');
    assert.equal(reopened.state.topics[0].rewrites.length, 1);
    reopened.removeTopic('1');
    assert.equal(reopened.state.topics.length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('旧版设置升级后自动补上 DeepSeek 地址和默认提示词', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-migrate-'));
  try {
    fs.writeFileSync(path.join(directory, 'radar-data.json'), JSON.stringify({ settings: { demoMode: false }, videos: [] }), 'utf8');
    const store = new JsonStore(directory);
    assert.equal(store.state.settings.demoMode, false);
    assert.equal(store.state.settings.deepseekBaseUrl, 'https://api.deepseek.com');
    assert.match(store.state.settings.rewriteSystemPrompt, /短视频爆款文案改写专家/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('读取规范的大写 TikHub 环境变量并兼容旧变量', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-radar-env-'));
  const previousUpper = process.env.TIKHUB_API_KEY;
  const previousLower = process.env.tikhub_api_key;
  try {
    delete process.env.TIKHUB_API_KEY;
    delete process.env.tikhub_api_key;
    process.env.TIKHUB_API_KEY = 'uppercase-test-key';
    const store = new JsonStore(directory);
    assert.equal(store.getSecret('tikhub'), 'uppercase-test-key');
    delete process.env.TIKHUB_API_KEY;
    process.env.tikhub_api_key = 'legacy-test-key';
    assert.equal(store.getSecret('tikhub'), 'legacy-test-key');
  } finally {
    if (previousUpper === undefined) delete process.env.TIKHUB_API_KEY;
    else process.env.TIKHUB_API_KEY = previousUpper;
    if (previousLower === undefined) delete process.env.tikhub_api_key;
    else process.env.tikhub_api_key = previousLower;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
