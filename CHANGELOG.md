# 更新日志 / Changelog

本文档遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，并采用[语义化版本](https://semver.org/lang/zh-CN/)控制版本号。详细发行说明请见 [`docs/版本发布/`](./docs/版本发布/1.1.5.md) 与 [GitHub Releases](https://github.com/GuoWWWX/Air-Proxy/releases)。

## [1.1.5] - 2026-11-26

- 手动测速按页面顺序进行，Windows 默认同时测 32 个节点，Android 默认 24 个。在设置中开启「高速测速」后，按可用逻辑处理器数增加并发，Windows 最多 64 个，Android 最多 48 个。
- Windows 节点库在工具栏左侧显示测速进度，测速期间保持列表顺序。
- 更新双端出厂节点 DNS，修复 Windows 测速内核切网复用及临时配置留存问题。

## [1.1.4] - 2026-11-26

### Fixed

- **Windows 关闭 IPv6 时双栈污染 AAAA 断网热修复**：升级内置 Mihomo 内核至 `v1.19.32-air.4`，将 `DisableIPv6` 校验后移至 TLS/HTTP/QUIC 域名嗅探之后；当连接通过被物理网卡 DNS 污染的 IPv6 地址（如 `2001::1`）进入 `Air-TUN` 时，嗅探出真实域名后清除 IPv6 目标地址改走域名代理/IPv4 直连，仅拦截无域名的纯 IPv6 字面量与 ICMPv6。

## [1.1.3] - 2026-11-26

### Added

- **Android 应用内块级增量更新**：支持基于本地已安装 APK 的 ZIP 条目复用与 4 路并发 Range 增量下载、进度条与速率展示、暂停/继续/取消/忽略控制、SHA-256 校验失败自动全量兜底，以及 `FileProvider` 自动拉起覆盖安装。
- **Windows `AIRDLT1` 二进制差分补丁**：发行打包脚本与桌面端更新器支持从上一版本按移位不变锚点生成与校验二进制差分补丁，并保持与全量分块 `.pack` 及 `schema: 1` 的无缝兼容。

### Changed

- **双端默认网络策略升级**：默认启用 `fake-ip`（内置 `geosite:cn` 过滤）与海外 QUIC（UDP 443）拦截回落 TCP/TLS，并开启 Sniffer `parse-pure-ip` 与 `override-destination`；未改动的出厂默认配置升级时自动迁移。
- **Windows 发行包体积优化**：桌面端 Release 编译启用 `opt-level = "s"`、`lto = "thin"` 与符号剥离。

### Fixed

- **双栈 IPv6 旁路漏流与高画质视频卡顿**：升级 Windows Mihomo 至 `v1.19.32-air.3`（合入 `Air-TUN` IPv6 接管与禁用前置拦截补丁）并调整 Android `VpnService`（含 `64:ff9b:1::/48` NAT64 前缀），彻底消除关闭出站 IPv6 时的双栈流量绕过 TUN 问题。
- **Android 节点库卡片高度跳变**：移除节点卡片中的图钉图标及选中态额外右内边距，切换当前节点时标题与卡片高度保持稳定。

## [1.1.2] - 2026-11-25

### Added

- **更新下载暂停与取消控制**：Windows 端更新弹窗与下载链路支持随时「暂停」/「继续下载」（保留已校验分块缓存）与「取消」（清理缓存并复位状态），避免下载过程中无法中断。
- **Android 切回前台自动检测**：在启动静默检测（6 小时节流）之外，新增切换回前台时超过 6 小时的自动静默检查，覆盖长期挂机场景。
- **双语更新说明自动适配**：支持在更新日志中使用 `<!-- lang:zh-CN -->` / `<!-- lang:en -->` 分区，桌面与手机端自动按当前界面语言展示对应版本说明。

### Changed

- **代理优先与 4 路并发分块下载**：Windows 与 Android 检查/下载更新在代理运行时优先通过本地代理端口请求并自动直连兜底；Windows 更新器默认复用连接池并使用 4 路并发下载分块，显著提升国内宽带环境下的更新下载速度。
- **高辨识度更新提醒与紧凑弹窗**：桌面端左下角更新入口与手机端设置/关于徽标升级为带橙色脉冲呼吸灯的强调样式；桌面端更新弹窗收窄收矮并缩小正文字号，Android 关于页改用 Markdown 紧凑排版展示更新内容。

## [1.1.1] - 2026-11-25

### Changed

- **Windows 覆盖安装向导**：自定义 NSIS 安装模板，检测到当前设备已安装 Air Proxy 时直接展示「覆盖安装」并保留现有配置、订阅与本地数据。
- **虚拟网卡识别名**：将 Wintun 驱动隧道类型由 `sing-tun` 更名为 `Air Tun`，并升级虚拟网卡服务协议版本（`v12`），保留对旧版服务的兼容。
- **默认网络与国内直连 DNS 优化**：Windows 端默认关闭 IPv6 与 AAAA 解析、默认采用 `mixed` TUN 协议栈；只要开启「DNS 连接遵循分流规则」且未单独覆盖直连 DNS，即持续启用国内直连 DNS 与 `geosite:cn,private` 策略；未修改过默认网络配置的旧版本升级后自动迁移。

### Fixed

- **单上游 DNS 测速与双端分流策略对齐**：在桌面端「测试 DNS 解析」选择单个上游时跳过 `directNameserver` 与 `respectRules` 的分流干预；同步调整 Android `dnsConfiguration()`，仅在启用「DNS 连接遵循分流规则」时注入国内直连 DNS 兜底与 `geosite:cn,private` 策略。

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

[1.1.1]: https://github.com/GuoWWWX/Air-Proxy/releases/tag/v1.1.1
[1.1.0]: https://github.com/GuoWWWX/Air-Proxy/releases/tag/v1.1.0
[1.0.0]: https://github.com/GuoWWWX/Air-Proxy/releases/tag/v1.0.0
