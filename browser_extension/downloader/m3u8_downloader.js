/**
 * M3U8 多线程切片合并下载器 Pro - 核心下载与组装引擎
 */

document.addEventListener("DOMContentLoaded", () => {
  const inputTitle = document.getElementById("video-title");
  const inputUrl = document.getElementById("m3u8-url");
  const selectConcurrency = document.getElementById("concurrency-select");
  const selectFormat = document.getElementById("format-select");
  const btnStart = document.getElementById("btn-start");
  const btnStop = document.getElementById("btn-stop");

  const progressSection = document.getElementById("progress-section");
  const statusText = document.getElementById("status-text");
  const percentText = document.getElementById("percent-text");
  const progressBarFill = document.getElementById("progress-bar-fill");
  const statChunks = document.getElementById("stat-chunks");
  const statSpeed = document.getElementById("stat-speed");
  const statSize = document.getElementById("stat-size");
  const logBox = document.getElementById("log-box");

  // 解析 URL 参数
  const params = new URLSearchParams(window.location.search);
  const initialUrl = params.get("url") || "";
  const initialTitle = params.get("title") || "嗅探视频_" + Date.now();

  inputUrl.value = initialUrl;
  inputTitle.value = initialTitle;

  let isDownloading = false;
  let abortController = null;
  let totalBytes = 0;
  let lastTime = 0;
  let lastBytes = 0;
  let speedInterval = null;

  function log(msg) {
    const time = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.textContent = `[${time}] ${msg}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0.0 MB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  /**
   * 将相对路径解析为绝对 URL
   */
  function resolveUrl(baseUrl, relativePath) {
    try {
      return new URL(relativePath, baseUrl).href;
    } catch (e) {
      return relativePath;
    }
  }

  /**
   * 解析 #EXT-X-KEY 属性键值对
   */
  function parseKeyAttributes(str) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
    let m;
    while ((m = regex.exec(str)) !== null) {
      attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
    }
    return attrs;
  }

  /**
   * 将 16 进制字符串转为 Uint8Array (16 字节 IV)
   */
  function parseHexIv(hexStr) {
    if (!hexStr) return null;
    if (hexStr.startsWith("0x") || hexStr.startsWith("0X")) {
      hexStr = hexStr.slice(2);
    }
    if (hexStr.length % 2 !== 0) hexStr = "0" + hexStr;
    const len = hexStr.length / 2;
    const bytes = new Uint8Array(16);
    const offset = Math.max(0, 16 - len);
    for (let i = 0; i < len && (offset + i) < 16; i++) {
      bytes[offset + i] = parseInt(hexStr.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  /**
   * 当 M3U8 未显式提供 IV 时，根据 RFC 8216 规范用 Sequence 序号构造 16 字节大端 IV
   */
  function getSequenceIv(seq) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(12, seq, false);
    return bytes;
  }

  // 密钥内存缓存：keyUrl -> Uint8Array
  const keyCache = new Map();

  async function getKey(keyUrl, signal) {
    if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
    log(`正在拉取 AES-128 解密密钥: ${keyUrl}`);
    const resp = await fetch(keyUrl, { signal });
    if (!resp.ok) throw new Error(`获取解密密钥失败: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const keyBytes = new Uint8Array(buf);
    keyCache.set(keyUrl, keyBytes);
    log(`成功拉取并缓存解密密钥 (16字节)`);
    return keyBytes;
  }

  /**
   * Web Crypto API 硬件加速解密单个 AES-128-CBC 切片
   */
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

  /**
   * 使用 mux.js 将原始 TS 切片封装为合法的 MP4 容器格式 (ISOBMFF)
   * 核心：必须开启 remux: true，将音频轨与视频轨同步混流，确保有画面有声音且音画完全同步！
   */
  async function transmuxTsToMp4(tsBuffers, logFn, progressCb) {
    return new Promise(async (resolve, reject) => {
      try {
        if (typeof muxjs === "undefined" || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
          throw new Error("未检测到 mux.js 转封装库");
        }

        // 关键设置：
        // 1. remux: true - 将视频轨与音频轨统一混流封装
        // 2. keepOriginalTimestamps: false - 核心关键！必须归零时间戳！若为 true，原始 PTS 会达数千万（对应几百甚至数千秒后），导致 Windows 播放器因等待未来时间戳渲染而表现为“黑屏/只有声音”！
        const transmuxer = new muxjs.mp4.Transmuxer({
          remux: true,
          keepOriginalTimestamps: false
        });

        let combinedInitSegment = null;
        let videoInitSegment = null;
        let audioInitSegment = null;
        const mediaSegments = [];
        let detectedAudio = false;
        let detectedVideo = false;

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

        // 分批推入 TS 切片并让出事件循环，防止浏览器主线程长期无响应挂起
        const BATCH_SIZE = 25;
        for (let i = 0; i < tsBuffers.length; i++) {
          if (tsBuffers[i] && tsBuffers[i].byteLength > 0) {
            transmuxer.push(tsBuffers[i]);
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

        // 关键断言：必须检测到了视频画面轨，绝不能输出只有音频轨的残缺 MP4 文件
        if (!detectedVideo) {
          throw new Error("未识别到 H.264 视频画面轨 (当前视频流可能为 H.265/HEVC 编码)");
        }

        const bestInit = combinedInitSegment || videoInitSegment;
        if (!bestInit || mediaSegments.length === 0) {
          throw new Error("转封装未能生成有效画面数据");
        }

        logFn(`音视频混流状态: 画面轨 [已捕获 ✓] | 声音轨 [${detectedAudio ? "已成功混流注入 ✓" : "未检测到独立音轨"}]`);

        const allBuffers = [bestInit, ...mediaSegments];
        // 零拷贝优化：直接传入分片数组给 Blob 构造器，底层自动链表引用，避免二次内存复制 1GB+ 造成 GC 假死
        resolve(new Blob(allBuffers, { type: "video/mp4" }));
      } catch (err) {
        logFn(`mux.js 转封装处理异常: ${err.message}`);
        reject(err);
      }
    });
  }

  /**
   * 解析 M3U8 文本，提取所有切片绝对地址及加密信息
   */
  async function parseM3U8(url, signal) {
    log(`正在拉取 M3U8 播放列表: ${url}`);
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`拉取播放列表失败: HTTP ${resp.status}`);
    const text = await resp.text();

    // 检查是否为嵌套主播放列表 (Master Playlist)
    if (text.includes("#EXT-X-STREAM-INF")) {
      log("检测到包含多清晰度 Master Playlist，正在自动匹配最高清晰度与音轨...");
      const lines = text.split("\n");
      let bestSubUrl = null;
      let audioSubUrl = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // 探测独立音频流 (如 Apple HLS 独立音轨)
        if (line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO")) {
          const attrs = parseKeyAttributes(line.slice(13));
          if (attrs.URI) {
            audioSubUrl = resolveUrl(url, attrs.URI);
            log(`🎵 发现独立音频分轨: ${audioSubUrl}`);
          }
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
            log("正在解析独立音频分轨切片列表...");
            const audioSegments = await parseM3U8(audioSubUrl, signal);
            log(`成功获取独立音频切片 ${audioSegments.length} 个，将与视频切片同步混流合成！`);
            videoSegments.audioSegments = audioSegments;
          } catch (e) {
            log(`获取独立音频轨失败: ${e.message}`);
          }
        }
        return videoSegments;
      }
    }

    // 解析切片及可能存在的 AES-128 加密 Key
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
        const attrStr = line.slice(11);
        const attrs = parseKeyAttributes(attrStr);
        if (attrs.URI) {
          const initUrl = resolveUrl(url, attrs.URI);
          log(`📦 检测到 fMP4 初始化头 (#EXT-X-MAP): ${initUrl}`);
          segments.push({
            url: initUrl,
            index: segments.length,
            keyInfo: null,
            isInitSegment: true
          });
        }
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const attrStr = line.slice(11);
        const attrs = parseKeyAttributes(attrStr);
        if (attrs.METHOD === "AES-128" && attrs.URI) {
          const keyUrl = resolveUrl(url, attrs.URI);
          const iv = attrs.IV ? parseHexIv(attrs.IV) : null;
          currentKeyInfo = {
            method: "AES-128",
            keyUrl: keyUrl,
            iv: iv
          };
          log(`🔒 检测到切片采用 AES-128 加密保护，密钥地址: ${keyUrl}`);
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

    if (segments.length === 0) {
      throw new Error("未能从该 M3U8 文本中找到任何有效 TS 切片地址");
    }

    log(`成功解析播放列表！发现 ${segments.length} 个切片${currentKeyInfo ? " (含 AES-128 自动解密保护)" : ""}`);
    return segments;
  }

  /**
   * 下载单个切片 (带 5 秒超时与快速重试机制，杜绝长尾卡顿)
   */
  async function fetchSegment(url, index, retries = 3, signal) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      const chunkController = new AbortController();
      const onParentAbort = () => chunkController.abort();
      if (signal) signal.addEventListener("abort", onParentAbort, { once: true });

      // 整体超时时间放宽至 15 秒，并且必须覆盖整个 arrayBuffer() 的下载过程
      const timeoutTimer = setTimeout(() => {
        chunkController.abort(new Error("切片拉取超时"));
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
        await new Promise(r => setTimeout(r, 200));
      } finally {
        if (signal) signal.removeEventListener("abort", onParentAbort);
      }
    }
  }

  /**
   * 启动多线程并发下载工作池
   */
  async function startDownload() {
    const url = inputUrl.value.trim();
    const title = inputTitle.value.trim() || "video";
    const concurrency = parseInt(selectConcurrency.value, 10) || 10;
    const format = selectFormat.value;

    if (!url) {
      alert("请输入有效的 M3U8 播放列表地址！");
      return;
    }

    isDownloading = true;
    abortController = new AbortController();
    const signal = abortController.signal;

    btnStart.disabled = true;
    btnStop.disabled = false;
    progressSection.style.display = "flex";
    logBox.innerHTML = "";
    statusText.textContent = "正在解析切片列表与加密参数...";
    percentText.textContent = "0%";
    progressBarFill.style.width = "0%";
    statChunks.textContent = "0 / 0";
    statSpeed.textContent = "0.0 MB/s";
    statSize.textContent = "0.0 MB";

    totalBytes = 0;
    lastBytes = 0;
    lastTime = Date.now();

    speedInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.5) {
        const speed = (totalBytes - lastBytes) / dt / 1024 / 1024;
        statSpeed.textContent = `${speed.toFixed(1)} MB/s`;
        lastBytes = totalBytes;
        lastTime = now;
      }
    }, 800);

    try {
      const segments = await parseM3U8(url, signal);
      const audioSegments = segments.audioSegments || [];
      const hasSeparateAudio = audioSegments.length > 0;
      const total = segments.length + audioSegments.length;
      statChunks.textContent = `0 / ${total}`;

      statusText.textContent = `正在并发拉取与解密切片 (${concurrency} 线程)...`;

      const chunkBuffers = new Array(segments.length);
      const audioBuffers = hasSeparateAudio ? new Array(audioSegments.length) : null;
      let completedCount = 0;
      let currentIndex = 0;

      // 任务合并队列：前 segments.length 为视频，后续为独立音频
      async function worker() {
        while (currentIndex < total) {
          if (signal.aborted) return;
          const taskIdx = currentIndex++;
          const isAudio = taskIdx >= segments.length;
          const seg = isAudio ? audioSegments[taskIdx - segments.length] : segments[taskIdx];
          const localIdx = isAudio ? (taskIdx - segments.length) : taskIdx;

          try {
            const rawData = await fetchSegment(seg.url, localIdx, 3, signal);
            let finalData = rawData;

            // 自动检测并解密 AES-128
            if (seg.keyInfo && seg.keyInfo.method === "AES-128") {
              const keyBytes = await getKey(seg.keyInfo.keyUrl, signal);
              finalData = await decryptSegment(rawData, keyBytes, seg.keyInfo.iv);
            }

            // 立即将二进制 Uint8Array 封装为 Blob 对象！
            // 关键优化：Uint8Array 长期驻留会导致 V8 JS 引擎引发史诗级 GC 垃圾回收卡顿（即用户反馈的后半程极慢）。
            // 转换为 Blob 后，浏览器底层引擎会自动接管内存，在内存不足时无缝持久化到系统临时磁盘，支持无限大小下载！
            const blobData = new Blob([finalData], { type: "video/mp2t" });

            if (isAudio) {
              audioBuffers[localIdx] = blobData;
            } else {
              chunkBuffers[localIdx] = blobData;
            }
            totalBytes += finalData.byteLength;
            completedCount++;

            // 0% ~ 90% 为切片下载阶段
            const pct = Math.floor((completedCount / total) * 90);
            percentText.textContent = `${pct}%`;
            progressBarFill.style.width = `${pct}%`;
            statChunks.textContent = `${completedCount} / ${total}`;
            statSize.textContent = formatBytes(totalBytes);

            if (completedCount % 20 === 0 || completedCount === total) {
              log(`已下载分片: ${completedCount}/${total} (${Math.floor((completedCount / total) * 100)}%)`);
            }
          } catch (err) {
            if (signal.aborted) return;
            log(`分片 #${taskIdx} 处理失败: ${err.message}`);
            throw err;
          }
        }
      }

      const workers = [];
      for (let i = 0; i < concurrency; i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (signal.aborted) return;

      statusText.textContent = "所有切片下载解密完成！正在封装混流...";
      log("所有切片已解密完成！正在组装音视频数据...");

      let outputBlob = null;
      let outputExt = format;

      // 检查切片是否包含 fMP4 (带 #EXT-X-MAP 初始化头或 .m4s 后缀)
      const isFmp4 = segments.some(s => s.isInitSegment || (s.url && s.url.includes(".m4s")));

      if (isFmp4) {
        statusText.textContent = "检测为标准 fMP4 流，正在组装 MP4 容器...";
        log("📦 检测到 fMP4 (ISO BMFF) 媒体流，已完整拼接初始化头与全部切片，输出为标准 .mp4 视频！");
        outputExt = "mp4";
        outputBlob = new Blob(chunkBuffers, { type: "video/mp4" });
        percentText.textContent = "100%";
        progressBarFill.style.width = "100%";
      } else if (format === "mp4") {
        statusText.textContent = "正在合并原生 TS 数据流...";
        log("按照用户指示，跳过 mux.js 混流，直接合并 TS 切片，保证音视频完好无损。");
        try {
          // 合并推入的切片流 (交替推入以保证音视频 PTS 时间戳步调一致，确保音画同步)
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
          outputExt = "ts";
          outputBlob = new Blob(allChunksForMux, { type: "video/mp2t" });
          
          percentText.textContent = `100%`;
          progressBarFill.style.width = `100%`;
          
          if (outputBlob && outputBlob.size > 0) {
            log(`✅ 合并成功！生成标准 TS 文件，大小: ${formatBytes(outputBlob.size)}`);
          } else {
            throw new Error("合并未产生数据");
          }
        } catch (transmuxErr) {
          log(`⚠️ 合并提示: ${transmuxErr.message}`);
          log(`💡 自动保存为单轨原生流 (.ts) 格式！`);
          outputExt = "ts";
          outputBlob = new Blob(chunkBuffers, { type: "video/mp2t" });
        }
      } else {
        outputBlob = new Blob(chunkBuffers, { type: "video/mp2t" });
      }

      statusText.textContent = "处理完成！已触发浏览器另存为。";
      log(`组装成功！最终文件大小: ${formatBytes(outputBlob.size)}`);

      // 触发另存为
      const safeFilename = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) + `.${outputExt}`;
      const downloadUrl = URL.createObjectURL(outputBlob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = safeFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);

      log(`🎉 下载已完成并保存为: ${safeFilename}`);
      log("💡 播放指南：已解密并合成完整视频。Windows 推荐使用全能播放器（如 PotPlayer、VLC 播放器）获得最流畅播放效果！");
    } catch (err) {
      if (signal.aborted) {
        statusText.textContent = "用户已手动停止下载";
        log("下载已被用户取消。");
      } else {
        statusText.textContent = `下载出错: ${err.message}`;
        log(`错误详情: ${err.message}`);
      }
    } finally {
      clearInterval(speedInterval);
      isDownloading = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
    }
  }

  function stopDownload() {
    if (abortController) {
      abortController.abort();
    }
    clearInterval(speedInterval);
    isDownloading = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    statusText.textContent = "已停止";
    log("下载任务已终止。");
  }

  btnStart.addEventListener("click", startDownload);
  btnStop.addEventListener("click", stopDownload);

  // 如果带参进入，自动检测是否可以立即就绪
  if (initialUrl) {
    log(`已载入目标 M3U8 流: ${initialUrl}`);
  }
});
