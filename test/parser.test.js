const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVideoPage, parseStats, parseSecUserId, parsePlayUrl, parseLowFans, recalc } = require('../src/lib/parser');

test('解析作者作品分页、Cursor 和互动率', () => {
  const payload = { data: { aweme_list: [{ aweme_id: '123', desc: '测试视频', author: { nickname: '测试作者', follower_count: 88 }, statistics: { play_count: 1000, digg_count: 100, collect_count: 20, share_count: 10, comment_count: 5 } }], max_cursor: 99, has_more: 1 } };
  const page = parseVideoPage(payload);
  assert.equal(page.cursor, 99);
  assert.equal(page.hasMore, true);
  assert.equal(page.videos[0].id, '123');
  assert.equal(page.videos[0].likeRate, 0.1);
  assert.equal(page.videos[0].collectRate, 0.02);
});

test('解析不同层级中的作者 ID 与最新直链', () => {
  assert.equal(parseSecUserId({ data: { user: { sec_uid: 'MS4wLjABAAAA-test-user' } } }), 'MS4wLjABAAAA-test-user');
  assert.equal(parsePlayUrl({ data: { original_video_url: 'https://cdn.example/video.mp4' } }), 'https://cdn.example/video.mp4');
});

test('统计接口可解析列表并重新计算比率', () => {
  const values = parseStats({ data: { statistics_list: [{ aweme_id: '7', play_count: 500, digg_count: 25, share_count: 5 }] } });
  assert.equal(values[0].id, '7');
  assert.equal(values[0].likeRate, 0.05);
  assert.equal(recalc({ play: 0, like: 1 }).likeRate, null);
});

test('低粉榜兼容 items 列表', () => {
  const list = parseLowFans({ data: { items: [{ item_id: '9', title: '爆款', stats: { views: 100, likes: 20 } }] } });
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'lowfans');
  assert.equal(list[0].likeRate, 0.2);
});

test('真实作者响应从视频列表同层读取 Cursor，不误取请求参数', () => {
  const result = parseVideoPage({
    params: { max_cursor: '0' },
    data: {
      aweme_list: [{ aweme_id: 'real-1', desc: '真实作品' }],
      max_cursor: 1787464800000,
      has_more: 1
    }
  });
  assert.equal(result.cursor, 1787464800000);
  assert.equal(result.hasMore, true);
  assert.equal(result.videos[0].id, 'real-1');
});

test('低粉榜兼容真实 objs 和 cnt 字段', () => {
  const result = parseLowFans({ data: { data: { objs: [{
    item_id: 'low-real-1', item_title: 'AI 创意视频', nick_name: '创作者',
    play_cnt: 100000, like_cnt: 8000, fans_cnt: 2600,
    publish_time: 1760000000, item_url: 'https://www.douyin.com/video/low-real-1'
  }] } } });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'AI 创意视频');
  assert.equal(result[0].nickname, '创作者');
  assert.equal(result[0].play, 100000);
  assert.equal(result[0].like, 8000);
  assert.equal(result[0].fans, 2600);
  assert.equal(result[0].shareUrl, 'https://www.douyin.com/video/low-real-1');
});
