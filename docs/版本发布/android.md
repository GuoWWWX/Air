# Air Proxy Android 发布

Android 版本由 `android/app/build.gradle.kts` 的 `versionCode` 和 `versionName` 管理。覆盖安装必须使用与现有分发包兼容的签名身份，发新版时递增 `versionCode`。发布密钥保存在项目目录以外。[构建配置](../../android/app/build.gradle.kts) · [Android 应用签名](https://developer.android.com/studio/publish/app-signing)

## 构建

按 [开发环境](../开发构建与清理.md#android) 准备 JDK、SDK、前端依赖和内核，然后在仓库根目录运行以下命令。

```powershell
pnpm exec tsc --noEmit -p android/web/tsconfig.json
./android/gradlew.bat -p android -PairSplitApks=true :app:assembleRelease :app:lintRelease
```

输出位于 `android/app/build/outputs/apk/release/`。按设备选择以下独立 APK，签名后均可直接安装。省略 `-PairSplitApks=true` 时只生成通用包 `app-release-unsigned.apk`。

| 架构 | 未签名文件 | 设备 |
| --- | --- | --- |
| ARM 64 位 | `app-arm64-v8a-release-unsigned.apk` | 大多数 Android 手机和平板 |
| ARM 32 位 | `app-armeabi-v7a-release-unsigned.apk` | 只支持 32 位 ARM 应用的旧设备 |
| x86 64 位 | `app-x86_64-release-unsigned.apk` | x86_64 模拟器或设备 |
| 通用 | `app-universal-release-unsigned.apk` | 设备架构不确定时 |

各包使用相同的应用 ID 和版本，应包含 `assets/web/index.html`、两份地理规则库、内核许可证和对应 ABI 的原生库。签名一致且版本符合升级条件时，通用包和设备专用包可以覆盖安装。两份规则库的摘要见 [版本清单](../../scripts/mihomo-data.json)。

## 签名与留存

下面以 `1.0.2` 和 SDK Build Tools `36.0.0` 为例。设置 `ANDROID_HOME`、`AIR_ANDROID_KEYSTORE` 和 `AIR_ANDROID_KEY_ALIAS` 后执行。签名口令由工具交互读取。先检查 APK 对齐，再签名并验证签名证书。[zipalign](https://developer.android.com/tools/zipalign) · [apksigner](https://developer.android.com/tools/apksigner)

```powershell
$version = '1.0.2'
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
$abi = 'arm64-v8a'
$unsigned = "android/app/build/outputs/apk/release/app-$abi-release-unsigned.apk"
$archive = "artifacts/android/$version"
New-Item -ItemType Directory -Force -Path $archive | Out-Null
$signed = Join-Path $archive "Air-Proxy-Android-$version-$abi.apk"

& "$buildTools/zipalign.exe" -c -P 16 4 $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK alignment check failed' }
& "$buildTools/apksigner.bat" sign --ks $env:AIR_ANDROID_KEYSTORE --ks-key-alias $env:AIR_ANDROID_KEY_ALIAS --out $signed $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
& "$buildTools/apksigner.bat" verify --verbose --print-certs $signed
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $signed
```

在测试设备上分别验收全新安装和从上一版覆盖安装。检查原订阅和配置仍可用、启动图标正确、VPN 授权和启停正常，再用本地订阅验证规则库离线冷启动。将签名 APK 及其摘要归档后，可以清理仓库的 Gradle 输出。
