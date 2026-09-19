/**
 * 万能网页视频嗅探与下载器 Pro - Background Service Worker (Manifest V3)
 */

// 存储每个标签页捕获到的媒体资源: tabId -> Array<MediaItem>
const tabMediaMap = new Map();

// 媒体文件后缀正则
const MEDIA_EXT_REGEX = /\.(m3u8|mp4|flv|f4v|webm|ts|mpd|m4s|m4a|avi|mkv|mov)(\?.*)?$/i;

// 常见媒体 Content-Type
const MEDIA_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/x-flv",
  "video/quicktime",
  "video/mp2t",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/dash+xml",
  "audio/mp4",
  "audio/mpeg"
];

// 媒体关键域名或路径特征 (抖音、B站、快手、各大影视CMS)
const MEDIA_KEYWORD_REGEX = /(douyinvod\.com|bilivideo\.com|googlevideo\.com|videoplayback|\.m3u8|core_stream|\/video\/tos\/)/i;

// 常见广告网络特征正则 (用于自动识别与标记广告)
const AD_KEYWORD_REGEX = /(googleads|doubleclick|pagead|cpro\.baidu|pos\.baidu|tanx\.com|atanx|eclick|openx|adservice|adsystem|advert|union|preroll|adbreak|vast|popads|\/ad_|\/ads\/|ad-delivery|adunit)/i;

/**
 * 格式化文件大小
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "未知大小";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

/**
 * 推断媒体类型标签 (MP4 / M3U8 / FLV 等)
 */
function detectFormat(url, mimeType) {
  const cleanUrl = url.split("?")[0].toLowerCase();
  if (cleanUrl.endsWith(".m3u8") || (mimeType && mimeType.includes("mpegurl"))) return "M3U8";
  if (cleanUrl.endsWith(".mp4") || (mimeType && mimeType.includes("mp4"))) return "MP4";
  if (cleanUrl.endsWith(".flv") || (mimeType && mimeType.includes("flv"))) return "FLV";
  if (cleanUrl.endsWith(".webm") || (mimeType && mimeType.includes("webm"))) return "WEBM";
  if (cleanUrl.endsWith(".ts")) return "TS";
  if (cleanUrl.endsWith(".mpd")) return "MPD";
  return "VIDEO";
}

/**
 * 异步解析 M3U8 切片总时长 (秒)
 */
async function estimateM3u8Duration(url) {
  try {
    const resp = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return 0;
    const text = await resp.text();
    // 如果是 Master 播放列表，定位到首个子流
    if (text.includes("#EXT-X-STREAM-INF")) {
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const subUrl = new URL(trimmed, url).href;
          return await estimateM3u8Duration(subUrl);
        }
      }
    }
    // 累加 #EXTINF 切片时长
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

// TS/M4S 切片与片段请求正则 (避免海量碎片污染嗅探列表)
const SEGMENT_URL_REGEX = /(\/seg[_-]?\d+|\/chunk[_-]?\d+|\/\d+\.ts|\/fragment[_-]?\d+|\/range\/|\.m4s|\.ts\?|\/ts\/)/i;

/**
 * 智能标题清理 (移除各大视频网站的后缀噪音与广告宣传标语)
 */
function cleanPageTitle(rawTitle) {
  if (!rawTitle) return "嗅探视频_" + Date.now();
  let title = rawTitle
    .replace(/_哔哩哔哩_bilibili/gi, "")
    .replace(/- 哔哩哔哩 \(゜-゜\)つロ 干杯~-bilibili/gi, "")
    .replace(/_bilibili/gi, "")
    .replace(/ - 腾讯视频/gi, "")
    .replace(/ - 优酷视频/gi, "")
    .replace(/ - 爱奇艺/gi, "")
    .replace(/ - 西瓜视频/gi, "")
    .replace(/ - 抖音/gi, "")
    .replace(/ - 在线播放.*$/gi, "")
    .replace(/ - 全集高清.*$/gi, "")
    .replace(/ - 高清免费在线观看.*$/gi, "")
    .replace(/ - 完整版在线观看.*$/gi, "")
    .replace(/_免费在线观看.*$/gi, "")
    .replace(/【.*?】/g, "")
    .trim();
  return title || rawTitle;
}

/**
 * 更新扩展图标角标 (Badge)
 */
function updateBadge(tabId) {
  const list = tabMediaMap.get(tabId) || [];
  // 角标优先显示非广告的有效视频数
  const validCount = list.filter(m => !m.isAd).length;
  const showCount = validCount > 0 ? validCount : list.length;
  chrome.action.setBadgeText({
    text: showCount > 0 ? String(showCount) : "",
    tabId: tabId
  });
  chrome.action.setBadgeBackgroundColor({
    color: "#89b4fa",
    tabId: tabId
  });
}

/**
 * 向当前 Tab 注册或更新媒体项
 */
function addMediaItem(tabId, item) {
  if (!tabId || tabId < 0 || !item || !item.url) return;
  if (item.url.startsWith("blob:") || item.url.startsWith("data:") || item.url.startsWith("chrome-extension://")) {
    return; // 坚决排除内存指针 blob，防止下载时报无法连接网络
  }
  if (!tabMediaMap.has(tabId)) {
    tabMediaMap.set(tabId, []);
  }
  const list = tabMediaMap.get(tabId);

  // 1. 如果新加入的是完整 M3U8 播放列表，自动清空该页面之前可能记录的零散 TS 切片
  if (item.format === "M3U8") {
    const nonTs = list.filter(m => m.format !== "TS");
    list.length = 0;
    list.push(...nonTs);
  }

  // 2. 如果是 TS 碎片切片：
  // 若已有 M3U8 存在，或符合切片规律，则坚决丢弃，绝不污染界面
  if (item.format === "TS") {
    if (list.some(m => m.format === "M3U8")) return;
    if (SEGMENT_URL_REGEX.test(item.url)) return;
  }

  // 标记广告属性
  if (item.isAd === undefined) {
    item.isAd = AD_KEYWORD_REGEX.test(item.url);
  }

  // 去重或更新
  const existing = list.find(m => m.url === item.url);
  if (existing) {
    if (item.duration && (!existing.duration || item.duration > existing.duration)) {
      existing.duration = item.duration;
    }
    if (item.isMainPlayer !== undefined) {
      existing.isMainPlayer = item.isMainPlayer;
    }
    if (item.isAd !== undefined) {
      existing.isAd = item.isAd;
    }
    if (item.size && !existing.size) {
      existing.size = item.size;
      existing.sizeFormatted = item.sizeFormatted;
    }
    return;
  }

  // 新增项
  list.unshift(item);
  if (list.length > 80) list.pop();
  updateBadge(tabId);

  // 如果是 M3U8 且缺少时长，异步预解析切片时长
  if (item.format === "M3U8" && (!item.duration || item.duration === 0)) {
    estimateM3u8Duration(item.url).then((dur) => {
      if (dur > 0) {
        item.duration = dur;
        // 如果时长很短 (<= 60秒)，可能是贴片广告
        if (dur <= 60 && !item.isMainPlayer) {
          item.isAd = true;
        }
        updateBadge(tabId);
      }
    });
  }
}

// -----------------------------------------------------------------------------
// 1. 核心网络请求监听 (webRequest)
// -----------------------------------------------------------------------------
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // 忽略扩展自身请求或非主要网页请求
    if (details.tabId < 0 || details.type === "main_frame") return;

    const url = details.url;
    if (!url || url.startsWith("chrome-extension://") || url.startsWith("data:") || url.startsWith("blob:")) return;

    let contentType = "";
    let contentLength = 0;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === "content-type" && h.value) {
          contentType = h.value.toLowerCase().split(";")[0].trim();
        } else if (name === "content-length" && h.value) {
          contentLength = parseInt(h.value, 10) || 0;
        }
      }
    }

    // 过滤判断：属于视频后缀 或 属于媒体MIME 或 命中视频流特征
    const hasMediaExt = MEDIA_EXT_REGEX.test(url);
    const hasMediaMime = MEDIA_MIME_TYPES.some(m => contentType.includes(m));
    const hasMediaKeyword = MEDIA_KEYWORD_REGEX.test(url);

    // 排除过小的文本或非音视频
    if (contentType.includes("javascript") || contentType.includes("html") || contentType.includes("image")) {
      return;
    }

    if (hasMediaExt || hasMediaMime || hasMediaKeyword) {
      const cleanUrl = url.split("?")[0].toLowerCase();

      // 如果当前标签页已经嗅探到了 M3U8，或者该请求是标准的切片规律，则忽略 TS/M4S 切片网络请求
      const currentList = tabMediaMap.get(details.tabId) || [];
      if ((cleanUrl.endsWith(".ts") || cleanUrl.endsWith(".m4s")) && currentList.some((m) => m.format === "M3U8")) {
        return;
      }
      if (cleanUrl.endsWith(".ts") && (contentLength < 1024 * 100 || SEGMENT_URL_REGEX.test(url))) {
        return;
      }

      chrome.tabs.get(details.tabId, (tab) => {
        const rawTitle = tab && tab.title ? tab.title : "嗅探视频";
        const pageTitle = cleanPageTitle(rawTitle);
        const format = detectFormat(url, contentType);

        const mediaItem = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          url: url,
          format: format,
          mimeType: contentType,
          size: contentLength,
          sizeFormatted: formatBytes(contentLength),
          title: pageTitle,
          pageUrl: tab ? tab.url : details.initiator,
          timestamp: Date.now(),
          source: "network"
        };

        addMediaItem(details.tabId, mediaItem);
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// -----------------------------------------------------------------------------
// 2. 标签页生命周期监听 (更新或关闭时清理)
// -----------------------------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    // 页面发生实质性跳转，清空上一个页面的嗅探缓存
    tabMediaMap.set(tabId, []);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaMap.delete(tabId);
});

// -----------------------------------------------------------------------------
// 3. 消息通讯服务 (为 Popup 及 Content Script 提供数据交换)
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request.action;

  if (action === "GET_MEDIA_LIST") {
    const tabId = request.tabId;
    const items = tabMediaMap.get(tabId) || [];
    sendResponse({ success: true, items: items });
    return true;
  }

  if (action === "CLEAR_MEDIA_LIST") {
    const tabId = request.tabId;
    tabMediaMap.set(tabId, []);
    updateBadge(tabId);
    sendResponse({ success: true });
    return true;
  }

  if (action === "ADD_DOM_MEDIA") {
    // 来自 Content Script 的 DOM 嗅探结果
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    if (tabId && request.item) {
      if (request.item.title) {
        request.item.title = cleanPageTitle(request.item.title);
      }
      addMediaItem(tabId, request.item);
    }
    sendResponse({ success: true });
    return true;
  }

  if (action === "SYNC_PLAYER_META") {
    // 来自 Content Script 的播放器元数据同步 (赋能真实网络流)
    const tabId = sender.tab ? sender.tab.id : request.tabId;
    if (tabId && request.meta) {
      const list = tabMediaMap.get(tabId) || [];
      const { duration, poster, isMainPlayer, title } = request.meta;
      for (const item of list) {
        if (duration > 0 && (!item.duration || duration > item.duration)) {
          item.duration = duration;
        }
        if (isMainPlayer && !item.isMainPlayer) {
          item.isMainPlayer = true;
        }
        if (poster && !item.poster) {
          item.poster = poster;
        }
        if (title && (!item.title || item.title === "嗅探视频")) {
          item.title = cleanPageTitle(title);
        }
      }
      updateBadge(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

// 缓存后台正在运行的下载任务
const bgActiveTasks = new Map();

let isCreatingOffscreen = null;
async function ensureOffscreenDocument() {
  if (isCreatingOffscreen) {
    await isCreatingOffscreen;
    return;
  }
  let hasDoc = false;
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      hasDoc = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL("downloader/offscreen.html")]
      });
      hasDoc = contexts.length > 0;
    }
  } catch (e) {
    hasDoc = false;
  }
  if (hasDoc) return;

  try {
    isCreatingOffscreen = chrome.offscreen.createDocument({
      url: "downloader/offscreen.html",
      reasons: ["BLOBS"],
      justification: "Download and transmux media streams in background without interruption"
    });
    await isCreatingOffscreen;
  } catch (e) {
    // Already created or ignore
  } finally {
    isCreatingOffscreen = null;
  }
}

  if (action === "DOWNLOAD_TASK_PROGRESS") {
    const data = request.data;
    if (data && data.id) {
      bgActiveTasks.set(data.id, data);
      if (data.status === "downloading" && data.percent >= 0) {
        chrome.action.setBadgeText({ text: `${data.percent}%` });
        chrome.action.setBadgeBackgroundColor({ color: "#0099ff" });
      } else if (data.status === "completed") {
        bgActiveTasks.delete(data.id);
        chrome.action.setBadgeText({ text: "✓" });
        chrome.action.setBadgeBackgroundColor({ color: "#a6e3a1" });
        setTimeout(() => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs[0]) updateBadge(tabs[0].id);
          });
        }, 3500);
      } else if (data.status === "stopped" || data.status === "error") {
        bgActiveTasks.delete(data.id);
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs && tabs[0]) updateBadge(tabs[0].id);
        });
      }
    }
    return;
  }

  if (action === "START_M3U8_TASK") {
    ensureOffscreenDocument().then(() => {
      chrome.runtime.sendMessage({
        action: "OFFSCREEN_START_TASK",
        task: request.task
      }).catch(() => {});
    });
    sendResponse({ success: true });
    return true;
  }

  if (action === "STOP_M3U8_TASK") {
    bgActiveTasks.delete(request.taskId);
    chrome.runtime.sendMessage({
      action: "OFFSCREEN_STOP_TASK",
      taskId: request.taskId
    }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (action === "GET_DOWNLOAD_STATUS") {
    const list = Array.from(bgActiveTasks.values());
    sendResponse({ success: true, tasks: list });
    return true;
  }

  if (action === "TRIGGER_DOWNLOAD") {
    const { url, filename, pageUrl } = request;

    // 排除网页内部页面级 blob 内存指针，但允许扩展自身生成的 blob:chrome-extension:// 文件
    const isExtensionBlob = url && url.startsWith("blob:") && url.includes(chrome.runtime.id);
    if (!url || (url.startsWith("blob:") && !isExtensionBlob) || url.startsWith("data:")) {
      sendResponse({ success: false, error: "无法直接下载网页内部内存缓冲流，请选择列表中嗅探到的真实视频源流！" });
      return true;
    }

    // 如果是扩展内部生成的合成文件，直接调起保存，不需要做防盗链请求头修改
    if (isExtensionBlob) {
      chrome.downloads.download({
        url: url,
        filename: filename || "video.mp4",
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId: downloadId });
        }
      });
      return true;
    }

    // 动态配置 declarativeNetRequest 防盗链伪装规则
    const prepareAntiLeechRule = async () => {
      if (pageUrl && chrome.declarativeNetRequest) {
        try {
          const origin = new URL(pageUrl).origin;
          const cleanUrl = url.split("?")[0];
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [7777],
            addRules: [{
              id: 7777,
              priority: 1,
              action: {
                type: "modifyHeaders",
                requestHeaders: [
                  { header: "Referer", operation: "set", value: pageUrl },
                  { header: "Origin", operation: "set", value: origin }
                ]
              },
              condition: {
                urlFilter: cleanUrl.slice(0, 80),
                resourceTypes: ["other", "media", "xmlhttprequest", "main_frame", "sub_frame"]
              }
            }]
          });
        } catch (e) {
          // ignore rule setup error
        }
      }
    };

    prepareAntiLeechRule().finally(() => {
      const downloadHeaders = [];
      if (pageUrl) {
        downloadHeaders.push({ name: "Referer", value: pageUrl });
        try {
          downloadHeaders.push({ name: "Origin", value: new URL(pageUrl).origin });
        } catch (e) {}
      }

      const downloadOptions = {
        url: url,
        filename: filename || "video.mp4",
        saveAs: true
      };
      if (downloadHeaders.length > 0) {
        downloadOptions.headers = downloadHeaders;
      }

      chrome.downloads.download(downloadOptions, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId: downloadId });
        }
      });
    });

    return true;
  }
});
