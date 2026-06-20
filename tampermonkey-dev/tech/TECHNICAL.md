# Rou.video 技术文档

> 破解过程、架构分析和项目总结

---

## 一、破解过程

### 视频格式：伪装 HLS 流

网站把 HLS 文件全部伪装成 `.jpg` 来防止简单爬虫：

| 实际内容 | 伪装文件名 |
|---------|-----------|
| m3u8 播放列表 | `index.jpg` |
| TS 视频片段 | `CLS-{000-097}.jpg` |

URL 示例：
```
m3u8:  https://v.rn{xxx}.xyz/hls/{videoId}/{videoId}-{resolution}/index.jpg?v=6&exp=...&auth=...
TS:    https://v.rn{xxx}.xyz/hls/{videoId}/{videoId}-{resolution}/CLS-{000}.jpg?v=6&exp=...&auth=...
```

### EV 字段加密

视频源 URL 隐藏在页面的 `__NEXT_DATA__` 中的 `ev` 字段，加密方式为 **Base64 + XOR**：

```javascript
const raw = atob(ev.d);                        // Base64 解码
const decrypted = raw.split('')
  .map(c => String.fromCharCode(c.charCodeAt(0) - ev.k))  // XOR 移位
  .join('');
const parsed = JSON.parse(decrypted);          // 得到 { videoUrl: "..." }
```

脚本会在页面加载后自动解密 EV 字段，获取 m3u8 URL 直接下载并解析播放列表。

### 播放列表特征

- **无加密**：m3u8 中无 `#EXT-X-KEY` 标签，TS 片段可直接合并
- **98 个片段**：对应约 974 秒视频
- **多 CDN 分发**：同一视频的片段来自 `v.rn200~rn255.xyz` 分散加载
- **统一 auth**：所有片段共用同一 auth token

### API 端点

```http
POST /api/v/{videoId}/play
Content-Type: application/json
Body: {"tags":["自拍流出"]}
```

当前返回 200 但数据为空 (`{}`)，推测：
- 需要认证（Cookie/Bearer Token）
- 或需要额外参数
- 或 API 已被弃用

### 关键技术亮点

1. **EV 字段解密**：Base64 + XOR 破解视频源地址，无需播放器加载即可获取
2. **网络拦截**：同时拦截 fetch 和 XHR，捕获 m3u8 响应
3. **容错下载**：单个片段下载失败不中止，自动跳过继续
4. **完整日志**：每个关键步骤都有日志，支持导出 `.log` 文件

---

## 二、项目总结

### 版本历史

| 版本 | 改进 |
|------|------|
| v3.6 | **并行下载**（并发 5 个请求，加速约 3-5 倍） |
| v3.5 | 高清诊断日志（登录态、EV 全字段、变体流检测） |
| v3.4 | 输出文件名改为 `.mp4` 后缀 |
| v3.3 | 智能文件名：自动提取视频标题，去掉网站后缀 |
| v3.2 | 添加 `@connect *` 跳过跨域权限确认框 |
| v3.1 | 完整调试日志系统 + 日志导出 |
| v3.0 | 破解伪装 HLS 流，下载并合并 TS 片段为 MP4 |

### 功能清单

**核心功能**：破解伪装 m3u8 → 解析播放列表 → 批量下载 TS 片段 → 自动合并为 MP4

**UI**：右上角浮动面板，提供三个按钮（保存 m3u8、下载 MP4、复制播放列表）+ 日志导出

### 已知限制

| 限制 | 说明 |
|------|------|
| 仅 404p | 高清由服务端 EV 加密控制，需用户登录提升权限 |
| 需代理 | rou.video 需要 127.0.0.1:10808 代理 |
| 不支持加密 | m3u8 有 `#EXT-X-KEY` 的视频暂不支持 |
| 单次单视频 | 无法批量下载多个视频 |

### 后续建议

- 自动选择最高画质
- 批量下载支持
- 发布到 Greasy Fork（更新 `@version` 用户会自动收到更新）

---

> **项目状态**：✅ 生产就绪 | **最后更新**：2026-06-20 | **许可证**：MIT
