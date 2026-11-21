# Android 发布

Android 版本由 `android/app/build.gradle.kts` 的 `versionCode` 和 `versionName` 管理。覆盖安装必须使用与现有分发包兼容的签名身份，发新版时递增 `versionCode`。发布密钥保存在项目目录以外。[构建配置](../../android/app/build.gradle.kts) · [Android 应用签名](https://developer.android.com/studio/publish/app-signing)

## 构建

按 [开发环境](../development.md#android) 准备 JDK、SDK、前端依赖和内核，然后在仓库根目录运行以下命令。

```powershell
pnpm exec tsc --noEmit -p android/web/tsconfig.json
./android/gradlew.bat -p android :app:assembleRelease :app:lintRelease
```

默认生成 `android/app/build/outputs/apk/release/app-release-unsigned.apk`。其中应包含 `assets/web/index.html`、`assets/geodata/GeoSite.dat`、`assets/geodata/geoip.metadb`、内核许可证和目标 ABI 的原生库。两份规则库的摘要见 [版本清单](../../scripts/mihomo-data.json)。

## 签名与留存

下面以 `1.0.2` 和 SDK Build Tools `36.0.0` 为例。设置 `ANDROID_HOME`、`AIR_ANDROID_KEYSTORE` 和 `AIR_ANDROID_KEY_ALIAS` 后执行。签名口令由工具交互读取。先检查 APK 对齐，再签名并验证签名证书。[zipalign](https://developer.android.com/tools/zipalign) · [apksigner](https://developer.android.com/tools/apksigner)

```powershell
$version = '1.0.2'
$buildTools = Join-Path $env:ANDROID_HOME 'build-tools/36.0.0'
$unsigned = 'android/app/build/outputs/apk/release/app-release-unsigned.apk'
$archive = "artifacts/android/$version"
New-Item -ItemType Directory -Force -Path $archive | Out-Null
$signed = Join-Path $archive "Air-Android-$version.apk"

& "$buildTools/zipalign.exe" -c -P 16 4 $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK alignment check failed' }
& "$buildTools/apksigner.bat" sign --ks $env:AIR_ANDROID_KEYSTORE --ks-key-alias $env:AIR_ANDROID_KEY_ALIAS --out $signed $unsigned
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
& "$buildTools/apksigner.bat" verify --verbose --print-certs $signed
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed' }
Get-FileHash -Algorithm SHA256 -LiteralPath $signed
```

在测试设备上分别验收全新安装和从上一版覆盖安装。检查原订阅和配置仍可用、启动图标正确、VPN 授权和启停正常，再用本地订阅验证规则库离线冷启动。将签名 APK 及其摘要归档后，可以清理仓库的 Gradle 输出。
