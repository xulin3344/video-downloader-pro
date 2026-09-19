#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
万能视频下载器 Pro (Universal Video Downloader Pro)
统一入口脚本 (Main Entry Point)
"""

import sys
import importlib

if __name__ == "__main__":
    # 动态导入带中文名称的主模块并启动
    main_module = importlib.import_module("视频下载器v10")
    if hasattr(main_module, "main"):
        main_module.main()
    else:
        import tkinter as tk
        root = tk.Tk()
        app = main_module.VideoDownloaderApp(root)
        root.mainloop()
