const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiClient } = require('../src/lib/api');

function memoryStore() {
  const store = {
    state: { settings: { demoMode: true, autoStats: false, deepseekBaseUrl: 'https://api.deepseek.com', rewriteSystemPrompt: '请改写文案' }, videos: [], authors: [], topics: [], collection: null },
    getSecret() { return 'test-secret'; },
    save() {},
    upsertVideos(items) {
      const map = new Map(this.state.videos.map((item) => [String(item.id), item]));
      items.forEach((item) => map.set(String(item.id), { ...(map.get(String(item.id)) || {}), ...item }));
      this.state.videos = [...map.values()];
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
    }
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
