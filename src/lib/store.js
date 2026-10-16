const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');
const { isTrustedEndpoint, TRUSTED_ENDPOINTS, validateEndpoint } = require('./security');

const SCHEMA_VERSION = 1;
const PRESERVE_WHEN_BLANK = new Set(['title', 'nickname', 'createdAt', 'shareUrl', 'authorKey', 'authorUrl']);

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function json(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }

function computeRates(video) {
  const play = Number(video.play || 0);
  return {
    ...video,
    likeRate: play ? Number(video.like || 0) / play : null,
    collectRate: play ? Number(video.collect || 0) / play : null,
    shareRate: play ? Number(video.share || 0) / play : null,
    commentRate: play ? Number(video.comment || 0) / play : null
  };
}

function mergeVideoPatch(previous, patch) {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (PRESERVE_WHEN_BLANK.has(key) && value === '' && previous?.[key]) continue;
    merged[key] = value;
  }
  merged.id = String(patch?.id || previous?.id || '');
  merged.updatedAt = new Date().toISOString();
  return computeRates(merged);
}

function loadSqlite() {
  try { return require('node:sqlite').DatabaseSync; }
  catch { throw new Error('当前运行环境不支持 SQLite，请使用应用内置运行环境启动'); }
}

class SqliteStore {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.file = path.join(userDataPath, 'radar-data.sqlite');
    this.legacyFile = path.join(userDataPath, 'radar-data.json');
    this.backupDir = path.join(userDataPath, 'backups');
    this.DatabaseSync = loadSqlite();
    fs.mkdirSync(userDataPath, { recursive: true });
    this.initialize();
    this.state = this.loadState();
    if (!options.skipAutoBackup) this.ensureDailyBackup();
  }

  defaults() {
    return {
      settings: {
        ...TRUSTED_ENDPOINTS,
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
        region: 'CN',
        customEndpointConsent: false
      },
      secrets: {}, videos: [], authors: [], topics: [], searches: [], collection: null,
      collectionTasks: {}, asrTasks: {}, tasks: []
    };
  }

  normalizeState(value = {}) {
    const defaults = this.defaults();
    const state = { ...defaults, ...value, settings: { ...defaults.settings, ...(value.settings || {}) }, secrets: { ...(value.secrets || {}) } };
    for (const key of ['videos', 'authors', 'topics', 'searches', 'tasks']) state[key] = Array.isArray(state[key]) ? state[key] : [];
    state.collectionTasks = state.collectionTasks && typeof state.collectionTasks === 'object' ? state.collectionTasks : {};
    state.asrTasks = state.asrTasks && typeof state.asrTasks === 'object' ? state.asrTasks : {};
    if (state.collection) {
      const key = String(state.collection.secUserId || state.collection.url || '');
      if (key && !state.collectionTasks[key]) state.collectionTasks[key] = state.collection;
    }
    return state;
  }

  initialize() {
    if (fs.existsSync(this.file)) { this.open(); this.migrateSchema(); return; }
    const staging = `${this.file}.migrating`;
    if (fs.existsSync(staging)) fs.renameSync(staging, `${staging}.failed-${timestamp()}`);
    let legacy = null;
    if (fs.existsSync(this.legacyFile)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      fs.copyFileSync(this.legacyFile, path.join(this.backupDir, `legacy-radar-data-${timestamp()}.json`));
      try {
        legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) throw new Error('根数据不是对象');
      } catch (error) {
        throw new Error(`旧版数据文件无法读取，已保留备份且没有修改原文件：${error.message}`);
      }
    }
    let stagingDb;
    try {
      stagingDb = new this.DatabaseSync(staging);
      this.createSchema(stagingDb);
      this.writeState(this.normalizeState(legacy || {}), stagingDb);
      this.setMeta('schema_version', String(SCHEMA_VERSION), stagingDb);
      if (legacy) this.setMeta('legacy_migrated_at', new Date().toISOString(), stagingDb);
      const integrity = stagingDb.prepare('PRAGMA integrity_check').get();
      if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('数据库完整性校验未通过');
      stagingDb.close();
      stagingDb = null;
      fs.renameSync(staging, this.file);
    } catch (error) {
      try { stagingDb?.close(); } catch {}
      if (fs.existsSync(staging)) fs.renameSync(staging, `${staging}.failed-${timestamp()}`);
      throw new Error(`初始化本地数据库失败，旧数据没有被修改：${error.message}`);
    }
    this.open();
  }

  open() {
    this.db = new this.DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }

  createSchema(db = this.db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS authors (author_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_tasks (author_key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asr_tasks (aweme_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
  }

  migrateSchema() {
    this.createSchema();
    const current = Number(this.getMeta('schema_version') || 0);
    if (current > SCHEMA_VERSION) throw new Error('本地数据由更高版本的软件创建，请升级客户端后再打开');
    if (current < SCHEMA_VERSION) {
      this.createBackup(null, 'pre-migration');
      this.transaction(() => this.setMeta('schema_version', String(SCHEMA_VERSION)));
    }
  }

  transaction(action, db = this.db) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  getMeta(key, db = this.db) { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value; }
  setMeta(key, value, db = this.db) { db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

  loadState() {
    const defaults = this.defaults();
    const settings = { ...defaults.settings };
    for (const row of this.db.prepare('SELECT key, value FROM settings').all()) settings[row.key] = json(row.value, row.value);
    const secrets = {};
    for (const row of this.db.prepare('SELECT name, value FROM secrets').all()) secrets[row.name] = row.value;
    const readData = (table) => this.db.prepare(`SELECT data FROM ${table}`).all().map((row) => json(row.data, {}));
    const collectionTasks = Object.fromEntries(readData('collection_tasks').map((item) => [String(item.secUserId || item.url || ''), item]).filter(([key]) => key));
    const asrTasks = Object.fromEntries(readData('asr_tasks').map((item) => [String(item.awemeId || ''), item]).filter(([key]) => key));
    return this.normalizeState({
      settings, secrets, videos: readData('videos'), authors: readData('authors'), topics: readData('topics'),
      searches: json(this.getMeta('searches'), []), collection: json(this.getMeta('last_collection'), null),
      collectionTasks, asrTasks, tasks: readData('tasks')
    });
  }

  writeState(state, db = this.db) {
    const now = new Date().toISOString();
    const execute = () => {
      for (const table of ['settings', 'secrets', 'videos', 'authors', 'topics', 'collection_tasks', 'asr_tasks', 'tasks']) db.exec(`DELETE FROM ${table}`);
      const setting = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?)');
      for (const [key, value] of Object.entries(state.settings || {})) setting.run(key, JSON.stringify(value));
      const secret = db.prepare('INSERT INTO secrets(name, value) VALUES(?, ?)');
      for (const [name, value] of Object.entries(state.secrets || {})) if (value) secret.run(name, String(value));
      const insertData = (table, keyName, key, value) => db.prepare(`INSERT INTO ${table}(${keyName}, data, updated_at) VALUES(?, ?, ?)`).run(String(key), JSON.stringify(value), now);
      for (const item of state.videos || []) if (item.id) insertData('videos', 'id', item.id, item);
      for (const item of state.authors || []) { const key = item.secUserId || item.url; if (key) insertData('authors', 'author_key', key, item); }
      for (const item of state.topics || []) if (item.id) insertData('topics', 'id', item.id, item);
      for (const [key, item] of Object.entries(state.collectionTasks || {})) if (key) insertData('collection_tasks', 'author_key', key, item);
      for (const [key, item] of Object.entries(state.asrTasks || {})) if (key) insertData('asr_tasks', 'aweme_id', key, item);
      const insertTask = db.prepare('INSERT INTO tasks(id, type, status, data, updated_at) VALUES(?, ?, ?, ?, ?)');
      for (const item of state.tasks || []) if (item.id) insertTask.run(item.id, item.type || 'unknown', item.status || 'unknown', JSON.stringify(item), now);
      this.setMeta('searches', JSON.stringify(state.searches || []), db);
      this.setMeta('last_collection', JSON.stringify(state.collection || null), db);
    };
    if (db === this.db) return this.transaction(execute, db);
    db.exec('BEGIN IMMEDIATE');
    try { execute(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  save() { this.writeState(this.state); }

  encrypt(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 环境无法安全保存密钥');
    return safeStorage.encryptString(value).toString('base64');
  }
  decrypt(value) { if (!value) return ''; try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; } }

  getSecret(name) {
    const envNames = { tikhub: ['TIKHUB_API_KEY', 'tikhub_api_key'], dashscope: ['DASHSCOPE_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'] };
    const environmentSecret = (envNames[name] || []).map((envName) => process.env[envName]).find((value) => typeof value === 'string' && value.trim());
    return this.decrypt(this.state.secrets[name]) || environmentSecret || '';
  }
  secretValues() { return ['tikhub', 'dashscope', 'deepseek'].map((name) => this.getSecret(name)).filter(Boolean); }

  publicSettings() {
    const settings = { ...this.state.settings };
    settings.hasTikhubKey = Boolean(this.getSecret('tikhub'));
    settings.hasDashscopeKey = Boolean(this.getSecret('dashscope'));
    settings.hasDeepseekKey = Boolean(this.getSecret('deepseek'));
    settings.usesCustomEndpoints = ['tikhubBaseUrl', 'dashscopeBaseUrl', 'deepseekBaseUrl'].some((name) => !isTrustedEndpoint(name, settings[name]));
    settings.databaseVersion = SCHEMA_VERSION;
    settings.lastBackupAt = this.getMeta('last_backup_at') || '';
    return settings;
  }

  updateSettings(input) {
    const consent = Boolean(input.customEndpointConsent ?? this.state.settings.customEndpointConsent);
    for (const key of Object.keys(TRUSTED_ENDPOINTS)) if (Object.hasOwn(input, key)) input[key] = validateEndpoint(key, input[key], consent);
    const allowed = ['tikhubBaseUrl', 'dashscopeBaseUrl', 'deepseekBaseUrl', 'rewriteSystemPrompt', 'retryCount', 'retryDelayMs', 'autoStats', 'demoMode', 'region', 'customEndpointConsent'];
    for (const key of allowed) if (Object.hasOwn(input, key)) this.state.settings[key] = input[key];
    if (input.tikhubKey) this.state.secrets.tikhub = this.encrypt(input.tikhubKey.trim());
    if (input.dashscopeKey) this.state.secrets.dashscope = this.encrypt(input.dashscopeKey.trim());
    if (input.deepseekKey) this.state.secrets.deepseek = this.encrypt(input.deepseekKey.trim());
    this.save();
    return this.publicSettings();
  }

  clearSecret(name) {
    if (!['tikhub', 'dashscope', 'deepseek'].includes(name)) throw new Error('未知密钥类型');
    delete this.state.secrets[name];
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    return this.publicSettings();
  }

  upsertVideos(items) {
    const map = new Map(this.state.videos.map((item) => [String(item.id), item]));
    const changed = [];
    for (const item of items || []) {
      if (!item?.id) continue;
      const value = mergeVideoPatch(map.get(String(item.id)) || {}, item);
      map.set(String(item.id), value);
      changed.push(value);
    }
    this.state.videos = [...map.values()];
    if (changed.length) this.transaction(() => {
      const statement = this.db.prepare('INSERT INTO videos(id, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at');
      for (const item of changed) statement.run(item.id, JSON.stringify(item), item.updatedAt);
    });
    return changed;
  }

  upsertAuthor(author) {
    const key = String(author.secUserId || author.url || '');
    if (!key) return null;
    const index = this.state.authors.findIndex((item) => String(item.secUserId || item.url) === key);
    const value = { ...(index >= 0 ? this.state.authors[index] : {}), ...author, updatedAt: new Date().toISOString() };
    if (index >= 0) this.state.authors[index] = value; else this.state.authors.push(value);
    this.db.prepare('INSERT INTO authors(author_key, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(author_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(key, JSON.stringify(value), value.updatedAt);
    return value;
  }

  addTopic(video) {
    const id = String(video?.id || '');
    if (!id) throw new Error('缺少视频 ID，无法加入选题库');
    const old = this.state.topics.find((item) => String(item.id) === id) || {};
    const topic = { ...old, ...video, id, topicAddedAt: old.topicAddedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.state.topics = [topic, ...this.state.topics.filter((item) => String(item.id) !== id)];
    this.db.prepare('INSERT INTO topics(id, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(id, JSON.stringify(topic), topic.updatedAt);
    return topic;
  }

  removeTopic(id) {
    this.state.topics = this.state.topics.filter((item) => String(item.id) !== String(id));
    this.db.prepare('DELETE FROM topics WHERE id = ?').run(String(id));
    return true;
  }

  saveRewrite(id, rewrite) {
    const index = this.state.topics.findIndex((item) => String(item.id) === String(id));
    if (index < 0) throw new Error('选题不存在或已被移出');
    const old = this.state.topics[index];
    const rewrites = Array.isArray(old.rewrites) ? old.rewrites : [];
    const topic = { ...old, rewrites: [rewrite, ...rewrites].slice(0, 20), latestRewrite: rewrite.text, rewriteUpdatedAt: rewrite.createdAt, updatedAt: new Date().toISOString() };
    this.state.topics[index] = topic;
    this.db.prepare('UPDATE topics SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(topic), topic.updatedAt, String(id));
    return topic;
  }

  setSearches(items) { this.state.searches = Array.isArray(items) ? items : []; this.setMeta('searches', JSON.stringify(this.state.searches)); }
  getCollection(authorKey) { return this.state.collectionTasks[String(authorKey || '')] || null; }

  saveCollection(value) {
    const key = String(value.secUserId || value.url || '');
    if (!key) throw new Error('采集任务缺少作者标识');
    const record = { ...(this.state.collectionTasks[key] || {}), ...value, updatedAt: new Date().toISOString() };
    this.state.collectionTasks[key] = record;
    this.state.collection = record;
    this.transaction(() => {
      this.db.prepare('INSERT INTO collection_tasks(author_key, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(author_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(key, JSON.stringify(record), record.updatedAt);
      this.setMeta('last_collection', JSON.stringify(record));
    });
    return record;
  }

  getAsrTask(awemeId) { return this.state.asrTasks[String(awemeId)] || null; }
  saveAsrTask(value) {
    const key = String(value.awemeId || '');
    if (!key) throw new Error('ASR 任务缺少视频 ID');
    const record = { ...(this.state.asrTasks[key] || {}), ...value, awemeId: key, updatedAt: new Date().toISOString() };
    this.state.asrTasks[key] = record;
    this.db.prepare('INSERT INTO asr_tasks(aweme_id, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(aweme_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(key, JSON.stringify(record), record.updatedAt);
    return record;
  }
  pendingAsrTasks() { return Object.values(this.state.asrTasks).filter((item) => item.taskId && ['SUBMITTED', 'PENDING', 'RUNNING', 'PAUSED'].includes(item.status)); }

  upsertTask(value) {
    const old = this.state.tasks.find((item) => item.id === value.id) || {};
    const task = { ...old, ...value, updatedAt: new Date().toISOString() };
    this.state.tasks = [task, ...this.state.tasks.filter((item) => item.id !== task.id)].slice(0, 100);
    this.db.prepare('INSERT INTO tasks(id, type, status, data, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status, data = excluded.data, updated_at = excluded.updated_at').run(task.id, task.type || 'unknown', task.status || 'unknown', JSON.stringify(task), task.updatedAt);
    return task;
  }

  clearCollectedData() {
    this.state.videos = []; this.state.searches = []; this.state.collection = null; this.state.collectionTasks = {};
    this.transaction(() => { this.db.exec('DELETE FROM videos; DELETE FROM collection_tasks;'); this.setMeta('searches', '[]'); this.setMeta('last_collection', 'null'); });
  }

  validateBackup(file) {
    const db = new this.DatabaseSync(file, { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('数据库完整性校验失败');
      const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
      if (!version || version > SCHEMA_VERSION) throw new Error('备份版本不受当前客户端支持');
      return true;
    } finally { db.close(); }
  }

  createBackup(targetPath = null, kind = 'manual') {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const file = targetPath || path.join(this.backupDir, `${kind}-${timestamp()}.sqlite`);
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(this.file, file);
    this.validateBackup(file);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(`${file}${suffix}`)) fs.unlinkSync(`${file}${suffix}`);
    const now = new Date().toISOString();
    this.setMeta('last_backup_at', now);
    if (kind === 'auto') this.pruneAutoBackups();
    return { path: file, createdAt: now };
  }

  ensureDailyBackup() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.getMeta('last_auto_backup_date') === today) { this.pruneAutoBackups(); return; }
    this.createBackup(path.join(this.backupDir, `auto-${today}.sqlite`), 'auto');
    this.setMeta('last_auto_backup_date', today);
  }

  pruneAutoBackups() {
    const allFiles = fs.readdirSync(this.backupDir);
    for (const name of allFiles.filter((item) => /^auto-\d{4}-\d{2}-\d{2}\.sqlite-(?:wal|shm)$/.test(item))) fs.unlinkSync(path.join(this.backupDir, name));
    const files = allFiles.filter((name) => /^auto-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().reverse();
    for (const name of files.slice(7)) fs.unlinkSync(path.join(this.backupDir, name));
  }

  restoreBackup(source) {
    const staging = `${this.file}.restore-staging`;
    fs.copyFileSync(source, staging);
    this.validateBackup(staging);
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(`${staging}${suffix}`)) fs.unlinkSync(`${staging}${suffix}`);
    const before = this.createBackup(null, 'pre-restore');
    this.db.close(); this.db = null;
    try {
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(`${this.file}${suffix}`)) fs.unlinkSync(`${this.file}${suffix}`);
      fs.copyFileSync(staging, this.file); fs.unlinkSync(staging);
      this.open(); this.migrateSchema(); this.state = this.loadState();
      return { restoredFrom: source, safetyBackup: before.path };
    } catch (error) {
      try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch {}
      try {
        if (this.db) this.db.close();
        this.db = null;
        fs.copyFileSync(before.path, this.file);
        this.open();
        this.state = this.loadState();
      } catch {}
      throw new Error(`恢复备份失败，已尝试还原恢复前的数据：${error.message}`);
    }
  }

  close() { try { this.db?.close(); } catch {} }
}

module.exports = { JsonStore: SqliteStore, SqliteStore, mergeVideoPatch, SCHEMA_VERSION };
