# Air Proxy Windows 发布

从 Windows 构建 `x86_64-pc-windows-gnu` 安装包。发布配置使用已核对版本和校验值的 Mihomo 可执行文件、许可证和构建信息。内核与图标的映射见 [Windows 基础配置](../../src-tauri/tauri.windows.conf.json) 和 [NSIS 配置](../../src-tauri/tauri.windows-release.conf.json)。

构建前运行 `scripts/prepare-windows-kernel.ps1`、`scripts/prepare-windows-service.ps1` 和 `scripts/prepare-mihomo-data.ps1`，校验 Windows 内核、Wintun、`air-tun-service.exe` 和两份规则库。输入缓存在 `.cache/air/`。首次构建 Windows 内核需要 Git 和 Go 1.26.8，可通过 `-GoExe` 指定 Go 路径。内核版本和摘要见 [内核构建记录](../../src-tauri/windows/Mihomo-build-info.txt)。安装程序内嵌 Wintun 及其许可证，安装虚拟网卡服务时将它们写入受保护的服务目录。程序内嵌 `GeoSite.dat` 和 `geoip.metadb`，供带地理规则的配置在离线时启动。

虚拟网卡服务由用户在 Air 内确认安装或更新，Windows 在这一步请求授权。服务启动时创建 `Air-TUN`，代理每次启用时复用这块网卡。停止代理或退出 Air 后，网卡继续显示为未连接，TUN 路由、地址和 DNS 设置已清理。卸载服务会移除网卡。

更新 `mihomo.exe`、`WebView2Loader.dll` 或 Wintun 后，同步更新 `src-tauri/src/proxy/tun_service/install.rs` 内对应的 SHA-256。发布前在隔离的 Windows 环境安装服务，运行 `installed_service_keeps_one_adapter_across_sessions`，并用 `Get-DnsClientServerAddress` 核对停用后的网卡 DNS。再检查关闭 Air 后网卡仍在，以及卸载后网卡消失。

Windows 正式版和本地测试版默认使用官方稳定更新渠道和验签公钥。构建独立测试渠道时，可用 `AIR_UPDATE_FEED` 和 `AIR_UPDATE_PUBLIC_KEY` 指定清单地址和对应的 Base64 编码 Ed25519 公钥。

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
./scripts/prepare-windows-kernel.ps1
./scripts/prepare-windows-service.ps1
./scripts/prepare-mihomo-data.ps1
pnpm tauri build --target x86_64-pc-windows-gnu --config src-tauri/tauri.windows-release.conf.json
```

发布官方更新清单时使用已有的发布私钥。独立渠道可用 `python scripts/prepare-update.py keygen --key $airSigningKey` 创建自己的密钥对。将私钥保存在工作区以外的受保护目录中，并保留备份。

覆盖安装后核对应用和安装登记都显示目标版本，再从安装目录生成增量发布文件。Python 需要安装 `cryptography`。

```powershell
$airSigningKey = Join-Path $env:LOCALAPPDATA 'AirRelease/air-update-signing.pem'
python scripts/prepare-update.py package --key $airSigningKey --version 1.0.0 `
  --notes 'docs/版本发布/1.0.0.md' --source (Join-Path $env:LOCALAPPDATA 'Air Proxy') `
  --output artifacts/windows/1.0.0 `
  --asset-base 'https://github.com/GuoWWWX/Air-Proxy/releases/download/v1.0.0'
```

默认的 NSIS 产物位于 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/`。使用 `CARGO_TARGET_DIR` 时，从该目录下的目标三元组查找安装包。清理前把留存的安装包复制到 `artifacts/windows/<版本>/`，与签名清单和更新包一起归档。

验收通过后，将安装包、`air-windows-x64.json` 和 `air-windows-x64-1.0.0.pack` 一起上传到同一个 GitHub Release。更新渠道需要允许客户端匿名读取。发布后确认清单地址可以读取，并验证 `.pack` 对单段请求返回 `206 Partial Content` 和对应的 `Content-Range`。
