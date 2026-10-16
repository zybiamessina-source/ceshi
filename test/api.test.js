const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiClient, TaskCancelledError } = require('../src/lib/api');

function memoryStore() {
  const store = {
    state: { settings: { demoMode: true, autoStats: false, retryCount: 2, retryDelayMs: 1000, deepseekBaseUrl: 'https://api.deepseek.com', dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1', rewriteSystemPrompt: '请改写文案' }, videos: [], authors: [], topics: [], searches: [], collection: null, collectionTasks: {}, asrTasks: {} },
    getSecret() { return 'test-secret'; },
    save() {},
    upsertVideos(items) {
      const map = new Map(this.state.videos.map((item) => [String(item.id), item]));
      items.forEach((item) => map.set(String(item.id), { ...(map.get(String(item.id)) || {}), ...item }));
      this.state.videos = [...map.values()];
      return this.state.videos.filter((item) => items.some((changed) => String(changed.id) === String(item.id)));
    },
    upsertAuthor(author) {
      const index = this.state.authors.findIndex((item) => item.secUserId === author.secUserId);
      if (index >= 0) this.state.authors[index] = { ...this.state.authors[index], ...author };
      else this.state.authors.push(author);
    },
    addTopic(topic) {
      const index = this.state.topics.findIndex((item) => item.id === topic.id);
      if (index >= 0) this.state.topics[index] = { ...this.state.topics[index], ...topic };
      else this.state.topics.push(topic);
      return this.state.topics.find((item) => item.id === topic.id);
    },
    saveRewrite(id, rewrite) {
      const topic = this.state.topics.find((item) => item.id === id);
      topic.rewrites = [rewrite, ...(topic.rewrites || [])];
      topic.latestRewrite = rewrite.text;
      return topic;
    },
    saveCollection(value) {
      const key = value.secUserId || value.url;
      this.state.collectionTasks[key] = { ...(this.state.collectionTasks[key] || {}), ...value };
      this.state.collection = this.state.collectionTasks[key];
      return this.state.collection;
    },
    getCollection(key) { return this.state.collectionTasks[key] || null; },
    saveAsrTask(value) {
      this.state.asrTasks[value.awemeId] = { ...(this.state.asrTasks[value.awemeId] || {}), ...value };
      return this.state.asrTasks[value.awemeId];
    },
    getAsrTask(id) { return this.state.asrTasks[id] || null; },
    setSearches(items) { this.state.searches = items; }
  };
  return store;
}

test('指定页数采集只扫描所选页数并登记作者', async () => {
  const store = memoryStore();
  const result = await new ApiClient(store).collectAuthor('https://www.douyin.com/user/demo-author', { mode: 'pages', pages: 2 });
  assert.equal(result.scanned, 2);
  assert.equal(result.count, 12);
  assert.equal(store.state.videos.length, 12);
  assert.equal(store.state.authors[0].nickname, '演示作者');
});

test('最新一页模式仅保存历史中不存在的视频', async () => {
  const store = memoryStore();
  const client = new ApiClient(store);
  await client.collectAuthor('https://www.douyin.com/user/demo-author', { mode: 'pages', pages: 2 });
  const result = await client.collectAuthor('https://www.douyin.com/user/demo-author', { mode: 'latest', pages: 1 });
  assert.equal(result.scanned, 1);
  assert.equal(result.count, 0);
  assert.equal(store.state.videos.length, 12);
});

test('一键改写在缺少文案时会先自动识别并保存结果', async () => {
  const store = memoryStore();
  store.addTopic({ id: 'topic-1', title: '演示选题' });
  const result = await new ApiClient(store).rewriteTopic('topic-1');
  assert.match(result.transcript, /演示模式/);
  assert.equal(store.state.topics[0].rewrites.length, 1);
  assert.equal(store.state.topics[0].rewrites[0].model, 'deepseek-v4-pro');
});

test('真实改写按官方 Chat Completions 格式调用 deepseek-v4-pro', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  store.addTopic({ id: 'topic-2', transcript: '这是一段原始文案。' });
  const client = new ApiClient(store);
  let request;
  client.request = async (url, options) => {
    request = { url, body: JSON.parse(options.body), authorization: options.headers.Authorization };
    return { choices: [{ message: { content: '这是一段全新的改写文案。' } }], usage: { total_tokens: 42 } };
  };
  const result = await client.rewriteTopic('topic-2');
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.body.model, 'deepseek-v4-pro');
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.thinking.type, 'disabled');
  assert.equal(request.authorization, 'Bearer test-secret');
  assert.equal(result.rewrite.text, '这是一段全新的改写文案。');
});

test('401 密钥错误立即停止，不执行无效重试或备用接口', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  const client = new ApiClient(store);
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'invalid key' }) });
  try {
    await assert.rejects(() => client.withFallback([
      () => client.request('https://example.com/a', {}, '测试接口'),
      () => { calls += 100; }
    ], '测试'), /请求失败/);
    assert.equal(calls, 0);
  } finally { global.fetch = originalFetch; }
});

test('服务端临时错误按设置重试后成功', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  const client = new ApiClient(store);
  client.wait = async () => {};
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'temporary' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, data: { ok: true } }) };
  };
  try {
    const result = await client.request('https://example.com/a', {}, '测试接口');
    assert.equal(result.data.ok, true);
    assert.equal(calls, 2);
  } finally { global.fetch = originalFetch; }
});

test('全量采集按作者恢复各自保存的 Cursor', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  store.saveCollection({ secUserId: 'author-a', url: 'https://www.douyin.com/user/author-a', cursor: 77, page: 2, complete: false });
  store.saveCollection({ secUserId: 'author-b', url: 'https://www.douyin.com/user/author-b', cursor: 99, page: 8, complete: false });
  const client = new ApiClient(store);
  client.resolveAuthor = async () => 'author-a';
  let requestedCursor;
  client.authorPage = async (_id, cursor) => {
    requestedCursor = cursor;
    return { data: { aweme_list: [{ aweme_id: 'new-1', desc: '新作品' }], max_cursor: 88, has_more: 0 } };
  };
  const result = await client.collectAuthor('https://www.douyin.com/user/author-a', { mode: 'all' });
  assert.equal(requestedCursor, 77);
  assert.equal(result.resumed, true);
  assert.equal(store.getCollection('author-a').page, 3);
  assert.equal(store.getCollection('author-b').cursor, 99);
});

test('ASR 重启续查已有任务号，不重复获取直链或提交', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  store.saveAsrTask({ awemeId: 'video-asr', taskId: 'existing-task', status: 'PAUSED' });
  const client = new ApiClient(store);
  client.wait = async () => {};
  client.latestPlayUrl = async () => { throw new Error('不应重新获取直链'); };
  const calls = [];
  client.request = async (url) => {
    calls.push(url);
    return { output: { task_status: 'SUCCEEDED' }, result: { text: '恢复后取得的识别文案' } };
  };
  const result = await client.transcribe('video-asr');
  assert.equal(result.transcript, '恢复后取得的识别文案');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/tasks\/existing-task$/);
  assert.equal(store.getAsrTask('video-asr').status, 'SUCCEEDED');
});

test('取消信号会立即结束接口任务且不再重试', async () => {
  const store = memoryStore();
  store.state.settings.demoMode = false;
  const controller = new AbortController();
  controller.abort();
  const client = new ApiClient(store, () => {}, { signal: controller.signal });
  await assert.rejects(() => client.request('https://example.com', {}, '取消测试'), TaskCancelledError);
});
