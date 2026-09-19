#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
视频下载器 V11 Pro - 现代化重构版
特性：
1. 现代化 Fluent / 卡片式高质感界面，支持一键切换深色暗黑 / 浅色明亮双主题
2. 剪贴板实时智能监听与「粘贴并提取」一键入队
3. 四级真实视频标题提取机制（短链还原 + yt-dlp 原生提取 + 网页 HTML/OG Meta 兜底清洗 + 原地即时改名）
4. 批量多链接导入器（支持多行粘贴与段落正则全量提取）
5. 每个任务卡片独占独立进度条、实时网速 (MB/s)、已下/总大小与剩余时间 (ETA)，并发下载互不干扰
6. 自动检测并集成系统 FFmpeg，解锁 1080P/4K 高清流自动合并
7. 个性化设置本地持久化记忆 (config.json)
"""

import os
import sys
import re
import json
import time
import shutil
import uuid
import threading
import http.server
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import tkinter as tk
from tkinter import ttk, messagebox, filedialog

# 第三方依赖
import yt_dlp
import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageTk
from io import BytesIO


# ==============================================================================
# 1. 颜色与主题系统 (Design Tokens)
# ==============================================================================
THEMES = {
    "dark": {
        "name": "dark",
        "bg_main": "#181825",        # 主背景深灰蓝
        "bg_card": "#1e1e2e",        # 卡片背景
        "bg_card_hover": "#28283d",  # 卡片悬停/高亮
        "bg_input": "#11111b",       # 输入框背景
        "border": "#313244",         # 边框
        "text_main": "#cdd6f4",      # 主要文字
        "text_sub": "#9399b2",       # 次要文字/标签
        "accent": "#89b4fa",         # 品牌主色 (冰川蓝)
        "accent_hover": "#b4befe",
        "success": "#a6e3a1",        # 成功绿
        "warning": "#f9e2af",        # 警示黄
        "danger": "#f38ba8",         # 错误红
        "btn_bg": "#313244",
        "btn_fg": "#cdd6f4",
        "bar_trough": "#313244",
        "bar_fill": "#89b4fa",
    },
    "light": {
        "name": "light",
        "bg_main": "#f1f5f9",        # 浅灰主背景
        "bg_card": "#ffffff",        # 白色卡片
        "bg_card_hover": "#f8fafc",
        "bg_input": "#ffffff",
        "border": "#cbd5e1",
        "text_main": "#0f172a",      # 浅色主文字
        "text_sub": "#64748b",       # 浅色次文字
        "accent": "#2563eb",         # 皇家蓝
        "accent_hover": "#1d4ed8",
        "success": "#10b981",
        "warning": "#f59e0b",
        "danger": "#ef4444",
        "btn_bg": "#e2e8f0",
        "btn_fg": "#0f172a",
        "bar_trough": "#e2e8f0",
        "bar_fill": "#2563eb",
    }
}


# ==============================================================================
# 2. 配置管理器 (ConfigManager)
# ==============================================================================
class ConfigManager:
    """管理持久化配置文件"""
    def __init__(self, config_filename="config.json"):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        self.config_path = os.path.join(base_dir, config_filename)
        self.default_config = {
            "download_dir": os.path.join(os.path.expanduser("~"), "Downloads"),
            "parallel_count": 3,
            "auto_clipboard": False,
            "theme": "dark",
            "quality_mode": "best",  # best, 1080p, 720p, audio_only
        }
        self.config = self.load_config()

    def load_config(self):
        config = dict(self.default_config)
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    config.update(data)
            except Exception as e:
                print(f"[Config] 加载失败，采用默认设置: {e}")
        return config

    def save_config(self):
        try:
            with open(self.config_path, "w", encoding="utf-8") as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[Config] 保存失败: {e}")

    def get(self, key):
        return self.config.get(key, self.default_config.get(key))

    def set(self, key, value):
        self.config[key] = value
        self.save_config()


# ==============================================================================
# 3. 智能多级标题解析与清洗引擎 (TitleResolver)
# ==============================================================================
class TitleResolver:
    """四级标题解析策略与短链还原"""

    COMMON_SUFFIXES = [
        r" - 哔哩哔哩_bilibili",
        r"_哔哩哔哩_bilibili",
        r" - 哔哩哔哩 \(゜-゜\)つロ 干杯~-bilibili",
        r" - bilibili",
        r" - YouTube",
        r"_腾讯视频",
        r"_爱奇艺",
        r"_优酷网",
        r"_好看视频",
        r" - 抖音",
        r" - 微博",
        r"_快手",
        r"_西瓜视频",
    ]

    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    )

    @classmethod
    def clean_title(cls, title, fallback="视频"):
        """彻底清洗标题，去掉各网站宣传后缀及 Windows 非法文件名字符"""
        if not title:
            return fallback

        t = str(title).strip()
        # 清除网页宣传后缀
        for suffix_pat in cls.COMMON_SUFFIXES:
            t = re.sub(suffix_pat, "", t, flags=re.IGNORECASE)

        # 清除 Windows 非法字符: \ / : * ? " < > |
        t = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", t)
        # 清除多余空格和首尾点
        t = re.sub(r"\s+", " ", t).strip(" .")

        # Windows 保留文件名规避
        reserved = {
            "CON", "PRN", "AUX", "NUL",
            "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        }
        if t.upper() in reserved:
            t = f"{t}_video"

        return t[:150] if t else fallback

    @classmethod
    def is_hash_or_empty(cls, title):
        """判断标题是否类似哈希串、随机字符串或无意义文件名"""
        if not title:
            return True
        s = str(title).strip().lower()
        if s in ["index", "video", "playlist", "videoplayback", "stream", "master", "untitled", "未命名"]:
            return True
        # 16位以上的纯16进制或UUID
        if re.fullmatch(r"[a-f0-9]{16,}", s) or re.fullmatch(r"[a-f0-9\-]{32,}", s):
            return True
        # 带扩展名的文件名作为标题
        if re.fullmatch(r"[\w\-_]+\.(m3u8|mp4|ts|mkv|flv)", s):
            return True
        return False

    @classmethod
    def resolve_redirect(cls, url):
        """还原短链接 (如 v.douyin.com, b23.tv, bit.ly 等) 并标准化特殊平台链接"""
        if not url:
            return url

        # 0. 抖音平台链接标准化: modal_id / item_id / vid / iesdouyin 转换为标准视频地址
        # 例如: https://www.douyin.com/jingxuan?modal_id=7680147714327219462
        douyin_modal = re.search(r'douyin\.com/[^\s\?]*\?[^\s]*(?:modal_id|item_id|vid)=(\d+)', url)
        if douyin_modal:
            return f"https://www.douyin.com/video/{douyin_modal.group(1)}"
        douyin_share = re.search(r'iesdouyin\.com/share/video/(\d+)', url)
        if douyin_share:
            return f"https://www.douyin.com/video/{douyin_share.group(1)}"

        try:
            headers = {"User-Agent": cls.USER_AGENT}
            resp = requests.head(url, headers=headers, allow_redirects=True, timeout=5)
            if resp and resp.url:
                target_url = resp.url
                # 检查重定向后的 URL 是否包含 modal_id 或 iesdouyin
                m1 = re.search(r'douyin\.com/[^\s\?]*\?[^\s]*(?:modal_id|item_id|vid)=(\d+)', target_url)
                if m1:
                    return f"https://www.douyin.com/video/{m1.group(1)}"
                m2 = re.search(r'iesdouyin\.com/share/video/(\d+)', target_url)
                if m2:
                    return f"https://www.douyin.com/video/{m2.group(1)}"
                return target_url
        except Exception:
            pass
        return url

    @classmethod
    def extract_webpage_title(cls, url):
        """当 yt-dlp 标题提取为直链哈希或无意义字符时，爬取原网页 HTML 中的 Meta / Title 标签"""
        try:
            headers = {"User-Agent": cls.USER_AGENT}
            resp = requests.get(url, headers=headers, timeout=6)
            if resp.status_code == 200:
                try:
                    html = resp.content.decode("utf-8")
                except UnicodeDecodeError:
                    html = resp.content.decode("gb18030", errors="ignore")
                soup = BeautifulSoup(html, "html.parser")

                # 优先寻找 OpenGraph 标题
                og_title = soup.find("meta", property="og:title")
                if og_title and og_title.get("content"):
                    return cls.clean_title(og_title["content"].strip())

                tw_title = soup.find("meta", attrs={"name": "twitter:title"})
                if tw_title and tw_title.get("content"):
                    return cls.clean_title(tw_title["content"].strip())

                # 普通 title 标签
                if soup.title and soup.title.string:
                    return cls.clean_title(soup.title.string.strip())
        except Exception:
            pass
        return None


# ==============================================================================
# 3.5 通用网页内嵌播放器与流媒体嗅探器 (MediaSniffer)
# ==============================================================================
class MediaSniffer:
    """通用网页内嵌播放器与流媒体嗅探器 (DPlayer / ArtPlayer / ckplayer / HTML5 Video / iframe / script m3u8)"""

    @classmethod
    def probe_m3u8_duration(cls, m3u8_url, referer):
        """拉取 m3u8 播放列表精准解析计算视频总时长 (秒)"""
        try:
            headers = {
                "User-Agent": TitleResolver.USER_AGENT,
                "Referer": referer
            }
            resp = requests.get(m3u8_url, headers=headers, timeout=4)
            if resp.status_code == 200:
                extinfs = re.findall(r'#EXTINF:([\d\.]+)', resp.text)
                if extinfs:
                    return sum(float(x) for x in extinfs)
        except Exception:
            pass
        return 0

    @classmethod
    def sniff(cls, page_url):
        """嗅探指定网页中内嵌的真实视频流与标题"""
        parsed = urlparse(page_url)
        referer = f"{parsed.scheme}://{parsed.netloc}/"
        headers = {
            "User-Agent": TitleResolver.USER_AGENT,
            "Referer": referer
        }

        try:
            resp = requests.get(page_url, headers=headers, timeout=8)
            try:
                html = resp.content.decode("utf-8")
            except UnicodeDecodeError:
                html = resp.content.decode("gb18030", errors="ignore")
            soup = BeautifulSoup(html, "html.parser")
        except Exception:
            return None, []

        # 1. 抓取真实中文标题与封面
        real_title = None
        thumbnail = None

        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            real_title = og_title["content"].strip()
        elif soup.title and soup.title.string:
            real_title = soup.title.string.strip()

        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            thumbnail = og_image["content"].strip()

        media_items = []

        # 2. 嗅探 DPlayer / ArtPlayer / ckplayer 容器 (data-config, data-video, data-url)
        for dp in soup.find_all(attrs={"class": re.compile(r"dplayer|artplayer|player", re.I)}):
            dp_title = dp.get("data-video_title")
            if dp_title and not real_title:
                real_title = dp_title.strip()

            cfg_str = dp.get("data-config")
            if cfg_str:
                try:
                    cfg = json.loads(cfg_str)
                    v_h265 = cfg.get("video_h265", {})
                    if isinstance(v_h265, dict) and v_h265.get("url"):
                        m_url = v_h265["url"]
                        dur = cls.probe_m3u8_duration(m_url, referer)
                        media_items.append({"url": m_url, "type": "H265 M3U8", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": dur})
                    v_obj = cfg.get("video", {})
                    if isinstance(v_obj, dict) and v_obj.get("url"):
                        m_url = v_obj["url"]
                        dur = cls.probe_m3u8_duration(m_url, referer)
                        media_items.append({"url": m_url, "type": "M3U8", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": dur})
                except Exception:
                    pass

            if dp.get("data-url"):
                d_url = dp["data-url"]
                dur = cls.probe_m3u8_duration(d_url, referer) if ".m3u8" in d_url else 0
                media_items.append({"url": d_url, "type": "Direct", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": dur})

        # 3. 嗅探 HTML5 <video> 与 <source> 标签
        for v in soup.find_all("video"):
            v_src = v.get("src")
            v_poster = v.get("poster")
            if v_src:
                media_items.append({"url": v_src, "type": "HTML5 Video", "title": real_title, "referer": referer, "thumbnail": v_poster or thumbnail, "duration": 0})
            for s in v.find_all("source"):
                s_src = s.get("src")
                if s_src:
                    media_items.append({"url": s_src, "type": "HTML5 Source", "title": real_title, "referer": referer, "thumbnail": v_poster or thumbnail, "duration": 0})

        # 4. 嗅探 iframe 播放器嵌入
        for ifr in soup.find_all("iframe"):
            src = ifr.get("src") or ifr.get("data-src")
            if src and any(k in src.lower() for k in ["player", "m3u8", "video", "play"]):
                if src.startswith("//"):
                    src = parsed.scheme + ":" + src
                elif src.startswith("/"):
                    src = f"{parsed.scheme}://{parsed.netloc}{src}"
                param_url = re.findall(r'[?&](?:url|v|vid)=([^&]+)', src)
                if param_url:
                    from urllib.parse import unquote
                    extracted_stream = unquote(param_url[0])
                    if extracted_stream.startswith("http"):
                        dur = cls.probe_m3u8_duration(extracted_stream, referer) if ".m3u8" in extracted_stream else 0
                        media_items.append({"url": extracted_stream, "type": "Iframe Stream", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": dur})
                else:
                    media_items.append({"url": src, "type": "Iframe Embed", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": 0})

        # 5. 正则扫描 script 代码中的 m3u8 / mp4
        if not media_items:
            found_streams = re.findall(r'https?://[^\s"\'<>]+\.(?:m3u8|mp4)[^\s"\'<>]*', html, re.I)
            for fs in found_streams:
                dur = cls.probe_m3u8_duration(fs, referer) if ".m3u8" in fs else 0
                media_items.append({"url": fs, "type": "Script Stream", "title": real_title, "referer": referer, "thumbnail": thumbnail, "duration": dur})

        # 去重
        seen = set()
        deduped = []
        for item in media_items:
            u = item["url"]
            if u not in seen:
                seen.add(u)
                deduped.append(item)

        cleaned_title = TitleResolver.clean_title(real_title) if real_title else None
        return cleaned_title, deduped


# ==============================================================================
# 4. 任务卡片控件 (TaskCard Widget)
# ==============================================================================
class TaskCard(tk.Frame):
    """现代化任务卡片：包含专属独立进度条、缩略图、多行可编辑标题、网速监控"""
    def __init__(self, parent, task_data, app):
        super().__init__(
            parent,
            bg=app.theme["bg_card"],
            highlightbackground=app.theme["border"],
            highlightthickness=1,
            padx=12,
            pady=10
        )
        self.app = app
        self.task_data = task_data
        self.task_id = task_data["id"]

        self._build_ui()

    def _build_ui(self):
        t = self.app.theme

        # 1. 顶部行：勾选框 + 平台/格式标签 + 时长 + 快捷操作按钮
        top_row = tk.Frame(self, bg=t["bg_card"])
        top_row.pack(fill=tk.X, expand=True)

        self.chk_var = tk.BooleanVar(value=True)
        self.chk = tk.Checkbutton(
            top_row,
            variable=self.chk_var,
            bg=t["bg_card"],
            activebackground=t["bg_card"],
            selectcolor=t["bg_input"],
            bd=0
        )
        self.chk.pack(side=tk.LEFT)

        # 平台标签 (Badge)
        platform_text = self.task_data.get("extractor", "通用视频").upper()
        self.platform_badge = tk.Label(
            top_row,
            text=f" {platform_text} ",
            bg=t["bg_input"],
            fg=t["accent"],
            font=("Segoe UI", 8, "bold"),
            padx=4,
            pady=1
        )
        self.platform_badge.pack(side=tk.LEFT, padx=(5, 8))

        # 时长标签
        duration_str = self.format_duration(self.task_data.get("duration", 0))
        self.duration_label = tk.Label(
            top_row,
            text=f"⏱ {duration_str}",
            bg=t["bg_card"],
            fg=t["text_sub"],
            font=("Segoe UI", 8)
        )
        self.duration_label.pack(side=tk.LEFT)

        # 右侧操作按钮集
        self.btn_del = tk.Button(
            top_row,
            text="✕ 移除",
            command=lambda: self.app.remove_task(self.task_id),
            bg=t["bg_card"],
            fg=t["danger"],
            activebackground=t["bg_card_hover"],
            activeforeground=t["danger"],
            bd=0,
            cursor="hand2",
            font=("Microsoft YaHei UI", 8)
        )
        self.btn_del.pack(side=tk.RIGHT, padx=2)

        self.btn_action = tk.Button(
            top_row,
            text="▶ 开始",
            command=lambda: self.app.start_single_download(self.task_id),
            bg=t["accent"],
            fg="#ffffff" if t["name"] == "light" else "#11111b",
            activebackground=t["accent_hover"],
            bd=0,
            cursor="hand2",
            padx=8,
            pady=2,
            font=("Microsoft YaHei UI", 8, "bold")
        )
        self.btn_action.pack(side=tk.RIGHT, padx=6)

        # 2. 中间主体：左侧封面缩略图 + 右侧信息区
        body_frame = tk.Frame(self, bg=t["bg_card"])
        body_frame.pack(fill=tk.X, expand=True, pady=(8, 4))

        # 缩略图容器 (128x72)
        self.thumb_label = tk.Label(
            body_frame,
            text="加载封面...",
            bg=t["bg_input"],
            fg=t["text_sub"],
            width=16,
            height=4,
            font=("Segoe UI", 8)
        )
        self.thumb_label.pack(side=tk.LEFT, padx=(0, 12))

        # 右侧内容区
        info_frame = tk.Frame(body_frame, bg=t["bg_card"])
        info_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 标题栏（支持点击重命名）
        title_box = tk.Frame(info_frame, bg=t["bg_card"])
        title_box.pack(fill=tk.X, expand=True)

        self.title_var = tk.StringVar(value=self.task_data.get("title", "未命名视频"))
        self.title_label = tk.Label(
            title_box,
            textvariable=self.title_var,
            bg=t["bg_card"],
            fg=t["text_main"],
            font=("Microsoft YaHei UI", 10, "bold"),
            anchor="w",
            wraplength=520,
            justify=tk.LEFT,
            cursor="hand2"
        )
        self.title_label.pack(side=tk.LEFT, fill=tk.X, expand=True)
        self.title_label.bind("<Double-Button-1>", lambda e: self.rename_title())

        self.btn_rename = tk.Button(
            title_box,
            text="✎ 改名",
            command=self.rename_title,
            bg=t["bg_card"],
            fg=t["text_sub"],
            bd=0,
            cursor="hand2",
            font=("Microsoft YaHei UI", 8)
        )
        self.btn_rename.pack(side=tk.RIGHT, padx=2)

        # 专属独立进度条
        progress_container = tk.Frame(info_frame, bg=t["bg_card"])
        progress_container.pack(fill=tk.X, expand=True, pady=(6, 4))

        self.progress_var = tk.DoubleVar(value=0.0)
        self.progress_bar = ttk.Progressbar(
            progress_container,
            variable=self.progress_var,
            maximum=100.0,
            mode="determinate"
        )
        self.progress_bar.pack(fill=tk.X, expand=True)

        # 状态指示与下载速度信息
        status_row = tk.Frame(info_frame, bg=t["bg_card"])
        status_row.pack(fill=tk.X, expand=True)

        self.status_var = tk.StringVar(value="等待下载")
        self.status_label = tk.Label(
            status_row,
            textvariable=self.status_var,
            bg=t["bg_card"],
            fg=t["text_sub"],
            font=("Segoe UI", 9)
        )
        self.status_label.pack(side=tk.LEFT)

        self.speed_var = tk.StringVar(value="")
        self.speed_label = tk.Label(
            status_row,
            textvariable=self.speed_var,
            bg=t["bg_card"],
            fg=t["accent"],
            font=("Segoe UI", 9, "bold")
        )
        self.speed_label.pack(side=tk.RIGHT)

    def rename_title(self):
        """原地弹窗修改视频标题"""
        new_title = tk_simpledialog_askstring(
            "修改标题",
            "请输入自定义保存文件名 (无需扩展名):",
            initialvalue=self.title_var.get(),
            parent=self.app.root
        )
        if new_title and new_title.strip():
            cleaned = TitleResolver.clean_title(new_title.strip())
            self.title_var.set(cleaned)
            self.task_data["title"] = cleaned
            self.task_data["safe_title"] = cleaned

    def update_progress(self, percent, speed_str="", downloaded_str="", eta_str=""):
        """更新该卡片独立的进度条与状态标签"""
        self.progress_var.set(percent)
        t = self.app.theme
        if percent < 100:
            self.status_label.config(fg=t["warning"])
            status_text = f"正在下载 {percent:.1f}% ({downloaded_str})"
            if eta_str:
                status_text += f" | 剩余: {eta_str}"
            self.status_var.set(status_text)
            self.speed_var.set(speed_str)
        else:
            self.status_label.config(fg=t["success"])
            self.status_var.set("✓ 下载完成，正在转码/合并...")
            self.speed_var.set("")

    def set_completed(self, filepath=None):
        """设置完成状态"""
        t = self.app.theme
        self.progress_var.set(100.0)
        self.status_label.config(fg=t["success"])
        self.status_var.set("✓ 已完成")
        self.speed_var.set("")
        self.task_data["status"] = "completed"
        self.task_data["filepath"] = filepath

        self.btn_action.config(
            text="📂 打开位置",
            bg=t["success"],
            fg="#ffffff" if t["name"] == "light" else "#11111b",
            state=tk.NORMAL,
            command=self.open_file_location
        )

    def set_failed(self, err_msg):
        """设置失败状态"""
        t = self.app.theme
        self.status_label.config(fg=t["danger"])
        self.status_var.set(f"✗ 失败: {err_msg[:40]}")
        self.speed_var.set("")
        self.task_data["status"] = "failed"
        self.btn_action.config(
            text="↻ 重试",
            bg=t["warning"],
            fg="#11111b",
            state=tk.NORMAL,
            command=lambda: self.app.start_single_download(self.task_id)
        )

    def open_file_location(self):
        """打开下载产物所在文件夹"""
        filepath = self.task_data.get("filepath")
        if filepath and os.path.exists(filepath):
            if sys.platform == "win32":
                os.system(f'explorer /select,"{os.path.abspath(filepath)}"')
            else:
                os.system(f'open "{os.path.dirname(filepath)}"')
        else:
            download_dir = self.app.config_mgr.get("download_dir")
            if os.path.exists(download_dir):
                if sys.platform == "win32":
                    os.system(f'explorer "{os.path.abspath(download_dir)}"')
                else:
                    os.system(f'open "{download_dir}"')

    @staticmethod
    def format_duration(seconds):
        if not seconds:
            return "未知时长"
        try:
            s = int(seconds)
            h, rem = divmod(s, 3600)
            m, sec = divmod(rem, 60)
            if h > 0:
                return f"{h:02d}:{m:02d}:{sec:02d}"
            return f"{m:02d}:{sec:02d}"
        except Exception:
            return "未知时长"


def tk_simpledialog_askstring(title, prompt, initialvalue="", parent=None):
    """轻量实现标题修改弹窗"""
    dialog = tk.Toplevel(parent)
    dialog.title(title)
    dialog.geometry("460x140")
    dialog.resizable(False, False)
    dialog.transient(parent)
    dialog.grab_set()

    result = [None]

    ttk.Label(dialog, text=prompt, font=("Microsoft YaHei UI", 9)).pack(padx=20, pady=(15, 5), anchor="w")
    entry = ttk.Entry(dialog, font=("Microsoft YaHei UI", 9))
    entry.insert(0, initialvalue)
    entry.pack(padx=20, fill=tk.X, expand=True)
    entry.focus_set()

    def on_ok():
        result[0] = entry.get()
        dialog.destroy()

    def on_cancel():
        dialog.destroy()

    btn_box = ttk.Frame(dialog)
    btn_box.pack(pady=10, side=tk.BOTTOM)
    ttk.Button(btn_box, text="确定", command=on_ok).pack(side=tk.LEFT, padx=10)
    ttk.Button(btn_box, text="取消", command=on_cancel).pack(side=tk.LEFT)

    entry.bind("<Return>", lambda e: on_ok())
    entry.bind("<Escape>", lambda e: on_cancel())

    parent.wait_window(dialog)
    return result[0]


# ==============================================================================
# 5. 主程序与控制中心 (VideoDownloaderApp)
# ==============================================================================
class VideoDownloaderApp:
    def __init__(self, root):
        self.root = root
        self.root.title("视频下载器 V11 Pro - 全能极速版")
        self.root.geometry("1020x760")
        self.root.minsize(860, 600)

        # 核心配置
        self.config_mgr = ConfigManager()
        self.current_theme_name = self.config_mgr.get("theme")
        self.theme = THEMES.get(self.current_theme_name, THEMES["dark"])

        # 任务与线程池管理
        self.tasks = {}       # {task_id: task_data}
        self.task_cards = {}  # {task_id: TaskCard}
        self.executor = ThreadPoolExecutor(max_workers=self.config_mgr.get("parallel_count"))
        self.thumb_executor = ThreadPoolExecutor(max_workers=4)

        # FFmpeg 检测
        self.ffmpeg_path = self._detect_ffmpeg()

        # 剪贴板监听状态
        self.last_clipboard = ""
        self.clipboard_monitor_active = False

        # 初始化主题与界面
        self._apply_theme_styles()
        self._build_main_ui()

        # 启动剪贴板监听
        if self.config_mgr.get("auto_clipboard"):
            self.toggle_clipboard_monitor(force_state=True)

        # 启动浏览器扩展通信桥梁 (127.0.0.1:18888)
        self._start_browser_bridge_server()

    def _start_browser_bridge_server(self):
        """启动轻量级本地 HTTP 桥梁，接收浏览器扩展一键投送的视频任务"""
        app_ref = self

        class BridgeHandler(http.server.BaseHTTPRequestHandler):
            def do_OPTIONS(self):
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_POST(self):
                if self.path == "/api/add_task":
                    try:
                        length = int(self.headers.get("Content-Length", 0))
                        body = self.rfile.read(length).decode("utf-8")
                        data = json.loads(body)
                        url = data.get("url")
                        if url:
                            app_ref.root.after(0, lambda: app_ref._handle_bridge_incoming_url(url))
                            self.send_response(200)
                            self.send_header("Content-Type", "application/json")
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            self.wfile.write(b'{"success": true}')
                            return
                    except Exception:
                        pass
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

            def log_message(self, format, *args):
                pass  # 静默控制台

        def run_server():
            try:
                server = http.server.HTTPServer(("127.0.0.1", 18888), BridgeHandler)
                server.serve_forever()
            except Exception:
                pass

        t = threading.Thread(target=run_server, daemon=True)
        t.start()

    def _handle_bridge_incoming_url(self, url):
        """响应浏览器扩展直接投送任务"""
        self.url_var.set(url)
        self.set_status(f"收到浏览器插件投送链接，正在解析: {url}")
        try:
            self.root.deiconify()
            self.root.lift()
        except Exception:
            pass
        self.extract_and_add()

    def _detect_ffmpeg(self):
        """检测系统是否存在 ffmpeg 可执行文件"""
        candidates = [
            shutil.which("ffmpeg"),
            r"C:\ProgramData\scoop\shims\ffmpeg.exe",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg.exe"),
        ]
        for path in candidates:
            if path and os.path.exists(path):
                return path
        return None

    def _apply_theme_styles(self):
        """配置全局 ttk 样式体系"""
        t = self.theme
        self.root.configure(bg=t["bg_main"])

        style = ttk.Style()
        style.theme_use("clam")

        # 通用配置
        style.configure(".", background=t["bg_main"], foreground=t["text_main"], font=("Microsoft YaHei UI", 9))
        
        # 按钮样式
        style.configure(
            "Accent.TButton",
            background=t["accent"],
            foreground="#ffffff" if t["name"] == "light" else "#11111b",
            font=("Microsoft YaHei UI", 9, "bold"),
            borderwidth=0,
            padding=6
        )
        style.map(
            "Accent.TButton",
            background=[("active", t["accent_hover"])],
        )

        style.configure(
            "Secondary.TButton",
            background=t["btn_bg"],
            foreground=t["btn_fg"],
            font=("Microsoft YaHei UI", 9),
            borderwidth=0,
            padding=5
        )
        style.map(
            "Secondary.TButton",
            background=[("active", t["bg_card_hover"])]
        )

        # 进度条样式
        style.configure(
            "Horizontal.TProgressbar",
            troughcolor=t["bar_trough"],
            background=t["bar_fill"],
            bordercolor=t["border"],
            lightcolor=t["bar_fill"],
            darkcolor=t["bar_fill"]
        )

        # 滚动条样式
        style.configure(
            "Vertical.TScrollbar",
            background=t["btn_bg"],
            troughcolor=t["bg_main"],
            bordercolor=t["border"],
            arrowcolor=t["text_sub"]
        )

    def _build_main_ui(self):
        """构建主窗口界面"""
        t = self.theme

        # ----------------------------------------------------
        # 顶部导航栏 (Header Bar)
        # ----------------------------------------------------
        header_frame = tk.Frame(self.root, bg=t["bg_card"], padx=16, pady=12)
        header_frame.pack(fill=tk.X)

        # Logo / Title
        logo_box = tk.Frame(header_frame, bg=t["bg_card"])
        logo_box.pack(side=tk.LEFT)

        title_lbl = tk.Label(
            logo_box,
            text="⚡ 视频下载器 V11 Pro",
            font=("Segoe UI", 13, "bold"),
            bg=t["bg_card"],
            fg=t["accent"]
        )
        title_lbl.pack(side=tk.LEFT)

        # FFmpeg 状态胶囊
        if self.ffmpeg_path:
            ffmpeg_badge = tk.Label(
                logo_box,
                text="● FFmpeg 已就绪",
                font=("Segoe UI", 8, "bold"),
                bg=t["bg_input"],
                fg=t["success"],
                padx=6,
                pady=2
            )
        else:
            ffmpeg_badge = tk.Label(
                logo_box,
                text="▲ 未检测到 FFmpeg (音视频可能分离)",
                font=("Segoe UI", 8),
                bg=t["bg_input"],
                fg=t["warning"],
                padx=6,
                pady=2
            )
        ffmpeg_badge.pack(side=tk.LEFT, padx=(10, 0))

        # 顶部右侧快捷开关 (主题切换、剪贴板监听、批量添加)
        header_right = tk.Frame(header_frame, bg=t["bg_card"])
        header_right.pack(side=tk.RIGHT)

        self.btn_clip_toggle = ttk.Button(
            header_right,
            text="📋 剪贴板监听: 关",
            style="Secondary.TButton",
            command=self.toggle_clipboard_monitor
        )
        self.btn_clip_toggle.pack(side=tk.LEFT, padx=4)

        ttk.Button(
            header_right,
            text="➕ 批量添加链接",
            style="Accent.TButton",
            command=self.open_batch_dialog
        ).pack(side=tk.LEFT, padx=4)

        theme_icon = "☀️ 浅色模式" if self.current_theme_name == "dark" else "🌙 深色模式"
        self.btn_theme_toggle = ttk.Button(
            header_right,
            text=theme_icon,
            style="Secondary.TButton",
            command=self.toggle_theme
        )
        self.btn_theme_toggle.pack(side=tk.LEFT, padx=4)

        # ----------------------------------------------------
        # 快捷输入与提取区域 (Quick Input Area)
        # ----------------------------------------------------
        input_card = tk.Frame(self.root, bg=t["bg_card"], padx=16, pady=10)
        input_card.pack(fill=tk.X, padx=12, pady=(10, 6))

        tk.Label(
            input_card,
            text="视频网址:",
            bg=t["bg_card"],
            fg=t["text_main"],
            font=("Microsoft YaHei UI", 9, "bold")
        ).pack(side=tk.LEFT)

        self.url_entry = tk.Entry(
            input_card,
            bg=t["bg_input"],
            fg=t["text_main"],
            insertbackground=t["accent"],
            highlightbackground=t["border"],
            highlightthickness=1,
            bd=0,
            font=("Consolas", 10),
            relief=tk.FLAT
        )
        self.url_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=8, ipady=4)
        self.url_entry.bind("<Return>", lambda e: self.extract_single_url())

        ttk.Button(
            input_card,
            text="智能提取",
            style="Accent.TButton",
            command=self.extract_single_url
        ).pack(side=tk.LEFT, padx=3)

        ttk.Button(
            input_card,
            text="粘贴并提取",
            style="Secondary.TButton",
            command=self.paste_and_extract
        ).pack(side=tk.LEFT, padx=3)

        # ----------------------------------------------------
        # 下载配置工具栏 (Settings & Global Actions Toolbar)
        # ----------------------------------------------------
        toolbar = tk.Frame(self.root, bg=t["bg_main"], padx=12, pady=4)
        toolbar.pack(fill=tk.X)

        # 保存目录
        tk.Label(toolbar, text="保存目录:", bg=t["bg_main"], fg=t["text_sub"]).pack(side=tk.LEFT)
        self.dir_label = tk.Label(
            toolbar,
            text=self.config_mgr.get("download_dir"),
            bg=t["bg_main"],
            fg=t["text_main"],
            font=("Segoe UI", 9, "underline"),
            cursor="hand2"
        )
        self.dir_label.pack(side=tk.LEFT, padx=(4, 8))
        self.dir_label.bind("<Button-1>", lambda e: self.open_download_dir())

        ttk.Button(toolbar, text="更改目录", style="Secondary.TButton", command=self.browse_dir).pack(side=tk.LEFT, padx=2)

        # 并行任务数
        tk.Label(toolbar, text="并行下载数:", bg=t["bg_main"], fg=t["text_sub"]).pack(side=tk.LEFT, padx=(16, 4))
        self.parallel_var = tk.IntVar(value=self.config_mgr.get("parallel_count"))
        self.parallel_spin = ttk.Spinbox(
            toolbar,
            from_=1,
            to=8,
            width=4,
            textvariable=self.parallel_var,
            command=self.on_parallel_changed
        )
        self.parallel_spin.pack(side=tk.LEFT)

        # 画质偏好
        tk.Label(toolbar, text="画质偏好:", bg=t["bg_main"], fg=t["text_sub"]).pack(side=tk.LEFT, padx=(16, 4))
        self.quality_var = tk.StringVar(value=self.config_mgr.get("quality_mode"))
        self.quality_combo = ttk.Combobox(
            toolbar,
            textvariable=self.quality_var,
            values=["best (最佳画质)", "1080p (高清1080P)", "720p (标清720P)", "audio_only (仅提取音频)"],
            state="readonly",
            width=18
        )
        self.quality_combo.pack(side=tk.LEFT)
        self.quality_combo.bind("<<ComboboxSelected>>", self.on_quality_changed)

        # 右侧全局操作 (全部开始、全选、反选、清空已完成)
        ttk.Button(toolbar, text="▶ 开始全部", style="Accent.TButton", command=self.start_all_downloads).pack(side=tk.RIGHT, padx=4)
        ttk.Button(toolbar, text="清空已完成", style="Secondary.TButton", command=self.clear_completed_tasks).pack(side=tk.RIGHT, padx=4)
        ttk.Button(toolbar, text="反选", style="Secondary.TButton", command=self.invert_selection).pack(side=tk.RIGHT, padx=2)
        ttk.Button(toolbar, text="全选", style="Secondary.TButton", command=self.select_all).pack(side=tk.RIGHT, padx=2)

        # ----------------------------------------------------
        # 任务卡片滚动列表容器 (Scrollable Tasks Canvas)
        # ----------------------------------------------------
        list_container = tk.Frame(self.root, bg=t["bg_main"])
        list_container.pack(fill=tk.BOTH, expand=True, padx=12, pady=(4, 6))

        self.canvas = tk.Canvas(list_container, bg=t["bg_main"], bd=0, highlightthickness=0)
        self.scrollbar = ttk.Scrollbar(list_container, orient=tk.VERTICAL, command=self.canvas.yview, style="Vertical.TScrollbar")
        self.scrollable_frame = tk.Frame(self.canvas, bg=t["bg_main"])

        self.scrollable_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        )
        self.canvas_window = self.canvas.create_window((0, 0), window=self.scrollable_frame, anchor=tk.NW)
        self.canvas.configure(yscrollcommand=self.scrollbar.set)

        self.canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        self.scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        # 响应窗口宽度调整卡片宽度
        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig(self.canvas_window, width=e.width)
        )

        # 鼠标滚轮绑定
        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)

        # 列表空态提示
        self.empty_label = tk.Label(
            self.scrollable_frame,
            text="暂无下载任务\n支持上方输入单链接、批量粘贴或复制链接自动提取",
            font=("Microsoft YaHei UI", 11),
            bg=t["bg_main"],
            fg=t["text_sub"],
            pady=80
        )
        self.empty_label.pack(fill=tk.BOTH, expand=True)

        # ----------------------------------------------------
        # 底部状态栏 (Footer Status Bar)
        # ----------------------------------------------------
        footer = tk.Frame(self.root, bg=t["bg_card"], padx=16, pady=6)
        footer.pack(fill=tk.X, side=tk.BOTTOM)

        self.status_left = tk.Label(
            footer,
            text="就绪",
            bg=t["bg_card"],
            fg=t["text_sub"],
            font=("Segoe UI", 9)
        )
        self.status_left.pack(side=tk.LEFT)

        self.status_right = tk.Label(
            footer,
            text="任务总数: 0 | 已完成: 0",
            bg=t["bg_card"],
            fg=t["text_sub"],
            font=("Segoe UI", 9)
        )
        self.status_right.pack(side=tk.RIGHT)

    def _on_mousewheel(self, event):
        """平滑滚动"""
        if self.canvas.winfo_exists():
            self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    # ==============================================================================
    # 6. 剪贴板自动监听逻辑
    # ==============================================================================
    def toggle_clipboard_monitor(self, force_state=None):
        """开启或关闭剪贴板智能监听"""
        if force_state is not None:
            self.clipboard_monitor_active = force_state
        else:
            self.clipboard_monitor_active = not self.clipboard_monitor_active

        self.config_mgr.set("auto_clipboard", self.clipboard_monitor_active)

        if self.clipboard_monitor_active:
            self.btn_clip_toggle.config(text="📋 剪贴板监听: 开 (自动捕获)")
            self._schedule_clipboard_check()
            self.set_status("已开启剪贴板监听：复制视频网址即可自动提取")
        else:
            self.btn_clip_toggle.config(text="📋 剪贴板监听: 关")
            self.set_status("剪贴板监听已关闭")

    def _schedule_clipboard_check(self):
        """后台轮询剪贴板"""
        if not self.clipboard_monitor_active:
            return

        try:
            content = self.root.clipboard_get()
            if content and content != self.last_clipboard:
                self.last_clipboard = content
                urls = re.findall(r"https?://[^\s<>\"'()]+", content)
                if urls:
                    url = urls[0]
                    # 避免对已经在列表中的 URL 重复提取
                    existing_urls = [task["url"] for task in self.tasks.values()]
                    if url not in existing_urls:
                        self.set_status(f"📋 监听到剪贴板新链接: {url}")
                        # 自动入队解析
                        self.url_entry.delete(0, tk.END)
                        self.url_entry.insert(0, url)
                        self.extract_info_async(url)
        except Exception:
            pass

        # 每 1.2 秒检测一次
        self.root.after(1200, self._schedule_clipboard_check)

    def paste_and_extract(self):
        """一键从剪贴板粘贴并提取"""
        try:
            content = self.root.clipboard_get()
            urls = re.findall(r"https?://[^\s<>\"'()]+", content)
            if urls:
                self.url_entry.delete(0, tk.END)
                self.url_entry.insert(0, urls[0])
                self.extract_single_url()
            else:
                messagebox.showinfo("提示", "剪贴板中未包含有效网址 (http/https)")
        except Exception as e:
            messagebox.showwarning("提示", f"读取剪贴板失败: {e}")

    # ==============================================================================
    # 7. 批量添加多链接对话框
    # ==============================================================================
    def open_batch_dialog(self):
        """弹出批量添加对话框"""
        t = self.theme
        dlg = tk.Toplevel(self.root)
        dlg.title("批量导入视频网址")
        dlg.geometry("620x460")
        dlg.configure(bg=t["bg_main"])
        dlg.transient(self.root)
        dlg.grab_set()

        header = tk.Frame(dlg, bg=t["bg_card"], padx=16, pady=10)
        header.pack(fill=tk.X)
        tk.Label(
            header,
            text="批量添加多链接 (自动去重过滤)",
            bg=t["bg_card"],
            fg=t["accent"],
            font=("Microsoft YaHei UI", 10, "bold")
        ).pack(anchor="w")
        tk.Label(
            header,
            text="可在下方直接粘贴整段文字，系统将自动识别并抽取所有以 http/https 开头的视频链接",
            bg=t["bg_card"],
            fg=t["text_sub"],
            font=("Microsoft YaHei UI", 8)
        ).pack(anchor="w", pady=(2, 0))

        content_box = tk.Frame(dlg, bg=t["bg_main"], padx=16, pady=10)
        content_box.pack(fill=tk.BOTH, expand=True)

        txt_input = tk.Text(
            content_box,
            bg=t["bg_input"],
            fg=t["text_main"],
            insertbackground=t["accent"],
            highlightbackground=t["border"],
            highlightthickness=1,
            bd=0,
            font=("Consolas", 10),
            wrap=tk.WORD
        )
        txt_input.pack(fill=tk.BOTH, expand=True)

        footer_box = tk.Frame(dlg, bg=t["bg_main"], padx=16, pady=10)
        footer_box.pack(fill=tk.X)

        count_lbl = tk.Label(footer_box, text="已识别: 0 个有效链接", bg=t["bg_main"], fg=t["text_sub"])
        count_lbl.pack(side=tk.LEFT)

        def update_count(*args):
            text = txt_input.get("1.0", tk.END)
            found = set(re.findall(r"https?://[^\s<>\"'()]+", text))
            count_lbl.config(text=f"已识别: {len(found)} 个有效链接", fg=t["accent"] if found else t["text_sub"])

        txt_input.bind("<KeyRelease>", update_count)

        def do_import():
            text = txt_input.get("1.0", tk.END)
            urls = list(dict.fromkeys(re.findall(r"https?://[^\s<>\"'()]+", text)))
            if not urls:
                messagebox.showwarning("警告", "未识别到任何有效链接，请检查输入内容", parent=dlg)
                return
            dlg.destroy()
            self.set_status(f"正在批量解析 {len(urls)} 个链接...")
            for u in urls:
                self.extract_info_async(u)

        ttk.Button(footer_box, text="立即导入并解析", style="Accent.TButton", command=do_import).pack(side=tk.RIGHT, padx=4)
        ttk.Button(footer_box, text="取消", style="Secondary.TButton", command=dlg.destroy).pack(side=tk.RIGHT)

    # ==============================================================================
    # 8. 视频信息提取流程
    # ==============================================================================
    def extract_single_url(self):
        """从输入框提取单个 URL"""
        raw_url = self.url_entry.get().strip()
        if not raw_url:
            messagebox.showwarning("提示", "请输入视频网址")
            return
        if not raw_url.startswith(("http://", "https://")):
            raw_url = "https://" + raw_url
            self.url_entry.delete(0, tk.END)
            self.url_entry.insert(0, raw_url)

        self.extract_info_async(raw_url)

    def extract_info_async(self, url):
        """异步拉取视频/播放列表信息"""
        self.set_status(f"正在深度解析: {url}...")
        threading.Thread(target=self._extract_worker, args=(url,), daemon=True).start()

    def _extract_worker(self, raw_url):
        """后台提取元数据工作线程（双引擎：yt-dlp 原生解析 + 通用网页内嵌播放器嗅探）"""
        # 1. 短链还原
        canonical_url = TitleResolver.resolve_redirect(raw_url)

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": False,
        }
        if self.ffmpeg_path:
            ydl_opts["ffmpeg_location"] = self.ffmpeg_path

        info = None
        yt_err_msg = ""
        # 2. 优先尝试 yt-dlp 原生提取
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(canonical_url, download=False)
        except Exception as e:
            yt_err_msg = str(e)
            info = None

        if info:
            if "entries" in info:
                # 播放列表 / 多视频
                entries = [e for e in info["entries"] if e]
                self.root.after(0, lambda: self.set_status(f"解析成功：发现播放列表包含 {len(entries)} 个视频"))
                for entry in entries:
                    video_url = entry.get("url") or canonical_url
                    title = entry.get("title") or "未命名视频"
                    self._create_and_add_task(entry, video_url, title)
                return
            else:
                # 单个视频
                extracted_title = info.get("title") or ""
                # 如果 yt-dlp 抓到的标题像哈希、或者为空，使用 HTML Meta 兜底策略
                if TitleResolver.is_hash_or_empty(extracted_title):
                    page_title = TitleResolver.extract_webpage_title(canonical_url)
                    if page_title:
                        extracted_title = page_title
                    elif "douyinvod.com" in canonical_url or "douyin" in canonical_url:
                        extracted_title = f"抖音嗅探视频_{int(time.time())}"

                final_title = TitleResolver.clean_title(extracted_title, info.get("id") or "未命名视频")
                self.root.after(0, lambda: self.set_status(f"解析成功: {final_title}"))
                self._create_and_add_task(info, canonical_url, final_title)
                return

        # 3. 如果 yt-dlp 失败（如独立博客、CMS站、DPlayer 等内嵌播放器网页），启动通用网页嗅探器！
        self.root.after(0, lambda: self.set_status("正在启动网页内嵌流媒体嗅探器 (DPlayer/m3u8)..."))
        page_title, media_items = MediaSniffer.sniff(canonical_url)

        if media_items:
            # 发现了内嵌流媒体！优先选取画质最佳/第一个流
            primary_item = media_items[0]
            stream_url = primary_item["url"]
            final_title = page_title or primary_item.get("title") or "网页嗅探视频"
            final_title = TitleResolver.clean_title(final_title)

            sniff_info = {
                "id": str(uuid.uuid4())[:8],
                "title": final_title,
                "duration": primary_item.get("duration", 0),
                "thumbnail": primary_item.get("thumbnail"),
                "extractor": primary_item.get("type", "WebSniffer"),
                "referer": primary_item.get("referer", canonical_url)
            }
            self.root.after(0, lambda: self.set_status(f"嗅探成功！已捕获视频流: {final_title}"))
            self._create_and_add_task(sniff_info, stream_url, final_title, referer=primary_item.get("referer"))
            return

        # 4. 彻底未能解析到任何有效视频，分流精准提示
        if "douyin.com" in canonical_url or "douyin.com" in raw_url or "Fresh cookies" in yt_err_msg:
            msg = (
                "【抖音网页版反爬提示】\n\n"
                "检测到您解析的是抖音电脑网页版页面。\n\n"
                "【为什么直接提取会失败？】\n"
                "抖音网页版采用了强力动态风控机制（强制要求在浏览器中实时运算 JS 加密签名与有效会话 Cookie），任何独立下载工具直接拉取均会被官方拦截。\n\n"
                "【如何轻松下载该视频？两种方案】：\n"
                "1. 【最推荐】您刚刚在浏览器中播放该视频时，浏览器插件（如猫抓）嗅探到的直接就是 .mp4 视频直链，请直接复制插件提取出来的直链粘贴到本软件，本软件支持高速满速直接下载！\n"
                "2. 或者使用抖音手机 App 打开视频，点击「分享」->「复制链接」（以 v.douyin.com 开头）再粘贴到本软件。"
            )
            self.root.after(0, lambda: self.set_status("提示：抖音网页版受风控拦截，请直接粘贴浏览器插件嗅探的直链下载"))
            self.root.after(0, lambda: messagebox.showinfo("抖音解析提示与解决方案", msg))
        else:
            self.root.after(0, lambda: self.set_status(f"未能从该页面中嗅探到可下载的视频: {raw_url}"))
            self.root.after(0, lambda: messagebox.showwarning("解析提示", f"未能从该页面中解析或嗅探到可播放的视频流:\n{raw_url}"))

    def _create_and_add_task(self, info, url, title, referer=None):
        """向任务列表添加卡片"""
        task_id = str(uuid.uuid4())
        task_data = {
            "id": task_id,
            "url": url,
            "title": title,
            "safe_title": title,
            "duration": info.get("duration", 0),
            "thumbnail": info.get("thumbnail"),
            "extractor": info.get("extractor", "Video"),
            "referer": referer or info.get("referer"),
            "status": "pending",
            "progress": 0.0,
            "filepath": None
        }

        self.root.after(0, lambda: self._render_task_card(task_data))

    def _render_task_card(self, task_data):
        """在主线程中渲染卡片"""
        # 隐藏空列表提示
        if self.empty_label.winfo_viewable():
            self.empty_label.pack_forget()

        task_id = task_data["id"]
        self.tasks[task_id] = task_data

        card = TaskCard(self.scrollable_frame, task_data, self)
        card.pack(fill=tk.X, expand=True, pady=4, padx=2)
        self.task_cards[task_id] = card

        # 异步加载缩略图 / 截取真实视频画面
        self.thumb_executor.submit(
            self._load_thumbnail_async,
            task_id,
            task_data.get("thumbnail"),
            task_data.get("url"),
            task_data.get("referer")
        )

        self._update_task_counters()

    def _load_thumbnail_async(self, task_id, thumb_url, video_url=None, referer=None):
        """后台拉取封面或截取视频真实画面，避免阻塞主界面"""
        photo = None

        # 1. 优先尝试使用 ffmpeg 截取视频流中第 3 秒的真实画面 (与浏览器插件效果一致)
        if self.ffmpeg_path and video_url and (".m3u8" in video_url or ".mp4" in video_url):
            try:
                import subprocess, tempfile
                temp_img = os.path.join(tempfile.gettempdir(), f"thumb_{task_id}.jpg")
                cmd = [
                    self.ffmpeg_path,
                    "-referer", referer or "https://www.google.com/",
                    "-user_agent", TitleResolver.USER_AGENT,
                    "-ss", "00:00:03",
                    "-i", video_url,
                    "-vframes", "1",
                    "-q:v", "2",
                    temp_img,
                    "-y"
                ]
                res = subprocess.run(cmd, capture_output=True, timeout=8)
                if res.returncode == 0 and os.path.exists(temp_img) and os.path.getsize(temp_img) > 1000:
                    img = Image.open(temp_img)
                    img = img.resize((128, 72), Image.Resampling.LANCZOS)
                    photo = ImageTk.PhotoImage(img)
                    try:
                        os.remove(temp_img)
                    except Exception:
                        pass
            except Exception:
                photo = None

        # 2. 降级方案：拉取网页原图封面
        if not photo and thumb_url:
            try:
                resp = requests.get(thumb_url, timeout=6)
                if resp.status_code == 200:
                    img_data = resp.content
                    img = Image.open(BytesIO(img_data))
                    img = img.resize((128, 72), Image.Resampling.LANCZOS)
                    photo = ImageTk.PhotoImage(img)
            except Exception:
                pass

        if photo:
            def apply_thumb():
                if task_id in self.task_cards:
                    card = self.task_cards[task_id]
                    card.thumb_label.config(image=photo, text="")
                    card.thumb_label.image = photo  # 保持引用

            self.root.after(0, apply_thumb)

    # ==============================================================================
    # 9. 下载调度与独立进度更新
    # ==============================================================================
    def start_all_downloads(self):
        """开始下载所有勾选的任务"""
        selected_ids = [tid for tid, card in self.task_cards.items() if card.chk_var.get() and self.tasks[tid]["status"] != "completed"]
        if not selected_ids:
            messagebox.showinfo("提示", "没有勾选待下载的任务")
            return

        self.set_status(f"开始批量下载 {len(selected_ids)} 个任务...")
        for tid in selected_ids:
            self.start_single_download(tid)

    def start_single_download(self, task_id):
        """启动单个任务下载"""
        if task_id not in self.tasks:
            return
        task = self.tasks[task_id]
        card = self.task_cards.get(task_id)

        task["status"] = "downloading"
        if card:
            card.btn_action.config(text="下载中...", state=tk.DISABLED)
            card.status_label.config(fg=self.theme["warning"])
            card.status_var.set("准备中...")

        self.executor.submit(self._download_worker, task_id)

    def _download_worker(self, task_id):
        """执行具体的 yt-dlp 下载"""
        task = self.tasks[task_id]
        card = self.task_cards.get(task_id)
        url = task["url"]
        download_dir = self.config_mgr.get("download_dir")

        if not os.path.exists(download_dir):
            try:
                os.makedirs(download_dir, exist_ok=True)
            except Exception as e:
                self.root.after(0, lambda: card.set_failed(f"无法创建下载目录: {e}"))
                return

        safe_title = TitleResolver.clean_title(task.get("title", "未命名"))
        outtmpl = os.path.join(download_dir, f"{safe_title}.%(ext)s")

        # 格式策略
        quality_mode = self.config_mgr.get("quality_mode")
        format_spec = "best"
        if quality_mode == "1080p":
            format_spec = "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
        elif quality_mode == "720p":
            format_spec = "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
        elif quality_mode == "audio_only":
            format_spec = "bestaudio/best"

        ydl_opts = {
            "format": format_spec,
            "outtmpl": outtmpl,
            "progress_hooks": [lambda d: self._progress_hook(d, task_id)],
            "quiet": True,
            "no_warnings": True,
        }

        referer = task.get("referer")
        if referer:
            ydl_opts["http_headers"] = {
                "Referer": referer,
                "User-Agent": TitleResolver.USER_AGENT
            }

        if self.ffmpeg_path:
            ydl_opts["ffmpeg_location"] = self.ffmpeg_path
            if quality_mode == "audio_only":
                ydl_opts["postprocessors"] = [{
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }]

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info_dict = ydl.extract_info(url, download=True)
                downloaded_file = ydl.prepare_filename(info_dict)
                if quality_mode == "audio_only":
                    downloaded_file = os.path.splitext(downloaded_file)[0] + ".mp3"

            self.root.after(0, lambda: self._on_task_finished(task_id, downloaded_file))
        except Exception as e:
            err_str = str(e)
            self.root.after(0, lambda: self._on_task_failed(task_id, err_str))

    def _progress_hook(self, d, task_id):
        """细粒度精准独立进度钩子"""
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            speed = d.get("speed") or 0
            eta = d.get("eta") or 0

            percent = (downloaded / total * 100.0) if total > 0 else 0.0

            # 速度格式化
            if speed > 1024 * 1024:
                speed_str = f"⚡ {speed / (1024 * 1024):.1f} MB/s"
            elif speed > 1024:
                speed_str = f"⚡ {speed / 1024:.1f} KB/s"
            else:
                speed_str = "计算中..."

            # 容量格式化
            total_mb = total / (1024 * 1024)
            down_mb = downloaded / (1024 * 1024)
            down_str = f"{down_mb:.1f} MB / {total_mb:.1f} MB" if total_mb > 0 else f"{down_mb:.1f} MB"

            # ETA 剩余时间
            eta_str = f"{int(eta // 60):02d}:{int(eta % 60):02d}" if eta else ""

            def update():
                card = self.task_cards.get(task_id)
                if card:
                    card.update_progress(percent, speed_str, down_str, eta_str)

            self.root.after(0, update)

    def _on_task_finished(self, task_id, filepath):
        """任务顺利下载完成"""
        card = self.task_cards.get(task_id)
        if card:
            card.set_completed(filepath)
        self._update_task_counters()
        self.set_status("任务下载完成！")

    def _on_task_failed(self, task_id, err_msg):
        """任务下载失败"""
        card = self.task_cards.get(task_id)
        if card:
            card.set_failed(err_msg)
        self._update_task_counters()
        self.set_status(f"下载失败: {err_msg[:60]}")

    # ==============================================================================
    # 10. 全局操作与工具函数
    # ==============================================================================
    def remove_task(self, task_id):
        """移除指定任务卡片"""
        if task_id in self.task_cards:
            self.task_cards[task_id].destroy()
            del self.task_cards[task_id]
        if task_id in self.tasks:
            del self.tasks[task_id]

        if not self.task_cards:
            self.empty_label.pack(fill=tk.BOTH, expand=True)

        self._update_task_counters()

    def clear_completed_tasks(self):
        """清空所有已完成任务"""
        completed_ids = [tid for tid, t in self.tasks.items() if t["status"] == "completed"]
        for tid in completed_ids:
            self.remove_task(tid)

    def select_all(self):
        for card in self.task_cards.values():
            card.chk_var.set(True)

    def invert_selection(self):
        for card in self.task_cards.values():
            card.chk_var.set(not card.chk_var.get())

    def browse_dir(self):
        """选择下载目录"""
        chosen = filedialog.askdirectory(initialdir=self.config_mgr.get("download_dir"), parent=self.root)
        if chosen:
            self.config_mgr.set("download_dir", chosen)
            self.dir_label.config(text=chosen)
            self.set_status(f"下载目录已更新: {chosen}")

    def open_download_dir(self):
        """点击路径快速在文件管理器中打开"""
        path = self.config_mgr.get("download_dir")
        if os.path.exists(path):
            if sys.platform == "win32":
                os.system(f'explorer "{os.path.abspath(path)}"')
            else:
                os.system(f'open "{path}"')

    def on_parallel_changed(self):
        """调整并发数"""
        try:
            val = int(self.parallel_var.get())
            val = max(1, min(val, 8))
            self.config_mgr.set("parallel_count", val)
            self.executor._max_workers = val
            self.set_status(f"并发数已设置为: {val}")
        except Exception:
            pass

    def on_quality_changed(self, event=None):
        """调整画质偏好"""
        raw = self.quality_var.get()
        mode = raw.split(" ")[0]
        self.config_mgr.set("quality_mode", mode)
        self.set_status(f"下载画质已设置为: {mode}")

    def toggle_theme(self):
        """深色/浅色主题切换"""
        new_theme = "light" if self.current_theme_name == "dark" else "dark"
        self.current_theme_name = new_theme
        self.theme = THEMES[new_theme]
        self.config_mgr.set("theme", new_theme)

        # 重新应用主题并刷新界面
        self._apply_theme_styles()
        for widget in self.root.winfo_children():
            widget.destroy()
        self.task_cards.clear()
        self._build_main_ui()

        # 重新挂载已有任务
        for tid, task in self.tasks.items():
            self._render_task_card(task)

    def set_status(self, msg):
        self.status_left.config(text=msg)

    def _update_task_counters(self):
        total = len(self.tasks)
        completed = sum(1 for t in self.tasks.values() if t["status"] == "completed")
        self.status_right.config(text=f"任务总数: {total} | 已完成: {completed}")


def main():
    root = tk.Tk()
    app = VideoDownloaderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
