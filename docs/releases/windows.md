# Windows 发布

从 Windows 构建 `x86_64-pc-windows-gnu` 安装包。发布配置使用已核对版本和校验值的 Mihomo 可执行文件、许可证和构建信息。内核与图标的映射见 [Windows 基础配置](../../src-tauri/tauri.windows.conf.json) 和 [NSIS 配置](../../src-tauri/tauri.windows-release.conf.json)。

构建前运行 `scripts/prepare-windows-kernel.ps1` 和 `scripts/prepare-mihomo-data.ps1`，校验 Windows 内核和两份规则库。输入缓存在 `.cache/air/`。版本与摘要见 [内核构建记录](../../src-tauri/windows/Mihomo-build-info.txt) 和 [地理规则库清单](../../scripts/mihomo-data.json)。安装包随程序提供 `GeoSite.dat` 和 `geoip.metadb`，供带地理规则的配置在离线时启动。

虚拟网卡服务由用户在 Air 内确认安装，Windows 只在安装或维修服务时请求授权。更新随包附带的 `mihomo.exe` 或 `WebView2Loader.dll` 时，同步更新 `src-tauri/src/proxy/tun_service/install.rs` 内对应的 SHA-256。发布前用普通权限启动 Air，验证确认安装、启用与关闭 TUN、退出后恢复路由，以及卸载时移除服务。

```powershell
$airSigningKey = Join-Path $env:LOCALAPPDATA 'AirRelease/air-update-signing.pem'
$env:AIR_UPDATE_PUBLIC_KEY = (Get-Content ([IO.Path]::ChangeExtension($airSigningKey, '.pub')) -Raw).Trim()
$env:AIR_UPDATE_FEED = 'https://github.com/GuoWWWX/Air/releases/latest/download/air-windows-x64.json'
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
./scripts/prepare-windows-kernel.ps1
./scripts/prepare-mihomo-data.ps1
pnpm tauri build --target x86_64-pc-windows-gnu --config src-tauri/tauri.windows-release.conf.json
```

首次创建签名密钥时使用 `python scripts/prepare-update.py keygen --key $airSigningKey`。将私钥保存在工作区以外的受保护目录中，并保留备份。升级包由同一把私钥签名。

覆盖安装后核对应用和安装登记都显示目标版本，再从安装目录生成增量发布文件。Python 需要安装 `cryptography`。

```powershell
python scripts/prepare-update.py package --key $airSigningKey --version 1.0.0 `
  --notes docs/releases/1.0.0.md --source (Join-Path $env:LOCALAPPDATA 'Air Proxy') `
  --output artifacts/windows/1.0.0 `
  --asset-base 'https://github.com/GuoWWWX/Air/releases/download/v1.0.0'
```

默认的 NSIS 产物位于 `src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/`。使用 `CARGO_TARGET_DIR` 时，从该目录下的目标三元组查找安装包。清理前把留存的安装包复制到 `artifacts/windows/<版本>/`，与签名清单和更新包一起归档。

验收通过后，将安装包、`air-windows-x64.json` 和 `air-windows-x64-1.0.0.pack` 一起上传到同一个 GitHub Release。更新渠道需要允许客户端匿名读取。发布后确认清单地址可以读取，并验证 `.pack` 对单段请求返回 `206 Partial Content` 和对应的 `Content-Range`。
