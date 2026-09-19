/**
 * 万能网页视频嗅探器 Pro - Main World 深度嗅探注入脚本
 * 运行于网页自身原生 JavaScript 上下文，能够直接截获被 MSE / Blob 封装前的真实流媒体地址
 */
(function () {
  "use strict";

  if (window.__PRO_SNIFFER_INJECTED__) return;
  window.__PRO_SNIFFER_INJECTED__ = true;

  const MEDIA_REGEX = /\.(m3u8|mp4|flv|webm)(\?.*)?$/i;
  const STREAM_KEYWORDS = [".m3u8", "googlevideo.com/videoplayback", "douyinvod.com", "bilivideo.com", "core_stream"];

  function notifyDetected(url, source) {
    if (!url || typeof url !== "string") return;
    if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("chrome-extension://")) return;

    let format = "VIDEO";
    const cleanUrl = url.split("?")[0].toLowerCase();
    if (cleanUrl.endsWith(".m3u8") || url.includes(".m3u8")) format = "M3U8";
    else if (cleanUrl.endsWith(".mp4")) format = "MP4";
    else if (cleanUrl.endsWith(".flv")) format = "FLV";
    else if (cleanUrl.endsWith(".webm")) format = "WEBM";

    window.dispatchEvent(
      new CustomEvent("__PRO_MEDIA_DETECTED__", {
        detail: { url, format, source }
      })
    );
  }

  // 1. Hook 原生 window.fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (resource, init) {
      try {
        const url = typeof resource === "string" ? resource : (resource && resource.url ? resource.url : "");
        if (url && (MEDIA_REGEX.test(url) || STREAM_KEYWORDS.some((k) => url.includes(k)))) {
          notifyDetected(url, "fetch");
        }
      } catch (e) {}
      return originalFetch.apply(this, arguments);
    };
  }

  // 2. Hook 原生 XMLHttpRequest.prototype.open
  if (typeof XMLHttpRequest !== "undefined" && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (typeof url === "string" && (MEDIA_REGEX.test(url) || STREAM_KEYWORDS.some((k) => url.includes(k)))) {
          notifyDetected(url, "xhr");
        }
      } catch (e) {}
      return originalOpen.apply(this, arguments);
    };
  }

  // 3. 页面全局播放器实例嗅探 (如 Bilibili __playinfo__, DPlayer, 西瓜视频等)
  function checkPlayerGlobals() {
    try {
      if (window.__playinfo__ && window.__playinfo__.data && window.__playinfo__.data.dash) {
        const videoList = window.__playinfo__.data.dash.video || [];
        if (videoList.length > 0 && videoList[0].baseUrl) {
          notifyDetected(videoList[0].baseUrl, "bilibili_dash");
        }
      }
    } catch (e) {}
  }

  if (document.readyState === "complete") {
    checkPlayerGlobals();
  } else {
    window.addEventListener("DOMContentLoaded", checkPlayerGlobals);
    window.addEventListener("load", checkPlayerGlobals);
  }
  setTimeout(checkPlayerGlobals, 2000);
  setTimeout(checkPlayerGlobals, 5000);
})();
