# Air 功能实现文档目录

本目录用于系统记录 **Air（Windows 桌面版 / Android 手机版）** 各个页面与核心功能的实际代码实现机制，与 [需求文档目录](../功能需求/README.md) 及 [页面功能说明](../页面功能说明.md) 配套使用：

- **[页面功能说明](../页面功能说明.md)**：面向使用与测试，说明「每个页面有什么功能、如何使用、双端页面位置与验收标准」。
- **`docs/功能实现/`（本目录）**：面向研发与维护，说明「每个功能在代码中具体怎么实现、关键文件在哪、状态如何流转」。
- **[需求文档目录](../功能需求/README.md)**：记录待排期的新特性与架构演进设计目标。

## 文档编写约定

- **双端共用实现（合写一份）**：Windows 桌面端和 Android 手机端复用同一套逻辑、共享组件（`src/shared/*`）或采用相同算法/规则时，统一写入 `双端共用实现` 小节，不重复撰写。
- **平台差异实现（分开写）**：两端的原生壳层、系统授权、持久化和调度机制不同时，拆分为 `电脑版实现（Windows 桌面端）` 与 `手机版实现（Android 移动端）` 分别说明。

## 实现文档索引

| 文档 | 覆盖范围 | 关键涉及模块 |
| --- | --- | --- |
| [应用壳层、页面交互与共享 UI 组件实现](./应用壳层与页面交互实现.md) | 窗口/标题栏/托盘、WebView 防浏览器化加固、导航、启动电源动效、滑块切换器、单行可展开提示胶囊、节点延迟按钮、多语言、编辑器、滚动位置记忆与手势接管 | `src/app/*`、`src/shared/ui/*`、`src/shared/i18n/*`、`android/web/src/*`、`MainActivity.kt` |
| [代理内核、系统接管与网络 DNS 实现](./代理内核与网络接管实现.md) | Mihomo 内核启停与热切换、Windows 系统代理 / 虚拟网卡服务 / 多播路由、Android `AirVpnService` / `libmihomo` JNI、分层 DNS、GeoData 与出口探测 | `src-tauri/src/proxy/*`、`src-tauri/src/network.rs`、`Core.kt`、`AirVpnService.kt`、`DnsProbe.kt` |
| [订阅导入、同步更新与扩展脚本实现](./订阅管理与扩展脚本实现.md) | URL/文件/二维码导入与分享、名称去重、DPAPI 与 `AtomicFile` 存储分离、后台自动同步、QuickJS 扩展脚本沙箱 | `src/shared/proxy/subscription-*`、`src-tauri/src/subscriptions/*`、`src-tauri/src/storage/*`、`ConfigFiles.kt`、`SubscriptionUpdateService.kt` |
| [节点库、分组、链路与测速监测实现](./节点分组链路与测速实现.md) | 节点库视图与三档密度、单节点/多选排队并发测速、流式延迟回传、自定义分组、多跳链路 `dialer-proxy` 与后台监测 | `src/features/nodes/*`、`src-tauri/src/monitoring/*`、`custom_groups.rs`、`chains/*`、`ProbeTiming.kt`、`AirDiagnostics.kt`、`AirMonitorService.kt` |
| [分流规则编译、实时连接与精细策略实现](./分流编译与实时连接实现.md) | 规则编译与订阅继承优先级、应用图标/包名解析、实时速率采样、实时连接与连接日志、一键修改应用与域名精细分流策略 | `src/shared/proxy/connection-policy.ts`、`src-tauri/src/routing/*`、`config.rs`、`windows_apps.rs`、`ConnectionSamples.kt`、`android/web/src/model.ts`、`connection-policy.tsx` |
