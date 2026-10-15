# 抖音爆款雷达V1版

当前客户端构建版本：`v0.3.1`

[下载最新 Windows 安装包](https://github.com/zybiamessina-source/ceshi/releases/latest)

Windows 本地桌面客户端，用于采集抖音作者作品、补全播放与互动数据、查询低粉爆款榜，并通过 Qwen3-ASR 识别视频文案。

## 当前状态

- 已接入 TikHub MCP 文档中确认的接口路径和请求参数。
- 支持采集全部作品、指定页数、仅采最新一页三种模式。
- 最新一页模式会与本地视频 ID 对比，只保存并处理新增视频。
- 已采集作者会单独建档，可从历史作者快速选择并筛选视频。
- 视频和低粉爆款结果均可加入独立的本地选题库。
- 选题库支持 DeepSeek-V4-Pro 一键改写；没有原文时会先自动调用 Qwen3-ASR 获取文案。
- DeepSeek 密钥使用 Windows 本机加密保存，系统提示词可在设置中编辑并保存。
- 默认开启演示模式，无密钥也可以体验完整界面。
- 2026-10-15 已使用真实接口完成联调：测试作者自动翻页 7 页并采集 132 条作品，最新一页再次采集新增 0 条。
- 已用真实响应校准作者 Cursor、低粉榜 `objs` 列表和 `*_cnt` 数据字段。
- TikHub 播放统计、最新直链、低粉榜、Qwen3-ASR 和 DeepSeek-V4-Pro 均已真实调用成功。
- 密钥由设置页填写，使用 Electron `safeStorage` 调用 Windows 本机加密后保存。

## 使用

运行安装版 EXE，按安装向导选择目录并完成安装；之后从桌面或开始菜单的“抖音爆款雷达”快捷方式启动。首次打开后可先在演示模式体验；真实使用时进入“设置”，填写 TikHub、DashScope 和 DeepSeek 密钥并关闭演示模式。

阿里云使用 `qwen3-asr-flash-filetrans`。新版百炼建议在设置中填写包含 Workspace ID 的专属地域 API 地址，例如：

`https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1`

## 开发

```powershell
npm install
npm test
npm start
npm run pack
npm run installer
```

开发测试时也支持从环境变量读取 `TIKHUB_API_KEY`、`DASHSCOPE_API_KEY` 和 `DEEPSEEK_API_KEY`；旧变量 `tikhub_api_key` 仍兼容。环境变量的值不会显示在界面或日志中。

## 已配置 TikHub 接口

- 作者链接解析：`/api/v1/douyin/web/get_sec_user_id`
- 作者作品主接口：`/api/v1/douyin/app/v3/fetch_user_post_videos`
- 作者作品备用接口：APP V3 Lite、Web `fetch_user_post_videos`
- 批量播放统计：`/api/v1/douyin/app/v3/fetch_multi_video_statistics`
- 播放统计备用：`/api/v1/douyin/app/v3/fetch_video_statistics`
- 最新直链主接口：`/api/v1/douyin/web/fetch_video_high_quality_play_url`
- 最新直链备用：APP V3 高清直链、Web 视频详情 V2
- 低粉爆款榜：`/api/v1/douyin/billboard/fetch_hot_total_low_fan_list`
