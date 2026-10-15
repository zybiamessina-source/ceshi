const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

class JsonStore {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'radar-data.json');
    this.state = this.read();
  }

  defaults() {
    return {
      settings: {
        tikhubBaseUrl: 'https://api.tikhub.dev',
        dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        deepseekBaseUrl: 'https://api.deepseek.com',
        rewriteSystemPrompt: `你是一名专业的短视频爆款文案改写专家。请根据用户提供的原始视频文案，创作一篇可直接用于短视频口播的新文案。

改写要求：
1. 保留原文的核心主题、事实信息和主要观点，不捏造数据、经历或无法确认的事实。
2. 不照抄原句，不做简单同义词替换；重新设计表达顺序、句式和节奏，确保与原文明显不同。
3. 开头用一句有冲击力的钩子迅速吸引注意，但不要使用虚假、夸张或无法兑现的承诺。
4. 正文口语化、画面感强、逻辑清楚，使用短句，适合自然口播。
5. 适当加入悬念、反差、具体场景或情绪推动，提高完播率和互动意愿。
6. 结尾自然收束，并给出一句不生硬的互动引导。
7. 文案长度尽量接近原文；原文很短时可以合理扩写，但不要堆砌空话。
8. 只输出最终改写文案，不要解释改写思路，不要添加“改写结果”等标题。`,
        retryCount: 30,
        retryDelayMs: 1000,
        autoStats: false,
        demoMode: true,
        region: 'CN'
      },
      secrets: {},
      videos: [],
      authors: [],
      topics: [],
      searches: [],
      collection: null
    };
  }

  read() {
    try {
      const defaults = this.defaults();
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const data = { ...defaults, ...parsed, settings: { ...defaults.settings, ...(parsed.settings || {}) }, secrets: { ...defaults.secrets, ...(parsed.secrets || {}) } };
      data.videos = Array.isArray(data.videos) ? data.videos : [];
      data.authors = Array.isArray(data.authors) ? data.authors : [];
      data.topics = Array.isArray(data.topics) ? data.topics : [];
      return data;
    } catch {
      return this.defaults();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }

  encrypt(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法安全保存密钥');
    return safeStorage.encryptString(value).toString('base64');
  }

  decrypt(value) {
    if (!value) return '';
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
  }

  getSecret(name) {
    const envNames = {
      tikhub: ['TIKHUB_API_KEY', 'tikhub_api_key'],
      dashscope: ['DASHSCOPE_API_KEY'],
      deepseek: ['DEEPSEEK_API_KEY']
    };
    const environmentSecret = (envNames[name] || [])
      .map((envName) => process.env[envName])
      .find((value) => typeof value === 'string' && value.trim());
    return this.decrypt(this.state.secrets[name]) || environmentSecret || '';
  }

  publicSettings() {
    return {
      ...this.state.settings,
      hasTikhubKey: Boolean(this.getSecret('tikhub')),
      hasDashscopeKey: Boolean(this.getSecret('dashscope')),
      hasDeepseekKey: Boolean(this.getSecret('deepseek'))
    };
  }

  updateSettings(input) {
    const allowed = ['tikhubBaseUrl', 'dashscopeBaseUrl', 'deepseekBaseUrl', 'rewriteSystemPrompt', 'retryCount', 'retryDelayMs', 'autoStats', 'demoMode', 'region'];
    for (const key of allowed) if (Object.hasOwn(input, key)) this.state.settings[key] = input[key];
    if (input.tikhubKey) this.state.secrets.tikhub = this.encrypt(input.tikhubKey.trim());
    if (input.dashscopeKey) this.state.secrets.dashscope = this.encrypt(input.dashscopeKey.trim());
    if (input.deepseekKey) this.state.secrets.deepseek = this.encrypt(input.deepseekKey.trim());
    this.save();
    return this.publicSettings();
  }

  upsertVideos(items) {
    const map = new Map(this.state.videos.map((item) => [String(item.id), item]));
    for (const item of items) {
      if (!item.id) continue;
      const old = map.get(String(item.id)) || {};
      map.set(String(item.id), { ...old, ...item, id: String(item.id), updatedAt: new Date().toISOString() });
    }
    this.state.videos = [...map.values()];
    this.save();
    return this.state.videos;
  }

  upsertAuthor(author) {
    const key = String(author.secUserId || author.url || '');
    if (!key) return;
    const index = this.state.authors.findIndex((item) => String(item.secUserId || item.url) === key);
    const old = index >= 0 ? this.state.authors[index] : {};
    const value = { ...old, ...author, updatedAt: new Date().toISOString() };
    if (index >= 0) this.state.authors[index] = value;
    else this.state.authors.push(value);
    this.save();
  }

  addTopic(video) {
    const id = String(video?.id || '');
    if (!id) throw new Error('缺少视频 ID，无法加入选题库');
    const old = this.state.topics.find((item) => String(item.id) === id) || {};
    const topic = { ...old, ...video, id, topicAddedAt: old.topicAddedAt || new Date().toISOString() };
    this.state.topics = [topic, ...this.state.topics.filter((item) => String(item.id) !== id)];
    this.save();
    return topic;
  }

  removeTopic(id) {
    this.state.topics = this.state.topics.filter((item) => String(item.id) !== String(id));
    this.save();
    return true;
  }

  saveRewrite(id, rewrite) {
    const index = this.state.topics.findIndex((item) => String(item.id) === String(id));
    if (index < 0) throw new Error('选题不存在或已被移出');
    const old = this.state.topics[index];
    const rewrites = Array.isArray(old.rewrites) ? old.rewrites : [];
    this.state.topics[index] = { ...old, rewrites: [rewrite, ...rewrites].slice(0, 20), latestRewrite: rewrite.text, rewriteUpdatedAt: rewrite.createdAt };
    this.save();
    return this.state.topics[index];
  }
}

module.exports = { JsonStore };
