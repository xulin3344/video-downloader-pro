/**
 * 万能网页视频嗅探与下载器 Pro - Content Script
 * 负责主动嗅探网页内部的 <video>, <source>, DPlayer/ArtPlayer 容器与动态注入流
 */

(function () {
  "use strict";

  // 记录已经报告过的媒体 URL 及其上报时的状态
  const reportedMediaState = new Map();

  const AD_KEYWORD_REGEX = /(googleads|doubleclick|pagead|cpro\.baidu|pos\.baidu|tanx\.com|atanx|eclick|openx|adservice|adsystem|advert|union|preroll|adbreak|vast|popads|\/ad_|\/ads\/|ad-delivery|adunit)/i;

  function getPageTitle() {
    let title = "";
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) title = og.content.trim();
    if (!title) {
      const tw = document.querySelector('meta[name="twitter:title"]');
      if (tw && tw.content) title = tw.content.trim();
    }
    if (!title && document.title) {
      title = document.title.trim();
    }
    return title || "网页嗅探视频";
  }

  /**
   * 判断元素是否具有广告特征
   */
  function isLikelyAd(url, el) {
    if (AD_KEYWORD_REGEX.test(url)) return true;
    if (!el) return false;

    // 检查元素或祖先元素的 class / id
    const adClassRegex = /(^|[\s_-])(ad|ads|advert|banner|sponsor|popunder)([\s_-]|$)/i;
    let curr = el;
    let depth = 0;
    while (curr && depth < 4) {
      if (curr.id && adClassRegex.test(curr.id)) return true;
      if (curr.className && typeof curr.className === "string" && adClassRegex.test(curr.className)) return true;
      curr = curr.parentElement;
      depth++;
    }

    // 检查尺寸：极小元素通常为角标/浮动广告
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && (rect.width < 180 || rect.height < 120)) {
      return true;
    }

    return false;
  }

  /**
   * 判断是否处于网页主播放器容器内
   */
  function isMainPlayerContainer(el) {
    if (!el) return false;
    const playerRegex = /(player|dplayer|artplayer|bpx-player|xgplayer|video-js|prism-player|ckplayer|video-container)/i;
    let curr = el;
    let depth = 0;
    while (curr && depth < 6) {
      if (curr.id && playerRegex.test(curr.id)) return true;
      if (curr.className && typeof curr.className === "string" && playerRegex.test(curr.className)) return true;
      curr = curr.parentElement;
      depth++;
    }

    // 检查画面面积
    const rect = el.getBoundingClientRect();
    if (rect.width >= 400 && rect.height >= 240) {
      return true;
    }

    return false;
  }

  function reportMedia(url, format, poster, duration, el) {
    if (!url || typeof url !== "string") return;
    if (url.startsWith("data:") || url.startsWith("chrome-extension://")) return;

    // 转为绝对路径
    try {
      url = new URL(url, window.location.href).href;
    } catch (e) {
      return;
    }

    const validDuration = (typeof duration === "number" && !isNaN(duration) && duration > 0) ? Math.round(duration) : 0;
    const adFlag = isLikelyAd(url, el);
    const mainContainerFlag = isMainPlayerContainer(el);

    // 关键拦截：如果 URL 是 blob: (通常为现代播放器的 MSE 内存缓冲 Handle，如 Bilibili/抖音等)
    // blob: 属于页面内部内存指针，浏览器跨域下载器无法访问，会直接报“无法连接网络”
    // 因此绝不可将其作为独立下载项添加，而是将其关键元数据（时长、主播放器标记）同步给该页面真正拉取的网络流！
    if (url.startsWith("blob:")) {
      if (validDuration > 0 || mainContainerFlag) {
        chrome.runtime.sendMessage({
          action: "SYNC_PLAYER_META",
          meta: {
            duration: validDuration,
            poster: poster || null,
            isMainPlayer: mainContainerFlag,
            title: getPageTitle()
          }
        }).catch(() => {});
      }
      return;
    }

    // 如果已经上报过，且没有新的更有效时长信息，则不重复发送
    const prevState = reportedMediaState.get(url);
    if (prevState && prevState.duration >= validDuration && validDuration === 0) {
      return;
    }

    reportedMediaState.set(url, {
      duration: validDuration,
      isAd: adFlag,
      isMainPlayer: mainContainerFlag
    });

    const title = getPageTitle();
    const cleanUrl = url.split("?")[0].toLowerCase();
    let detectedFormat = format || "MP4";
    if (cleanUrl.endsWith(".m3u8")) detectedFormat = "M3U8";
    else if (cleanUrl.endsWith(".flv")) detectedFormat = "FLV";
    else if (cleanUrl.endsWith(".webm")) detectedFormat = "WEBM";

    const mediaItem = {
      id: `dom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url: url,
      format: detectedFormat,
      size: 0,
      sizeFormatted: "流式媒体",
      title: title,
      poster: poster || null,
      duration: validDuration,
      isAd: adFlag,
      isMainPlayer: mainContainerFlag,
      pageUrl: window.location.href,
      timestamp: Date.now(),
      source: "dom"
    };

    chrome.runtime.sendMessage({
      action: "ADD_DOM_MEDIA",
      item: mediaItem
    }).catch(() => {
      // 忽略后台还未准备好的临时异常
    });
  }

  /**
   * 绑定单个 video 标签的元数据更新监听
   */
  function bindVideoListeners(v) {
    if (v.__hasSniffListener) return;
    v.__hasSniffListener = true;

    const onMeta = () => {
      const src = v.currentSrc || v.src;
      if (src) {
        reportMedia(src, "MP4", v.poster, v.duration, v);
      }
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("durationchange", onMeta);
    v.addEventListener("play", onMeta);
  }

  /**
   * 扫描当前 DOM 中的媒体元素
   */
  function scanMediaElements() {
    // 1. 扫描所有 <video> 标签
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      bindVideoListeners(v);
      const src = v.currentSrc || v.src;
      if (src) {
        reportMedia(src, "MP4", v.poster, v.duration, v);
      }
      // 检查其子 <source> 标签
      const sources = v.querySelectorAll("source");
      sources.forEach((s) => {
        if (s.src) {
          reportMedia(s.src, s.type && s.type.includes("mpegurl") ? "M3U8" : "MP4", v.poster, v.duration, v);
        }
      });
    });

    // 2. 扫描 DPlayer / ArtPlayer / ckplayer 数据容器
    const playerContainers = document.querySelectorAll("[data-config], [data-url], .dplayer, .artplayer");
    playerContainers.forEach((el) => {
      const directUrl = el.getAttribute("data-url");
      if (directUrl) {
        reportMedia(directUrl, directUrl.includes(".m3u8") ? "M3U8" : "MP4", null, 0, el);
      }
      const cfgStr = el.getAttribute("data-config");
      if (cfgStr) {
        try {
          const cfg = JSON.parse(cfgStr);
          if (cfg.video && cfg.video.url) {
            reportMedia(cfg.video.url, cfg.video.url.includes(".m3u8") ? "M3U8" : "MP4", cfg.video.pic, 0, el);
          }
          if (cfg.video_h265 && cfg.video_h265.url) {
            reportMedia(cfg.video_h265.url, "H265 M3U8", cfg.video.pic, 0, el);
          }
        } catch (e) {
          // ignore json parse error
        }
      }
    });
  }

  // 初次加载完成扫描
  scanMediaElements();

  // 监听 DOM 变化（应对如单页应用的动态无限滚动加载和延迟挂载）
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.type === "attributes") {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) {
      scanMediaElements();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "data-url", "data-config"]
  });

  // 监听来自 MAIN world 深度注入脚本捕获的流媒体事件
  window.addEventListener("__PRO_MEDIA_DETECTED__", (evt) => {
    if (evt.detail && evt.detail.url) {
      reportMedia(evt.detail.url, evt.detail.format || "M3U8", null, 0, null);
    }
  });

  // 监听来自 Popup 的重新扫描请求
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "FORCE_RESCAN_DOM") {
      scanMediaElements();
      sendResponse({ success: true, count: reportedMediaState.size });
      return true;
    }
  });
})();
