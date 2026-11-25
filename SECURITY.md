# 安全政策 / Security Policy

## 受支持的版本 / Supported Versions

| 版本 / Version | 安全支持状态 / Supported |
| --- | --- |
| `1.1.x` | :white_check_mark: 积极维护 |
| `< 1.1.0` | :x: 不再支持，请升级至最新版本 |

## 漏洞反馈方式 / Reporting a Vulnerability

请**不要**直接在公开 Issue 中披露潜在安全漏洞、提权缺陷或凭证泄露问题。

- 请通过仓库的 **[GitHub Security Advisories（私密漏洞报告）](https://github.com/GuoWWWX/Air-Proxy/security/advisories/new)** 提交报告。
- 请尽可能附上受影响版本、复现步骤、潜在影响评估以及（脱敏后的）验证方式。

## 安装包与更新校验 / Release Integrity

为降低分发篡改风险，官方发布遵循以下校验机制：

1. **校验文件摘要**：每个 [GitHub Release](https://github.com/GuoWWWX/Air-Proxy/releases) 均附带 `SHA256SUMS.txt`，建议下载安装包或 APK 后先核对 SHA-256。
2. **Windows 增量更新签名**：桌面端「设置 → 关于」触发的增量更新包采用 **Ed25519** 公钥签名验证清单与分块校验，未通过签名或摘要校验的文件不会被应用。
3. **Android 签名一致性**：正式 APK 均由同一发布签名身份签名，升级安装时由系统校验签名一致。

## 用户数据与日志脱敏 / Data Hygiene

- 本项目的 Windows 本地敏感数据通过系统 DPAPI 与本地数据库加密存储；Android 端本地配置保存在应用私有目录。
- 向社区反馈问题并附上截图或日志前，请务必移除或打码订阅 URL、节点主机/密码、认证 Token 及个人出口 IP。
