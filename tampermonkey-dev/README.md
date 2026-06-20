# Rou.video 视频下载脚本

> v3.4 · 一键下载 rou.video 视频，自动破解伪装 HLS 流并合并为 MP4。

---

## 目录结构

```
tampermonkey-dev/
├── scripts/             🎯 油猴脚本
│   ├── rou-video-downloader-v3.user.js   ← 主脚本（用这个）
│   ├── rou-video-downloader.user.js      旧版
│   └── test-page.html                    本地调试页
├── guides/              📖 使用文档
│   └── USAGE.md                          从安装到常见问题，一篇搞定
└── tech/                🔧 技术文档
    ├── TECHNICAL.md                       破解过程 + 项目总结
    └── rou.video.har                      原始抓包数据
```

## 快速开始

```
1️⃣ Tampermonkey 安装脚本（scripts/rou-video-downloader-v3.user.js 粘贴进去）
2️⃣ 配置代理 127.0.0.1:10808
3️⃣ 访问 rou.video → 右上角出现面板 → 点 [⚡ 下载 MP4]
```

遇到问题？→ `guides/USAGE.md`

## 我应该看哪个？

| 目标 | 文档 |
|------|------|
| 第一次用 | `guides/USAGE.md`（安装 + 常见问题） |
| 了解技术原理 | `tech/TECHNICAL.md`（破解过程 + 代码亮点） |
| 要看原始抓包 | `tech/rou.video.har` |

---

> MIT · 仅供学习 · 2026-06-20
