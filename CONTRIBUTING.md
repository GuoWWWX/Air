# 参与贡献 / Contributing

感谢你对 **Air Proxy** 的关注！欢迎通过提交 Issue、完善文档或发起 Pull Request 参与改进。

## 分支与提交规范 / Branch & Commit Workflow

1. 从 `main` 分支拉取最新代码并创建主题分支（例如 `feat/...` 或 `fix/...`）。
2. 保持改动范围聚焦，不修改与本次任务无关的配置文件或构建缓存。
3. 提交 PR 前请确保所有基础检查脚本与对应平台的单元测试全部通过，并填写 [PR 模板](./.github/PULL_REQUEST_TEMPLATE.md)。

## 开发环境要求 / Prerequisites

- **Node.js**：20.19+ 或 22.12+，使用 `pnpm`（`pnpm@10.33.0`）管理依赖，切勿改用 `npm` / `yarn` 产生额外锁文件。
- **Rust（桌面端）**：`rustup` 1.89+；Windows 下推荐使用 `stable-x86_64-pc-windows-gnu` 或 `msvc` 工具链，完整构建前按 [`docs/开发构建与清理.md`](./docs/开发构建与清理.md) 准备内核与 `air-tun-service.exe`。
- **Android**：JDK 21、Android SDK（Compile SDK 36）。

## 本地校验命令 / Local Checks

```powershell
# 安装前端依赖
pnpm install --frozen-lockfile

# 双端语言包完整性校验（桌面端 + Android 共用词条）
node scripts/check-languages.mjs

# 桌面端与 Android WebView TypeScript / Vite 构建检查
pnpm build
pnpm exec tsc --noEmit -p android/web/tsconfig.json
pnpm exec vite build --config android/web/vite.config.ts

# 路由与遥测单元测试
node scripts/test-android-routing.mjs
node scripts/test-desktop-telemetry.mjs

# Rust 核心单元测试
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features

# Android 单元测试
./android/gradlew.bat -p android :app:testDebugUnitTest
```

## 文案与本地化规范 / Localization

- 内置语言包位于 [`resources/languages/`](./resources/languages/)（`zh-CN.json` 与 `en.json`）。
- 桌面端与 Android 共用的界面文案必须同时补齐中英文翻译键，并在提交前运行 `node scripts/check-languages.mjs` 验证零缺失、零未翻译键。

## 隐私、密钥与合规提醒 / Privacy & Security

- **严禁提交**任何真实的机场订阅链接、节点配置、私人 IP、签名私钥（`*.pem`、`*.p12`、`*.dpapi`）或第三方 API Token。
- 新增第三方依赖或调整内核分发方式时，请同步核对开源协议兼容性。
