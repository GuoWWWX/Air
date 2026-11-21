# 开发、构建与清理

在仓库根目录执行下列命令。桌面和手机的前端使用同一份 `package.json` 与 `pnpm-lock.yaml`。Vite 支持 Node.js 20.19+（20.x）或 22.12+，pnpm 版本由 `packageManager` 锁定。[前端配置](../package.json)

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsc --noEmit -p android/web/tsconfig.json
```

## Windows

桌面需要 WebView2、Rust 和对应的 Windows 原生构建工具。正式包采用 `x86_64-pc-windows-gnu`，需要该 Rust 工具链及 MinGW-w64。构建输入在首次准备时下载，以后的相同版本可直接复用。[Tauri 环境要求](https://v2.tauri.app/start/prerequisites/) · [正式安装包步骤](releases/windows.md)

```powershell
./scripts/prepare-windows-kernel.ps1
./scripts/prepare-mihomo-data.ps1
pnpm tauri dev
```

单独运行 `pnpm dev` 会启动浏览器预览。原生开发版会把准备好的 Windows 内核放在应用程序旁边，使用与安装版相同的发现路径。要检查真实代理、TUN、系统托盘或应用图标，请从原生入口验证。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features cold_start_loads_geo_rules_without_downloading -- --ignored
```

第二条命令在 Windows 使用真实的随包内核、临时工作目录和仅本机可见的端口。测试加载 `GEOSITE`、`GEOIP` 规则，同时检查模拟下载端没有收到连接。[冷启动回归测试](../src-tauri/src/mihomo/geodata.rs)

## Android

安装可运行 Gradle 的 JDK 17 或 21、Android SDK Platform 36，通过 `ANDROID_HOME` 或 `android/local.properties` 指定 SDK 路径。从根目录先安装前端依赖，再调用随仓库提供的 Gradle Wrapper。[Gradle 版本](../android/gradle/wrapper/gradle-wrapper.properties) · [Android 构建配置](../android/app/build.gradle.kts)

```powershell
./android/gradlew.bat -p android :app:assembleDebug :app:lintRelease
```

macOS 或 Linux 开发机可调用 `sh android/gradlew -p android :app:assembleDebug :app:lintRelease`。调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。正式 APK 的构建、签名、覆盖安装验证与归档步骤见 [Android 发布](releases/android.md)。

Gradle 先构建手机界面，从共享图标生成启动图标，并准备原生 AAR 与规则库。首次联网构建自动下载并校验这些输入。断网构建需事先缓存 Gradle 分发、依赖和 SDK，运行 `prepare-mihomo-data.ps1` 准备规则库，同时把 `AIR_ANDROID_CORE` 指向校验匹配的 `libmihomo-android-v0.3.14.aar`，再给 Gradle 命令加 `--offline`。支持的 APK 架构为 `arm64-v8a`、`armeabi-v7a` 和 `x86_64`。[Android 内核上游](https://github.com/oviron/libmihomo-android/releases/tag/v0.3.14)

检查离线冷启动时，在测试设备上让规则库下载地址不可达，用本地 YAML 导入含 `GEOSITE` 和 `GEOIP` 的规则，从全新应用数据启动。确认 VPN 进入运行状态，再删除最后一个代理出站，核对规则和 VPN 停止状态。构建机和测试设备的离线场景分别验收。

## 文件归属与清理

| 位置 | 内容与处理方式 |
| --- | --- |
| `.cache/air/windows-x64/` | 固定版本 Windows 内核。由 `prepare-windows-kernel.ps1` 验证压缩包与解压后的可执行文件。 |
| `.cache/air/mihomo-data/` | Windows 和 Android 可共用的两份地理规则库。升级时更新 [修订号与 SHA-256](../scripts/mihomo-data.json)，两端重新构建后核对包内数据。 |
| `src-tauri/windows/`、`android/app/src/main/assets/licenses/` | 许可证、内核构建信息与安装源文件，随源码维护。 |
| `node_modules/`、Gradle 用户目录、Cargo 注册表、Android SDK | 开发依赖。保留后可继续离线构建。 |
| `dist/`、`src-tauri/target/` 下的标准 Cargo 输出、`src-tauri/gen/schemas/`、Android 的 `build/`、`.gradle/`、`.kotlin/` | 编译产物、生成的接口描述和项目缓存，构建时重新生成。 |
| `artifacts/<平台>/<版本>/` | 建议的本地归档目录。留存的安装包、更新包和校验清单在清理前从构建输出复制到这里。 |
| 运行时的用户目录 | 由系统和应用管理的订阅、设置、监测记录与 VPN 状态。开发清理的路径限于仓库。 |

构建结束后，先预览将删除的路径，确认需要留存的安装包已归档，再执行清理。

```powershell
./scripts/clean.ps1 -WhatIf
./scripts/clean.ps1
```

清理脚本逐项核对实际路径，遇到待删目录中的链接会停下并报告。Cargo 的标准输出按目录清理，`target` 下自行创建的工作目录、旧 `release-candidate` 交付文件以及 `artifacts` 中的归档都会保留。自定义 `CARGO_TARGET_DIR` 与 Gradle 用户目录由设置它们的人管理。[清理脚本](../scripts/clean.ps1)

Windows 上如果清理时提示 `classes.dex` 正被占用，可以用 `./android/gradlew.bat -p android --status` 查看构建守护进程。确认构建结束并显示 `IDLE` 后，用相同的 Gradle 用户目录运行 `./android/gradlew.bat -p android --stop`，再执行清理脚本。
