# 更新日志 / Changelog

本文档遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，并采用[语义化版本](https://semver.org/lang/zh-CN/)控制版本号。详细发行说明请见 [`docs/版本发布/`](./docs/版本发布/1.1.0.md) 与 [GitHub Releases](https://github.com/GuoWWWX/Air-Proxy/releases)。

## [1.1.0] - 2026-11-25

### Added

- **Android 更新推送能力**：新增启动静默检查（6 小时节流）、一次弹窗提示、底栏设置红蓝点提醒、关于页 `v{version}` 版本徽标、基于设备 ABI 的优先直链下载与更新说明展示。
- **双端更新代理兜底**：Windows 与 Android 在直连更新源受阻时，均可自动回落通过当前活跃本地代理端口完成版本检查与包体下载。
- **社区与工程文档**：补充 MIT 许可证、[文档中心](./docs/README.md)、双语首页说明与展示截图，以及 Windows 服务打包与离线冷启动验证文档。

### Changed

- **统一品牌与交互细节**：双端应用与提示名称统一为 **Air Proxy**；桌面端优化启动按钮外圈脉冲透明度与分段渐隐过渡，侧栏仅在缺少内核时提示「诊断内核」，仪表盘策略分组列表支持完整滚动与点击直达对应分组。
- **订阅界面收口**：合并订阅与分流设置下的节点 / 分组区域为全高标签页，移动端同步隐藏冗余外层滚动条。

### Fixed

- **Android NAT64 路由**：修复 Android 8–12L 同时开启 IPv6 与「绕过局域网私网」时遗漏 `64:ff9b::/96` 前缀导致部分 IPv6 流量绕过 VPN 的问题。
- **Windows 端口回滚一致性**：修复切换代理端口并更新系统代理失败后，已生效内核端口与回滚配置文件不一致的问题。
- **Android 过期测速重算**：修复自动策略组沿用超过 24 小时过期延迟记录的问题，并在定时巡检与返回前台时即时重算。

## [1.0.0]

### Added

- 首个公开版本，支持 Windows 桌面端（Tauri 2 + Rust + WebView2）与 Android 原生壳层集成 Mihomo 内核。
- 支持订阅链接 / Clash YAML / 二维码导入、多订阅筛选、本地覆写、YAML / JS（QuickJS）扩展、自建策略组与可视化多跳链式代理。
- Windows 支持系统代理与 Wintun 虚拟网卡服务（`AirTunService`）独立切换、DPAPI + SQLite 加密存储及 Ed25519 签名分块增量更新。

[1.1.0]: https://github.com/GuoWWWX/Air-Proxy/releases/tag/v1.1.0
[1.0.0]: https://github.com/GuoWWWX/Air-Proxy/releases/tag/v1.0.0
