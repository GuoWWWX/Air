# Air Proxy

Air 在本机管理代理订阅、节点、分组和链路，通过 Mihomo 提供代理、连接记录与测速。当前仓库可以构建 Windows 桌面版和 Android 手机版。iOS、macOS、HarmonyOS 与 Linux 的工程位置、权限模型和首轮验收见 [跨平台架构](docs/目录与跨平台架构.md#后续平台)。

**[下载最新版 Windows 安装包](https://github.com/GuoWWWX/Air-Proxy/releases/latest)**

支持 Windows 10 / 11 x64，随附的 Mihomo 内核要求处理器支持 `x86-64-v2`。安装后导入订阅或添加节点，选中节点并点击「启动」。首次打开虚拟网卡时，在 Air 内确认安装服务并完成 Windows 授权。

可以用版本页的 `SHA256SUMS.txt` 核对下载。Air 内的「设置 → 关于」提供后续更新。

Mihomo 作为独立进程随 Air 分发。安装目录包含其 GPL-3.0 许可证和构建信息，版本页提供对应源码与第三方许可说明。

| 从哪里开始 | 入口 |
| --- | --- |
| 查看全部功能、两端差异及订阅更新和扩展用法 | [Air 功能与使用说明](docs/页面功能说明.md) |
| 找源码，判断功能属于哪一端 | [目录与架构](docs/目录与跨平台架构.md) |
| 启动开发版、构建 Android APK、运行测试、清理临时文件 | [开发与清理](docs/开发构建与清理.md) |
| 制作 Windows 安装包和更新包、签名 Android APK | [Windows 发布](docs/版本发布/windows.md) · [Android 发布](docs/版本发布/android.md) |
| 核对功能目标、交互和原型 | [项目规范](docs/项目规范.md) · [可编辑原型](design/air-prototype.pen) |

## 工程入口

| 位置 | 用途 |
| --- | --- |
| [src/app](src/app)、[src/features](src/features)、[src/platform/desktop](src/platform/desktop) | 桌面页面、功能和 Tauri 调用 |
| [src/shared](src/shared)、[src/assets](src/assets) | 两端共用的交互组件、代理状态类型和品牌素材 |
| [src-tauri](src-tauri) | 桌面内核管理、Windows 系统接管、存储和安装包配置 |
| [android/web](android/web)、[android/app](android/app) | 手机页面与 Android 原生 VPN、后台服务、APK 构建 |
| [scripts](scripts)、[docs](docs)、[design](design) | 构建工具、项目文档、设计源文件 |

在仓库根目录执行 `pnpm install --frozen-lockfile` 和 `pnpm dev` 可以预览桌面界面。要验证真实网络接管，请按 [开发指南](docs/开发构建与清理.md) 启动原生程序。
