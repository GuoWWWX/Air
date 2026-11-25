## 变更说明 / Summary

<!-- 简要说明本次 PR 的修改目的、实现思路及影响范围 -->

## 涉及平台 / Affected Platform(s)

- [ ] Windows 桌面端 (`src/`, `src-tauri/`)
- [ ] Android 手机端 (`android/web/`, `android/app/`)
- [ ] 双端共享 / 语言包 (`src/shared/`, `resources/languages/`)
- [ ] 文档 / 工程配置 (`docs/`, `scripts/`, `.github/`)

## 关联 Issue / Related Issue

- Closes #

## 验证清单 / Verification Checklist

- [ ] `node scripts/check-languages.mjs`
- [ ] `pnpm build`
- [ ] `pnpm exec tsc --noEmit -p android/web/tsconfig.json`
- [ ] `node scripts/test-android-routing.mjs`
- [ ] `node scripts/test-desktop-telemetry.mjs`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features`（如涉及 Rust 逻辑）
- [ ] `./android/gradlew.bat -p android :app:testDebugUnitTest`（如涉及 Android 原生代码）

## 规范与脱敏确认 / Compliance

- [ ] 已确认提交内容不包含订阅链接、私钥、凭证或真实个人信息
- [ ] 新增界面文案已同步补齐中英文语言包并通过双端校验
