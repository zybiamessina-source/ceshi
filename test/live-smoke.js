const { ApiClient } = require('../src/lib/api');
const { parseVideoPage } = require('../src/lib/parser');

const AUTHOR_URL = 'https://www.douyin.com/user/MS4wLjABAAAA8STS6_M6xDdyhaTpeC5wuitJkGrSqohI1TeGYq0UBWNwqGcnImByfUKqAo8vy72s?from_tab_name=main';

function createStore() {
  return {
    state: {
      settings: {
        demoMode: false,
        autoStats: false,
        retryCount: Number(process.env.LIVE_RETRY_COUNT || 2),
        retryDelayMs: 1000,
        tikhubBaseUrl: process.env.TIKHUB_BASE_URL || 'https://api.tikhub.dev',
        dashscopeBaseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1',
        deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        rewriteSystemPrompt: '请保留原文核心信息，改写成口语自然、开头有吸引力、适合短视频口播的新文案。只输出改写后的文案。',
        region: 'CN'
      },
      videos: [],
      authors: [],
      topics: [],
      searches: [],
      collection: null
    },
    getSecret(name) {
      const names = {
        tikhub: ['TIKHUB_API_KEY', 'tikhub_api_key'],
        dashscope: ['DASHSCOPE_API_KEY'],
        deepseek: ['DEEPSEEK_API_KEY']
      };
      return (names[name] || []).map((item) => process.env[item]).find(Boolean) || '';
    },
    save() {},
    upsertVideos(items) {
      const map = new Map(this.state.videos.map((item) => [String(item.id), item]));
      for (const item of items) map.set(String(item.id), { ...(map.get(String(item.id)) || {}), ...item });
      this.state.videos = [...map.values()];
    },
    upsertAuthor(author) {
      const index = this.state.authors.findIndex((item) => item.secUserId === author.secUserId);
      if (index >= 0) this.state.authors[index] = { ...this.state.authors[index], ...author };
      else this.state.authors.push(author);
    },
    addTopic(topic) {
      const index = this.state.topics.findIndex((item) => String(item.id) === String(topic.id));
      if (index >= 0) this.state.topics[index] = { ...this.state.topics[index], ...topic };
      else this.state.topics.push({ ...topic, rewrites: [] });
      return this.state.topics.find((item) => String(item.id) === String(topic.id));
    },
    saveRewrite(id, rewrite) {
      const topic = this.state.topics.find((item) => String(item.id) === String(id));
      topic.rewrites = [rewrite, ...(topic.rewrites || [])];
      topic.latestRewrite = rewrite.text;
      return topic;
    }
  };
}

function safeError(error) {
  const secrets = ['TIKHUB_API_KEY', 'tikhub_api_key', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY']
    .map((name) => process.env[name])
    .filter(Boolean);
  let message = `${error?.message || error}${error?.details ? `：${error.details}` : ''}`;
  for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
  return message;
}

async function step(name, action) {
  try {
    const data = await action();
    console.log(JSON.stringify({ step: name, ok: true, ...data }, null, 2));
    return data;
  } catch (error) {
    console.log(JSON.stringify({ step: name, ok: false, error: safeError(error) }, null, 2));
    return null;
  }
}

async function main() {
  const stage = process.argv[2] || 'tikhub';
  const store = createStore();
  const client = new ApiClient(store, (event) => console.log(JSON.stringify({ progress: event.message })));
  let videoId = '';

  if (stage === 'web-backup') {
    const secUserId = /\/user\/([^?/#]+)/.exec(AUTHOR_URL)?.[1];
    await step('author-web-backup', async () => {
      const payload = await client.tikhub('/api/v1/douyin/web/fetch_user_post_videos', {
        query: { sec_user_id: secUserId, max_cursor: '0', count: 20, filter_type: '0' }, label: 'Web 作者备用接口'
      });
      const parsed = parseVideoPage(payload);
      return { videos: parsed.videos.length, cursor: parsed.cursor, hasMore: parsed.hasMore };
    });
    return;
  }

  if (stage === 'full-collection') {
    const full = await step('author-all-pages', async () => {
      const result = await client.collectAuthor(AUTHOR_URL, { mode: 'all' });
      return {
        scannedPages: result.scanned,
        newVideos: result.count,
        storedVideos: store.state.videos.length,
        complete: store.state.collection?.complete === true,
        finalCursorPresent: store.state.collection?.cursor !== undefined && store.state.collection?.cursor !== null
      };
    });
    if (full) {
      await step('author-latest-deduplicate', async () => {
        const result = await client.collectAuthor(AUTHOR_URL, { mode: 'latest', pages: 1 });
        return { scannedPages: result.scanned, newVideos: result.count, storedVideos: store.state.videos.length };
      });
    }
    return;
  }

  if (stage === 'shape') {
    const secUserId = /\/user\/([^?/#]+)/.exec(AUTHOR_URL)?.[1];
    const describe = (value, path = '$', depth = 0, rows = []) => {
      if (depth > 5 || rows.length >= 160 || value === null || value === undefined) return rows;
      if (Array.isArray(value)) {
        rows.push(`${path}: array(${value.length})`);
        if (value.length) describe(value[0], `${path}[0]`, depth + 1, rows);
        return rows;
      }
      if (typeof value !== 'object') return rows;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (Array.isArray(child)) rows.push(`${childPath}: array(${child.length})`);
        else if (child && typeof child === 'object') rows.push(`${childPath}: object`);
        else rows.push(`${childPath}: ${typeof child}`);
        describe(child, childPath, depth + 1, rows);
        if (rows.length >= 160) break;
      }
      return rows;
    };
    await step('author-shape', async () => {
      const first = await client.authorPage(secUserId, 0);
      const parsed = parseVideoPage(first);
      const data = first?.data || {};
      const paging = Object.fromEntries(Object.entries(data).filter(([key]) => /cursor|more|offset|page/i.test(key)));
      return { parsedCursor: parsed.cursor, parsedHasMore: parsed.hasMore, paging, paths: describe(first) };
    });
    for (const endpoint of [
      { name: 'app-normal', path: '/api/v1/douyin/app/v3/fetch_user_post_videos', query: { sec_user_id: secUserId, max_cursor: 0, count: 20, sort_type: 0, channel: 'normal' } },
      { name: 'app-lite', path: '/api/v1/douyin/app/v3/fetch_user_post_videos', query: { sec_user_id: secUserId, max_cursor: 0, count: 20, sort_type: 0, channel: 'lite' } },
      { name: 'web', path: '/api/v1/douyin/web/fetch_user_post_videos', query: { sec_user_id: secUserId, max_cursor: '0', count: 20, filter_type: '0' } }
    ]) {
      await step(`author-endpoint-${endpoint.name}`, async () => {
        const payload = await client.tikhub(endpoint.path, { query: endpoint.query, label: `作者接口 ${endpoint.name}` });
        const parsed = parseVideoPage(payload);
        const data = payload?.data || {};
        return {
          videos: parsed.videos.length,
          cursor: parsed.cursor,
          hasMore: parsed.hasMore,
          paging: Object.fromEntries(Object.entries(data).filter(([key]) => /cursor|more|offset|page/i.test(key))),
          firstId: parsed.videos[0]?.id || '',
          lastId: parsed.videos.at(-1)?.id || ''
        };
      });
    }
    await step('low-fan-shape', async () => {
      const payload = await client.tikhub('/api/v1/douyin/billboard/fetch_hot_total_low_fan_list', {
        method: 'POST', body: { page: 1, page_size: 20, date_window: 24, keyword: 'AI创意视频', tags: [] }, label: '低粉爆款榜结构'
      });
      return { paths: describe(payload) };
    });
    return;
  }

  if (['tikhub', 'all', 'asr'].includes(stage)) {
    const collection = await step('author-pages', async () => {
      const result = await client.collectAuthor(AUTHOR_URL, { mode: 'pages', pages: 2 });
      videoId = String(store.state.videos[0]?.id || '');
      return {
        scannedPages: result.scanned,
        newVideos: result.count,
        parsedVideos: store.state.videos.length,
        nickname: store.state.authors[0]?.nickname || '',
        firstVideoIdPresent: Boolean(videoId),
        cursorPresent: store.state.collection?.cursor !== undefined && store.state.collection?.cursor !== null
      };
    });
    if (!collection) return;

    await step('video-statistics', async () => {
      const ids = store.state.videos.slice(0, 2).map((item) => item.id);
      const result = await client.refreshStats(ids);
      return {
        requested: ids.length,
        parsed: result.length,
        playPresent: result.some((item) => Number(item.play) > 0),
        ratioPresent: result.some((item) => typeof item.likeRate === 'number')
      };
    });

    await step('latest-play-url', async () => {
      const playUrl = await client.latestPlayUrl(videoId);
      const parsed = new URL(playUrl);
      return { available: true, host: parsed.hostname, urlLength: playUrl.length };
    });

    await step('low-fan-search', async () => {
      const result = await client.searchLowFans({ keyword: 'AI创意视频', page: 1, pageSize: 20, dateWindow: 24 });
      return { parsed: result.length, firstVideoIdPresent: Boolean(result[0]?.id) };
    });
  }

  if (['deepseek', 'all'].includes(stage)) {
    store.addTopic({ id: 'rewrite-live-test', transcript: '很多人以为创意需要复杂技术，其实真正打动人的，往往只是把熟悉的事物换一个角度。' });
    await step('deepseek-rewrite', async () => {
      const result = await client.rewriteTopic('rewrite-live-test');
      return { model: result.rewrite.model, characters: result.rewrite.text.length, preview: result.rewrite.text.slice(0, 80) };
    });
  }

  if (['asr', 'all'].includes(stage) && videoId) {
    await step('qwen3-asr', async () => {
      const result = await client.transcribe(videoId);
      return { characters: result.transcript.length, preview: result.transcript.slice(0, 80) };
    });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ fatal: safeError(error) }));
  process.exitCode = 1;
});
