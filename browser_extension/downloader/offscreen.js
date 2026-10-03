/**
 * 万能网页视频嗅探器 Pro - 后台持久化静默下载与混流封装引擎 (Offscreen Worker)
 * 作用：在后台独立执行 M3U8 切片拉取、AES-128硬件解密、mux.js 转封装，绝不因用户关闭 Popup 弹窗而中断！
 */

const activeTasks = new Map();

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0.0 MB";
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function resolveUrl(baseUrl, relativePath) {
  try {
    return new URL(relativePath, baseUrl).href;
  } catch (e) {
    return relativePath;
  }
}

function parseKeyAttributes(str) {
  const attrs = {};
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = regex.exec(str)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function parseHexIv(hexStr) {
  if (!hexStr) return null;
  if (hexStr.startsWith("0x") || hexStr.startsWith("0X")) {
    hexStr = hexStr.slice(2);
  }
  if (hexStr.length % 2 !== 0) hexStr = "0" + hexStr;
  const len = hexStr.length / 2;
  const bytes = new Uint8Array(16);
  const offset = Math.max(0, 16 - len);
  for (let i = 0; i < len && offset + i < 16; i++) {
    bytes[offset + i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return bytes;
}

function getSequenceIv(seq) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, seq, false);
  return bytes;
}

async function getKey(keyUrl, signal, keyCache) {
  if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
  const resp = await fetch(keyUrl, { signal });
  if (!resp.ok) throw new Error(`获取解密密钥失败: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const keyBytes = new Uint8Array(buf);
  keyCache.set(keyUrl, keyBytes);
  return keyBytes;
}

async function decryptSegment(cipherData, keyBytes, ivBytes) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: ivBytes },
    cryptoKey,
    cipherData
  );
  return new Uint8Array(decrypted);
}

async function transmuxTsToMp4(tsBuffers, progressCb) {
  return new Promise(async (resolve, reject) => {
    try {
      if (typeof muxjs === "undefined" || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
        throw new Error("未检测到 mux.js 库");
      }

      const transmuxer = new muxjs.mp4.Transmuxer({
        remux: true,
        keepOriginalTimestamps: false // 归零时间戳，防止黑屏或只有声音
      });

      let combinedInitSegment = null;
      let videoInitSegment = null;
      let audioInitSegment = null;
      const mediaSegments = [];
      let detectedVideo = false;
      let detectedAudio = false;

      transmuxer.on("trackinfo", (info) => {
        if (info.hasAudio) detectedAudio = true;
        if (info.hasVideo) detectedVideo = true;
      });

      transmuxer.on("data", (segment) => {
        if (segment.initSegment && segment.initSegment.byteLength > 0) {
          if (segment.type === "combined") {
            combinedInitSegment = new Uint8Array(segment.initSegment);
          } else if (segment.type === "video") {
            videoInitSegment = new Uint8Array(segment.initSegment);
          } else if (segment.type === "audio") {
            audioInitSegment = new Uint8Array(segment.initSegment);
          }
        }
        if (segment.data && segment.data.byteLength > 0) {
          mediaSegments.push(new Uint8Array(segment.data));
        }
      });

      // 分批推送切片并主动让出事件循环，防止长时间锁死主线程导致页面卡死
      const BATCH_SIZE = 25;
      for (let i = 0; i < tsBuffers.length; i++) {
        let chunk = tsBuffers[i];
        if (!chunk) continue;
        if (chunk instanceof Blob) {
          const ab = await chunk.arrayBuffer();
          chunk = new Uint8Array(ab);
        }
        if (chunk && chunk.byteLength > 0) {
          transmuxer.push(chunk);
        }
        if (i % BATCH_SIZE === 0 || i === tsBuffers.length - 1) {
          if (progressCb) {
            const pct = Math.floor(((i + 1) / tsBuffers.length) * 100);
            progressCb(pct);
          }
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      transmuxer.flush();

      // 关键：必须含有视频画面轨，否则抛出异常以便自动降级保存 TS 原画复合流
      if (!detectedVideo) {
        throw new Error("视频流非 H.264 编码 (可能为 H.265/HEVC 高清流)");
      }

      const bestInit = combinedInitSegment || videoInitSegment;
      if (!bestInit || mediaSegments.length === 0) {
        throw new Error("未能生成有效画面数据");
      }

      const allBuffers = [bestInit, ...mediaSegments];
      // 零拷贝优化：直接传入分片数组给 Blob 构造器，底层自动链表引用，避免复制分配 1GB+ 连续内存引发 GC 假死
      resolve(new Blob(allBuffers, { type: "video/mp4" }));
    } catch (err) {
      reject(err);
    }
  });
}

async function parseM3U8(url, signal) {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`拉取播放列表失败: HTTP ${resp.status}`);
  const text = await resp.text();

  if (text.includes("#EXT-X-STREAM-INF")) {
    const lines = text.split("\n");
    let bestSubUrl = null;
    let audioSubUrl = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO")) {
        const attrs = parseKeyAttributes(line.slice(13));
        if (attrs.URI) audioSubUrl = resolveUrl(url, attrs.URI);
      }
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith("#")) {
            bestSubUrl = resolveUrl(url, next);
            break;
          }
        }
        if (bestSubUrl) break;
      }
    }
    if (bestSubUrl) {
      const videoSegments = await parseM3U8(bestSubUrl, signal);
      if (audioSubUrl) {
        try {
          const audioSegments = await parseM3U8(audioSubUrl, signal);
          videoSegments.audioSegments = audioSegments;
        } catch (e) {}
      }
      return videoSegments;
    }
  }

  let mediaSequence = 0;
  let currentKeyInfo = null;
  const segments = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1].trim(), 10) || 0;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseKeyAttributes(line.slice(11));
      if (attrs.URI) {
        const initUrl = resolveUrl(url, attrs.URI);
        segments.push({
          url: initUrl,
          index: segments.length,
          keyInfo: null,
          isInitSegment: true
        });
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseKeyAttributes(line.slice(11));
      if (attrs.METHOD === "AES-128" && attrs.URI) {
        currentKeyInfo = {
          method: "AES-128",
          keyUrl: resolveUrl(url, attrs.URI),
          iv: attrs.IV ? parseHexIv(attrs.IV) : null
        };
      } else if (attrs.METHOD === "NONE") {
        currentKeyInfo = null;
      }
    } else if (!line.startsWith("#")) {
      const segIdx = segments.length;
      const segSeq = mediaSequence + segIdx;
      let keyInfo = null;
      if (currentKeyInfo && currentKeyInfo.method === "AES-128") {
        keyInfo = {
          method: "AES-128",
          keyUrl: currentKeyInfo.keyUrl,
          iv: currentKeyInfo.iv || getSequenceIv(segSeq)
        };
      }
      segments.push({
        url: resolveUrl(url, line),
        index: segIdx,
        keyInfo: keyInfo
      });
    }
  }

  if (segments.length === 0) throw new Error("M3U8 未包含有效 TS 切片");
  return segments;
}

async function fetchSegment(url, retries = 3, signal) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const chunkController = new AbortController();
    const onParentAbort = () => chunkController.abort();
    if (signal) signal.addEventListener("abort", onParentAbort, { once: true });

    // 整体超时时间放宽至 15 秒，并且必须覆盖整个 arrayBuffer() 的下载过程，防止下载中途卡死
    const timeoutTimer = setTimeout(() => {
      chunkController.abort(new Error("切片下载超时"));
    }, 15000);

    try {
      const resp = await fetch(url, { signal: chunkController.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      clearTimeout(timeoutTimer); // 必须在整个切片下载完成后才能清除定时器！
      return new Uint8Array(buf);
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (signal && signal.aborted) throw err;
      if (attempt === retries) throw err;
      // 快速重试：200ms 后在新连接建立请求，迅速摆脱卡死节点
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      if (signal) signal.removeEventListener("abort", onParentAbort);
    }
  }
}

async function startTask(taskConfig) {
  const { id, url, title = "video", concurrency = 10, pageUrl } = taskConfig;
  const abortController = new AbortController();
  const signal = abortController.signal;

  const taskRecord = {
    id,
    url,
    title,
    status: "parsing",
    percent: 0,
    speed: "0.0 MB/s",
    completed: 0,
    total: 0,
    sizeFormatted: "0.0 MB",
    abortController
  };
  activeTasks.set(id, taskRecord);

  function broadcastProgress(status, percent, speed, completed, total, sizeFormatted) {
    taskRecord.status = status;
    taskRecord.percent = percent;
    taskRecord.speed = speed;
    taskRecord.completed = completed;
    taskRecord.total = total;
    taskRecord.sizeFormatted = sizeFormatted;

    chrome.runtime.sendMessage({
      action: "DOWNLOAD_TASK_PROGRESS",
      data: { id, status, percent, speed, completed, total, sizeFormatted }
    }).catch(() => {});
  }

  let totalBytes = 0;
  let lastBytes = 0;
  let lastTime = Date.now();
  let currentSpeed = "0.0 MB/s";

  const speedTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    if (dt > 0.5) {
      const sp = (totalBytes - lastBytes) / dt / 1024 / 1024;
      currentSpeed = `${sp.toFixed(2)} MB/s`;
      lastBytes = totalBytes;
      lastTime = now;
    }
  }, 800);

  try {
    broadcastProgress("parsing", 0, "0.0 MB/s", 0, 0, "0.0 MB");
    const segments = await parseM3U8(url, signal);
    const audioSegments = segments.audioSegments || [];
    const hasSeparateAudio = audioSegments.length > 0;
    const total = segments.length + audioSegments.length;

    const chunkBuffers = new Array(segments.length);
    const audioBuffers = hasSeparateAudio ? new Array(audioSegments.length) : null;
    const keyCache = new Map();
    let completedCount = 0;
    let currentIndex = 0;

    async function worker() {
      while (currentIndex < total) {
        if (signal.aborted) return;
        const taskIdx = currentIndex++;
        const isAudio = taskIdx >= segments.length;
        const seg = isAudio ? audioSegments[taskIdx - segments.length] : segments[taskIdx];
        const localIdx = isAudio ? taskIdx - segments.length : taskIdx;

        const rawData = await fetchSegment(seg.url, 3, signal);
        let finalData = rawData;
        if (seg.keyInfo && seg.keyInfo.method === "AES-128") {
          const keyBytes = await getKey(seg.keyInfo.keyUrl, signal, keyCache);
          finalData = await decryptSegment(rawData, keyBytes, seg.keyInfo.iv);
        }

        // 立即将二进制数据封装为 Blob 对象交由浏览器底层接管内存，防止 V8 引擎堆内存爆满和 GC 卡顿
        const blobData = new Blob([finalData], { type: "video/mp2t" });

        if (isAudio) {
          audioBuffers[localIdx] = blobData;
        } else {
          chunkBuffers[localIdx] = blobData;
        }

        totalBytes += finalData.byteLength;
        completedCount++;

        // 0% ~ 90% 为分片拉取阶段，平滑向 90% 递进
        const pct = Math.floor((completedCount / total) * 90);
        broadcastProgress("downloading", pct, currentSpeed, completedCount, total, formatBytes(totalBytes));
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    if (signal.aborted) return;

    broadcastProgress("transmuxing", 90, "音视频混流封装中...", total, total, formatBytes(totalBytes));

    let outputBlob = null;
    let outputExt = "mp4";

    // 1. 检查是否为标准 fMP4 媒体流（包含 #EXT-X-MAP 初始化分片或 .m4s）
    const isFmp4 = segments.some(s => s.isInitSegment || (s.url && s.url.includes(".m4s")));

    if (isFmp4) {
      // fMP4 流直接组装为标准 .mp4 容器
      outputExt = "mp4";
      outputBlob = new Blob(chunkBuffers, { type: "video/mp4" });
      broadcastProgress("transmuxing", 100, `fMP4 媒体流已组装为标准 MP4`, total, total, formatBytes(outputBlob.size));
    } else {
      // 2. 标准 MPEG-TS 切片：使用 mux.js 混流转封装为标准 MP4 (H.264+AAC)
      try {
        let allChunksForMux;
        if (hasSeparateAudio && audioBuffers) {
          allChunksForMux = [];
          const maxLen = Math.max(chunkBuffers.length, audioBuffers.length);
          for (let i = 0; i < maxLen; i++) {
            if (i < chunkBuffers.length && chunkBuffers[i]) allChunksForMux.push(chunkBuffers[i]);
            if (i < audioBuffers.length && audioBuffers[i]) allChunksForMux.push(audioBuffers[i]);
          }
        } else {
          allChunksForMux = chunkBuffers;
        }

        outputBlob = await transmuxTsToMp4(allChunksForMux, (pct) => {
          broadcastProgress("transmuxing", 90 + Math.floor(pct * 0.1), `转封装为 MP4 (${pct}%)...`, total, total, formatBytes(totalBytes));
        });
        outputExt = "mp4";
        broadcastProgress("transmuxing", 100, `MP4 转封装完成`, total, total, formatBytes(outputBlob.size));
      } catch (transmuxErr) {
        // 如果是 H.265/HEVC 编码的 TS 切片，mux.js 不支持纯前端重封装，安全降级为原生无损 .ts 避免文件损坏
        outputExt = "ts";
        outputBlob = new Blob(chunkBuffers, { type: "video/mp2t" });
        broadcastProgress("transmuxing", 100, `已自动安全保存为无损 TS 流`, total, total, formatBytes(outputBlob.size));
      }
    }

    const safeFilename = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) + `.${outputExt}`;
    const blobUrl = URL.createObjectURL(outputBlob);

    // 通知 background.js 触发下载另存为
    chrome.runtime.sendMessage({
      action: "TRIGGER_DOWNLOAD",
      url: blobUrl,
      filename: safeFilename,
      pageUrl: pageUrl
    });

    broadcastProgress("completed", 100, "下载完成", total, total, formatBytes(outputBlob.size));

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      activeTasks.delete(id);
    }, 60000);
  } catch (err) {
    if (signal.aborted) {
      broadcastProgress("stopped", 0, "已取消", 0, 0, "0.0 MB");
    } else {
      broadcastProgress("error", 0, `出错: ${err.message}`, 0, 0, "0.0 MB");
    }
    setTimeout(() => activeTasks.delete(id), 10000);
  } finally {
    clearInterval(speedTimer);
  }
}

function stopTask(id) {
  const task = activeTasks.get(id);
  if (task && task.abortController) {
    task.abortController.abort();
    activeTasks.delete(id);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "OFFSCREEN_START_TASK") {
    startTask(request.task);
    sendResponse({ success: true });
    return true;
  }
  if (request.action === "OFFSCREEN_STOP_TASK") {
    stopTask(request.taskId);
    sendResponse({ success: true });
    return true;
  }
  if (request.action === "OFFSCREEN_GET_ACTIVE_TASKS") {
    const list = [];
    for (const [id, t] of activeTasks.entries()) {
      list.push({
        id: t.id,
        url: t.url,
        title: t.title,
        status: t.status,
        percent: t.percent,
        speed: t.speed,
        completed: t.completed,
        total: t.total,
        sizeFormatted: t.sizeFormatted
      });
    }
    sendResponse({ success: true, tasks: list });
    return true;
  }
});
