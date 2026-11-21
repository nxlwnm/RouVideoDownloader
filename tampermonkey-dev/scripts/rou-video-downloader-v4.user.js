// ==UserScript==
// @name         Rou.video 视频下载助手
// @namespace    http://tampermonkey.net/
// @version      4.2.0
// @description  下载 rou.video 视频：自动解析 PNG 伪装 HLS 流，重封装为标准 MP4（无跳帧），支持断点续传
// @author       You
// @match        https://rou.video/*
// @match        https://www.rou.video/*
// @match        https://https.rou.video/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      rou.video
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // 日志系统
    // ================================================================
    const LOG_PREFIX = '[RouDL]';
    const logBuffer = [];

    function push(level, args) {
        const msg = args.map(a => {
            if (typeof a === 'object' && a !== null) {
                try { return JSON.stringify(a); } catch (e) { return String(a); }
            }
            return String(a);
        }).join(' ');
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        logBuffer.push(`${ts} ${LOG_PREFIX}${level ? ' [' + level + ']' : ''} ${msg}`);
    }
    function log(...a) { push('', a); console.log(LOG_PREFIX, ...a); }
    function warn(...a) { push('WARN', a); console.warn(LOG_PREFIX, ...a); }
    function err(...a) { push('ERROR', a); console.error(LOG_PREFIX, ...a); }

    // ================================================================
    // 状态
    // ================================================================
    const STATE = {
        videoId: null,
        playlist: null,
        quality: null,
        chunks: null,      // Uint8Array[] 下载到的 TS 数据
        failed: [],
        busy: false,
        paused: false,
        cacheRestored: 0,  // 本次从 IndexedDB 恢复的分片数
        cacheBytes: 0,     // 已写入缓存的数据量
        cacheEnabled: true,
    };

    const CONCURRENCY = 6;
    const MAX_RETRY = 3;
    const MAX_CACHE_BYTES = 800 * 1024 * 1024; // 单个视频缓存上限 800MB

    // ================================================================
    // PNG 包装体解包
    // 站点把所有 HLS 响应（m3u8 + 每个分片）包装成 PNG，
    // 自定义 chunk 类型 'roUd'，首字节为 flags（bit0 = zlib 压缩）
    // ================================================================
    const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

    function isPng(bytes) {
        if (bytes.length < 8) return false;
        for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
        return true;
    }

    async function inflateZlib(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('当前浏览器不支持 DecompressionStream，请升级浏览器');
        }
        const ds = new DecompressionStream('deflate');
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function unwrapPayload(buffer) {
        let bytes;
        if (!buffer) throw new Error('响应为空');
        if (typeof Blob !== 'undefined' && buffer instanceof Blob) {
            bytes = new Uint8Array(await buffer.arrayBuffer());
        } else if (buffer instanceof ArrayBuffer) {
            bytes = new Uint8Array(buffer);
        } else if (ArrayBuffer.isView(buffer)) {
            bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        } else {
            throw new Error('未知的响应类型');
        }
        if (!isPng(bytes)) return bytes; // 未包装则原样返回

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let i = 8;
        while (i + 8 <= bytes.length) {
            const len = view.getUint32(i);
            const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
            const start = i + 8;
            if (start + len > bytes.length) break;
            if (type === 'roUd') {
                const flags = bytes[start];
                const body = bytes.subarray(start + 1, start + len);
                return (flags & 1) ? await inflateZlib(body) : body;
            }
            i = start + len + 4;
        }
        throw new Error('PNG 包装体中未找到 roUd 数据块');
    }

    // ================================================================
    // GM 网络请求
    // ================================================================
    function gmGet(url, opts) {
        opts = opts || {};
        const responseType = opts.responseType || 'arraybuffer';
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: responseType,
                timeout: opts.timeout || 90000,
                headers: Object.assign({ 'Referer': location.href }, opts.headers || {}),
                onload: r => resolve({
                    status: r.status,
                    data: r.response,
                    finalUrl: r.finalUrl || r.responseURL || url,
                    headers: r.responseHeaders || '',
                }),
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('请求超时')),
                onabort: () => reject(new Error('请求被中止')),
            });
        });
    }

    async function gmGetUnwrapped(url, opts) {
        const r = await gmGet(url, opts);
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return { data: await unwrapPayload(r.data), finalUrl: r.finalUrl };
    }

    // ================================================================
    // 播放列表解析
    // ================================================================
    function parsePlaylist(text, baseUrl) {
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const out = {
            isMaster: false, variants: [], segments: [],
            totalDuration: 0, targetDuration: 0, key: null, map: null,
        };
        let pendingDur = 0;
        let pendingVariant = null;

        for (const line of lines) {
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                out.isMaster = true;
                const res = line.match(/RESOLUTION=(\d+)x(\d+)/);
                const bw = line.match(/BANDWIDTH=(\d+)/);
                pendingVariant = {
                    width: res ? parseInt(res[1], 10) : 0,
                    height: res ? parseInt(res[2], 10) : 0,
                    bandwidth: bw ? parseInt(bw[1], 10) : 0,
                };
            } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                out.targetDuration = parseFloat(line.split(':')[1]) || 0;
            } else if (line.startsWith('#EXT-X-KEY')) {
                const method = (line.match(/METHOD=([^,]+)/) || [])[1];
                if (method && method !== 'NONE') {
                    out.key = {
                        method: method,
                        uri: (line.match(/URI="([^"]+)"/) || [])[1],
                        iv: (line.match(/IV=0x([0-9a-fA-F]+)/) || [])[1],
                    };
                }
            } else if (line.startsWith('#EXT-X-MAP')) {
                const uri = (line.match(/URI="([^"]+)"/) || [])[1];
                if (uri) out.map = new URL(uri, baseUrl).href;
            } else if (line.startsWith('#EXTINF:')) {
                const m = line.match(/#EXTINF:\s*([\d.]+)/);
                pendingDur = m ? parseFloat(m[1]) : 0;
            } else if (!line.startsWith('#')) {
                const abs = new URL(line, baseUrl).href;
                if (pendingVariant) {
                    out.variants.push(Object.assign({ url: abs }, pendingVariant));
                    pendingVariant = null;
                } else {
                    out.segments.push({ url: abs, duration: pendingDur });
                    out.totalDuration += pendingDur;
                    pendingDur = 0;
                }
            }
        }
        return out;
    }

    // ================================================================
    // 载入播放列表（/api/hls/{id} → 302 → CDN 上的伪装 PNG）
    // ================================================================
    async function loadPlaylist() {
        const apiUrl = `${location.origin}/api/hls/${STATE.videoId}`;
        log(`[列表] 请求 ${apiUrl}`);

        let r = await gmGetUnwrapped(apiUrl);
        let text = new TextDecoder('utf-8').decode(r.data);
        let baseUrl = r.finalUrl || apiUrl;
        log(`[列表] 响应 ${text.length} 字节, 落地地址: ${baseUrl}`);

        if (!text.startsWith('#EXTM3U')) {
            throw new Error('返回内容不是 m3u8 播放列表');
        }

        let list = parsePlaylist(text, baseUrl);

        // 主播放列表（多清晰度）→ 取最高
        if (list.isMaster && list.variants.length) {
            const best = list.variants.slice().sort((a, b) =>
                (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
            log(`[列表] 主播放列表，选择 ${best.width}x${best.height} @${best.bandwidth}`);
            const sub = await gmGetUnwrapped(best.url);
            text = new TextDecoder('utf-8').decode(sub.data);
            baseUrl = sub.finalUrl || best.url;
            list = parsePlaylist(text, baseUrl);
            list.quality = best.height || 0;
            STATE.quality = best.height || null;
        } else {
            const q = baseUrl.match(/-(\d+)\//) || list.segments[0].url.match(/-(\d+)\//);
            STATE.quality = q ? parseInt(q[1], 10) : null;
        }

        if (!list.segments.length) throw new Error('播放列表中没有可下载的分片');

        log(`[列表] 分片 ${list.segments.length} 个, 总时长 ${list.totalDuration.toFixed(1)}s, 画质 ${STATE.quality || '?'}p`);
        if (list.key) warn(`[列表] 分片已加密: ${list.key.method}`);
        if (list.map) warn('[列表] 检测到 fMP4 初始化段 (EXT-X-MAP)');
        return list;
    }

    // ================================================================
    // 分片下载（含重试 / AES-128 解密）
    // ================================================================
    let keyCache = null;
    async function getKeyBytes(key) {
        if (keyCache) return keyCache;
        const r = await gmGet(new URL(key.uri, location.href).href, { timeout: 30000 });
        if (r.status < 200 || r.status >= 300) throw new Error(`密钥请求失败 HTTP ${r.status}`);
        keyCache = new Uint8Array(r.data);
        return keyCache;
    }

    async function decryptAes128(bytes, key, ivHex, seq) {
        const keyBytes = await getKeyBytes(key);
        let iv;
        if (ivHex) {
            iv = new Uint8Array(ivHex.match(/.{2}/g).map(h => parseInt(h, 16)));
        } else {
            iv = new Uint8Array(16);
            const view = new DataView(iv.buffer);
            view.setUint32(12, seq, false);
        }
        const ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, ck, bytes);
        return new Uint8Array(out);
    }

    // ================================================================
    // 断点续传缓存（IndexedDB）
    // key = `${videoId}|${quality}|${total}|${index}`
    // 把分片总数写进 key，源站重新转码导致分片数变化时旧缓存自动失效。
    // ================================================================
    const IDB_NAME = 'rouDL';
    const IDB_STORE = 'segments';
    const IDB_VERSION = 1;
    let dbPromise = null;

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') { reject(new Error('不支持 IndexedDB')); return; }
            const req = indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('打开数据库失败'));
        }).catch(e => {
            STATE.cacheEnabled = false;
            warn(`[缓存] IndexedDB 不可用(${e.message})，本次不做断点续传`);
            return null;
        });
        return dbPromise;
    }

    function idbReq(store, mode, fn) {
        return openDb().then(db => {
            if (!db) return null;
            return new Promise((resolve, reject) => {
                let tx;
                try { tx = db.transaction(store, mode); } catch (e) { reject(e); return; }
                const req = fn(tx.objectStore(store));
                tx.oncomplete = () => resolve(req ? req.result : undefined);
                tx.onerror = () => reject(tx.error || new Error('事务失败'));
                tx.onabort = () => reject(tx.error || new Error('事务中止'));
            });
        });
    }

    const idbGet = key => idbReq(IDB_STORE, 'readonly', s => s.get(key));
    const idbPut = (key, val) => idbReq(IDB_STORE, 'readwrite', s => s.put(val, key));
    const idbKeys = () => idbReq(IDB_STORE, 'readonly', s => s.getAllKeys());
    const idbClear = () => idbReq(IDB_STORE, 'readwrite', s => s.clear());

    async function idbDeleteKeys(keys) {
        if (!keys.length) return;
        await idbReq(IDB_STORE, 'readwrite', s => { keys.forEach(k => s.delete(k)); });
    }

    function cachePrefix() {
        const total = STATE.playlist ? STATE.playlist.segments.length : 0;
        return `${STATE.videoId}|${STATE.quality || 0}|${total}|`;
    }
    function cacheKey(index) { return cachePrefix() + index; }

    // 写入队列：串行落盘，避免并发事务抢占
    const cacheQueue = [];
    let cacheDraining = false;

    function queueCache(index, data) {
        if (!STATE.cacheEnabled || !STATE.playlist) return;
        if (STATE.cacheBytes + data.length > MAX_CACHE_BYTES) {
            if (STATE.cacheEnabled) warn('[缓存] 已达上限，停止写入缓存');
            STATE.cacheEnabled = false;
            return;
        }
        STATE.cacheBytes += data.length;
        cacheQueue.push([index, data]);
        if (!cacheDraining) drainCache();
    }

    async function drainCache() {
        cacheDraining = true;
        while (cacheQueue.length) {
            const [index, data] = cacheQueue.shift();
            try {
                await idbPut(cacheKey(index), data.slice().buffer);
            } catch (e) {
                warn(`[缓存] 分片 #${index} 写入失败: ${e.message}`);
                STATE.cacheEnabled = false;
                cacheQueue.length = 0;
                break;
            }
        }
        cacheDraining = false;
    }

    async function waitCacheIdle() {
        while (cacheDraining || cacheQueue.length) {
            await new Promise(r => setTimeout(r, 60));
        }
    }

    // 从缓存恢复已下载分片（并清理分片总数不匹配的旧数据）
    async function restoreFromCache(total) {
        if (!STATE.cacheEnabled) return 0;
        let keys;
        try { keys = await idbKeys(); } catch (e) { warn('[缓存] 读取索引失败: ' + e.message); return 0; }
        if (!keys || !keys.length) return 0;

        const prefix = cachePrefix();
        const vidPrefix = `${STATE.videoId}|${STATE.quality || 0}|`;
        const stale = [];
        const valid = [];
        for (const k of keys) {
            if (typeof k !== 'string') continue;
            if (!k.startsWith(vidPrefix)) continue;
            if (k.startsWith(prefix)) valid.push(k); else stale.push(k);
        }
        if (stale.length) {
            await idbDeleteKeys(stale);
            log(`[缓存] 清理失效分片 ${stale.length} 个（分片总数已变化）`);
        }
        if (!valid.length) return 0;

        let restored = 0;
        for (const k of valid) {
            const idx = parseInt(k.slice(prefix.length), 10);
            if (!(idx >= 0 && idx < total)) continue;
            if (STATE.chunks[idx]) continue;
            try {
                const buf = await idbGet(k);
                if (buf && buf.byteLength) {
                    STATE.chunks[idx] = new Uint8Array(buf);
                    restored++;
                }
            } catch (e) { warn(`[缓存] 读取分片 #${idx} 失败: ${e.message}`); }
        }
        log(`[缓存] 从本地恢复 ${restored}/${total} 个分片`);
        return restored;
    }

    // 只统计可续传的分片数量（不读数据）
    async function countCached(total) {
        if (!STATE.cacheEnabled) return 0;
        try {
            const keys = await idbKeys();
            const prefix = cachePrefix();
            let n = 0;
            for (const k of keys) {
                if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
                const idx = parseInt(k.slice(prefix.length), 10);
                if (idx >= 0 && idx < total) n++;
            }
            return n;
        } catch (e) { return 0; }
    }

    async function clearCacheForCurrent() {
        if (!STATE.playlist) return;
        try {
            const keys = await idbKeys();
            const prefix = cachePrefix();
            const mine = (keys || []).filter(k => typeof k === 'string' && k.startsWith(prefix));
            await idbDeleteKeys(mine);
            STATE.cacheBytes = 0;
            log(`[缓存] 已清理本视频缓存 ${mine.length} 个分片`);
        } catch (e) { warn('[缓存] 清理失败: ' + e.message); }
    }

    async function clearAllCache() {
        try {
            const keys = await idbKeys();
            await idbClear();
            STATE.cacheBytes = 0;
            const n = (keys || []).length;
            log(`[缓存] 已清空全部缓存 (${n} 个分片)`);
            setStatus(`🧹 缓存已清空（${n} 个分片）`);
            notify('缓存已清空', '🧹 Rou.video');
        } catch (e) {
            err('[缓存] 清空失败: ' + e.message);
            setStatus('❌ 清空缓存失败: ' + e.message);
        }
    }

    async function fetchSegment(seg, index) {
        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
            try {
                const r = await gmGet(seg.url, { timeout: 60000 });
                if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
                let data = await unwrapPayload(r.data);
                if (STATE.playlist.key && STATE.playlist.key.method === 'AES-128') {
                    data = await decryptAes128(data, STATE.playlist.key, STATE.playlist.key.iv, index);
                }
                if (!data.length) throw new Error('空响应');
                return data;
            } catch (e) {
                lastErr = e;
                if (attempt < MAX_RETRY) {
                    await new Promise(res => setTimeout(res, 400 * Math.pow(2, attempt - 1)));
                }
            }
        }
        throw lastErr || new Error('下载失败');
    }

    async function downloadAllSegments() {
        const total = STATE.playlist.segments.length;
        if (!STATE.chunks || STATE.chunks.length !== total) STATE.chunks = new Array(total);
        STATE.failed = [];
        STATE.paused = false;
        STATE.cacheBytes = 0;
        updatePauseBtn();
        const t0 = Date.now();

        // 1) 恢复上次（含刷新页面/重开浏览器前）已下载的分片
        STATE.cacheRestored = await restoreFromCache(total);
        let doneBase = 0;
        for (let i = 0; i < total; i++) if (STATE.chunks[i]) doneBase++;
        if (doneBase) log(`[下载] 已有 ${doneBase}/${total} 个分片（本地缓存/内存），继续下载剩余部分`);

        // 2) 计算待下载列表
        let pending = [];
        for (let i = 0; i < total; i++) if (!STATE.chunks[i]) pending.push(i);
        log(`[下载] 待下载 ${pending.length} 个分片, 并发 ${CONCURRENCY}`);

        await runQueue(pending, doneBase, total);

        // 3) 仍然失败 → 可能是分片 URL 的 exp/auth 过期，重新拉取播放列表再试一轮
        if (STATE.failed.length && pending.length) {
            try {
                setProgress(doneBase / total, '下载地址可能已过期，正在重新获取…');
                const fresh = await loadPlaylist();
                if (fresh.segments.length === total) {
                    STATE.playlist = fresh;
                    const retry = STATE.failed.slice();
                    STATE.failed = [];
                    log(`[下载] 刷新播放列表后重试 ${retry.length} 个失败分片`);
                    await runQueue(retry, doneBase, total);
                } else {
                    warn('[下载] 刷新后分片数量变化，放弃重试');
                }
            } catch (e) {
                warn('[下载] 刷新播放列表失败: ' + e.message);
            }
        }

        await waitCacheIdle();

        const okBytes = STATE.chunks.reduce((s, c) => s + (c ? c.length : 0), 0);
        const okCount = STATE.chunks.filter(Boolean).length;
        log(`[下载] 完成: 成功 ${okCount}/${total}, ${(okBytes / 1048576).toFixed(2)} MB, ` +
            `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return STATE.failed.length === 0;
    }

    // 按索引队列并发下载，支持暂停/继续
    async function runQueue(indices, doneBase, total) {
        if (!indices.length) return;
        let ptr = 0;
        let done = 0;

        async function worker() {
            while (true) {
                while (STATE.paused) await new Promise(r => setTimeout(r, 150));
                const p = ptr++;
                if (p >= indices.length) return;
                const i = indices[p];
                if (STATE.chunks[i]) { done++; continue; }
                try {
                    const data = await fetchSegment(STATE.playlist.segments[i], i);
                    STATE.chunks[i] = data;
                    queueCache(i, data);
                } catch (e) {
                    if (!STATE.failed.includes(i)) STATE.failed.push(i);
                    err(`[下载] 分片 #${i} 失败: ${e.message}`);
                }
                done++;
                setProgress((doneBase + done) / total, `下载中 ${doneBase + done}/${total}`);
            }
        }

        const workers = [];
        for (let k = 0; k < Math.min(CONCURRENCY, indices.length); k++) workers.push(worker());
        await Promise.all(workers);
        STATE.failed.sort((a, b) => a - b);
    }

    // ================================================================
    // 合并 / 保存
    // ================================================================
    function getFilenameBase() {
        let title = '';
        try {
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content) title = og.content;
        } catch (e) { /* ignore */ }
        if (!title) title = document.title || '';
        // 去掉站点后缀："xxx - 肉視頻,您的私人AV影院"
        const idx = title.indexOf(' - ');
        if (idx > 0) title = title.substring(0, idx);
        title = title.replace(/[\/\\<>:"|?*\x00-\x1f]/g, '_').trim();
        if (!title) title = STATE.videoId || 'video';
        return title.slice(0, 80);
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 30000);
        log(`[保存] ${filename} (${(blob.size / 1048576).toFixed(2)} MB)`);
    }

    function notify(text, title) {
        try { if (typeof GM_notification === 'function') GM_notification(text, title); } catch (e) { /* ignore */ }
    }

    // 原始 TS 直拼
    function buildTsBlob() {
        const parts = STATE.chunks.filter(Boolean);
        return new Blob(parts, { type: 'video/mp2t' });
    }

    // 是否还有分片没拿到（缺失才需要走下载流程，已缓存则直接复用）
    function needDownload() {
        if (!STATE.playlist) return false;
        const total = STATE.playlist.segments.length;
        if (!STATE.chunks || STATE.chunks.length !== total) return true;
        for (let i = 0; i < total; i++) if (!STATE.chunks[i]) return true;
        return false;
    }

    // 文件已保存 → 按约定清理本地磁盘缓存（内存中的分片保留，方便会话内再导出一次）
    async function afterSaved() {
        await clearCacheForCurrent();
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function doDownloadMp4() {
        if (STATE.busy) return;
        if (!STATE.playlist) { setStatus('❌ 播放列表未就绪'); return; }
        STATE.busy = true;
        setButtonsEnabled(false);
        try {
            await downloadMp4InMemory();
        } catch (e) {
            err('[MP4] ' + e.message);
            setStatus(`❌ ${e.message}`);
            setProgress(0, '可再点「下载 MP4」重试');
            notify(e.message, '❌ Rou.video');
        } finally {
            STATE.busy = false;
            STATE.paused = false;
            setButtonsEnabled(true);
        }
    }

    // ---- 内存模式：全部下载后一次性 Blob 保存（支持断点续传） ----
    async function downloadMp4InMemory() {
        if (needDownload()) {
            const ok = await downloadAllSegments();
            if (!ok) {
                setStatus(`⚠️ ${STATE.failed.length} 个分片下载失败`);
                setProgress(0, '已中止：避免生成跳帧文件');
                throw new Error(`有 ${STATE.failed.length} 个分片下载失败，再次点击会从断点继续`);
            }
        }
        setProgress(0.98, '正在重封装为 MP4…');
        await sleep(30);

        const chunks = STATE.chunks.filter(Boolean);
        const base = getFilenameBase();
        let blob, name;

        if (STATE.playlist.map) {
            const init = await gmGetUnwrapped(STATE.playlist.map);
            blob = new Blob([init.data, ...chunks], { type: 'video/mp4' });
            name = `${base}_${STATE.quality || '?'}p.mp4`;
            log('[封装] fMP4 直拼');
        } else {
            const res = TS2MP4.remuxTsToMp4(chunks);
            log(`[封装] ${res.width}x${res.height}, ${res.videoFrames} 视频帧, ` +
                `${res.audioFrames} 音频帧, ${res.durationSec.toFixed(1)}s`);
            if (res.warnings.length) warn('[封装] ' + res.warnings.join('; '));
            blob = new Blob(res.parts, { type: 'video/mp4' });
            name = `${base}_${res.height}p.mp4`;
        }

        saveBlob(blob, name);
        setProgress(1, `✅ 完成 ${(blob.size / 1048576).toFixed(1)} MB`);
        setStatus(`✅ 已保存 ${name}`);
        notify('下载完成', '🎉 Rou.video');
        await afterSaved();
    }

    async function doDownloadTs() {
        if (STATE.busy) return;
        STATE.busy = true;
        setButtonsEnabled(false);
        try {
            if (!STATE.playlist) throw new Error('播放列表未就绪');
            if (needDownload()) {
                const ok = await downloadAllSegments();
                if (!ok) throw new Error(`有 ${STATE.failed.length} 个分片下载失败，再次点击会从断点继续`);
            }
            setProgress(0.99, '正在合并…');
            const blob = buildTsBlob();
            const name = `${getFilenameBase()}_${STATE.quality || '?'}p.ts`;
            saveBlob(blob, name);
            setProgress(1, `✅ 完成 ${(blob.size / 1048576).toFixed(1)} MB`);
            setStatus(`✅ 已保存 ${name}（原始 TS 流）`);
            await afterSaved();
        } catch (e) {
            err('[TS] ' + e.message);
            setStatus(`❌ ${e.message}`);
        } finally {
            STATE.busy = false;
            STATE.paused = false;
            setButtonsEnabled(true);
        }
    }

    // ================================================================
    // UI
    // ================================================================
    let UI = null;

    function isMobile() { return window.innerWidth < 768 || 'ontouchstart' in window; }

    function createUI() {
        if (UI) return;
        const mobile = isMobile();

        const root = document.createElement('div');
        root.id = 'rou-dl4';
        const boxStyle = {
            zIndex: '2147483000', color: '#e8e8e8',
            background: 'rgba(12,14,18,0.96)',
            border: '1px solid rgba(78,205,196,0.45)',
            boxShadow: '0 8px 28px rgba(0,0,0,0.55)',
            fontFamily: 'Segoe UI, system-ui, Arial, sans-serif',
            userSelect: 'none',
        };
        if (mobile) {
            // 移动端：默认收起为右下角小按钮，展开后是底部抽屉
            Object.assign(root.style, boxStyle, {
                position: 'fixed', top: 'auto', left: '0', right: '0', bottom: '0',
                width: '100%', maxHeight: '82vh', overflowY: 'auto', display: 'none',
                borderRadius: '14px 14px 0 0',
                paddingBottom: 'calc(8px + env(safe-area-inset-bottom, 0px))',
            });
        } else {
            Object.assign(root.style, boxStyle, {
                position: 'fixed', top: '80px', right: '20px', width: '336px',
                borderRadius: '10px', overflow: 'hidden',
            });
        }

        // 标题栏
        const header = document.createElement('div');
        Object.assign(header.style, {
            padding: mobile ? '12px 14px' : '9px 12px',
            cursor: mobile ? 'pointer' : 'grab', display: 'flex',
            justifyContent: 'space-between', alignItems: 'center', gap: '10px',
            background: 'linear-gradient(90deg, rgba(78,205,196,0.18), rgba(78,205,196,0.04))',
            borderBottom: '1px solid rgba(78,205,196,0.22)',
            fontSize: '13px', fontWeight: '700', color: '#4ecdc4',
        });
        const title = document.createElement('span');
        title.textContent = '🔽 Rou.video 下载';
        const hint = document.createElement('span');
        hint.textContent = mobile ? '收起 ✕' : '↕ 拖动';
        Object.assign(hint.style, { fontSize: '10px', color: '#7a8794', fontWeight: '400' });
        header.appendChild(title);
        header.appendChild(hint);
        root.appendChild(header);

        // 状态
        const status = document.createElement('div');
        status.id = 'rou-dl4-status';
        status.textContent = '⏳ 正在解析视频…';
        Object.assign(status.style, { fontSize: '12px', color: '#b9c4cf', padding: '9px 12px 2px', lineHeight: '1.5' });
        root.appendChild(status);

        // 进度条
        const barWrap = document.createElement('div');
        Object.assign(barWrap.style, {
            height: '5px', margin: '7px 12px 0', background: 'rgba(255,255,255,0.1)',
            borderRadius: '3px', overflow: 'hidden',
        });
        const bar = document.createElement('div');
        bar.id = 'rou-dl4-bar';
        Object.assign(bar.style, {
            height: '100%', width: '0%', borderRadius: '3px',
            background: 'linear-gradient(90deg,#4ecdc4,#5ee7a0)', transition: 'width 0.2s',
        });
        barWrap.appendChild(bar);
        root.appendChild(barWrap);

        // 进度文字
        const progText = document.createElement('div');
        progText.id = 'rou-dl4-prog';
        progText.textContent = '';
        Object.assign(progText.style, { fontSize: '11px', color: '#7a8794', padding: '5px 12px 0' });
        root.appendChild(progText);

        // 按钮区
        const btns = document.createElement('div');
        Object.assign(btns.style, { padding: '10px 12px 6px', display: 'flex', flexWrap: 'wrap', gap: '8px' });

        function mkBtn(id, text, bg, color, flex) {
            const b = document.createElement('button');
            b.id = id;
            b.textContent = text;
            Object.assign(b.style, {
                flex: flex || '1 1 46%', padding: mobile ? '11px 8px' : '8px 8px',
                borderRadius: '6px', border: 'none', cursor: 'pointer',
                fontSize: mobile ? '13px' : '12px', fontWeight: '600',
                background: bg, color: color, transition: 'filter 0.15s',
            });
            if (mobile) b.style.minHeight = '44px';
            b.onmouseenter = () => { b.style.filter = 'brightness(1.12)'; };
            b.onmouseleave = () => { b.style.filter = ''; };
            btns.appendChild(b);
            return b;
        }

        mkBtn('rou-dl4-mp4', '⚡ 下载 MP4', '#4ecdc4', '#06231f');
        mkBtn('rou-dl4-ts', '📦 下载 TS', 'rgba(255,107,107,0.9)', '#fff');
        mkBtn('rou-dl4-pause', '⏸ 暂停', 'rgba(255,200,80,0.9)', '#2a2000');
        mkBtn('rou-dl4-clear', '🧹 清空缓存', 'rgba(255,255,255,0.1)', '#cfd8e3');
        mkBtn('rou-dl4-reload', '🔄 重新检测', 'rgba(255,255,255,0.1)', '#cfd8e3', '1 1 100%');
        root.appendChild(btns);

        // 日志按钮
        const logBtn = document.createElement('button');
        logBtn.textContent = '📄 导出调试日志';
        Object.assign(logBtn.style, {
            margin: '0 12px 10px', width: 'calc(100% - 24px)', padding: mobile ? '10px' : '6px',
            borderRadius: '6px', border: '1px solid rgba(255,255,255,0.16)',
            background: 'transparent', color: '#8b98a5', cursor: 'pointer', fontSize: '11px',
        });
        if (mobile) logBtn.style.minHeight = '44px';
        logBtn.onclick = exportLogs;
        root.appendChild(logBtn);

        document.body.appendChild(root);
        UI = root;

        // 移动端：小按钮 + 遮罩 + 抽屉开合
        if (mobile) {
            const backdrop = document.createElement('div');
            backdrop.id = 'rou-dl4-backdrop';
            Object.assign(backdrop.style, {
                position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
                background: 'rgba(0,0,0,0.45)', zIndex: '2147482999', display: 'none',
            });
            document.body.appendChild(backdrop);

            const mini = document.createElement('button');
            mini.id = 'rou-dl4-mini';
            mini.textContent = '🔽 下载';
            Object.assign(mini.style, {
                position: 'fixed',
                right: 'calc(14px + env(safe-area-inset-right, 0px))',
                bottom: 'calc(14px + env(safe-area-inset-bottom, 0px))',
                zIndex: '2147483000', padding: '12px 18px', minHeight: '44px',
                borderRadius: '24px', border: '1px solid rgba(78,205,196,0.6)',
                background: 'rgba(12,14,18,0.94)', color: '#4ecdc4',
                fontSize: '13px', fontWeight: '700', boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
            });
            document.body.appendChild(mini);

            const showSheet = () => {
                root.style.display = 'block';
                backdrop.style.display = 'block';
                mini.style.display = 'none';
            };
            const hideSheet = () => {
                root.style.display = 'none';
                backdrop.style.display = 'none';
                mini.style.display = 'block';
            };
            mini.onclick = showSheet;
            header.onclick = hideSheet;
            backdrop.onclick = hideSheet;
        }

        // 拖动（仅 PC；移动端抽屉固定，避免与页面滚动冲突）
        if (!mobile) {
            let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
            const start = (x, y) => {
                dragging = true;
                header.style.cursor = 'grabbing';
                const rect = root.getBoundingClientRect();
                sx = x; sy = y; ox = rect.left; oy = rect.top;
            };
            const move = (x, y) => {
                if (!dragging) return;
                root.style.left = (ox + x - sx) + 'px';
                root.style.top = (oy + y - sy) + 'px';
                root.style.right = 'auto';
            };
            const end = () => { dragging = false; header.style.cursor = 'grab'; };

            header.addEventListener('mousedown', e => {
                e.preventDefault();
                start(e.clientX, e.clientY);
                const mm = ev => move(ev.clientX, ev.clientY);
                const mu = () => { end(); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
                document.addEventListener('mousemove', mm);
                document.addEventListener('mouseup', mu);
            });
        }

        // 事件
        document.getElementById('rou-dl4-mp4').onclick = doDownloadMp4;
        document.getElementById('rou-dl4-ts').onclick = doDownloadTs;
        document.getElementById('rou-dl4-pause').onclick = togglePause;
        document.getElementById('rou-dl4-clear').onclick = () => {
            if (confirm('确定清空本地断点续传缓存？已下载的分片会被删除。')) clearAllCache();
        };
        document.getElementById('rou-dl4-reload').onclick = () => {
            STATE.chunks = null;
            STATE.failed = [];
            STATE.cacheRestored = 0;
            startLoad();
        };
        updatePauseBtn();
    }

    function togglePause() {
        if (!STATE.busy) return;
        STATE.paused = !STATE.paused;
        updatePauseBtn();
        const el = document.getElementById('rou-dl4-prog');
        if (el) el.textContent = STATE.paused
            ? '⏸ 已暂停（已下载分片会保留，刷新页面也能继续）'
            : '▶ 继续下载…';
        log(`[下载] ${STATE.paused ? '用户暂停' : '用户继续'}`);
    }

    function updatePauseBtn() {
        const b = document.getElementById('rou-dl4-pause');
        if (!b) return;
        b.textContent = STATE.paused ? '▶ 继续' : '⏸ 暂停';
        b.disabled = !STATE.busy;
        b.style.opacity = STATE.busy ? '1' : '0.45';
        b.style.cursor = STATE.busy ? 'pointer' : 'default';
    }

    function setStatus(text) {
        const el = document.getElementById('rou-dl4-status');
        if (el) el.textContent = text;
    }

    function setProgress(ratio, text) {
        const bar = document.getElementById('rou-dl4-bar');
        if (bar) bar.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
        if (text !== undefined) {
            const t = document.getElementById('rou-dl4-prog');
            if (t) t.textContent = text;
        }
    }

    function setButtonsEnabled(on) {
        ['rou-dl4-mp4', 'rou-dl4-ts', 'rou-dl4-reload', 'rou-dl4-clear'].forEach(id => {
            const b = document.getElementById(id);
            if (b) { b.disabled = !on; b.style.opacity = on ? '1' : '0.45'; b.style.cursor = on ? 'pointer' : 'default'; }
        });
        updatePauseBtn();
    }

    function exportLogs() {
        const content = logBuffer.join('\n');
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `RouDL_log_${STATE.videoId || 'unknown'}_${Date.now()}.log`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        log(`[导出] 已导出 ${logBuffer.length} 行日志`);
    }

    // ================================================================
    // 流程控制
    // ================================================================
    async function startLoad() {
        createUI();
        const id = STATE.videoId;
        if (!id) {
            setStatus('当前不是视频页');
            setButtonsEnabled(false);
            return;
        }
        setButtonsEnabled(false);
        setProgress(0, '');
        setStatus(`⏳ 解析视频 ${id} …`);
        try {
            STATE.playlist = await loadPlaylist();
            const total = STATE.playlist.segments.length;
            const dur = STATE.playlist.totalDuration;
            const mm = Math.floor(dur / 60), ss = Math.round(dur % 60);
            const cached = await countCached(total);
            STATE.cacheRestored = 0;
            setStatus(`✅ 就绪 · ${STATE.quality ? STATE.quality + 'p' : '未知画质'} · ${total} 分片 · ` +
                `${mm}:${String(ss).padStart(2, '0')}${STATE.playlist.key ? ' · 🔒加密' : ''}` +
                `${cached ? ` · 💾已缓存 ${cached}/${total}` : ''}`);
            setProgress(0, cached
                ? `点「下载 MP4」从断点继续（还差 ${total - cached} 个分片）`
                : '点「下载 MP4」开始');
            setButtonsEnabled(true);
        } catch (e) {
            err('[解析] ' + e.message);
            setStatus(`❌ 解析失败: ${e.message}`);
            setProgress(0, '可点「重新检测」重试');
            setButtonsEnabled(true);
        }
    }

    function checkRoute() {
        const m = location.pathname.match(/^\/v\/([A-Za-z0-9]+)/);
        const id = m ? m[1] : null;
        if (id && id !== STATE.videoId) {
            STATE.videoId = id;
            STATE.playlist = null;
            STATE.chunks = null;
            STATE.failed = [];
            STATE.quality = null;
            STATE.paused = false;
            STATE.cacheRestored = 0;
            STATE.cacheBytes = 0;
            log(`[路由] 检测到视频 ${id}`);
            startLoad();
        } else if (!id && STATE.videoId) {
            STATE.videoId = null;
            STATE.playlist = null;
            setStatus('等待进入视频页…');
            setProgress(0, '');
        }
    }

    // ================================================================
    // TS → MP4 重封装核心
    // ================================================================
    // ===== TS2MP4-CORE-START =====
    const TS2MP4 = (function () {
        'use strict';

        function concatBytes(list) {
            let total = 0;
            for (let i = 0; i < list.length; i++) total += list[i].length;
            const out = new Uint8Array(total);
            let p = 0;
            for (let i = 0; i < list.length; i++) { out.set(list[i], p); p += list[i].length; }
            return out;
        }
        function u8(n) { return new Uint8Array([n & 0xff]); }
        function u16(n) { return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]); }
        function u32(n) { return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }
        function i32(n) { return u32(n >>> 0); }
        function fourcc(s) { return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]); }
        function concatAll(list) { return concatBytes(list.filter(Boolean)); }

        function box(type, ...parts) {
            const body = concatAll(parts);
            return concatBytes([u32(body.length + 8), fourcc(type), body]);
        }
        function fullBox(type, version, flags, ...parts) {
            return box(type, u8(version), u8((flags >>> 16) & 0xff), u8((flags >>> 8) & 0xff), u8(flags & 0xff), ...parts);
        }

        // ---------- 位读取 ----------
        function BitReader(bytes) { this.b = bytes; this.pos = 0; }
        BitReader.prototype.bit = function () {
            const byte = this.b[this.pos >> 3];
            if (byte === undefined) throw new Error('bitreader eof');
            const v = (byte >> (7 - (this.pos & 7))) & 1;
            this.pos++;
            return v;
        };
        BitReader.prototype.bits = function (n) {
            let v = 0;
            for (let i = 0; i < n; i++) v = v * 2 + this.bit();
            return v;
        };
        BitReader.prototype.ue = function () {
            let zeros = 0;
            while (this.bit() === 0) { if (++zeros > 31) throw new Error('bad ue'); }
            if (zeros === 0) return 0;
            return Math.pow(2, zeros) - 1 + this.bits(zeros);
        };
        BitReader.prototype.se = function () {
            const v = this.ue();
            return (v & 1) ? (v + 1) / 2 : -(v / 2);
        };

        function unescapeRbsp(bytes) {
            const out = new Uint8Array(bytes.length);
            let n = 0, zeros = 0;
            for (let i = 0; i < bytes.length; i++) {
                const b = bytes[i];
                if (zeros >= 2 && b === 3) { zeros = 0; continue; }
                out[n++] = b;
                zeros = b === 0 ? zeros + 1 : 0;
            }
            return out.subarray(0, n);
        }

        // sps: 完整 NAL（含 1 字节头）
        function parseSps(sps) {
            const rbsp = unescapeRbsp(sps.subarray(1));
            const r = new BitReader(rbsp);
            const profileIdc = r.bits(8);
            r.bits(8); r.bits(8); r.ue();
            let chromaFormatIdc = 1, separateColourPlane = 0;
            const high = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profileIdc) >= 0;
            if (high) {
                chromaFormatIdc = r.ue();
                if (chromaFormatIdc === 3) separateColourPlane = r.bit();
                r.ue(); r.ue(); r.bit();
                if (r.bit()) {
                    const count = chromaFormatIdc !== 3 ? 8 : 12;
                    for (let i = 0; i < count; i++) {
                        if (r.bit()) {
                            const size = i < 6 ? 16 : 64;
                            let last = 8, next = 8;
                            for (let j = 0; j < size; j++) {
                                if (next !== 0) next = (last + r.se() + 256) % 256;
                                last = next === 0 ? last : next;
                            }
                        }
                    }
                }
            }
            r.ue();
            const pocType = r.ue();
            if (pocType === 0) r.ue();
            else if (pocType === 1) { const n = r.ue(); for (let i = 0; i < n; i++) r.se(); r.se(); r.se(); }
            r.ue(); r.bit();
            const wMbs = r.ue() + 1;
            const hMap = r.ue() + 1;
            const frameMbsOnly = r.bit();
            if (!frameMbsOnly) r.bit();
            r.bit();
            let cL = 0, cR = 0, cT = 0, cB = 0;
            if (r.bit()) { cL = r.ue(); cR = r.ue(); cT = r.ue(); cB = r.ue(); }
            const chromaArray = separateColourPlane ? 0 : chromaFormatIdc;
            const subW = (chromaArray === 1 || chromaArray === 2) ? 2 : 1;
            const subH = (chromaArray === 1) ? 2 : 1;
            const width = wMbs * 16 - (cL + cR) * subW;
            const height = (2 - frameMbsOnly) * hMap * 16 - (cT + cB) * subH * (2 - frameMbsOnly);
            return { profileIdc, width, height };
        }

        // ---------- TS 解复用 ----------
        const AUDIO_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

        // 流式解复用器：可逐分片 push，状态（PES / 未完成 AU / 时间戳）跨分片保留
        function createTsDemuxer(onSample) {
            const st = {
                pmtPid: -1, video: null, audio: null,
                pes: {}, pendingVideo: null,
                sps: null, pps: null,
                curNals: [], curHasVcl: false, curKey: false,
                auPts: null, auDts: null, pendingTs: null,
                lastDts: null, lastDelta: 3003,
                lastAudioPts: null, audioCfg: null,
                prevPesPts: null, prevPesDts: null,
                videoFrames: 0, audioFrames: 0, warnings: [],
            };

            function readTs(b, o) {
                return ((b[o] & 0x0e) * 536870912) + ((b[o + 1] & 0xff) << 22) + ((b[o + 2] & 0xfe) << 14) +
                    ((b[o + 3] & 0xff) << 7) + ((b[o + 4] & 0xfe) >> 1);
            }

            function flushAu() {
                if (!st.curNals.length) return;
                let dts = st.auDts;
                if (dts == null || (st.lastDts != null && dts <= st.lastDts)) {
                    dts = st.lastDts == null ? 0 : st.lastDts + st.lastDelta;
                } else if (st.lastDts != null) {
                    st.lastDelta = dts - st.lastDts;
                }
                const pts = st.auPts == null ? dts : st.auPts;
                const size = st.curNals.reduce((s, n) => s + 4 + n.length, 0);
                const data = new Uint8Array(size);
                let p = 0;
                for (const nal of st.curNals) {
                    data[p++] = (nal.length >>> 24) & 0xff;
                    data[p++] = (nal.length >>> 16) & 0xff;
                    data[p++] = (nal.length >>> 8) & 0xff;
                    data[p++] = nal.length & 0xff;
                    data.set(nal, p); p += nal.length;
                }
                st.lastDts = dts;
                st.videoFrames++;
                onSample({ kind: 'video', data, dts: Math.round(dts), pts: Math.round(pts), key: st.curKey });
                st.curNals = [];
                st.curHasVcl = false;
                st.curKey = false;
                st.auPts = null;
                st.auDts = null;
            }

            function pushNal(nal) {
                const type = nal[0] & 0x1f;
                if (type === 7) st.sps = nal;
                else if (type === 8) st.pps = nal;
                const isVcl = type >= 1 && type <= 5;
                let newAu = false;
                if (st.curHasVcl) {
                    if (!isVcl && type !== 6) newAu = true;
                    else if (isVcl && (nal[1] & 0x80) !== 0) newAu = true;
                } else if (type === 9 && st.curNals.length) {
                    newAu = true;
                }
                if (newAu) flushAu();
                if (!st.curNals.length) {
                    const ts = st.pendingTs;
                    if (ts) { st.auPts = ts.pts; st.auDts = ts.dts; }
                }
                st.curNals.push(nal);
                if (isVcl) { st.curHasVcl = true; if (type === 5) st.curKey = true; }
            }

            function extractNals(buf, tailStart, tsBefore, tsAfter) {
                const starts = [];
                for (let i = 0; i + 2 < buf.length; i++) {
                    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i + 3); i += 2; }
                }
                if (!starts.length) return buf;
                for (let k = 0; k < starts.length; k++) {
                    const from = starts[k];
                    if (k === starts.length - 1) return buf.subarray(from - 3);
                    const to = starts[k + 1] - 3;
                    const nal = buf.subarray(from, to);
                    if (!nal.length) continue;
                    st.pendingTs = from < tailStart ? tsBefore : tsAfter;
                    pushNal(nal);
                }
                return new Uint8Array(0);
            }

            function pushAudio(data, pts) {
                let i = 0, first = true;
                while (i + 7 <= data.length) {
                    if (data[i] !== 0xff || (data[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
                    const protectionAbsent = data[i + 1] & 1;
                    const profile = (data[i + 2] >> 6) & 0x03;
                    const freqIdx = (data[i + 2] >> 2) & 0x0f;
                    const chanCfg = ((data[i + 2] & 1) << 2) | ((data[i + 3] >> 6) & 0x03);
                    const frameLen = ((data[i + 3] & 0x03) << 11) | (data[i + 4] << 3) | ((data[i + 5] >> 5) & 0x07);
                    if (frameLen < 7 || i + frameLen > data.length) break;
                    const headerLen = protectionAbsent ? 7 : 9;
                    const sampleRate = AUDIO_RATES[freqIdx] || 44100;
                    let framePts;
                    if (first && pts != null) framePts = pts;
                    else framePts = (st.lastAudioPts == null ? 0 : st.lastAudioPts) + (1024 * 90000 / sampleRate);
                    st.lastAudioPts = framePts;
                    first = false;
                    if (!st.audioCfg) st.audioCfg = { profile, freqIdx, chanCfg, sampleRate };
                    st.audioFrames++;
                    onSample({ kind: 'audio', data: data.subarray(i + headerLen, i + frameLen), pts: Math.round(framePts), key: true });
                    i += frameLen;
                }
            }

            function flushPes(pid) {
                const p = st.pes[pid];
                if (!p || !p.len) return;
                const buf = concatBytes(p.bufs);
                p.bufs = []; p.len = 0;
                let i = 0;
                if (!(buf.length > 3 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1)) {
                    i = -1;
                    for (let k = 0; k + 3 < buf.length; k++) {
                        if (buf[k] === 0 && buf[k + 1] === 0 && buf[k + 2] === 1) { i = k; break; }
                    }
                    if (i < 0 || i + 9 >= buf.length) return;
                }
                const flags = buf[i + 7];
                const hdrLen = buf[i + 8];
                let pts = null, dts = null;
                if ((flags & 0x80) && i + 13 < buf.length) {
                    pts = readTs(buf, i + 9);
                    dts = (flags & 0x40 && i + 18 < buf.length) ? readTs(buf, i + 14) : pts;
                }
                const es = buf.subarray(i + 9 + hdrLen);
                if (!es.length) return;

                if (st.video && pid === st.video.pid) {
                    const prev = st.pendingVideo;
                    const tailStart = prev ? prev.length : 0;
                    const merged = prev ? concatBytes([prev, es]) : es;
                    st.pendingVideo = null;
                    const tail = extractNals(merged, tailStart,
                        { pts: st.prevPesPts, dts: st.prevPesDts }, { pts, dts });
                    st.prevPesPts = pts; st.prevPesDts = dts;
                    if (tail && tail.length) st.pendingVideo = tail.slice();
                } else if (st.audio && pid === st.audio.pid) {
                    pushAudio(es, pts);
                }
            }

            function parsePsi(pid, payload) {
                const ptr = payload[0];
                const sec = payload.subarray(1 + ptr);
                if (sec.length < 12) return;
                const secLen = ((sec[1] & 0x0f) << 8) | sec[2];
                if (sec.length < secLen + 3) return;
                const tableId = sec[0];
                if (pid === 0 && tableId === 0) {
                    for (let o = 8; o + 4 <= secLen + 3 - 4; o += 4) {
                        const prog = (sec[o] << 8) | sec[o + 1];
                        const pidv = ((sec[o + 2] & 0x1f) << 8) | sec[o + 3];
                        if (prog !== 0) { st.pmtPid = pidv; break; }
                    }
                } else if (pid === st.pmtPid && tableId === 2) {
                    const progInfoLen = ((sec[10] & 0x0f) << 8) | sec[11];
                    let o = 12 + progInfoLen;
                    while (o + 5 <= secLen + 3 - 4) {
                        const streamType = sec[o];
                        const epid = ((sec[o + 1] & 0x1f) << 8) | sec[o + 2];
                        const esInfoLen = ((sec[o + 3] & 0x0f) << 8) | sec[o + 4];
                        if (streamType === 0x1b || streamType === 0x24) st.video = { pid: epid, streamType };
                        else if (streamType === 0x0f || streamType === 0x11) st.audio = { pid: epid, streamType };
                        o += 5 + esInfoLen;
                    }
                }
            }

            // 单个分片解包；分片边界不 flush PES/AU，保证跨分片的 PES、AU 不断裂
            let carry = null;
            function push(chunk) {
                if (carry) {
                    chunk = concatBytes([carry, chunk]);
                    carry = null;
                }
                const n = chunk.length;
                const usable = n - (n % 188);
                let off = 0;
                while (off + 188 <= usable) {
                    if (chunk[off] !== 0x47) {
                        let k = off + 1;
                        while (k + 188 <= usable && chunk[k] !== 0x47) k++;
                        if (k + 188 > usable) break;
                        off = k;
                    }
                    const b1 = chunk[off + 1], b2 = chunk[off + 2], b3 = chunk[off + 3];
                    const pusi = (b1 & 0x40) !== 0;
                    const pid = ((b1 & 0x1f) << 8) | b2;
                    const afc = (b3 >> 4) & 0x03;
                    let p = off + 4;
                    if (afc & 0x02) { const afl = chunk[p]; p += 1 + afl; }
                    if ((afc & 0x01) && p < off + 188) {
                        const payload = chunk.subarray(p, off + 188);
                        if (pusi && (pid === 0 || pid === st.pmtPid)) {
                            parsePsi(pid, payload);
                        } else if ((st.video && pid === st.video.pid) || (st.audio && pid === st.audio.pid)) {
                            if (pusi) {
                                flushPes(pid);
                                st.pes[pid] = { bufs: [payload], len: payload.length };
                            } else if (st.pes[pid]) {
                                st.pes[pid].bufs.push(payload);
                                st.pes[pid].len += payload.length;
                            }
                        }
                    }
                    off += 188;
                }
                if (usable < n) carry = chunk.slice(usable);
            }

            // 全部数据结束后收尾
            function end() {
                if (carry) { push(carry); carry = null; }
                if (st.video) flushPes(st.video.pid);
                if (st.audio) flushPes(st.audio.pid);
                if (st.pendingVideo && st.pendingVideo.length > 4) {
                    const buf = st.pendingVideo;
                    const starts = [];
                    for (let i = 0; i + 2 < buf.length; i++) {
                        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) starts.push(i + 3);
                    }
                    if (starts.length === 1) pushNal(buf.subarray(starts[0]));
                }
                flushAu();
            }

            return {
                push: push,
                end: end,
                get video() { return st.video; },
                get audio() { return st.audio; },
                get sps() { return st.sps; },
                get pps() { return st.pps; },
                get audioCfg() { return st.audioCfg; },
                get videoFrames() { return st.videoFrames; },
                get audioFrames() { return st.audioFrames; },
            };
        }

        // 一次性解复用整段数据（内存模式）
        function demuxTs(chunks, onSample) {
            const d = createTsDemuxer(onSample);
            for (let i = 0; i < chunks.length; i++) d.push(chunks[i]);
            d.end();
            return d;
        }

        // ---------- MP4 箱子 ----------
        function desc(tag, payload) {
            return concatAll([u8(tag), u8(payload.length), payload]);
        }

        function buildEsds(cfg) {
            const aot = cfg.audioObjectType || 2;
            const asc = new Uint8Array([
                (aot << 3) | (cfg.freqIdx >> 1),
                ((cfg.freqIdx & 1) << 7) | (cfg.chanCfg << 3),
            ]);
            const dsi = desc(0x05, asc);
            const dcd = desc(0x04, concatAll([
                u8(0x40), u8(0x15), new Uint8Array([0, 0, 0]),
                u32(128000), u32(128000), dsi,
            ]));
            const sl = desc(0x06, u8(0x02));
            const esd = desc(0x03, concatAll([u16(0), u8(0), dcd, sl]));
            return fullBox('esds', 0, 0, esd);
        }

        function buildAvcC(sps, pps) {
            return box('avcC',
                u8(1), u8(sps[1]), u8(sps[2]), u8(sps[3]),
                u8(0xff), u8(0xe1), u16(sps.length), sps,
                u8(1), u16(pps.length), pps
            );
        }

        function buildStbl(track) {
            const samples = track.samples;
            const chunks = track.chunks || [{ offset: track.chunkOffset || 0, count: samples.length }];
            const sizeOf = s => (s.size != null ? s.size : s.data.length);
            const parts = [];
            parts.push(fullBox('stsd', 0, 0, u32(1), track.sampleEntry));

            const stts = [];
            for (let i = 0; i < samples.length; i++) {
                const d = samples[i].duration || 1;
                if (stts.length && stts[stts.length - 1].d === d) stts[stts.length - 1].c++;
                else stts.push({ c: 1, d });
            }
            parts.push(fullBox('stts', 0, 0, concatAll([u32(stts.length)].concat(
                stts.map(e => concatAll([u32(e.c), u32(e.d)]))))));

            if (track.cttsOffsets) {
                const ent = [];
                for (const o of track.cttsOffsets) {
                    if (ent.length && ent[ent.length - 1].o === o) ent[ent.length - 1].c++;
                    else ent.push({ c: 1, o });
                }
                parts.push(fullBox('ctts', 0, 0, concatAll([u32(ent.length)].concat(
                    ent.map(e => concatAll([u32(e.c), u32(e.o)]))))));
            }

            if (track.isVideo) {
                const keys = [];
                for (let i = 0; i < samples.length; i++) if (samples[i].key) keys.push(i + 1);
                if (keys.length && keys.length < samples.length) {
                    parts.push(fullBox('stss', 0, 0, concatAll([u32(keys.length)].concat(keys.map(k => u32(k))))));
                }
            }

            // stsc：按每个 chunk 的样本数分组
            const sc = [];
            for (let i = 0; i < chunks.length; i++) {
                const n = chunks[i].count;
                if (!sc.length || sc[sc.length - 1].n !== n) sc.push({ f: i + 1, n: n });
            }
            parts.push(fullBox('stsc', 0, 0, concatAll([u32(sc.length)].concat(
                sc.map(e => concatAll([u32(e.f), u32(e.n), u32(1)]))))));
            parts.push(fullBox('stsz', 0, 0, u32(0), u32(samples.length),
                concatAll(samples.map(s => u32(sizeOf(s))))));
            parts.push(fullBox('stco', 0, 0, concatAll([u32(chunks.length)].concat(
                chunks.map(c => u32(c.offset >>> 0))))));
            return box('stbl', ...parts);
        }

        function buildTrak(t) {
            const tkhd = fullBox('tkhd', 0, 7,
                u32(0), u32(0), u32(t.trackId), u32(0), u32(t.presentationDuration),
                u32(0), u32(0), u16(t.isAudio ? 0x0100 : 0), u16(0),
                concatAll([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
                u32((t.width || 0) * 65536), u32((t.height || 0) * 65536)
            );
            const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(t.mediaDuration), u16(0x55c4), u16(0));
            const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc(t.isAudio ? 'soun' : 'vide'), u32(0), u32(0), u32(0), u8(0));
            const mhd = t.isAudio ? fullBox('smhd', 0, 0, u16(0), u16(0))
                : fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
            const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
            const minf = box('minf', mhd, dinf, buildStbl(t));
            const edts = t.editList ? box('edts', t.editList) : null;
            return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, minf));
        }

        // ---------- 流式写入：逐分片生成 MP4 box ----------
        function buildAvc1Entry(dim, sps, pps) {
            return box('avc1',
                new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0),
                u16(dim.width), u16(dim.height),
                u32(0x00480000), u32(0x00480000), u32(0), u16(1),
                new Uint8Array(32), u16(0x0018), new Uint8Array([0xff, 0xff]),
                buildAvcC(sps, pps)
            );
        }

        function buildMp4aEntry(cfg) {
            return box('mp4a',
                new Uint8Array(6), u16(1), u32(0), u32(0),
                u16(cfg.chanCfg), u16(16), u16(0), u16(0),
                u32((cfg.sampleRate * 65536) >>> 0),
                buildEsds({ audioObjectType: cfg.profile + 1, freqIdx: cfg.freqIdx, chanCfg: cfg.chanCfg })
            );
        }

        function buildMvhd(totalMs, trackCount) {
            return fullBox('mvhd', 0, 0,
                u32(0), u32(0), u32(1000), u32(totalMs),
                u32(0x00010000), u16(0x0100), u16(0),
                u32(0), u32(0),
                concatAll([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
                u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
                u32(trackCount + 1)
            );
        }

        /**
         * 流式 MP4 写入器：每个分片解复用后立刻落盘，最后补 moov 索引。
         * 文件布局：ftyp | mdat(size 占位) | ...样本... | moov
         *   - 每个分片贡献 1 个视频 chunk + 1 个音频 chunk（stsc/stco 记录真实位置）
         *   - 内存里只留样本元数据（size/pts/dts），不保留样本数据
         * @param sink {{ write(bytes):Promise, writeAt(offset, bytes):Promise }}
         */
        function createStreamingMp4Writer(sink) {
            const VT = 90000;
            const vSamples = [], aSamples = [];
            const vChunks = [], aChunks = [];
            let sps = null, pps = null, audioCfg = null, streamType = 0;
            let pos = 0, ftypLen = 0;
            let pendingParts = [], pendingLen = 0;
            let aFirstPts = null;

            async function flushPending() {
                if (!pendingLen) return;
                const buf = concatBytes(pendingParts);
                pendingParts = [];
                pendingLen = 0;
                await sink.write(buf);
            }

            function emit(bytes) {
                pos += bytes.length;
                pendingParts.push(bytes);
                pendingLen += bytes.length;
                return pendingLen >= (1 << 20) ? flushPending() : null;
            }

            async function open() {
                const ftyp = box('ftyp', fourcc('isom'), u32(0x200),
                    fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
                ftypLen = ftyp.length;
                await sink.write(concatBytes([ftyp, u32(0), fourcc('mdat')]));
                pos = ftypLen + 8;
            }

            function setCodec(info) {
                if (info.sps && !sps) sps = info.sps;
                if (info.pps && !pps) pps = info.pps;
                if (info.audioCfg && !audioCfg) audioCfg = info.audioCfg;
                if (info.streamType) streamType = info.streamType;
            }

            async function pushFragment(aus, frames) {
                if (aus && aus.length) {
                    vChunks.push({ offset: pos, count: aus.length });
                    for (const s of aus) {
                        vSamples.push({ size: s.data.length, dts: s.dts, pts: s.pts, key: s.key });
                        await emit(s.data);
                    }
                }
                if (frames && frames.length) {
                    if (aFirstPts == null) aFirstPts = frames[0].pts;
                    aChunks.push({ offset: pos, count: frames.length });
                    for (const f of frames) {
                        aSamples.push({ size: f.data.length, pts: f.pts });
                        await emit(f.data);
                    }
                }
            }

            async function finish() {
                await flushPending();
                if (streamType === 0x24) throw new Error('HEVC(H.265) 暂不支持重封装');
                if (!vSamples.length) throw new Error('没有解析到视频帧');
                if (!sps || !pps) throw new Error('缺少 SPS/PPS');

                const dim = parseSps(sps);
                const vFirstRaw = vSamples[0].dts;
                for (const s of vSamples) { s.dts -= vFirstRaw; s.pts -= vFirstRaw; }
                for (let i = 0; i < vSamples.length; i++) {
                    if (i + 1 < vSamples.length) vSamples[i].duration = Math.max(1, vSamples[i + 1].dts - vSamples[i].dts);
                    else vSamples[i].duration = vSamples.length > 1 ? vSamples[i - 1].duration : 3003;
                }
                let vDur = 0;
                for (const s of vSamples) vDur += s.duration;

                const rawOffsets = vSamples.map(s => s.pts - s.dts);
                const minOff = Math.min.apply(null, rawOffsets);
                const cttsShift = minOff < 0 ? -minOff : 0;
                const hasB = rawOffsets.some(o => o !== rawOffsets[0]) || rawOffsets[0] !== 0;

                const videoTrack = {
                    isVideo: true, trackId: 1, timescale: VT,
                    mediaDuration: vDur,
                    presentationDuration: Math.round(vDur * 1000 / VT),
                    durationMs: Math.round(vDur * 1000 / VT),
                    samples: vSamples, chunks: vChunks,
                    sampleEntry: buildAvc1Entry(dim, sps, pps),
                    width: dim.width, height: dim.height,
                    cttsOffsets: hasB ? rawOffsets.map(o => o + cttsShift) : null,
                };
                if (cttsShift > 0) {
                    videoTrack.editList = fullBox('elst', 0, 0, u32(1),
                        u32(videoTrack.presentationDuration), u32(cttsShift), u32(0x00010000));
                }

                let audioTrack = null;
                if (aSamples.length && audioCfg) {
                    const sr = audioCfg.sampleRate;
                    for (let i = 0; i < aSamples.length; i++) {
                        aSamples[i].dts = i * 1024;
                        aSamples[i].duration = 1024;
                    }
                    const mediaDur = aSamples.length * 1024;
                    audioTrack = {
                        isAudio: true, trackId: 2, timescale: sr,
                        mediaDuration: mediaDur,
                        presentationDuration: Math.round(mediaDur * 1000 / sr),
                        durationMs: Math.round(mediaDur * 1000 / sr),
                        samples: aSamples, chunks: aChunks,
                        sampleEntry: buildMp4aEntry(audioCfg),
                        width: 0, height: 0,
                    };
                    const rel = (aFirstPts == null ? vFirstRaw : aFirstPts) - vFirstRaw;
                    const offsetSamples = Math.round(rel * sr / 90000);
                    if (offsetSamples > 0) {
                        // 音频起点晚于视频 → 空编辑延迟
                        audioTrack.editList = fullBox('elst', 0, 0, u32(2),
                            u32(Math.round(offsetSamples * 1000 / sr)), i32(-1), u32(0x00010000),
                            u32(audioTrack.presentationDuration), u32(0), u32(0x00010000));
                    } else if (offsetSamples < 0) {
                        // 音频起点早于视频 → 从媒体中间开始播放
                        audioTrack.editList = fullBox('elst', 0, 0, u32(1),
                            u32(audioTrack.presentationDuration), u32(-offsetSamples), u32(0x00010000));
                    }
                }

                const totalMs = Math.max(videoTrack.durationMs, audioTrack ? audioTrack.durationMs : 0);
                const tracks = [videoTrack];
                if (audioTrack) tracks.push(audioTrack);
                const moov = box('moov', buildMvhd(totalMs, tracks.length), ...tracks.map(buildTrak));

                const mdatSize = pos - ftypLen;
                if (mdatSize > 0xffffffff) throw new Error('文件超过 4GB，超出当前封装实现范围');

                await sink.writeAt(ftypLen, u32(mdatSize));
                await sink.write(moov);
                pos += moov.length;

                return {
                    durationSec: totalMs / 1000,
                    width: dim.width, height: dim.height,
                    videoFrames: vSamples.length,
                    audioFrames: aSamples.length,
                    moovAtTail: true,
                    warnings: audioTrack ? [] : ['未解析到音频轨'],
                };
            }

            return { open, setCodec, pushFragment, finish, get pos() { return pos; } };
        }

        function remuxTsToMp4(chunks) {
            const video = [], audio = [];
            const st = demuxTs(chunks, s => (s.kind === 'video' ? video : audio).push(s));
            if (st.video && st.video.streamType === 0x24) throw new Error('HEVC(H.265) 暂不支持重封装');
            if (!st.sps || !st.pps) throw new Error('未找到 SPS/PPS');
            if (!video.length) throw new Error('未解析到视频帧');
            const warnings = [];
            if (!st.audioCfg || !audio.length) warnings.push('未解析到音频轨');

            const dim = parseSps(st.sps);
            const VT = 90000;

            const vFirst = video[0].dts;
            for (const s of video) { s.dts -= vFirst; s.pts -= vFirst; }

            for (let i = 0; i < video.length; i++) {
                if (i + 1 < video.length) video[i].duration = Math.max(1, video[i + 1].dts - video[i].dts);
                else video[i].duration = video.length > 1 ? video[i - 1].duration : 3003;
            }
            let vDur = 0;
            for (const s of video) vDur += s.duration;

            const rawOffsets = video.map(s => s.pts - s.dts);
            const minOff = Math.min.apply(null, rawOffsets);
            const cttsShift = minOff < 0 ? -minOff : 0;
            const cttsOffsets = rawOffsets.map(o => o + cttsShift);
            const hasB = rawOffsets.some(o => o !== rawOffsets[0]) || rawOffsets[0] !== 0;

            const avc1 = buildAvc1Entry(dim, st.sps, st.pps);

            const videoTrack = {
                isVideo: true, trackId: 1, timescale: VT,
                mediaDuration: vDur,
                presentationDuration: Math.round(vDur * 1000 / VT),
                durationMs: Math.round(vDur * 1000 / VT),
                samples: video, sampleEntry: avc1,
                width: dim.width, height: dim.height,
                cttsOffsets: hasB ? cttsOffsets : null,
            };

            let audioTrack = null;
            if (audio.length && st.audioCfg) {
                const sr = st.audioCfg.sampleRate;
                const relStart = audio[0].pts - vFirst;
                const delaySamples = Math.round(relStart * sr / 90000);
                const startTrim = delaySamples < 0 ? -delaySamples : 0;
                const kept = audio.slice(startTrim);
                const mp4a = buildMp4aEntry(st.audioCfg);
                const aSamples = kept.map((s, i) => ({ data: s.data, dts: i * 1024, pts: i * 1024, duration: 1024, key: true }));
                const mediaDur = aSamples.length * 1024;
                audioTrack = {
                    isAudio: true, trackId: 2, timescale: sr,
                    mediaDuration: mediaDur,
                    presentationDuration: Math.round(mediaDur * 1000 / sr),
                    durationMs: Math.round(mediaDur * 1000 / sr),
                    samples: aSamples, sampleEntry: mp4a, width: 0, height: 0,
                };
                const delay = Math.max(0, delaySamples);
                if (delay > 0) {
                    audioTrack.editList = fullBox('elst', 0, 0, u32(2),
                        u32(Math.round(delay * 1000 / sr)), i32(-1), u32(0x00010000),
                        u32(audioTrack.presentationDuration), u32(0), u32(0x00010000));
                }
            }
            if (cttsShift > 0) {
                videoTrack.editList = fullBox('elst', 0, 0, u32(1),
                    u32(videoTrack.presentationDuration), u32(cttsShift), u32(0x00010000));
            }

            const totalMs = Math.max(videoTrack.durationMs, audioTrack ? audioTrack.durationMs : 0);
            const tracks = [videoTrack];
            if (audioTrack) tracks.push(audioTrack);

            function layout(offsets) {
                videoTrack.chunkOffset = offsets.v;
                if (audioTrack) audioTrack.chunkOffset = offsets.a;
                const ftyp = box('ftyp', fourcc('isom'), u32(0x200), fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'));
                const moov = box('moov', buildMvhd(totalMs, tracks.length), ...tracks.map(buildTrak));
                return { ftyp, moov };
            }

            const vBytes = video.reduce((s, x) => s + x.data.length, 0);
            const aBytes = audioTrack ? audioTrack.samples.reduce((s, x) => s + x.data.length, 0) : 0;
            let g = layout({ v: 0, a: 0 });
            let base = g.ftyp.length + g.moov.length + 8;
            g = layout({ v: base, a: base + vBytes });
            base = g.ftyp.length + g.moov.length + 8;
            g = layout({ v: base, a: base + vBytes });

            const mdatSize = vBytes + aBytes;
            const mdatHeader = concatAll([u32(mdatSize + 8), fourcc('mdat')]);
            const parts = [g.ftyp, g.moov, mdatHeader];
            for (const s of video) parts.push(s.data);
            if (audioTrack) for (const s of audioTrack.samples) parts.push(s.data);

            return {
                parts,
                durationSec: totalMs / 1000,
                width: dim.width, height: dim.height,
                videoFrames: video.length,
                audioFrames: audioTrack ? audioTrack.samples.length : 0,
                warnings,
            };
        }

        return { remuxTsToMp4, parseSps, createTsDemuxer, createStreamingMp4Writer };
    })();
    // ===== TS2MP4-CORE-END =====

    // ================================================================
    // 启动
    // ================================================================
    function init() {
        log('========================================');
        log('Rou.video 下载助手 v4.2.0 启动');
        log('URL:', location.href);
        log('UA:', navigator.userAgent);
        log('========================================');
        createUI();
        checkRoute();
        setInterval(checkRoute, 1200);
        log('[init] 已就绪，切换到视频页后自动解析');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
