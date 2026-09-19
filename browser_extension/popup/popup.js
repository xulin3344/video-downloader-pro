/**
 * 万能视频嗅探与下载器 Pro - Popup 交互逻辑 (支持智能主视频识别与广告过滤)
 */

document.addEventListener("DOMContentLoaded", () => {
  const mediaListContainer = document.getElementById("media-list");
  const emptyState = document.getElementById("empty-state");
  const tabTitleEl = document.getElementById("tab-title");
  const countBadge = document.getElementById("media-count-badge");
  const btnRefresh = document.getElementById("btn-refresh");
  const btnClear = document.getElementById("btn-clear");
  const btnCopyAll = document.getElementById("btn-copy-all");
  const btnRescan = document.getElementById("btn-rescan");
  const filterMainBtn = document.getElementById("filter-main");
  const filterAllBtn = document.getElementById("filter-all");
  const filterHintEl = document.getElementById("filter-hint");
  const toast = document.getElementById("toast");

  let currentTabId = null;
  let currentTabTitle = "";
  let currentTabUrl = "";
  let mediaItems = [];
  let currentFilter = "main"; // "main" (仅看主视频) 或 "all" (全部资源)

  function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => {
      toast.classList.remove("show");
    }, 2000);
  }

  /**
   * 格式化时长为友好的可读字符串
   */
  function formatDuration(sec) {
    if (!sec || typeof sec !== "number" || sec <= 0 || isNaN(sec)) return "";
    sec = Math.round(sec);
    if (sec < 60) return `${sec} 秒`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  /**
   * 异步解析 M3U8 切片总时长 (秒)
   */
  async function fetchM3u8Duration(url) {
    try {
      const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (!resp.ok) return 0;
      const text = await resp.text();
      if (text.includes("#EXT-X-STREAM-INF")) {
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            const subUrl = new URL(trimmed, url).href;
            return await fetchM3u8Duration(subUrl);
          }
        }
      }
      const extinfRegex = /#EXTINF:\s*([0-9.]+)/g;
      let match;
      let totalSec = 0;
      while ((match = extinfRegex.exec(text)) !== null) {
        totalSec += parseFloat(match[1]);
      }
      return Math.round(totalSec);
    } catch (e) {
      return 0;
    }
  }

  /**
   * 复制文本到剪贴板
   */
  async function copyToClipboard(text, successMsg = "已复制直链到剪贴板") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast(successMsg);
    }
  }

  /**
   * 尝试向本地 Python 桌面端发送任务 (端口 18888)
   */
  async function sendToDesktopApp(url, title) {
    try {
      const resp = await fetch("http://127.0.0.1:18888/api/add_task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, title }),
        signal: AbortSignal.timeout(1500)
      });
      if (resp.ok) {
        showToast("已成功推送到本地下载器！");
        return;
      }
    } catch (e) {
      await copyToClipboard(url, "已复制！桌面下载器剪贴板监听将自动捕获");
    }
  }

  /**
   * 主视频智能评分计算算法
   */
  function calcMediaScore(item) {
    let score = 0;

    // 1. 时长维度 (核心权重)
    if (item.duration > 0) {
      if (item.duration >= 300) {
        score += 5000 + Math.min(item.duration, 7200); // 5分钟以上长视频，极高权重
      } else if (item.duration >= 90) {
        score += 2500 + item.duration; // 1.5分钟~5分钟
      } else if (item.duration <= 60) {
        score -= 3000; // <= 60秒短片，通常为贴片广告或微小片段
      }
    }

    // 2. 体积维度 (Content-Length)
    if (item.size > 0) {
      if (item.size >= 50 * 1024 * 1024) {
        score += 4000 + Math.min(item.size / (1024 * 1024), 5000);
      } else if (item.size >= 10 * 1024 * 1024) {
        score += 1500;
      } else if (item.size <= 2 * 1024 * 1024) {
        score -= 1500; // 小于 2MB 减分
      }
    }

    // 3. 主播放器容器
    if (item.isMainPlayer) {
      score += 3500;
    }

    // 4. M3U8 在各类影视/直播/CMS站中通常为主流正片
    if (item.format === "M3U8") {
      score += 1200;
    }

    // 5. 广告扣分
    if (item.isAd) {
      score -= 10000;
    }

    return score;
  }

  /**
   * 更新卡片上的标签信息 (时长、主视频、广告)
   */
  function updateCardTags(tagsDiv, item, isMain) {
    tagsDiv.innerHTML = "";

    // 主视频金标
    if (isMain) {
      const mainBadge = document.createElement("span");
      mainBadge.className = "badge-main-video";
      mainBadge.innerHTML = `⭐ 推荐主视频`;
      tagsDiv.appendChild(mainBadge);
    }

    // 格式标签
    const format = item.format || "MP4";
    const formatBadge = document.createElement("span");
    formatBadge.className = `badge-format ${format.replace(/\s+/g, "")}`;
    formatBadge.textContent = format;
    tagsDiv.appendChild(formatBadge);

    // 时长标签
    if (item.duration > 0) {
      const durBadge = document.createElement("span");
      durBadge.className = "badge-duration";
      durBadge.innerHTML = `⏱️ ${formatDuration(item.duration)}`;
      tagsDiv.appendChild(durBadge);
    }

    // 大小标签
    const size = item.sizeFormatted || "流媒体";
    const sizeBadge = document.createElement("span");
    sizeBadge.className = "badge-size";
    sizeBadge.textContent = size;
    tagsDiv.appendChild(sizeBadge);

    // 广告标签
    if (item.isAd) {
      const adBadge = document.createElement("span");
      adBadge.className = "badge-ad";
      adBadge.textContent = "⚠️ 疑似广告";
      tagsDiv.appendChild(adBadge);
    }
  }

  // 记录每个卡片的实时下载进度控制器: itemId -> Controller
  const cardProgressCtrlMap = new Map();

  /**
   * 构建卡片内嵌实时下载进度条控制面板
   */
  function setupCardProgress(card, actionsDiv, item, title) {
    const progressBox = document.createElement("div");
    progressBox.className = "card-progress-box";
    progressBox.style.display = "none";

    progressBox.innerHTML = `
      <div class="card-progress-bar-wrap">
        <div class="card-progress-status-row">
          <span class="card-progress-status-text">准备下载...</span>
          <span class="card-progress-pct-label">0%</span>
        </div>
        <div class="card-progress-bar-track">
          <div class="card-progress-bar-fill" style="width: 0%;"></div>
        </div>
      </div>
      <div class="card-progress-side-info">
        <span class="card-progress-speed">0.0 MB/s</span>
        <span class="card-progress-chunks"></span>
      </div>
      <button class="card-progress-btn-stop" title="停止下载">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
        停止
      </button>
    `;

    const statusText = progressBox.querySelector(".card-progress-status-text");
    const pctLabel = progressBox.querySelector(".card-progress-pct-label");
    const barFill = progressBox.querySelector(".card-progress-bar-fill");
    const speedLabel = progressBox.querySelector(".card-progress-speed");
    const chunksLabel = progressBox.querySelector(".card-progress-chunks");
    const btnStop = progressBox.querySelector(".card-progress-btn-stop");

    btnStop.addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({
        action: "STOP_M3U8_TASK",
        taskId: item.id
      });
      showToast("已停止下载任务");
      resetToActions();
    });

    function showProgress() {
      actionsDiv.style.display = "none";
      progressBox.style.display = "flex";
    }

    function resetToActions() {
      progressBox.style.display = "none";
      actionsDiv.style.display = "flex";
    }

    function updateProgress(data) {
      showProgress();
      const pct = Math.min(100, Math.max(0, data.percent || 0));
      barFill.style.width = `${pct}%`;
      pctLabel.textContent = `${pct}%`;
      speedLabel.textContent = data.speed || "0.0 MB/s";
      if (data.total > 0) {
        chunksLabel.textContent = `(${data.completed}/${data.total})`;
      } else {
        chunksLabel.textContent = "";
      }

      if (data.status === "parsing") {
        statusText.textContent = "解析切片与密钥...";
      } else if (data.status === "downloading") {
        statusText.textContent = "正在下载中...";
      } else if (data.status === "transmuxing") {
        statusText.textContent = "混流封装中...";
      } else if (data.status === "completed") {
        statusText.textContent = "✅ 下载完成！";
        barFill.style.background = "linear-gradient(90deg, #10b981, #34d399)";
        showToast("🎉 视频已成功下载存入下载目录！");
        setTimeout(resetToActions, 4000);
      } else if (data.status === "error" || data.status === "stopped") {
        resetToActions();
      }
    }

    card.appendChild(progressBox);
    return { showProgress, resetToActions, updateProgress };
  }

  /**
   * 生成单个视频卡片 HTML 节点
   */
  function createMediaCard(item, isMain) {
    const card = document.createElement("div");
    card.className = "media-card" + (isMain ? " main-video" : "") + (item.isAd ? " is-ad" : "");

    const title = item.title || currentTabTitle || "未命名嗅探视频";
    const format = item.format || "MP4";
    const isM3u8 = format.includes("M3U8");

    // 卡片顶部信息
    const topDiv = document.createElement("div");
    topDiv.className = "card-top";

    const titleEl = document.createElement("div");
    titleEl.className = "card-title";
    titleEl.textContent = title;

    const tagsDiv = document.createElement("div");
    tagsDiv.className = "card-tags";
    updateCardTags(tagsDiv, item, isMain);

    topDiv.appendChild(titleEl);
    topDiv.appendChild(tagsDiv);
    card.appendChild(topDiv);

    // 略缩视频演示预览容器
    const previewBox = document.createElement("div");
    previewBox.className = "preview-box";

    if (item.poster) {
      const img = document.createElement("img");
      img.src = item.poster;
      img.className = "preview-poster";
      previewBox.appendChild(img);
    } else {
      const vid = document.createElement("video");
      vid.className = "preview-video";
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = "metadata";

      if (!isM3u8) {
        vid.src = item.url;
        vid.addEventListener("loadedmetadata", () => {
          if (vid.duration && !isNaN(vid.duration) && vid.duration > 0) {
            const dur = Math.round(vid.duration);
            item.duration = dur;
            if (dur <= 60 && !item.isMainPlayer) item.isAd = true;
            updateCardTags(tagsDiv, item, isMain);
          }
        });
        vid.addEventListener("mouseenter", () => {
          vid.play().catch(() => {});
        });
        vid.addEventListener("mouseleave", () => {
          vid.pause();
          vid.currentTime = 0;
        });
        previewBox.appendChild(vid);
      } else {
        const notice = document.createElement("div");
        notice.className = "m3u8-notice";
        notice.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px;color:#89b4fa;">✨ HLS (M3U8) 流媒体</div>
          <div>支持后台极速切片下载与自动无损合并封装为 MP4</div>
        `;
        previewBox.appendChild(notice);

        fetchM3u8Duration(item.url).then((dur) => {
          if (dur > 0) {
            item.duration = dur;
            if (dur <= 60 && !item.isMainPlayer) item.isAd = true;
            updateCardTags(tagsDiv, item, isMain);
          }
        });
      }
    }
    card.appendChild(previewBox);

    // URL 单行展示
    const urlBox = document.createElement("div");
    urlBox.className = "card-url-box";
    urlBox.textContent = item.url;
    urlBox.title = item.url;
    card.appendChild(urlBox);

    // 操作按钮
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "card-actions";

    const progressCtrl = setupCardProgress(card, actionsDiv, item, title);
    cardProgressCtrlMap.set(item.id, progressCtrl);

    if (isM3u8) {
      const btnM3u8 = document.createElement("button");
      btnM3u8.className = "act-btn primary";
      btnM3u8.title = "直接在插件后台合并下载并显示进度，关闭弹窗后台不中断";
      btnM3u8.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="8 17 12 21 16 17"></polyline>
          <line x1="12" y1="12" x2="12" y2="21"></line>
          <path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"></path>
        </svg>
        合并下载
      `;
      btnM3u8.addEventListener("click", () => {
        progressCtrl.showProgress();
        progressCtrl.updateProgress({ status: "parsing", percent: 0, speed: "0.0 MB/s" });
        chrome.runtime.sendMessage({
          action: "START_M3U8_TASK",
          task: {
            id: item.id,
            url: item.url,
            title: title,
            concurrency: 10,
            pageUrl: item.pageUrl || currentTabUrl
          }
        });
      });
      actionsDiv.appendChild(btnM3u8);

      // 新标签页独立控制台打开 (备用入口)
      const btnTab = document.createElement("button");
      btnTab.className = "act-btn secondary";
      btnTab.style.maxWidth = "36px";
      btnTab.title = "在新标签页中打开完整下载控制台 (查看分片日志)";
      btnTab.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
      `;
      btnTab.addEventListener("click", () => {
        const downloaderUrl = chrome.runtime.getURL(`downloader/m3u8_downloader.html?url=${encodeURIComponent(item.url)}&title=${encodeURIComponent(title)}`);
        chrome.tabs.create({ url: downloaderUrl });
      });
      actionsDiv.appendChild(btnTab);
    } else {
      const btnDl = document.createElement("button");
      btnDl.className = "act-btn primary";
      btnDl.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        直接下载
      `;
      btnDl.addEventListener("click", async () => {
        const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 100) + `.${format.toLowerCase()}`;
        const originalHtml = btnDl.innerHTML;
        btnDl.disabled = true;
        btnDl.innerHTML = `<span style="font-size:11px;">正在发起...</span>`;

        // 尝试方案 1：调用浏览器下载器 (带有防盗链 Referer/Origin 伪装)
        chrome.runtime.sendMessage({
          action: "TRIGGER_DOWNLOAD",
          url: item.url,
          filename: safeName,
          pageUrl: item.pageUrl || currentTabUrl
        }, async (res) => {
          if (res && res.success) {
            showToast("已成功调起浏览器下载！");
            btnDl.disabled = false;
            btnDl.innerHTML = originalHtml;
            return;
          }

          // 如果浏览器系统下载器受限 (防盗链或 CORS 报无法连接网络)，启用方案 2：内置管道极速拉取另存为
          showToast("系统下载受限，正在启动内置管道极速拉取...");
          btnDl.innerHTML = `<span style="font-size:11px;">管道抓取中...</span>`;

          try {
            const resp = await fetch(item.url, { credentials: "include" });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = safeName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
            showToast("已成功通过内置管道下载完成！");
          } catch (fetchErr) {
            showToast(`下载受限: ${fetchErr.message}，建议点击「推送到桌面端」下载！`);
          } finally {
            btnDl.disabled = false;
            btnDl.innerHTML = originalHtml;
          }
        });
      });
      actionsDiv.appendChild(btnDl);
    }

    // 复制直链按钮
    const btnCopy = document.createElement("button");
    btnCopy.className = "act-btn secondary";
    btnCopy.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      复制直链
    `;
    btnCopy.addEventListener("click", () => {
      copyToClipboard(item.url, "已复制直链到剪贴板！");
    });
    actionsDiv.appendChild(btnCopy);

    // 推送到桌面端按钮
    const btnDesktop = document.createElement("button");
    btnDesktop.className = "act-btn success";
    btnDesktop.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
      推送到桌面端
    `;
    btnDesktop.addEventListener("click", () => {
      sendToDesktopApp(item.url, title);
    });
    actionsDiv.appendChild(btnDesktop);

    card.appendChild(actionsDiv);
    return card;
  }

  /**
   * 刷新并重新渲染卡片列表 (智能识别主视频与过滤广告)
   */
  function renderList() {
    mediaListContainer.innerHTML = "";

    if (!mediaItems || mediaItems.length === 0) {
      emptyState.style.display = "flex";
      countBadge.textContent = "0 个资源";
      return;
    }

    // 1. 为所有媒体项计算智能评分
    mediaItems.forEach((m) => {
      m._score = calcMediaScore(m);
    });

    // 2. 选出得分最高的主视频候选项
    let bestItem = null;
    let maxScore = -99999;
    mediaItems.forEach((m) => {
      if (m._score > maxScore) {
        maxScore = m._score;
        bestItem = m;
      }
    });

    // 3. 根据过滤模式筛选要显示的列表
    let displayList = [];
    if (currentFilter === "main") {
      // 仅看主视频模式：排除明显广告
      displayList = mediaItems.filter((m) => {
        if (m.isAd) return false;
        // 如果页面已识别出时长 > 60 秒的正片，则短于 45 秒且非主容器的片段自动视为广告/预览过滤
        if (bestItem && bestItem.duration > 60 && m.duration > 0 && m.duration < 45 && !m.isMainPlayer) {
          return false;
        }
        return true;
      });

      // 如果全部被过滤（例如页面只有短视频），则至少保留得分最高的项
      if (displayList.length === 0 && bestItem) {
        displayList = [bestItem];
      }
      filterHintEl.textContent = `⭐ 优先推荐最长正片 (已过滤广告)`;
    } else {
      // 全部资源模式
      displayList = [...mediaItems];
      filterHintEl.textContent = `显示全部 ${mediaItems.length} 个音视频`;
    }

    // 4. 排序：推荐主视频置顶，其余按评分及时长倒序排列
    displayList.sort((a, b) => {
      if (bestItem && a.url === bestItem.url) return -1;
      if (bestItem && b.url === bestItem.url) return 1;
      return (b._score || 0) - (a._score || 0);
    });

    if (displayList.length === 0) {
      emptyState.style.display = "flex";
      countBadge.textContent = "0 个资源";
      return;
    }

    emptyState.style.display = "none";
    countBadge.textContent = `${displayList.length} / ${mediaItems.length} 个资源`;

    displayList.forEach((item) => {
      const isMain = bestItem && item.url === bestItem.url;
      const card = createMediaCard(item, isMain);
      mediaListContainer.appendChild(card);
    });

    // 查询后台活跃下载任务并自动恢复对应的卡片内嵌进度条
    chrome.runtime.sendMessage({ action: "GET_DOWNLOAD_STATUS" }, (res) => {
      if (res && res.tasks && res.tasks.length > 0) {
        for (const t of res.tasks) {
          const ctrl = cardProgressCtrlMap.get(t.id);
          if (ctrl) ctrl.updateProgress(t);
        }
      }
    });
  }

  /**
   * 从 Background 获取媒体流并主动触发 Content 扫描
   */
  function fetchMedia() {
    if (!currentTabId) return;

    chrome.tabs.sendMessage(currentTabId, { action: "FORCE_RESCAN_DOM" }, () => {
      chrome.runtime.sendMessage({
        action: "GET_MEDIA_LIST",
        tabId: currentTabId
      }, (response) => {
        if (response && response.success) {
          mediaItems = response.items || [];
          renderList();
        }
      });
    });
  }

  // 获取当前标签页信息
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      const activeTab = tabs[0];
      currentTabId = activeTab.id;
      currentTabTitle = activeTab.title || "未知页面";
      currentTabUrl = activeTab.url || "";

      tabTitleEl.textContent = currentTabTitle;
      tabTitleEl.title = `${currentTabTitle} (${currentTabUrl})`;

      fetchMedia();
    }
  });

  // 绑定过滤模式切换
  filterMainBtn.addEventListener("click", () => {
    if (currentFilter === "main") return;
    currentFilter = "main";
    filterMainBtn.classList.add("active");
    filterAllBtn.classList.remove("active");
    renderList();
  });

  filterAllBtn.addEventListener("click", () => {
    if (currentFilter === "all") return;
    currentFilter = "all";
    filterAllBtn.classList.add("active");
    filterMainBtn.classList.remove("active");
    renderList();
  });

  // 绑定基础操作事件
  btnRefresh.addEventListener("click", () => {
    showToast("正在重新嗅探当前页面...");
    fetchMedia();
  });

  btnRescan.addEventListener("click", () => {
    showToast("正在深度重新嗅探...");
    fetchMedia();
  });

  btnClear.addEventListener("click", () => {
    if (!currentTabId) return;
    chrome.runtime.sendMessage({
      action: "CLEAR_MEDIA_LIST",
      tabId: currentTabId
    }, () => {
      mediaItems = [];
      renderList();
      showToast("已清空嗅探列表");
    });
  });

  btnCopyAll.addEventListener("click", () => {
    if (!mediaItems || mediaItems.length === 0) {
      showToast("暂无可复制的视频直链");
      return;
    }
    const allUrls = mediaItems.map(m => m.url).join("\n");
    copyToClipboard(allUrls, `已复制全部 ${mediaItems.length} 条视频直链！`);
  });

  // 监听后台广播的实时下载进度
  chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "DOWNLOAD_TASK_PROGRESS" && request.data) {
      const ctrl = cardProgressCtrlMap.get(request.data.id);
      if (ctrl) {
        ctrl.updateProgress(request.data);
      }
    }
  });
});

