function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visit(value);
  for (const child of Object.values(value)) walk(child, visit, seen);
}

function firstByKeys(root, keys, predicate = () => true) {
  let found;
  walk(root, (node) => {
    if (found !== undefined || Array.isArray(node)) return;
    for (const key of keys) {
      if (Object.hasOwn(node, key) && predicate(node[key])) { found = node[key]; break; }
    }
  });
  return found;
}

function firstArray(root, keys) {
  return firstByKeys(root, keys, Array.isArray) || [];
}

function firstArrayEntry(root, keys, seen = new Set()) {
  if (!root || typeof root !== 'object' || seen.has(root)) return null;
  seen.add(root);
  if (!Array.isArray(root)) {
    for (const key of keys) {
      if (Array.isArray(root[key])) return { list: root[key], node: root, key };
    }
  }
  for (const child of Object.values(root)) {
    const found = firstArrayEntry(child, keys, seen);
    if (found) return found;
  }
  return null;
}

function ownByKeys(node, keys) {
  if (!node || typeof node !== 'object') return undefined;
  for (const key of keys) if (Object.hasOwn(node, key)) return node[key];
  return undefined;
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function findMetric(node, keys) {
  return number(firstByKeys(node, keys, (v) => v !== null && v !== '' && !Number.isNaN(Number(v))));
}

function normalizeVideo(item, source = 'author') {
  const id = firstByKeys(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'id'], (v) => typeof v === 'string' || typeof v === 'number');
  if (!id) return null;
  const author = firstByKeys(item, ['author', 'user', 'author_info'], (v) => v && typeof v === 'object') || {};
  const stats = firstByKeys(item, ['statistics', 'statistics_data', 'stats', 'statistics_info'], (v) => v && typeof v === 'object') || item;
  const title = firstByKeys(item, ['desc', 'description', 'title', 'aweme_desc', 'item_title'], (v) => typeof v === 'string') || '';
  const nickname = firstByKeys(author, ['nickname', 'nick_name', 'name'], (v) => typeof v === 'string')
    || firstByKeys(item, ['nickname', 'nick_name'], (v) => typeof v === 'string') || '';
  const play = findMetric(stats, ['play_count', 'playCount', 'view_count', 'views', 'play_cnt']);
  const like = findMetric(stats, ['digg_count', 'like_count', 'likeCount', 'likes', 'like_cnt']);
  const collect = findMetric(stats, ['collect_count', 'collection_count', 'favorite_count', 'favorites', 'collect_cnt']);
  const share = findMetric(stats, ['share_count', 'shareCount', 'shares', 'share_cnt']);
  const comment = findMetric(stats, ['comment_count', 'commentCount', 'comments', 'comment_cnt']);
  const fans = findMetric(author, ['follower_count', 'followers_count', 'fans_count', 'fans_cnt'])
    || findMetric(item, ['follower_count', 'followers_count', 'fans_count', 'fans_cnt']);
  const created = firstByKeys(item, ['create_time', 'publish_time', 'createTime']);
  const providedShareUrl = firstByKeys(item, ['item_url', 'share_url', 'shareUrl'], (v) => typeof v === 'string' && /^https?:\/\//.test(v));
  return {
    id: String(id), source, title, nickname, play, like, collect, share, comment, fans,
    createdAt: created ? new Date(number(created) * (String(created).length <= 10 ? 1000 : 1)).toISOString() : '',
    shareUrl: providedShareUrl || `https://www.douyin.com/video/${id}`,
    likeRate: play ? like / play : null,
    collectRate: play ? collect / play : null,
    shareRate: play ? share / play : null,
    commentRate: play ? comment / play : null
  };
}

function parseVideoPage(payload) {
  const entry = firstArrayEntry(payload, ['aweme_list', 'awemeList', 'item_list', 'items', 'videos', 'list']);
  const list = entry?.list || [];
  const videos = list.map((item) => normalizeVideo(item)).filter(Boolean);
  const cursor = ownByKeys(entry?.node, ['max_cursor', 'maxCursor', 'cursor', 'next_cursor', 'nextCursor']);
  const hasMoreRaw = ownByKeys(entry?.node, ['has_more', 'hasMore', 'more']);
  const hasMore = hasMoreRaw === true || hasMoreRaw === 1 || hasMoreRaw === '1';
  return { videos, cursor: cursor ?? null, hasMore };
}

function parseStats(payload) {
  const list = firstArray(payload, ['statistics_list', 'statistics', 'aweme_list', 'items', 'list']);
  const candidates = list.length ? list : [payload];
  return candidates.map((item) => normalizeVideo(item, 'stats')).filter(Boolean);
}

function parseSecUserId(payload) {
  return firstByKeys(payload, ['sec_user_id', 'sec_uid', 'secUserId'], (v) => typeof v === 'string' && v.length > 8) || '';
}

function parsePlayUrl(payload) {
  return firstByKeys(payload, ['original_video_url', 'play_url', 'playUrl', 'url'], (v) => typeof v === 'string' && /^https?:\/\//.test(v)) || '';
}

function parseLowFans(payload) {
  const list = firstArray(payload, ['item_list', 'aweme_list', 'items', 'list', 'data_list', 'objs']);
  return list.map((item) => normalizeVideo(item, 'lowfans')).filter(Boolean);
}

function recalc(video) {
  const play = number(video.play);
  return {
    ...video,
    likeRate: play ? number(video.like) / play : null,
    collectRate: play ? number(video.collect) / play : null,
    shareRate: play ? number(video.share) / play : null,
    commentRate: play ? number(video.comment) / play : null
  };
}

module.exports = { firstByKeys, normalizeVideo, parseVideoPage, parseStats, parseSecUserId, parsePlayUrl, parseLowFans, recalc };
