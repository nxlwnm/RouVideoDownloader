# 🎯 油猴脚本

> 把 `.user.js` 导入 Tampermonkey 即可使用。详细使用说明见 `../guides/USAGE.md`。

```
scripts/
├── rou-video-downloader-v3.user.js    ✅ 主脚本（v3.4 最新版）
├── rou-video-downloader.user.js       ⏸ v1 旧版（功能过时，保留参考）
└── test-page.html                     🧪 本地调试页
```

**安装**：Tampermonkey → 添加新脚本 → 粘贴 `rou-video-downloader-v3.user.js` 内容 → Ctrl+S 保存

**测试**：双击 `test-page.html` 用浏览器打开，右上角出现红色面板即成功。
