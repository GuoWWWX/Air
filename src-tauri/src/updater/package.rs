use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
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

pub const DELTA_MAGIC: &[u8; 8] = b"AIRDLT1\0";

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
    #[serde(default)]
    pub patches: Vec<Patch>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub file: String,
    pub base_sha256: String,
    pub target_sha256: String,
    pub asset: String,
    pub size: u64,
    pub sha256: String,
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
    for patch in &manifest.patches {
        if !FILES.contains(&patch.file.as_str())
            || !digest_ok(&patch.base_sha256)
            || !digest_ok(&patch.target_sha256)
            || !digest_ok(&patch.sha256)
            || patch.size == 0
            || patch.size > MAX_PACK
            || !Url::parse(&patch.asset).is_ok_and(|url| allowed_url(&url))
            || !manifest
                .files
                .iter()
                .any(|asset| asset.name == patch.file && asset.sha256 == patch.target_sha256)
        {
            return Err("更新差分补丁参数无效".into());
        }
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Control {
    Running,
    Pause,
    Cancel,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    Paused,
    Canceled,
    Failed(String),
}

async fn wait_stop(control: &mut tokio::sync::watch::Receiver<Control>) {
    while *control.borrow_and_update() == Control::Running {
        if control.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn stop_error(control: &tokio::sync::watch::Receiver<Control>) -> FetchError {
    match *control.borrow() {
        Control::Pause => FetchError::Paused,
        Control::Cancel => FetchError::Canceled,
        Control::Running => FetchError::Paused,
    }
}

#[derive(Clone)]
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

fn local_block_index(file: &mut File) -> HashMap<String, u64> {
    let mut index = HashMap::new();
    let Ok(meta) = file.metadata() else {
        return index;
    };
    if file.seek(SeekFrom::Start(0)).is_err() {
        return index;
    }
    let mut buf = vec![0; BLOCK];
    let mut offset = 0u64;
    while offset + BLOCK as u64 <= meta.len() {
        if file.read_exact(&mut buf).is_err() {
            break;
        }
        index.entry(hash(&buf)).or_insert(offset);
        offset += BLOCK as u64;
    }
    index
}

fn local_block(
    local: Option<&mut File>,
    shifted: &mut Option<HashMap<String, u64>>,
    index: usize,
    size: usize,
    block: &Block,
    bytes: &mut [u8],
) -> bool {
    let Some(file) = local else {
        return false;
    };
    if file.seek(SeekFrom::Start((index * BLOCK) as u64)).is_ok()
        && file.read_exact(&mut bytes[..size]).is_ok()
        && hash(&bytes[..size]) == block.sha256
    {
        return true;
    }
    if size == BLOCK {
        let map = shifted.get_or_insert_with(|| local_block_index(file));
        if let Some(&offset) = map.get(&block.sha256) {
            return file.seek(SeekFrom::Start(offset)).is_ok()
                && file.read_exact(&mut bytes[..size]).is_ok()
                && hash(&bytes[..size]) == block.sha256;
        }
    }
    false
}

pub fn plan(manifest: &Manifest, install: &Path, cache: &Path) -> Vec<Needed> {
    plan_without(manifest, install, cache, &HashSet::new())
}

pub fn plan_without(
    manifest: &Manifest,
    install: &Path,
    cache: &Path,
    skip_files: &HashSet<&str>,
) -> Vec<Needed> {
    let mut needed = Vec::new();
    let mut bytes = vec![0; BLOCK];
    for file in &manifest.files {
        if skip_files.contains(file.name.as_str())
            || file.matches(install)
            || file.matches(cache)
        {
            continue;
        }
        let mut local = File::open(file.materialized(install)).ok();
        let mut shifted = None;
        for (index, block) in file.blocks.iter().enumerate() {
            let size = file.block_size(index);
            if local_block(local.as_mut(), &mut shifted, index, size, block, &mut bytes) {
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

pub fn patch_cache_path(cache: &Path, patch: &Patch) -> PathBuf {
    cache.join(format!("{}.patch.part", &patch.sha256[..16]))
}

pub fn patch_saved_bytes(cache: &Path, patch: &Patch) -> u64 {
    let path = patch_cache_path(cache, patch);
    let len = path.metadata().map_or(0, |meta| meta.len());
    if len > patch.size {
        let _ = fs::remove_file(&path);
        0
    } else {
        len
    }
}

pub fn select_patches<'a>(
    manifest: &'a Manifest,
    install: &Path,
    cache: &Path,
) -> Vec<(&'a Asset, &'a Patch)> {
    if manifest.patches.is_empty() {
        return Vec::new();
    }
    let mut selected = Vec::new();
    for file in &manifest.files {
        if file.matches(install) || file.matches(cache) {
            continue;
        }
        let install_path = file.materialized(install);
        let Ok(local_sha) = hash_file(&install_path) else {
            continue;
        };
        let Some(patch) = manifest.patches.iter().find(|patch| {
            patch.file == file.name
                && patch.base_sha256 == local_sha
                && patch.target_sha256 == file.sha256
        }) else {
            continue;
        };
        let pack_bytes: u64 = file.blocks.iter().map(|block| block.length).sum();
        if patch.size < pack_bytes {
            selected.push((file, patch));
        }
    }
    selected
}

pub async fn fetch_patch(
    client: &Client,
    patch: &Patch,
    cache: &Path,
    control: &mut tokio::sync::watch::Receiver<Control>,
    mut progress: impl FnMut(u64),
) -> Result<PathBuf, FetchError> {
    match *control.borrow_and_update() {
        Control::Running => {}
        Control::Pause => return Err(FetchError::Paused),
        Control::Cancel => return Err(FetchError::Canceled),
    }
    let part_path = patch_cache_path(cache, patch);
    let mut saved = patch_saved_bytes(cache, patch);
    if saved < patch.size {
        let url = Url::parse(&patch.asset).map_err(|_| FetchError::Failed("差分补丁地址无效".into()))?;
        let mut req = client.get(url).header(header::ACCEPT_ENCODING, "identity");
        if saved > 0 {
            req = req.header(header::RANGE, format!("bytes={saved}-{}", patch.size - 1));
        }
        let mut response = tokio::select! {
            res = req.send() => res.map_err(|_| FetchError::Failed("差分补丁下载连接中断".into()))?,
            _ = wait_stop(control) => return Err(stop_error(control)),
        };
        if saved > 0 && response.status() == StatusCode::OK {
            saved = 0;
        } else if saved > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
            return Err(FetchError::Failed(format!(
                "差分服务器返回异常状态（HTTP {}）",
                response.status().as_u16()
            )));
        } else if saved == 0 && !response.status().is_success() {
            return Err(FetchError::Failed(format!(
                "差分补丁下载失败（HTTP {}）",
                response.status().as_u16()
            )));
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&part_path)
            .map_err(|e| FetchError::Failed(io_error(e)))?;
        file.set_len(saved)
            .map_err(|e| FetchError::Failed(io_error(e)))?;
        file.seek(SeekFrom::Start(saved))
            .map_err(|e| FetchError::Failed(io_error(e)))?;
        let mut remaining = patch.size - saved;
        loop {
            let data = tokio::select! {
                res = response.chunk() => match res {
                    Ok(Some(data)) => data,
                    Ok(None) => break,
                    Err(_) => {
                        let _ = file.flush();
                        return Err(FetchError::Failed("差分补丁下载中断，已保留下载进度".into()));
                    }
                },
                _ = wait_stop(control) => {
                    let _ = file.flush();
                    return Err(stop_error(control));
                }
            };
            if data.len() as u64 > remaining {
                let _ = fs::remove_file(&part_path);
                return Err(FetchError::Failed("差分补丁长度超出预期".into()));
            }
            file.write_all(&data)
                .map_err(|e| FetchError::Failed(io_error(e)))?;
            remaining -= data.len() as u64;
            progress(data.len() as u64);
        }
        file.flush().map_err(|e| FetchError::Failed(io_error(e)))?;
        drop(file);
        if remaining != 0 {
            return Err(FetchError::Failed("差分补丁下载未完成，已保留进度".into()));
        }
    }
    let verify_path = part_path.clone();
    let expected_sha = patch.sha256.clone();
    let valid = tokio::task::spawn_blocking(move || {
        hash_file(&verify_path).is_ok_and(|digest| digest == expected_sha)
    })
    .await
    .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(&part_path);
        return Err(FetchError::Failed("差分补丁校验失败".into()));
    }
    Ok(part_path)
}

pub fn apply_patch(
    old_path: &Path,
    patch_path: &Path,
    asset: &Asset,
    cache: &Path,
) -> Result<(), String> {
    let mut old_file = File::open(old_path).map_err(io_error)?;
    let old_len = old_file.metadata().map_err(io_error)?.len();
    let patch_file = File::open(patch_path).map_err(io_error)?;
    let mut decoder = GzDecoder::new(BufReader::new(patch_file));

    let mut magic = [0u8; 8];
    decoder
        .read_exact(&mut magic)
        .map_err(|_| "差分补丁格式无效".to_owned())?;
    if &magic != DELTA_MAGIC {
        return Err("差分补丁标识无效".into());
    }

    let mut target = tempfile::NamedTempFile::new_in(cache).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut written: u64 = 0;
    let mut io_buf = vec![0u8; 64 * 1024];

    loop {
        let mut tag = [0u8; 1];
        match decoder.read_exact(&mut tag) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(io_error(error)),
        }
        match tag[0] {
            0 => {
                let mut len_bytes = [0u8; 4];
                decoder
                    .read_exact(&mut len_bytes)
                    .map_err(|_| "差分数据读取失败".to_owned())?;
                let mut remaining = u32::from_le_bytes(len_bytes) as u64;
                if written.saturating_add(remaining) > asset.size {
                    return Err("差分输出超过目标文件大小".into());
                }
                while remaining > 0 {
                    let take = remaining.min(io_buf.len() as u64) as usize;
                    decoder
                        .read_exact(&mut io_buf[..take])
                        .map_err(|_| "差分数据不完整".to_owned())?;
                    target.write_all(&io_buf[..take]).map_err(io_error)?;
                    digest.update(&io_buf[..take]);
                    written += take as u64;
                    remaining -= take as u64;
                }
            }
            1 => {
                let mut off_bytes = [0u8; 8];
                let mut len_bytes = [0u8; 4];
                decoder
                    .read_exact(&mut off_bytes)
                    .map_err(|_| "差分偏移读取失败".to_owned())?;
                decoder
                    .read_exact(&mut len_bytes)
                    .map_err(|_| "差分长度读取失败".to_owned())?;
                let offset = u64::from_le_bytes(off_bytes);
                let mut remaining = u32::from_le_bytes(len_bytes) as u64;
                let end = offset
                    .checked_add(remaining)
                    .ok_or("差分偏移溢出")?;
                if end > old_len || written.saturating_add(remaining) > asset.size {
                    return Err("差分复制超出文件范围".into());
                }
                old_file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
                while remaining > 0 {
                    let take = remaining.min(io_buf.len() as u64) as usize;
                    old_file
                        .read_exact(&mut io_buf[..take])
                        .map_err(io_error)?;
                    target.write_all(&io_buf[..take]).map_err(io_error)?;
                    digest.update(&io_buf[..take]);
                    written += take as u64;
                    remaining -= take as u64;
                }
            }
            _ => return Err("差分指令无效".into()),
        }
    }

    if written != asset.size || format!("{:x}", digest.finalize()) != asset.sha256 {
        return Err("差分合并结果校验失败".into());
    }
    target.as_file().sync_all().map_err(io_error)?;
    target.persist(asset.materialized(cache)).map_err(io_error)?;
    let _ = fs::remove_file(patch_path);
    Ok(())
}

pub async fn fetch_block(
    client: &Client,
    url: &mut Url,
    pack_size: u64,
    block: &Needed,
    control: &mut tokio::sync::watch::Receiver<Control>,
    mut progress: impl FnMut(u64),
) -> Result<(), FetchError> {
    match *control.borrow_and_update() {
        Control::Running => {}
        Control::Pause => return Err(FetchError::Paused),
        Control::Cancel => return Err(FetchError::Canceled),
    }
    if block.saved == block.length() {
        return Ok(());
    }
    let start = block.block.offset + block.saved;
    let end = block.block.offset + block.length() - 1;
    let send = client
        .get(url.clone())
        .header(header::RANGE, format!("bytes={start}-{end}"))
        .header(header::ACCEPT_ENCODING, "identity")
        .send();
    let mut response = tokio::select! {
        res = send => res.map_err(|_| FetchError::Failed("更新下载连接中断".into()))?,
        _ = wait_stop(control) => return Err(stop_error(control)),
    };
    let expected = format!("bytes {start}-{end}/{pack_size}");
    if response.status() != StatusCode::PARTIAL_CONTENT
        || response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            != Some(expected.as_str())
    {
        return Err(FetchError::Failed(format!(
            "更新服务器未返回所需的数据范围（HTTP {}）",
            response.status().as_u16()
        )));
    }
    *url = response.url().clone();
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&block.cache)
        .map_err(|e| FetchError::Failed(io_error(e)))?;
    file.set_len(block.saved)
        .map_err(|e| FetchError::Failed(io_error(e)))?;
    file.seek(SeekFrom::Start(block.saved))
        .map_err(|e| FetchError::Failed(io_error(e)))?;
    let mut remaining = end - start + 1;
    loop {
        let data = tokio::select! {
            res = response.chunk() => match res {
                Ok(Some(data)) => data,
                Ok(None) => break,
                Err(_) => {
                    let _ = file.flush();
                    return Err(FetchError::Failed("更新下载中断，已保留下载进度".into()));
                }
            },
            _ = wait_stop(control) => {
                let _ = file.flush();
                return Err(stop_error(control));
            }
        };
        if data.len() as u64 > remaining {
            return Err(FetchError::Failed("更新服务器返回了无效长度".into()));
        }
        file.write_all(&data)
            .map_err(|e| FetchError::Failed(io_error(e)))?;
        remaining -= data.len() as u64;
        progress(data.len() as u64);
    }
    file.flush().map_err(|e| FetchError::Failed(io_error(e)))?;
    drop(file);
    if remaining != 0 {
        return Err(FetchError::Failed("更新下载中断，已保留下载进度".into()));
    }
    let cache = block.cache.clone();
    let decoded_block = block.block.clone();
    let decoded_size = block.decoded_size;
    let valid = tokio::task::spawn_blocking(move || decode(&cache, &decoded_block, decoded_size).is_ok())
        .await
        .unwrap_or(false);
    if !valid {
        let _ = fs::remove_file(&block.cache);
        return Err(FetchError::Failed("更新数据校验失败，请重试".into()));
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
        let mut shifted = None;
        let mut target = tempfile::NamedTempFile::new_in(cache).map_err(io_error)?;
        let mut digest = Sha256::new();
        for (index, block) in file.blocks.iter().enumerate() {
            let size = file.block_size(index);
            let decoded;
            let chunk = if local_block(local.as_mut(), &mut shifted, index, size, block, &mut bytes) {
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
