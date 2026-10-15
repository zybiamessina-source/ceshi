const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { parseSecUserId, parseVideoPage, parseStats, parsePlayUrl, parseLowFans, recalc, firstByKeys } = require('./parser');

class ApiError extends Error {
  constructor(message, details = '') {
    super(message);
    this.details = details;
  }
}

class ApiClient {
  constructor(store, progress = () => {}) {
    this.store = store;
    this.progress = progress;
  }

  settings() { return this.store.state.settings; }

  async request(url, options = {}, label = '接口') {
    const attempts = Math.max(1, Number(this.settings().retryCount) || 30);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
        const text = await response.text();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { throw new ApiError(`${label}返回了无法解析的数据`, `HTTP ${response.status}`); }
        if (!response.ok) {
          const rawResponseMessage = body.message_zh || body.message || body.detail || body.error?.message || '';
          const responseMessage = typeof rawResponseMessage === 'object' ? JSON.stringify(rawResponseMessage) : rawResponseMessage;
          throw new ApiError(`${label}请求失败`, `HTTP ${response.status}${responseMessage ? `：${responseMessage}` : ''}`);
        }
        const code = body.code ?? body.status_code;
        if (code && ![0, 200, '0', '200', 'ok', 'success'].includes(code)) {
          throw new ApiError(`${label}返回失败`, String(body.message || body.detail || code));
        }
        return body;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          this.progress({ type: 'retry', message: `${label}失败，1 秒后重试（${attempt}/${attempts}）` });
          await delay(Number(this.settings().retryDelayMs) || 1000);
        }
      }
    }
    throw new ApiError(`${label}连续重试 ${attempts} 次仍然失败`, lastError?.details || lastError?.message || '未知错误');
  }

  async tikhub(path, { method = 'GET', query, body, label } = {}) {
    const key = this.store.getSecret('tikhub');
    if (!key) throw new ApiError('尚未填写 TikHub 密钥');
    const base = this.settings().tikhubBaseUrl.replace(/\/$/, '');
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
    return this.request(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }, label || 'TikHub 接口');
  }

  async withFallback(endpoints, actionName) {
    let lastError;
    for (let index = 0; index < endpoints.length; index += 1) {
      try { return await endpoints[index](); }
      catch (error) {
        lastError = error;
        if (index < endpoints.length - 1) this.progress({ type: 'fallback', message: `${actionName}主接口不可用，正在切换备用接口` });
      }
    }
    throw lastError;
  }

  async resolveAuthor(url) {
    const direct = /\/user\/([^?/#]+)/.exec(url)?.[1];
    if (direct?.startsWith('MS4')) return direct;
    const payload = await this.tikhub('/api/v1/douyin/web/get_sec_user_id', { query: { url }, label: '解析作者主页' });
    const id = parseSecUserId(payload);
    if (!id) throw new ApiError('没有从作者主页解析出 sec_user_id', '需要在真实接口测试阶段校准字段');
    return id;
  }

  async authorPage(secUserId, cursor) {
    return this.withFallback([
      () => this.tikhub('/api/v1/douyin/app/v3/fetch_user_post_videos', {
        query: { sec_user_id: secUserId, max_cursor: cursor || 0, count: 20, sort_type: 0, channel: 'normal' }, label: 'APP V3 作者作品'
      }),
      () => this.tikhub('/api/v1/douyin/app/v3/fetch_user_post_videos', {
        query: { sec_user_id: secUserId, max_cursor: cursor || 0, count: 20, sort_type: 0, channel: 'lite' }, label: 'APP V3 极速版作者作品'
      }),
      () => this.tikhub('/api/v1/douyin/web/fetch_user_post_videos', {
        query: { sec_user_id: secUserId, max_cursor: cursor || '0', count: 20, filter_type: '0' }, label: 'Web 作者作品'
      })
    ], '作者作品采集');
  }

  async collectAuthor(url, options = {}, shouldStop = () => false) {
    const mode = options.mode || 'all';
    const pageLimit = mode === 'latest' ? 1 : (mode === 'pages' ? Math.max(1, Number(options.pages) || 1) : Infinity);
    if (this.settings().demoMode) return this.demoAuthor(url, { mode, pages: pageLimit });
    const secUserId = await this.resolveAuthor(url);
    const previous = this.store.state.collection;
    let cursor = mode === 'all' && previous?.url === url && !previous?.complete ? previous.cursor : 0;
    let page = 0;
    const seenCursors = new Set();
    const newVideos = [];
    const existingIds = new Set(this.store.state.videos.map((video) => String(video.id)));
    let nickname = this.store.state.authors.find((author) => author.secUserId === secUserId)?.nickname || '';
    while (!shouldStop() && page < pageLimit) {
      const payload = await this.authorPage(secUserId, cursor);
      const parsed = parseVideoPage(payload);
      page += 1;
      nickname = parsed.videos.find((video) => video.nickname)?.nickname || nickname;
      const enriched = parsed.videos.map((video) => ({ ...video, authorKey: secUserId, authorUrl: url }));
      const unseen = enriched.filter((video) => !existingIds.has(String(video.id)));
      unseen.forEach((video) => existingIds.add(String(video.id)));
      newVideos.push(...unseen);
      this.store.upsertVideos(mode === 'latest' ? unseen : enriched);
      const reachedLimit = page >= pageLimit;
      this.store.state.collection = { url, secUserId, nickname, cursor: parsed.cursor, page, mode, complete: !parsed.hasMore || reachedLimit, updatedAt: new Date().toISOString() };
      this.store.save();
      this.progress({ type: 'collection', page, count: this.store.state.videos.length, newCount: newVideos.length, message: `已完成第 ${page} 页，本页 ${parsed.videos.length} 条，新增 ${unseen.length} 条` });
      const cursorKey = String(parsed.cursor ?? '');
      if (reachedLimit || !parsed.hasMore || !cursorKey || seenCursors.has(cursorKey)) break;
      seenCursors.add(cursorKey);
      cursor = parsed.cursor;
    }
    if (nickname) {
      this.store.state.videos = this.store.state.videos.map((video) => !video.authorKey && video.nickname === nickname ? { ...video, authorKey: secUserId, authorUrl: url } : video);
    }
    this.store.upsertAuthor({ secUserId, nickname: nickname || '未知作者', url, videoCount: this.store.state.videos.filter((video) => video.authorKey === secUserId).length, lastMode: mode });
    if (this.settings().autoStats && newVideos.length) await this.refreshStats(newVideos.map((v) => v.id));
    return { count: newVideos.length, scanned: page, stopped: shouldStop(), mode, videos: this.store.state.videos };
  }

  async refreshStats(ids) {
    if (this.settings().demoMode) {
      const updated = this.store.state.videos.filter((v) => !ids?.length || ids.includes(v.id)).map((v, i) => recalc({ ...v, play: v.play || 120000 + i * 8173 }));
      this.store.upsertVideos(updated);
      return updated;
    }
    const selected = ids?.length ? ids : this.store.state.videos.map((v) => v.id);
    const result = [];
    for (let index = 0; index < selected.length; index += 50) {
      const batch = selected.slice(index, index + 50);
      const payload = await this.withFallback([
        () => this.tikhub('/api/v1/douyin/app/v3/fetch_multi_video_statistics', { query: { aweme_ids: batch.join(',') }, label: '批量播放统计' }),
        async () => {
          const chunks = [];
          for (let i = 0; i < batch.length; i += 2) {
            chunks.push(...parseStats(await this.tikhub('/api/v1/douyin/app/v3/fetch_video_statistics', { query: { aweme_ids: batch.slice(i, i + 2).join(',') }, label: '播放统计备用接口' })));
          }
          return { __parsed: chunks };
        }
      ], '播放统计');
      result.push(...(payload.__parsed || parseStats(payload)));
      this.progress({ type: 'stats', message: `已补全 ${Math.min(index + 50, selected.length)}/${selected.length} 条播放数据` });
    }
    const merged = result.map(recalc);
    this.store.upsertVideos(merged);
    return merged;
  }

  async latestPlayUrl(awemeId) {
    const query = { aweme_id: awemeId, region: this.settings().region || 'CN' };
    const payload = await this.withFallback([
      () => this.tikhub('/api/v1/douyin/web/fetch_video_high_quality_play_url', { query, label: 'Web 最新视频直链' }),
      () => this.tikhub('/api/v1/douyin/app/v3/fetch_video_high_quality_play_url', { query, label: 'APP V3 最新视频直链' }),
      () => this.tikhub('/api/v1/douyin/web/fetch_one_video_v2', { query: { aweme_id: awemeId }, label: '视频详情备用接口' })
    ], '获取最新播放直链');
    const url = parsePlayUrl(payload);
    if (!url) throw new ApiError('接口成功，但没有找到可用播放直链', '需要用真实返回数据校准字段');
    return url;
  }

  async transcribe(awemeId) {
    if (this.settings().demoMode) {
      const transcript = '这是演示模式生成的识别文案。关闭演示模式并填写密钥后，将在每次识别前重新获取最新视频直链。';
      this.store.upsertVideos([{ id: awemeId, transcript, transcriptStatus: '演示完成' }]);
      return { transcript };
    }
    const key = this.store.getSecret('dashscope');
    if (!key) throw new ApiError('尚未填写阿里云 DashScope 密钥');
    const audioUrl = await this.latestPlayUrl(awemeId);
    const base = this.settings().dashscopeBaseUrl.replace(/\/$/, '');
    const submit = await this.request(`${base}/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model: 'qwen3-asr-flash-filetrans', input: { file_url: audioUrl }, parameters: { channel_id: [0], enable_itn: true, enable_words: false } })
    }, '提交 Qwen3-ASR');
    const taskId = submit.output?.task_id;
    if (!taskId) throw new ApiError('ASR 没有返回任务 ID');
    for (let poll = 0; poll < 360; poll += 1) {
      await delay(2000);
      const status = await this.request(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${key}` } }, '查询 ASR 任务');
      const state = status.output?.task_status;
      this.progress({ type: 'asr', message: `文案识别状态：${state || '处理中'}` });
      if (state === 'FAILED' || state === 'UNKNOWN') throw new ApiError('Qwen3-ASR 识别失败', status.output?.message || status.message || state);
      if (state === 'SUCCEEDED') {
        const transcriptUrl = firstByKeys(status, ['transcription_url'], (v) => typeof v === 'string');
        let result = status;
        if (transcriptUrl) result = await this.request(transcriptUrl, {}, '下载识别结果');
        const sentences = [];
        const collectText = (value) => {
          if (!value || typeof value !== 'object') return;
          if (typeof value.text === 'string') sentences.push(value.text);
          for (const child of Object.values(value)) collectText(child);
        };
        collectText(result);
        const transcript = [...new Set(sentences)].join('\n').trim();
        if (!transcript) throw new ApiError('识别完成，但结果中没有找到文案', '需要用真实返回数据校准字段');
        this.store.upsertVideos([{ id: awemeId, transcript, transcriptStatus: '完成' }]);
        return { transcript };
      }
    }
    throw new ApiError('Qwen3-ASR 等待超时', '任务可能仍在阿里云后台执行');
  }

  async rewriteTopic(topicId) {
    let topic = this.store.state.topics.find((item) => String(item.id) === String(topicId));
    if (!topic) throw new ApiError('选题不存在或已被移出');
    let transcript = String(topic.transcript || '').trim();
    if (!transcript) {
      this.progress({ type: 'rewrite', message: '选题还没有文案，正在先获取文案…' });
      const result = await this.transcribe(topicId);
      transcript = String(result.transcript || '').trim();
      this.store.addTopic({ id: topicId, transcript, transcriptStatus: '完成' });
      topic = this.store.state.topics.find((item) => String(item.id) === String(topicId));
    }
    if (!transcript) throw new ApiError('没有可用于改写的原始文案');

    let text;
    let usage = null;
    if (this.settings().demoMode) {
      text = `你有没有发现，真正让人停下来的创意，往往不是复杂，而是把熟悉的东西换一个角度。\n\n${transcript.replace(/^这是演示模式生成的识别文案。?/, '今天就用一个简单案例，拆开看看好创意是怎么抓住注意力的。')}\n\n如果是你，你会把这个思路用在哪个题材里？评论区说说你的想法。`;
    } else {
      const key = this.store.getSecret('deepseek');
      if (!key) throw new ApiError('尚未填写 DeepSeek API Key');
      const base = String(this.settings().deepseekBaseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
      const systemPrompt = String(this.settings().rewriteSystemPrompt || '').trim();
      if (!systemPrompt) throw new ApiError('请先在设置中填写并保存改写系统提示词');
      this.progress({ type: 'rewrite', message: '正在调用 DeepSeek-V4-Pro 改写文案…' });
      const response = await this.request(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `请改写下面这段短视频原始文案：\n\n${transcript}` }
          ],
          thinking: { type: 'disabled' },
          temperature: 0.8,
          max_tokens: 3000,
          stream: false
        })
      }, 'DeepSeek 文案改写');
      text = String(response?.choices?.[0]?.message?.content || '').trim();
      usage = response?.usage || null;
      if (!text) throw new ApiError('DeepSeek 请求成功，但没有返回改写文案');
    }

    const rewrite = { id: randomUUID(), text, model: 'deepseek-v4-pro', createdAt: new Date().toISOString(), usage };
    const updatedTopic = this.store.saveRewrite(topicId, rewrite);
    this.progress({ type: 'rewrite', message: '爆款文案改写完成' });
    return { transcript, rewrite, topic: updatedTopic };
  }

  async searchLowFans({ keyword, page = 1, pageSize = 20, dateWindow = 24 }) {
    if (this.settings().demoMode) return this.demoLowFans(keyword);
    const payload = await this.tikhub('/api/v1/douyin/billboard/fetch_hot_total_low_fan_list', {
      method: 'POST', body: { page, page_size: pageSize, date_window: dateWindow, keyword, tags: [] }, label: '低粉爆款榜'
    });
    const items = parseLowFans(payload);
    this.store.state.searches = items;
    this.store.save();
    return items;
  }

  demoAuthor(url, options = {}) {
    const now = Math.floor(Date.now() / 1000);
    const secUserId = /\/user\/([^?/#]+)/.exec(url)?.[1] || 'demo-author';
    const total = options.mode === 'latest' ? 6 : Math.min(18, Number.isFinite(options.pages) ? options.pages * 6 : 18);
    const catalog = Array.from({ length: total }, (_, index) => recalc({
      id: `demo-${index + 1}`, source: 'demo', nickname: '演示作者', title: `演示视频 ${index + 1}：AI 创意短片灵感`,
      play: 68000 + index * 19321, like: 3200 + index * 371, collect: 460 + index * 53, share: 120 + index * 17, comment: 180 + index * 11,
      fans: 9360, createdAt: new Date((now - index * 86400) * 1000).toISOString(), shareUrl: `https://www.douyin.com/video/demo-${index + 1}`, authorKey: secUserId, authorUrl: url
    }));
    const existingIds = new Set(this.store.state.videos.map((video) => String(video.id)));
    const videos = options.mode === 'latest' ? catalog.filter((video) => !existingIds.has(video.id)) : catalog;
    this.store.upsertVideos(videos);
    this.store.upsertAuthor({ secUserId, nickname: '演示作者', url, videoCount: this.store.state.videos.filter((video) => video.authorKey === secUserId).length, lastMode: options.mode || 'all' });
    this.store.state.collection = { url, secUserId, nickname: '演示作者', cursor: null, page: options.mode === 'latest' ? 1 : Math.ceil(total / 6), mode: options.mode || 'all', complete: true, demo: true };
    this.store.save();
    this.progress({ type: 'collection', page: this.store.state.collection.page, count: this.store.state.videos.length, newCount: videos.length, message: `演示采集完成，新增 ${videos.length} 条` });
    return { count: videos.length, scanned: this.store.state.collection.page, mode: options.mode || 'all', videos: this.store.state.videos, demo: true };
  }

  demoLowFans(keyword) {
    return Array.from({ length: 12 }, (_, index) => recalc({
      id: `hot-${index + 1}`, source: 'lowfans', nickname: `低粉作者 ${index + 1}`, title: `${keyword || 'AI创意视频'} · 爆款案例 ${index + 1}`,
      play: 820000 - index * 27000, like: 59000 - index * 1700, collect: 9300 - index * 311, share: 4100 - index * 137, comment: 2300 - index * 81,
      fans: 2100 + index * 450, createdAt: new Date(Date.now() - index * 7200000).toISOString(), shareUrl: `https://www.douyin.com/video/hot-${index + 1}`
    }));
  }
}

module.exports = { ApiClient, ApiError };
