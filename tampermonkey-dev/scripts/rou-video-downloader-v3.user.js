// ==UserScript==
// @name         Rou.video 视频下载助手 (v3)
// @namespace    http://tampermonkey.net/
// @version      3.8
// @description  下载 rou.video 视频（破解伪装 HLS/JPEG 流 + 高清诊断日志）
// @author       You
// @match        https://rou.video/*
// @match        https://www.rou.video/*
// @match        https://https.rou.video/*
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ================================================================
    // 日志系统 — 同时输出到 Console + 内存缓冲区（可导出）
    // ================================================================
    const LOG_PREFIX = '[RouDL]';
    const logBuffer = []; // 内存日志缓冲区

    function log(...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = `${ts} ${LOG_PREFIX} ${msg}`;
        logBuffer.push(line);
        console.log(LOG_PREFIX, ...args);
    }

    function warn(...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = `${ts} ${LOG_PREFIX} [WARN] ${msg}`;
        logBuffer.push(line);
        console.warn(LOG_PREFIX, ...args);
    }

    function err(...args) {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ');
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const line = `${ts} ${LOG_PREFIX} [ERROR] ${msg}`;
        logBuffer.push(line);
        console.error(LOG_PREFIX, ...args);
    }

    // ================================================================
    // 【诊断】登录状态检测
    // ================================================================
    function logAuthState() {
        log('[诊断] ===== 登录状态检测 =====');
        // 1. Cookie
        try {
            const cookies = document.cookie.split(';').map(c => c.trim()).filter(Boolean);
            log(`[诊断] document.cookie: ${cookies.length} 个`);
            cookies.forEach(c => {
                const [k, v] = c.split('=');
                if (k && v) {
                    // 只显示前 30 位，避免敏感信息泄露
                    log(`[诊断]   Cookie: ${k}=${v.slice(0, 30)}${v.length > 30 ? '...' : ''}`);
                }
            });
        } catch (e) { err('[诊断] Cookie 读取失败:', e.message); }

        // 2. localStorage - 找 auth/token 相关 key
        try {
            const lsKeys = Object.keys(localStorage);
            const authKeys = lsKeys.filter(k => /auth|token|login|user|session|vip|member/i.test(k));
            if (authKeys.length > 0) {
                log(`[诊断] localStorage 中发现 ${authKeys.length} 个认证相关 key:`);
                authKeys.forEach(k => {
                    let v = localStorage.getItem(k);
                    v = v ? v.slice(0, 40) : '';
                    log(`[诊断]   LS: ${k}=${v}${v.length >= 40 ? '...' : ''}`);
                });
            } else {
                log('[诊断] localStorage 中无认证相关 key');
                if (lsKeys.length > 0) log(`[诊断]   (共有 ${lsKeys.length} 个 key, 均不匹配 auth 模式)`);
            }
        } catch (e) { err('[诊断] localStorage 读取失败:', e.message); }

        // 3. 检查页面是否显示已登录 UI
        try {
            const bodyText = document.body?.innerText || '';
            const loginIndicators = bodyText.match(/登录|注册|退出|注销|会员|sign.?in|sign.?out|log.?out|logout|login|register/i);
            log(`[诊断] 页面UI登录提示: ${loginIndicators ? '有 → "' + loginIndicators[0] + '"' : '未发现'}`);
        } catch (e) { /* 静默 */ }
        log('[诊断] ===== 登录状态检测结束 =====');
    }

    // ================================================================
    // 【诊断】全量页面数据转储
    // ================================================================
    function dumpFullPageProps() {
        log('[诊断] ===== 全量页面数据分析 =====');
        try {
            const data = getNextData();
            if (!data) { log('[诊断] 无 __NEXT_DATA__'); return; }
            
            const pageProps = data.props?.pageProps || {};
            log(`[诊断] pageProps 一级字段: ${Object.keys(pageProps).join(', ')}`);

            // 用户信息
            if (pageProps.user) {
                log(`[诊断] 用户信息: ${JSON.stringify(pageProps.user).slice(0, 500)}`);
            } else {
                log('[诊断] pageProps 中无 user 字段');
            }

            // video 详细
            const video = pageProps.video || {};
            log(`[诊断] video 字段: ${Object.keys(video).join(', ')}`);
            if (video.sources) {
                log(`[诊断] 视频 sources (原始): ${JSON.stringify(video.sources)}`);
            } else {
                log('[诊断] video 中无 sources 字段');
            }

            // ev 字段信息
            const ev = pageProps.ev;
            if (ev) {
                log(`[诊断] ev 结构: d_len=${ev.d?.length}, k=${ev.k}, 其他字段: ${Object.keys(ev).filter(k => k !== 'd' && k !== 'k').join(', ')}`);
            } else {
                log('[诊断] pageProps 中无 ev 字段');
            }

            // 检查是否有相关视频/推荐视频
            const related = pageProps.relatedVideos || [];
            log(`[诊断] relatedVideos 数量: ${related.length}`);
            if (related.length > 0) {
                const allSources = new Set();
                related.forEach(rv => {
                    (rv.sources || []).forEach(s => allSources.add(s.resolution || s));
                });
                log(`[诊断] 相关视频来源画质: ${[...allSources].sort().join(', ')}`);
            }

            // 查找任何可能包含 user/login/auth 的字段
            const allKeys = Object.keys(pageProps);
            const authFields = allKeys.filter(k => /user|auth|token|login|session|vip|member|account|profile/i.test(k));
            if (authFields.length > 0) {
                log(`[诊断] 有认证相关字段: ${authFields.join(', ')}`);
                authFields.forEach(k => {
                    log(`[诊断]   ${k}: ${JSON.stringify(pageProps[k]).slice(0, 300)}`);
                });
            }

            // 检查 buildId
            if (data.buildId) {
                log(`[诊断] buildId: ${data.buildId}`);
            }
        } catch (e) { err('[诊断] 数据转储失败:', e.message); }
        log('[诊断] ===== 全量页面数据分析结束 =====');
    }

    // ================================================================
    // 状态变量
    // ================================================================
    let VIDEO_ID = null;
    let VIDEOS = [];         // 解析到的视频源
    let UI_CTNR = null;      // UI 容器

    // ================================================================
    // 初始化：检测视频页面
    // ================================================================
    function detectVideoId() {
        const m = window.location.pathname.match(/\/v\/([a-z0-9]+)/i);
        if (m) {
            VIDEO_ID = m[1];
            log(`[检测] 从 URL 提取视频 ID: "${VIDEO_ID}"`);
        } else {
            log(`[检测] 当前 URL 不是视频详情页: ${window.location.pathname}`);
        }
        return VIDEO_ID;
    }

    // ================================================================
    // 读取 __NEXT_DATA__
    // ================================================================
    function getNextData() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) {
                log('[__NEXT_DATA__] 未找到（元素不存在）');
                return null;
            }
            const data = JSON.parse(el.textContent);
            log(`[__NEXT_DATA__] 读取成功, 根字段: ${Object.keys(data).join(', ')}`);
            return data;
        } catch (e) {
            err('[__NEXT_DATA__] 解析失败:', e.message);
            return null;
        }
    }

    // ================================================================
    // 获取 video tags（用于 API 调用）
    // ================================================================
    function getTags() {
        const data = getNextData();
        if (!data) return [];
        const tags = data.props?.pageProps?.video?.tags || [];
        log(`[Tags] 获取到 ${tags.length} 个标签: ${tags.join(', ')}`);
        return tags;
    }

    // ================================================================
    // 获取视频元数据（查看可用的画质）
    // ================================================================
    function getVideoMeta() {
        const data = getNextData();
        if (!data) return null;
        const video = data.props?.pageProps?.video;
        if (video) {
            log(`[Meta] 视频ID: ${video.id}`);
            log(`[Meta] 时长: ${video.duration} 秒`);
            log(`[Meta] 播放次数: ${video.viewCount}`);
            log(`[Meta] 参考源: ${video.ref}`);
        }
        const related = data.props?.pageProps?.relatedVideos || [];
        if (related.length > 0) {
            // 从相关视频看有哪些可用的画质
            const allSources = new Set();
            related.forEach(rv => {
                (rv.sources || []).forEach(s => allSources.add(s.resolution));
            });
            log(`[Meta] 可用画质 (from related): ${[...allSources].sort().join('p, ')}p`);
        }
        return video;
    }

    // ================================================================
    // 拦截网络请求 — 抓伪装成 index.jpg 的 m3u8
    // ================================================================
    function hookAllNetwork() {
        log('[拦截] 开始注册 fetch + XHR 拦截器...');

        // ---- 拦截 fetch — 捕获 m3u8 响应内容 ----
        const origFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = function(...args) {
            const req = args[0];
            const urlStr = req instanceof Request ? req.url : String(args[0]);

            if (urlStr.includes('/hls/')) {
                if (urlStr.includes('/index.jpg')) {
                    log(`[fetch] 检测到 m3u8 请求, 等待响应...`);
                    // 拦截响应内容
                    return origFetch.apply(this, args).then(async response => {
                        try {
                            const clone = response.clone();
                            const text = await clone.text();
                            if (text.startsWith('#EXTM3U')) {
                                log(`[fetch] ✓ 捕获 m3u8 响应! 内容长度: ${text.length}`);
                                parseM3U8(text, urlStr);
                                updateUI();
                            }
                        } catch (e) { /* 静默 */ }
                        return response;
                    });
                } else if (urlStr.includes('/CLS-')) {
                    const segMatch = urlStr.match(/CLS-(\d+)\.jpg/);
                    if (segMatch) log(`[fetch] → TS 片段 #${segMatch[1]}`);
                }
            }
            return origFetch.apply(this, args);
        };
        log('[拦截] fetch 拦截器已安装（含 m3u8 响应捕获）');

        // ---- 拦截 XMLHttpRequest ----
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            const u = typeof url === 'string' ? url : String(url);
            const xhr = this;

            if (u.includes('/hls/') && u.includes('/index.jpg')) {
                log(`[XHR] 检测到伪装 m3u8 请求: ${u.slice(0, 120)}`);
                log(`[XHR] 方法: ${method}`);

                xhr.addEventListener('load', function() {
                    try {
                        const text = xhr.responseText || '';
                        const contentType = xhr.getResponseHeader?.('content-type') || '';
                        log(`[XHR] 响应状态: ${xhr.status}, Content-Type: ${contentType}`);
                        log(`[XHR] 响应大小: ${text.length} 字节`);
                        log(`[XHR] 前 50 字符: "${text.slice(0, 50)}"`);

                        if (text.startsWith('#EXTM3U')) {
                            log(`[XHR] ✓ 确认是 m3u8 播放列表！开始解析...`);
                            parseM3U8(text, u);
                            updateUI();
                        } else {
                            log(`[XHR] × 响应不是 m3u8 格式（不以 #EXTM3U 开头）`);
                        }
                    } catch (e) {
                        err('[XHR] load 事件处理出错:', e.message);
                    }
                });

                xhr.addEventListener('error', function() {
                    err(`[XHR] m3u8 请求出错: ${u.slice(0, 100)}`);
                });

                xhr.addEventListener('abort', function() {
                    warn(`[XHR] m3u8 请求被中止: ${u.slice(0, 100)}`);
                });
            }
            return origOpen.call(this, method, url, ...rest);
        };
        log('[拦截] XHR 拦截器已安装');
    }

    // ================================================================
    // 调用 play API 获取播放源
    // ================================================================
    async function callPlayAPI() {
        if (!VIDEO_ID) {
            log('[PlayAPI] 跳过：无视频 ID');
            return;
        }

        log('[PlayAPI] ===== 开始调用 Play API =====');
        const tags = getTags();
        log(`[PlayAPI] 视频ID: ${VIDEO_ID}`);
        log(`[PlayAPI] tags:`, tags);

        if (tags.length === 0) {
            log('[PlayAPI] 无标签数据, 尝试空 body...');
        }

        const apiUrl = `/api/v/${VIDEO_ID}/play`;
        const body = tags.length > 0 ? JSON.stringify({ tags }) : '{}';
        log(`[PlayAPI] POST ${apiUrl}`);
        log(`[PlayAPI] 请求体: ${body}`);

        try {
            const startTime = Date.now();
            // 带 credentials: 'include' 以发送登录 Cookie
            const r = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Referer': window.location.href,
                },
                credentials: 'include',
                body: body
            });
            const elapsed = Date.now() - startTime;
            log(`[PlayAPI] 响应状态: ${r.status} ${r.statusText} (耗时 ${elapsed}ms)`);

            if (r.status === 200) {
                const text = await r.text();
                log(`[PlayAPI] 响应内容 (raw): ${text}`);
                log(`[PlayAPI] 响应大小: ${text.length} 字节`);

                if (text && text !== '{}') {
                    try {
                        const data = JSON.parse(text);
                        log(`[PlayAPI] 解析后的 JSON 对象:`, data);

                        // 尝试找出视频 URL
                        let found = false;
                        ['source', 'sources', 'url', 'm3u8', 'playlist', 'hlsUrl', 'videoUrl', 'streamUrl',
                         'data', 'src', 'file', 'link', 'path', 'uri', 'location'].forEach(key => {
                            if (data[key]) {
                                const val = data[key];
                                if (Array.isArray(val)) {
                                    log(`[PlayAPI] ✓ 找到数组字段 "${key}": ${JSON.stringify(val).slice(0, 200)}`);
                                } else if (typeof val === 'string') {
                                    log(`[PlayAPI] ✓ 找到 URL 字段 "${key}": ${val.slice(0, 200)}`);
                                } else {
                                    log(`[PlayAPI] ✓ 找到对象字段 "${key}":`, val);
                                }
                                found = true;
                            }
                        });

                        if (!found) {
                            warn(`[PlayAPI] 所有已知字段都不匹配, 全部键: ${Object.keys(data).join(', ')}`);
                            // 尝试将整个响应视为 URL
                            if (typeof data === 'string') {
                                VIDEOS.push({ url: data, resolution: 'api', segments: [], duration: 0 });
                                log('[PlayAPI] 整个响应就是 URL');
                                updateUI();
                                return;
                            }
                        }

                        // 提取 URL
                        const videoUrl = data.source || data.url || data.m3u8 || data.playlist ||
                                        (Array.isArray(data.sources) ? data.sources[0]?.url || data.sources[0] : null) ||
                                        data.data || data.src || data.file || data.videoUrl ||
                                        data.streamUrl || data.hlsUrl || data.link || data.path || data.uri || data.location;
                        if (videoUrl) {
                            const urlStr = typeof videoUrl === 'string' ? videoUrl : (videoUrl.url || videoUrl);
                            VIDEOS.push({ url: urlStr, resolution: 'api', segments: [], duration: 0 });
                            log(`[PlayAPI] ✓ 成功获取视频 URL: ${urlStr.slice(0, 150)}`);
                            updateUI();
                        } else {
                            warn('[PlayAPI] 未能在响应中找到视频 URL');
                        }
                    } catch (e) {
                        // 不是 JSON？可能就是纯文本 URL
                        if (text.includes('m3u8') || text.includes('.mp4') || text.startsWith('http')) {
                            VIDEOS.push({ url: text.trim(), resolution: 'api', segments: [], duration: 0 });
                            log(`[PlayAPI] 响应不是 JSON, 按纯文本 URL 处理: ${text.trim().slice(0, 150)}`);
                            updateUI();
                        } else {
                            warn(`[PlayAPI] 响应不是 JSON 也不是 URL: ${text.slice(0, 100)}`);
                        }
                    }
                } else {
                    log('[PlayAPI] 响应为空对象 {}，前端可能通过其他方式获取源');
                }
            } else {
                warn(`[PlayAPI] 非 200 响应: ${r.status}`);
                const text = await r.text().catch(() => '');
                if (text) log(`[PlayAPI] 响应体: ${text.slice(0, 200)}`);
            }
        } catch (e) {
            err('[PlayAPI] 请求异常:', e.message);
        }
        log('[PlayAPI] ===== Play API 调用结束 =====');
    }

    // ================================================================
    // 解密 ev 字段 —— 返回 m3u8 播放列表 URL
    // ================================================================
    function decodeEV() {
        log('[EV] ===== 尝试解密 ev 字段 =====');
        try {
            const data = getNextData();
            if (!data) {
                log('[EV] 无 __NEXT_DATA__');
                return null;
            }
            const ev = data.props?.pageProps?.ev;
            if (!ev) {
                log('[EV] 页面数据中无 ev 字段');
                return null;
            }

            log(`[EV] d 长度: ${ev.d?.length}, k 值: ${ev.k}`);

            const raw = atob(ev.d);
            log(`[EV] Base64 解码后长度: ${raw.length}`);

            const decrypted = raw.split('')
                .map(c => String.fromCharCode(c.charCodeAt(0) - ev.k))
                .join('');
            log(`[EV] XOR 解密后原文: ${decrypted}`);

            const parsed = JSON.parse(decrypted);
            log(`[EV] ✓ 解密成功, 字段: ${Object.keys(parsed).join(', ')}`);
            log(`[EV] 完整解密数据:`, parsed);

            // 逐一输出每个字段
            Object.keys(parsed).forEach(key => {
                const val = parsed[key];
                if (typeof val === 'string') {
                    log(`[EV]   ${key}: ${val.slice(0, 200)}`);
                } else {
                    log(`[EV]   ${key}:`, JSON.stringify(val).slice(0, 300));
                }
            });

            if (parsed.videoUrl) {
                log(`[EV] ✓ 获取到 m3u8 URL: ${parsed.videoUrl.slice(0, 150)}`);
                // 检查 URL 画质
                const resMatch = parsed.videoUrl.match(/-(\d+)\//);
                if (resMatch) log(`[EV]   URL 中画质: ${resMatch[1]}p`);
            }
            return parsed;
        } catch (e) {
            err('[EV] 解密失败:', e.message);
            return null;
        }
    }

    // ================================================================
    // 用解密出的 EV URL 直接下载 m3u8 并解析
    // ================================================================
    async function fetchM3U8FromEV(evData) {
        if (!evData?.videoUrl) {
            log('[EV-Fetch] 无 videoUrl, 跳过');
            return;
        }
        const url = evData.videoUrl;
        log('[EV-Fetch] ===== 开始从 EV 获取 m3u8 内容 =====');
        log(`[EV-Fetch] URL: ${url.slice(0, 150)}`);

        try {
            const r = await fetch(url);
            const content = await r.text();
            log(`[EV-Fetch] 响应状态: ${r.status}, 内容长度: ${content.length}`);
            log(`[EV-Fetch] 前 60 字符: "${content.slice(0, 60)}"`);

            if (content.startsWith('#EXTM3U')) {
                log(`[EV-Fetch] ✓ 确认是 m3u8 内容`);
                parseM3U8(content, url);
                updateUI();
            } else {
                log(`[EV-Fetch] × 内容不是 m3u8 格式`);
            }
        } catch (e) {
            err('[EV-Fetch] 获取失败:', e.message);
        }
        log('[EV-Fetch] ===== 完成 =====');
    }

    // ================================================================
    // 解析 m3u8 内容
    // ================================================================
    function parseM3U8(m3u8Text, requestUrl) {
        log(`[解析] ===== 开始解析 m3u8 =====`);
        log(`[解析] 来源 URL: ${requestUrl?.slice(0, 150)}`);
        log(`[解析] m3u8 全文内容:\n${m3u8Text}`);

        const lines = m3u8Text.split('\n');
        log(`[解析] 共 ${lines.length} 行`);

        // ================================================================
        // 【诊断】检测是否为主播放列表（多分辨率变体流）
        // ================================================================
        const hasStreamInf = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));
        if (hasStreamInf) {
            log('[诊断] ===== 检测到主播放列表 (Master Playlist)! 包含多分辨率变体流 =====');
            const variants = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (line.startsWith('#EXT-X-STREAM-INF:')) {
                    const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
                    const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                    const nextLine = lines[i + 1]?.trim();
                    const variantInfo = {
                        resolution: resMatch ? resMatch[1] : 'unknown',
                        bandwidth: bwMatch ? bwMatch[1] : 'unknown',
                        url: nextLine || 'unknown',
                        lineIndex: i,
                    };
                    variants.push(variantInfo);
                    log(`[诊断]   变体 #${variants.length}: ${variantInfo.resolution}, ${variantInfo.bandwidth}b/s, URL=${variantInfo.url?.slice(0, 120)}`);
                }
            }
            log(`[诊断] 共 ${variants.length} 个变体流`);
            log(`[诊断] ===== 主播放列表诊断结束 =====`);
            // 仍然尝试解析片段（但主列表本身没有片段）
        }

        // ================================================================
        // 常规解析：片段列表
        // ================================================================
        let segments = [];
        let duration = 0;
        let hasKey = false;
        let keyUrl = null;
        let targetDuration = 0;

        // 提取 resolution
        const resMatch = requestUrl?.match(/-(\d+)\.jpg/) || requestUrl?.match(/-(\d+)\//);
        const resolution = resMatch ? parseInt(resMatch[1]) : 0;
        log(`[解析] 检测到分辨率: ${resolution}p`);

        // 定位到资源目录
        const dirMatch = requestUrl?.match(/^(https:\/\/[^/]+\/hls\/[^/]+\/)[^/]+/);
        const dirUrl = dirMatch ? dirMatch[1] : '';
        log(`[解析] 资源目录: ${dirUrl}`);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                targetDuration = parseFloat(line.split(':')[1]);
                log(`[解析] 目标时长: ${targetDuration}s`);
            } else if (line.startsWith('#EXT-X-KEY')) {
                hasKey = true;
                const keyMatch = line.match(/URI="([^"]+)"/);
                if (keyMatch) {
                    keyUrl = keyMatch[1];
                    warn(`[解析] ⚠️ 视频已加密! KEY URI: ${keyUrl}`);
                }
                log(`[解析] 第 ${i} 行: 加密密钥定义 - ${line}`);
            } else if (line.startsWith('#EXTINF:')) {
                const secMatch = line.match(/[\d.]+/);
                const sec = secMatch ? parseFloat(secMatch[0]) : 0;
                duration += sec;
                if (i % 20 === 0) {
                    log(`[解析] 片段时长累计: ${duration.toFixed(1)}s (进度 ${i}/${lines.length})`);
                }
            } else if (line.startsWith('http')) {
                segments.push(line);
            } else if (line.endsWith('.jpg') && !line.startsWith('#')) {
                segments.push(line);
            }
        }

        log(`[解析] 解析完成:`);
        log(`[解析]   - 分辨率: ${resolution}p`);
        log(`[解析]   - 片段数: ${segments.length}`);
        log(`[解析]   - 总时长: ${duration.toFixed(1)}s`);
        log(`[解析]   - 加密: ${hasKey ? '是 (KEY: ' + keyUrl + ')' : '否 ✓'}`);

        if (hasKey) {
            warn('[解析] ⚠️ 视频已加密, 当前下载功能不支持解密!');
        }

        if (segments.length > 0) {
            log(`[解析] 第一个片段: ${segments[0].slice(0, 150)}`);
            log(`[解析] 最后片段: ${segments[segments.length - 1].slice(0, 150)}`);

            const entry = {
                playlist: requestUrl,
                dir: dirUrl,
                segments: segments,
                duration: duration,
                resolution: resolution,
                hasKey: hasKey,
                keyUrl: keyUrl,
            };
            VIDEOS.push(entry);
            log(`[解析] ✓ 已添加到视频列表 #${VIDEOS.length - 1}`);
        } else {
            if (!hasStreamInf) {
                warn('[解析] × 未解析到任何片段!');
            } else {
                log('[解析] 主播放列表无片段（正常行为），变体流需要分别下载');
            }
        }

        log(`[解析] ===== m3u8 解析结束 =====`);
    }

    // ================================================================
    // 生成完整的 m3u8 文件内容
    // ================================================================
    function generateM3U8Content(entry) {
        log(`[生成] 生成 m3u8 文件, 共 ${entry.segments.length} 个片段`);
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:10`];
        let totalDur = 0;
        for (const seg of entry.segments) {
            const fullUrl = seg.startsWith('http') ? seg : entry.dir + seg;
            totalDur += 10;
            lines.push(`#EXTINF:10,`, fullUrl);
        }
        lines.push('#EXT-X-ENDLIST');
        log(`[生成] 完成, 共 ${lines.length} 行`);
        return lines.join('\n');
    }

    // ================================================================
    // UI - 可拖动 + 移动端适配
    // ================================================================
    function isMobile() {
        return window.innerWidth < 768 || 'ontouchstart' in window;
    }

    function createUI() {
        if (UI_CTNR) return;
        log('[UI] 创建下载面板...');

        const mobile = isMobile();
        const panelW = mobile ? 'min(96vw, 360px)' : '340px';
        const topPos = mobile ? '10px' : '80px';

        UI_CTNR = document.createElement('div');
        UI_CTNR.id = 'rou-dl3';
        Object.assign(UI_CTNR.style, {
            position:'fixed', top:topPos, right: mobile ? '2vw' : '20px', zIndex:'99999',
            background:'rgba(0,0,0,0.92)', color:'#fff', padding:'0',
            borderRadius:'10px', width: panelW,
            fontFamily:'Segoe UI, Arial, sans-serif',
            boxShadow:'0 0 20px rgba(255,107,107,0.4)',
            border:'2px solid #ff6b6b', maxHeight:'75vh', overflow:'hidden',
            userSelect:'none', WebkitUserSelect:'none',
        });

        // ---- 标题栏（拖动把手） ----
        const header = document.createElement('div');
        Object.assign(header.style, {
            padding:'10px 14px', cursor:'grab', background:'rgba(255,107,107,0.15)',
            borderBottom:'1px solid rgba(255,107,107,0.3)',
            display:'flex', justifyContent:'space-between', alignItems:'center',
            fontSize: mobile ? '15px' : '14px', fontWeight:'700', color:'#ff6b6b',
        });
        header.innerHTML = '<span>🔽 Rou.video 下载</span><span style="font-size:11px;color:#888;font-weight:400">↕ 拖动</span>';
        UI_CTNR.appendChild(header);

        // ---- 状态栏 ----
        const s = document.createElement('div');
        s.id = 'rou-dl3-status';
        s.textContent = '⏳ 等待视频加载...';
        Object.assign(s.style, {
            fontSize: mobile ? '13px' : '12px', color:'#aaa',
            padding:'8px 14px 0', marginBottom:'4px',
        });
        UI_CTNR.appendChild(s);

        // ---- 列表区（可滚动） ----
        const list = document.createElement('div');
        list.id = 'rou-dl3-list';
        Object.assign(list.style, {
            padding:'4px 10px 10px', maxHeight: mobile ? '50vh' : '55vh',
            overflowY:'auto', fontSize: mobile ? '13px' : '12px',
        });
        UI_CTNR.appendChild(list);

        // ---- 导出日志按钮 ----
        const logBtn = document.createElement('button');
        logBtn.textContent = '📄 导出调试日志';
        Object.assign(logBtn.style, {
            margin:'4px 10px 10px', width:'calc(100% - 20px)',
            padding: mobile ? '10px' : '6px', borderRadius:'4px',
            border:'1px solid #666', background:'transparent', color:'#ccc',
            cursor:'pointer', fontSize: mobile ? '14px' : '11px',
        });
        logBtn.onclick = exportLogs;
        UI_CTNR.appendChild(logBtn);

        document.body.appendChild(UI_CTNR);

        // ================================================================
        // 拖动逻辑（鼠标 + 触摸）
        // ================================================================
        let isDragging = false;
        let startX, startY, origLeft, origTop;

        function onDragStart(px, py) {
            isDragging = true;
            header.style.cursor = 'grabbing';
            const rect = UI_CTNR.getBoundingClientRect();
            startX = px;
            startY = py;
            origLeft = rect.left;
            origTop = rect.top;
        }

        function onDragMove(px, py) {
            if (!isDragging) return;
            const dx = px - startX;
            const dy = py - startY;
            UI_CTNR.style.left = origLeft + dx + 'px';
            UI_CTNR.style.top = origTop + dy + 'px';
            UI_CTNR.style.right = 'auto';
        }

        function onDragEnd() {
            isDragging = false;
            header.style.cursor = 'grab';
        }

        // 鼠标事件
        header.addEventListener('mousedown', e => {
            e.preventDefault();
            onDragStart(e.clientX, e.clientY);
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
        function onMouseMove(e) { onDragMove(e.clientX, e.clientY); }
        function onMouseUp() {
            onDragEnd();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        // 触摸事件
        header.addEventListener('touchstart', e => {
            const t = e.touches[0];
            onDragStart(t.clientX, t.clientY);
        }, { passive: true });
        header.addEventListener('touchmove', e => {
            const t = e.touches[0];
            onDragMove(t.clientX, t.clientY);
        }, { passive: true });
        header.addEventListener('touchend', onDragEnd, { passive: true });

        log('[UI] 面板已添加到页面（可拖动 + 移动端适配）');
    }

    // ---- 移动端下按钮加大 ----
    function mobileBtnStyle(extra) {
        const mobile = isMobile();
        return mobile
            ? Object.assign({ display:'block', width:'100%', marginBottom:'6px',
                padding:'10px', fontSize:'14px', borderRadius:'4px',
                border:'none', cursor:'pointer', textAlign:'center' }, extra)
            : extra;
    }

    function updateUI() {
        createUI();
        const st = document.getElementById('rou-dl3-status');
        const li = document.getElementById('rou-dl3-list');
        if (!st || !li) return;

        st.textContent = VIDEOS.length > 0 ? `✓ ${VIDEOS.length} 个视频源` : '⏳ 等待视频加载...';

        li.innerHTML = VIDEOS.length === 0
            ? '<div style="color:#aaa;font-size:12px;padding:8px">播放视频后自动出现...</div>'
            : VIDEOS.map((v, i) => renderEntry(v, i)).join('');
    }

    function renderEntry(v, i) {
        const mobile = isMobile();
        const res = v.resolution ? `${v.resolution}p` : '?';
        const segInfo = v.segments?.length ? `📦 ${v.segments.length} 片段` : '';
        const durInfo = v.duration ? `⏱ ${v.duration.toFixed(0)}s` : '';
        const encInfo = v.hasKey ? '🔒 加密' : '✅ 无加密';

        let html = `<div style="margin-bottom:8px;padding:${mobile ? '10px' : '8px'};background:rgba(255,255,255,0.07);border-radius:6px;border:1px solid rgba(255,107,107,0.3)">`;
        html += `<div style="font-weight:bold;color:#4ecdc4;margin-bottom:4px;font-size:${mobile ? '14px' : '12px'}">#${i+1} [${res}] ${segInfo} ${durInfo} ${encInfo}</div>`;

        if (v.segments?.length) {
            if (v.segments.length > 0 && !mobile) {
                const firstSeg = v.segments[0].slice(0, 60);
                const lastSeg = v.segments[v.segments.length - 1].slice(0, 60);
                html += `<div style="font-size:10px;color:#666;margin-bottom:6px">首: ${firstSeg}...<br>尾: ${lastSeg}...</div>`;
            }
            const btnFont = mobile ? '14px' : '11px';
            const btnPad = mobile ? '10px 12px' : '5px 10px';
            html += `<button class="rou-dl-btn" data-i="${i}" data-action="dl-m3u8" style="background:#4ecdc4;color:#000;border:none;padding:${btnPad};border-radius:4px;cursor:pointer;font-size:${btnFont};margin-right:4px;${mobile?'width:48%;display:inline-block':''}">💾 保存 .m3u8</button>`;
            html += `<button class="rou-dl-btn" data-i="${i}" data-action="dl-mp4" style="background:#ff6b6b;color:#fff;border:none;padding:${btnPad};border-radius:4px;cursor:pointer;font-size:${btnFont};${mobile?'width:48%;display:inline-block':''}">⚡ 下载 MP4</button>`;
        }

        html += ` <button class="rou-dl-btn" data-i="${i}" data-action="copy-m3u8" style="background:transparent;color:#4ecdc4;border:1px solid #4ecdc4;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px">📋 复制 m3u8</button>`;
        html += `</div>`;
        return html;
    }

    // ================================================================
    // 导出调试日志
    // ================================================================
    function exportLogs() {
        log('[导出] 用户请求导出调试日志...');
        const content = logBuffer.join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `RouDL_debug_${VIDEO_ID || 'unknown'}_${Date.now()}.log`;
        a.click();
        URL.revokeObjectURL(url);
        log(`[导出] 日志已保存, 共 ${logBuffer.length} 行`);
        GM_notification(`日志已导出 (${logBuffer.length} 行)`, '📄 导出完成');
    }

    // ================================================================
    // 获取视频标题（用于文件名）
    // ================================================================
    function getVideoTitle() {
        try {
            const data = getNextData();
            if (data?.props?.pageProps?.video?.title) {
                let title = data.props.pageProps.video.title;
                // 去掉网站标题后缀：找最后一个 " - " 之前的内容
                const lastSplit = title.lastIndexOf(' - ');
                if (lastSplit !== -1) {
                    title = title.substring(0, lastSplit);
                }
                return title.replace(/[/<>:"|?*]/g, '_').trim();
            }
        } catch (e) { /* 静默 */ }
        
        // 备选：从 <title> 提取
        try {
            let title = document.title;
            // 同样找最后一个 " - " 之前的内容
            const lastSplit = title.lastIndexOf(' - ');
            if (lastSplit !== -1) {
                title = title.substring(0, lastSplit);
            }
            return title.replace(/[/<>:"|?*]/g, '_').trim();
        } catch (e) { /* 静默 */ }
        
        return null;
    }

    // ================================================================
    // 下载逻辑
    // ================================================================
    function downloadM3U8(entry, i) {
        log(`[下载] ===== 保存 .m3u8 文件 (画质 #${i}) =====`);
        const content = generateM3U8Content(entry);
        log(`[下载] m3u8 大小: ${content.length} 字节`);
        const blob = new Blob([content], { type: 'application/vnd.apple.mpegurl' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // 生成文件名：优先用视频标题，否则用视频ID
        let baseFileName = getVideoTitle() || VIDEO_ID || 'video';
        const filename = `${baseFileName}_${entry.resolution || i}p.m3u8`;
        
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        log(`[下载] ✓ 已保存: ${filename}`);
        GM_notification(`已保存: ${filename}`, '💾');
    }

    async function downloadMP4(entry, i) {
        log(`[下载] ===== 开始下载并合并 MP4 (画质 #${i}) =====`);
        log(`[下载] 目标: ${entry.segments.length} 个 TS 片段`);
        log(`[下载] 总时长: ${(entry.duration || 0).toFixed(0)}s`);

        if (entry.hasKey) {
            err('[下载] × 无法下载: 视频已加密，不支持解密');
            GM_notification('视频已加密，不支持下载', '❌ 错误');
            return;
        }

        if (!entry.segments?.length) {
            warn('[下载] 没有片段数据');
            return;
        }

        const st = document.getElementById('rou-dl3-status');
        if (st) st.textContent = `⏳ 下载片段 (0/${entry.segments.length})...`;

        // 并行下载：一次并发 5 个请求
        const CONCURRENCY = 5;
        const blobs = [];
        const errors = [];
        const total = entry.segments.length;

        log(`[下载] 启动并行下载, 并发数=${CONCURRENCY}, 总片段数=${total}`);

        const segUrls = entry.segments.map((seg, idx) => ({
            idx,
            url: seg.startsWith('http') ? seg : entry.dir + seg,
        }));

        // 分批并行
        for (let start = 0; start < total; start += CONCURRENCY) {
            const batch = segUrls.slice(start, start + CONCURRENCY);
            log(`[下载] 并行批次: ${start}-${Math.min(start + CONCURRENCY - 1, total - 1)}`);

            const results = await Promise.allSettled(
                batch.map(async ({ idx, url }) => {
                    try {
                        const blob = await fetchViaGM(url);
                        if (blob && blob.size > 0) {
                            return { idx, blob };
                        } else {
                            throw new Error('空内容');
                        }
                    } catch (e) {
                        throw { idx, err: e.message };
                    }
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled') {
                    const { idx, blob } = r.value;
                    blobs[idx] = blob;
                } else {
                    const reason = r.reason;
                    const idx = reason.idx !== undefined ? reason.idx : errors.length;
                    errors.push(`片段 ${idx} ${reason.err || '未知错误'}`);
                    err(`[下载] 片段 ${idx} 下载失败: ${reason.err || '未知错误'}`);
                }
            }

            const downloaded = blobs.filter(Boolean).length;
            if (st) st.textContent = `⏳ 下载片段 (${downloaded}/${total})...`;
        }

        // 过滤掉失败的空位
        const successBlobs = blobs.filter(Boolean);
        log(`[下载] 下载完成: 成功 ${successBlobs.length}/${total} 片段, 失败 ${errors.length}`);

        if (successBlobs.length === 0) {
            err('[下载] × 所有片段都下载失败');
            GM_notification('所有片段下载失败', '❌ 错误');
            if (st) st.textContent = '❌ 下载全部失败';
            return;
        }

        // 合并
        if (st) st.textContent = `⏳ 合并 ${successBlobs.length} 个片段...`;
        log(`[下载] 开始合并 ${successBlobs.length} 个片段...`);
        const totalSize = successBlobs.reduce((s, b) => s + b.size, 0);
        log(`[下载] 总大小: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

        const merged = new Blob(successBlobs, { type: 'video/mp4' });
        log(`[下载] 合并后大小: ${(merged.size / 1024 / 1024).toFixed(2)} MB`);

        // 提供下载
        const mergedUrl = URL.createObjectURL(merged);
        const a = document.createElement('a');
        
        // 生成文件名：优先用视频标题，否则用视频ID
        let baseFileName = getVideoTitle() || VIDEO_ID || 'video';
        const filename = `${baseFileName}_${entry.resolution || i}p.mp4`;
        
        a.href = mergedUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(mergedUrl);
        log(`[下载] ✓ 已保存: ${filename}`);

        if (st) {
            const errorInfo = errors.length > 0 ? `, ⚠️ ${errors.length} 片段失败` : '';
            st.textContent = `✓ 完成! ${(totalSize / 1024 / 1024).toFixed(1)}MB${errorInfo}`;
        }
        GM_notification(`下载完成: ${(totalSize / 1024 / 1024).toFixed(1)}MB`, '🎉 成功');
        log('[下载] ===== 下载完成 =====');
    }

    function fetchViaGM(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        resolve(r.response);
                    } else {
                        reject(new Error(`HTTP ${r.status}`));
                    }
                },
                onerror: ev => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout (60s)')),
                timeout: 60000,
            });
        });
    }

    function copyM3U8(entry) {
        log('[复制] 复制 m3u8 内容到剪贴板...');
        const content = generateM3U8Content(entry);
        navigator.clipboard.writeText(content).then(() => {
            log('[复制] ✓ 已复制');
            GM_notification('m3u8 已复制到剪贴板', '📋');
        }).catch(e => {
            err('[复制] 复制失败:', e.message);
        });
    }

    // ================================================================
    // 事件绑定
    // ================================================================
    document.addEventListener('click', function(e) {
        const btn = e.target.closest('.rou-dl-btn');
        if (!btn) return;
        const i = parseInt(btn.dataset.i);
        const action = btn.dataset.action;
        const entry = VIDEOS[i];
        if (!entry) {
            warn(`[事件] 按钮索引 ${i} 未找到对应视频源`);
            return;
        }

        log(`[事件] 用户点击: ${action}, 画质 #${i}`);
        if (action === 'dl-m3u8') downloadM3U8(entry, i);
        else if (action === 'dl-mp4') downloadMP4(entry, i);
        else if (action === 'copy-m3u8') copyM3U8(entry);
    });

    // ================================================================
    // 监听 DOM 变化（动态加载的播放器）
    // ================================================================
    function watchDOM() {
        log('[监听] 启动 DOM MutationObserver...');
        const observer = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                // 检测新加入的 video 标签
                for (const node of mut.addedNodes) {
                    if (node.nodeName === 'VIDEO' || (node.querySelectorAll && node.querySelectorAll('video').length > 0)) {
                        log('[监听] 检测到新 video 元素被添加到 DOM');
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('[监听] MutationObserver 已启动');
    }

    // ================================================================
    // 初始化
    // ================================================================
    function init() {
        log('========================================');
        log('Rou.video 下载助手 v3.5 启动');
        log('页面 URL:', window.location.href);
        log('页面标题:', document.title);
        log('User-Agent:', navigator.userAgent);
        log('========================================');

        // 检测视频 ID
        if (!detectVideoId()) return;

        // 获取视频元数据
        getVideoMeta();

        // 尝试解密 ev → 获取 m3u8 URL → 下载并解析
        const evData = decodeEV();
        if (evData?.videoUrl) {
            log('[init] ev 中有 videoUrl, 立即开始获取 m3u8...');
            fetchM3U8FromEV(evData);
        } else {
            log('[init] ev 中无 videoUrl, 等待播放器请求 m3u8');
        }

        // 创建 UI
        createUI();

        // 拦截网络
        hookAllNetwork();

        // DOM 监听
        watchDOM();

        // 【诊断】登录状态 + 页面数据转储
        logAuthState();
        dumpFullPageProps();

        // 延迟调用 Play API（带 Cookie）
        log('[init] 1.5s 后调用 Play API...');
        setTimeout(() => {
            log('[init] Play API 调用开始');
            callPlayAPI();
        }, 1500);

        // 定时扫描已完成的资源 — 增强版
        log('[init] 启动定时嗅探 (每 3s)...');
        setInterval(() => {
            try {
                const entries = performance.getEntriesByType('resource');
                for (const e of entries) {
                    const name = e.name;
                    if (name.includes('/hls/')) {
                        if (name.includes('/index.jpg')) {
                            log(`[定时] m3u8 资源: ${name.slice(0, 150)}`);
                        } else if (name.includes('/CLS-')) {
                            const segMatch = name.match(/CLS-(\d+)\.jpg/);
                            if (segMatch) log(`[定时] TS 片段 #${segMatch[1]}`);
                        }
                    }
                    // 捕获 Play API 请求
                    if (name.includes('/api/v/') && name.includes('/play')) {
                        log(`[定时] Play API 资源: ${name.slice(0, 150)}`);
                    }
                }
                // 扫描所有 video 元素
                const videos = document.querySelectorAll('video');
                if (videos.length > 0) {
                    videos.forEach((v, i) => {
                        if (v.src) log(`[定时] video[${i}] src: ${v.src.slice(0, 120)}`);
                    });
                }
            } catch (e) {}
        }, 3000);

        log('========================================');
        log('[init] 初始化完成！请播放视频');
        log('[init] 调试日志已开启，可在面板点击 [📄 导出调试日志] 保存');
        log('[init] 也可按 F12 → Console 查看实时日志');
        log('========================================');
    }

    // 页面加载完成后启动
    if (document.readyState === 'loading') {
        log('[init] 页面仍在加载，等待 DOMContentLoaded...');
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
