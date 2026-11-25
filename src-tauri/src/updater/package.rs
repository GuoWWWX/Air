use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use flate2::read::GzDecoder;
use reqwest::{header, Client, StatusCode, Url};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const BLOCK: usize = 1024 * 1024;
pub const MAX_MANIFEST: usize = 512 * 1024;
pub const EXE: &str = "air-proxy.exe";
const FILES: &[&str] = &[
    "WebView2Loader.dll",
    "mihomo.exe",
    "Mihomo-LICENSE.txt",
    "Mihomo-build-info.txt",
    "Air-Proxy.ico",
    EXE,
];
const MAX_PACK: u64 = 256 * 1024 * 1024;

#[derive(Deserialize)]
struct Envelope {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    schema: u8,
    app: String,
    target: String,
    pub version: Version,
    pub notes: String,
    pub asset: String,
    pub asset_size: u64,
    pub files: Vec<Asset>,
}

#[derive(Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub blocks: Vec<Block>,
}

#[derive(Clone, Deserialize)]
pub struct Block {
    pub sha256: String,
    pub offset: u64,
    pub length: u64,
}

fn digest_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn hash_file(path: &Path) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn allowed_url(url: &Url) -> bool {
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]"));
    (url.scheme() == "https" || (loopback && url.scheme() == "http"))
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn verify(raw: &[u8], key: &VerifyingKey) -> Result<Manifest, String> {
    if raw.len() > MAX_MANIFEST {
        return Err("更新清单过大".into());
    }
    let envelope: Envelope = serde_json::from_slice(raw).map_err(|_| "更新清单格式无效")?;
    let bytes = STANDARD
        .decode(envelope.payload)
        .map_err(|_| "更新清单编码无效")?;
    let sig = STANDARD
        .decode(envelope.signature)
        .map_err(|_| "更新签名编码无效")?;
    let sig = Signature::from_slice(&sig).map_err(|_| "更新签名无效")?;
    key.verify_strict(&bytes, &sig)
        .map_err(|_| "更新签名验证失败")?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "更新参数无效")?;
    if manifest.schema != 1
        || manifest.app != "app.air.client"
        || manifest.target != "windows-x86_64"
        || !manifest.version.pre.is_empty()
        || !manifest.version.build.is_empty()
        || manifest.notes.len() > 64 * 1024
        || manifest.asset_size > MAX_PACK
        || manifest.files.len() != FILES.len()
        || !Url::parse(&manifest.asset).is_ok_and(|url| allowed_url(&url))
    {
        return Err("更新包与 Air Proxy 安装版本不兼容".into());
    }
    let mut offset = 0;
    let mut total_size = 0;
    for (asset, name) in manifest.files.iter().zip(FILES) {
        if asset.name != *name
            || asset.size == 0
            || asset.size > MAX_PACK
            || !digest_ok(&asset.sha256)
            || asset.blocks.len() as u64 != asset.size.div_ceil(BLOCK as u64)
        {
            return Err("更新文件列表不合法".into());
        }
        total_size += asset.size;
        for block in &asset.blocks {
            if block.offset != offset
                || block.length == 0
                || block.length > BLOCK as u64 + 4096
                || !digest_ok(&block.sha256)
            {
                return Err("更新数据块校验失败".into());
            }
            offset += block.length;
        }
    }
    if offset != manifest.asset_size || total_size > MAX_PACK {
        return Err("更新包大小不合法".into());
    }
    Ok(manifest)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

impl Asset {
    fn block_size(&self, index: usize) -> usize {
        (self.size - (index * BLOCK) as u64).min(BLOCK as u64) as usize
    }

    pub fn materialized(&self, dir: &Path) -> PathBuf {
        dir.join(&self.name)
    }

    pub fn matches(&self, dir: &Path) -> bool {
        let path = self.materialized(dir);
        path.metadata().is_ok_and(|meta| meta.len() == self.size)
            && hash_file(&path).is_ok_and(|digest| digest == self.sha256)
    }
}

pub struct Needed {
    block: Block,
    decoded_size: usize,
    cache: PathBuf,
    pub saved: u64,
}

impl Needed {
    pub fn length(&self) -> u64 {
        self.block.length
    }
}

fn cache_path(dir: &Path, block: &Block) -> PathBuf {
    dir.join(format!("{}.part", block.offset))
}

fn decode(path: &Path, block: &Block, size: usize) -> io::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(size);
    GzDecoder::new(file)
        .take(size as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() != size || hash(&bytes) != block.sha256 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "更新数据块内容校验失败",
        ));
    }
    Ok(bytes)
}

fn local_block(
    local: Option<&mut File>,
    index: usize,
    size: usize,
    block: &Block,
    bytes: &mut [u8],
) -> bool {
    local.is_some_and(|file| {
        file.seek(SeekFrom::Start((index * BLOCK) as u64)).is_ok()
            && file.read_exact(&mut bytes[..size]).is_ok()
            && hash(&bytes[..size]) == block.sha256
    })
}

pub fn plan(manifest: &Manifest, install: &Path, cache: &Path) -> Vec<Needed> {
    let mut needed = Vec::new();
    let mut bytes = vec![0; BLOCK];
    for file in &manifest.files {
        if file.matches(cache) {
            continue;
        }
        let mut local = File::open(file.materialized(install)).ok();
        for (index, block) in file.blocks.iter().enumerate() {
            let size = file.block_size(index);
            if local_block(local.as_mut(), index, size, block, &mut bytes) {
                continue;
            }
            let path = cache_path(cache, block);
            let mut saved = path.metadata().map_or(0, |meta| meta.len());
            if saved > block.length
                || (saved == block.length && decode(&path, block, size).is_err())
            {
                let _ = fs::remove_file(&path);
                saved = 0;
            }
            needed.push(Needed {
                block: block.clone(),
                decoded_size: size,
                cache: path,
                saved,
            });
        }
    }
    needed
}

pub async fn fetch_block(
    client: &Client,
    url: &mut Url,
    pack_size: u64,
    block: &Needed,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    if block.saved == block.length() {
        return Ok(());
    }
    let start = block.block.offset + block.saved;
    let end = block.block.offset + block.length() - 1;
    let mut response = client
        .get(url.clone())
        .header(header::RANGE, format!("bytes={start}-{end}"))
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| "更新下载连接中断")?;
    let expected = format!("bytes {start}-{end}/{pack_size}");
    if response.status() != StatusCode::PARTIAL_CONTENT
        || response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            != Some(expected.as_str())
    {
        return Err(format!(
            "更新服务器未返回所需的数据范围（HTTP {}）",
            response.status().as_u16()
        ));
    }
    *url = response.url().clone();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&block.cache)
        .map_err(io_error)?;
    file.set_len(block.saved).map_err(io_error)?;
    file.seek(SeekFrom::Start(block.saved)).map_err(io_error)?;
    let mut remaining = end - start + 1;
    loop {
        let data = match response.chunk().await {
            Ok(Some(data)) => data,
            Ok(None) => break,
            Err(_) => {
                file.sync_data().map_err(io_error)?;
                return Err("更新下载中断，已保留下载进度".into());
            }
        };
        if data.len() as u64 > remaining {
            return Err("更新服务器返回了无效长度".into());
        }
        file.write_all(&data).map_err(io_error)?;
        remaining -= data.len() as u64;
        progress(data.len() as u64);
    }
    file.sync_all().map_err(io_error)?;
    drop(file);
    if remaining != 0 {
        return Err("更新下载中断，已保留下载进度".into());
    }
    if decode(&block.cache, &block.block, block.decoded_size).is_err() {
        fs::remove_file(&block.cache).map_err(io_error)?;
        return Err("更新数据校验失败，请重试".into());
    }
    Ok(())
}

pub fn assemble(manifest: &Manifest, install: &Path, cache: &Path) -> Result<(), String> {
    let mut bytes = vec![0; BLOCK];
    for file in &manifest.files {
        if file.matches(install) || file.matches(cache) {
            continue;
        }
        let mut local = File::open(file.materialized(install)).ok();
        let mut target = tempfile::NamedTempFile::new_in(cache).map_err(io_error)?;
        let mut digest = Sha256::new();
        for (index, block) in file.blocks.iter().enumerate() {
            let size = file.block_size(index);
            let decoded;
            let chunk = if local_block(local.as_mut(), index, size, block, &mut bytes) {
                &bytes[..size]
            } else {
                decoded = decode(&cache_path(cache, block), block, size).map_err(io_error)?;
                &decoded
            };
            target.write_all(chunk).map_err(io_error)?;
            digest.update(chunk);
        }
        if format!("{:x}", digest.finalize()) != file.sha256 {
            return Err("更新文件校验失败".into());
        }
        target.as_file().sync_all().map_err(io_error)?;
        target.persist(file.materialized(cache)).map_err(io_error)?;
    }
    Ok(())
}

pub fn io_error(error: impl std::fmt::Display) -> String {
    format!("无法保存或读取更新文件（{error}）")
}
