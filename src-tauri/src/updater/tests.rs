use std::{fs, io::Write, os::windows::fs::OpenOptionsExt, sync::Arc};

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use flate2::{write::GzEncoder, Compression};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{package, windows};

fn release(url: &str, mimicked_large_file: &[u8]) -> (Value, Vec<u8>) {
    let input = [
        ("WebView2Loader.dll", b"loader".as_slice()),
        ("mihomo.exe", mimicked_large_file),
        ("Mihomo-LICENSE.txt", b"license"),
        ("Mihomo-build-info.txt", b"build"),
        ("Air-Proxy.ico", b"icon"),
        ("air-proxy.exe", b"new executable"),
    ];
    let mut pack = Vec::new();
    let mut files = Vec::new();
    for (name, bytes) in input {
        let blocks: Vec<_> = bytes.chunks(package::BLOCK).map(|block| {
            let offset = pack.len();
            let mut gzip = GzEncoder::new(&mut pack, Compression::fast());
            gzip.write_all(block).unwrap();
            gzip.finish().unwrap();
            json!({ "sha256": package::hash(block), "offset": offset, "length": pack.len() - offset })
        }).collect();
        files.push(json!({ "name": name, "size": bytes.len(), "sha256": package::hash(bytes), "blocks": blocks }));
    }
    (
        json!({
            "schema": 1, "app": "app.air.client", "target": "windows-x86_64", "version": "1.0.3",
            "notes": "## Air\n\n- **更新**", "asset": url, "assetSize": pack.len(), "files": files,
        }),
        pack,
    )
}

fn signed(manifest: &Value) -> (SigningKey, Vec<u8>) {
    let key = SigningKey::from_bytes(&[42; 32]);
    let raw = serde_json::to_vec(manifest).unwrap();
    let sig = key.sign(&raw);
    let raw = serde_json::to_vec(&json!({
        "payload": STANDARD.encode(raw),
        "signature": STANDARD.encode(sig.to_bytes()),
    }))
    .unwrap();
    (key, raw)
}

#[test]
fn signatures_are_required_and_only_known_files_are_allowed() {
    let (mut release, _) = release("https://example.invalid/air.pack", b"kernel");
    let (key, raw) = signed(&release);
    assert!(package::verify(&raw, &key.verifying_key()).is_ok());
    assert!(package::verify(&raw, &SigningKey::from_bytes(&[1; 32]).verifying_key()).is_err());
    release["files"][5]["name"] = json!("../../air-proxy.exe");
    let (_, raw) = signed(&release);
    assert!(package::verify(&raw, &key.verifying_key()).is_err());
}

#[tokio::test]
async fn skipped_version_reuses_installed_blocks_and_resumes_interrupted_range() {
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/air.pack", server.local_addr().unwrap());
    let mut new_kernel = vec![b'k'; package::BLOCK];
    new_kernel.extend_from_slice(b"new tail");
    let (content, bytes) = release(&url, &new_kernel);
    let (key, raw) = signed(&content);
    let manifest = package::verify(&raw, &key.verifying_key()).unwrap();
    assert!(manifest.version > semver::Version::new(1, 0, 0));
    let install = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let mut old_kernel = new_kernel[..package::BLOCK].to_vec();
    old_kernel.extend_from_slice(b"old tail");
    fs::write(install.path().join("mihomo.exe"), old_kernel).unwrap();
    for (name, bytes) in [
        ("WebView2Loader.dll", b"loader".as_slice()),
        ("Mihomo-LICENSE.txt", b"license"),
        ("Mihomo-build-info.txt", b"build"),
        ("Air-Proxy.ico", b"icon"),
        ("air-proxy.exe", b"old executable"),
    ] {
        fs::write(install.path().join(name), bytes).unwrap();
    }

    let size = manifest.asset_size;
    let bytes: Arc<[u8]> = bytes.into();
    let task = tokio::spawn(async move {
        let mut requested = Vec::new();
        for index in 0..3 {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut request = Vec::new();
            let mut input = [0; 2048];
            while !request.ends_with(b"\r\n\r\n") {
                let count = socket.read(&mut input).await.unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&input[..count]);
            }
            let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
            let (start, end) = headers
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .unwrap()
                .split_once('-')
                .unwrap();
            let (start, end): (usize, usize) = (start.parse().unwrap(), end.parse().unwrap());
            requested.push(start);
            let data = &bytes[start..=end];
            let head = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{size}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len());
            socket.write_all(head.as_bytes()).await.unwrap();
            let sent = if index == 0 {
                data.len() / 2
            } else {
                data.len()
            };
            socket.write_all(&data[..sent]).await.unwrap();
            // Let the client commit the partial body before disconnecting.
            if index == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            }
            socket.shutdown().await.unwrap();
        }
        requested
    });
    let mut url = Url::parse(&url).unwrap();
    let plan = package::plan(&manifest, install.path(), cache.path());
    assert_eq!(plan.len(), 2);
    let missing: u64 = plan.iter().map(package::Needed::length).sum();
    assert!(missing < manifest.asset_size / 2);
    let (_ctrl_tx, mut ctrl_rx) = tokio::sync::watch::channel(package::Control::Running);
    let client = Client::builder().no_proxy().build().unwrap();
    assert!(
        package::fetch_block(&client, &mut url, size, &plan[0], &mut ctrl_rx, |_| {})
            .await
            .is_err()
    );
    let plan = package::plan(&manifest, install.path(), cache.path());
    assert!(plan[0].saved > 0 && plan[0].saved < plan[0].length());
    let client = Client::builder().no_proxy().build().unwrap();
    for block in &plan {
        package::fetch_block(&client, &mut url, size, block, &mut ctrl_rx, |_| {})
            .await
            .unwrap();
    }
    let requested = task.await.unwrap();
    assert_eq!(requested[1] - requested[0], plan[0].saved as usize);
    package::assemble(&manifest, install.path(), cache.path()).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(install.path().join("air-proxy.exe"))
        .unwrap();
    assert!(windows::apply(&manifest, install.path(), cache.path()).is_err());
    assert_eq!(
        fs::read(install.path().join("air-proxy.exe")).unwrap(),
        b"old executable"
    );
    assert_eq!(
        fs::read(install.path().join("mihomo.exe")).unwrap()[package::BLOCK..],
        *b"old tail"
    );
    drop(locked);
    windows::apply(&manifest, install.path(), cache.path()).unwrap();
    assert!(manifest
        .files
        .iter()
        .all(|file| file.matches(install.path())));
    assert_eq!(
        fs::read(install.path().join("mihomo.exe")).unwrap(),
        new_kernel
    );
}

#[tokio::test]
async fn pause_and_cancel_controls_interrupt_block_download_cleanly() {
    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/air.pack", server.local_addr().unwrap());
    let new_kernel: Vec<u8> = (0..65_536u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8 ^ (i as u8))
        .collect();
    let (content, bytes) = release(&url, &new_kernel);
    let (key, raw) = signed(&content);
    let manifest = package::verify(&raw, &key.verifying_key()).unwrap();
    let install = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let plan = package::plan(&manifest, install.path(), cache.path());
    let target_block = plan
        .iter()
        .find(|b| b.length() > 1024)
        .expect("large block")
        .clone();
    let size = manifest.asset_size;
    let bytes: Arc<[u8]> = bytes.into();

    let server_task = tokio::spawn(async move {
        for _ in 0..2 {
            let (mut socket, _) = server.accept().await.unwrap();
            let mut request = Vec::new();
            let mut input = [0; 2048];
            while !request.ends_with(b"\r\n\r\n") {
                let count = socket.read(&mut input).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&input[..count]);
            }
            let headers = String::from_utf8_lossy(&request).to_ascii_lowercase();
            let (start, end) = headers
                .lines()
                .find_map(|line| line.strip_prefix("range: bytes="))
                .unwrap()
                .split_once('-')
                .unwrap();
            let (start, end): (usize, usize) = (start.parse().unwrap(), end.parse().unwrap());
            let data = &bytes[start..=end];
            let head = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{size}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                data.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let split = (data.len() / 2).max(1);
            let _ = socket.write_all(&data[..split]).await;
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });

    // Test Pause preserves saved bytes
    let (ctrl_tx, mut ctrl_rx) = tokio::sync::watch::channel(package::Control::Running);
    let mut url_pause = Url::parse(&url).unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let paused_res = {
        let tx = ctrl_tx.clone();
        let fut = package::fetch_block(&client, &mut url_pause, size, &target_block, &mut ctrl_rx, |len| {
            if len > 0 {
                let _ = tx.send(package::Control::Pause);
            }
        });
        fut.await
    };
    assert_eq!(paused_res, Err(package::FetchError::Paused));
    let paused_plan = package::plan(&manifest, install.path(), cache.path());
    assert!(paused_plan.iter().any(|b| b.saved > 0));

    // Test Cancel returns Canceled cleanly
    let (ctrl_tx2, mut ctrl_rx2) = tokio::sync::watch::channel(package::Control::Running);
    let mut url_cancel = Url::parse(&url).unwrap();
    let cancel_res = package::fetch_block(&client, &mut url_cancel, size, &paused_plan[0], &mut ctrl_rx2, |_| {
        let _ = ctrl_tx2.send(package::Control::Cancel);
    })
    .await;
    assert_eq!(cancel_res, Err(package::FetchError::Canceled));
    server_task.abort();
}

#[tokio::test]
async fn binary_delta_patch_applies_resumes_and_falls_back_cleanly() {
    let old_exe = [
        b"OLD_HEADER_".repeat(64),
        vec![0xAB; 65_536],
        b"_OLD_TAIL".repeat(64),
    ]
    .concat();
    let new_exe = [
        b"NEW_HEADER_".repeat(64),
        vec![0xAB; 65_536],
        b"_NEW_TAIL".repeat(64),
    ]
    .concat();

    // Build AIRDLT1 delta stream: LITERAL(new head) + COPY(old 65536 middle) + LITERAL(new tail).
    let mut raw_delta = Vec::from(package::DELTA_MAGIC.as_slice());
    let new_head = b"NEW_HEADER_".repeat(64);
    let old_head_len = b"OLD_HEADER_".repeat(64).len() as u64;
    let new_tail = b"_NEW_TAIL".repeat(64);
    raw_delta.push(0);
    raw_delta.extend_from_slice(&(new_head.len() as u32).to_le_bytes());
    raw_delta.extend_from_slice(&new_head);
    raw_delta.push(1);
    raw_delta.extend_from_slice(&old_head_len.to_le_bytes());
    raw_delta.extend_from_slice(&(65_536u32).to_le_bytes());
    raw_delta.push(0);
    raw_delta.extend_from_slice(&(new_tail.len() as u32).to_le_bytes());
    raw_delta.extend_from_slice(&new_tail);

    let mut patch_gz = Vec::new();
    let mut gzip = GzEncoder::new(&mut patch_gz, Compression::fast());
    gzip.write_all(&raw_delta).unwrap();
    gzip.finish().unwrap();

    let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = server.local_addr().unwrap();
    let pack_url = format!("http://{addr}/air.pack");
    let patch_url = format!("http://{addr}/air.patch");

    // Build release with new_exe as an incompressible big asset if needed so patch < pack_bytes.
    let mut pack = Vec::new();
    let input: [(&str, &[u8]); 6] = [
        ("WebView2Loader.dll", b"loader"),
        ("mihomo.exe", b"kernel"),
        ("Mihomo-LICENSE.txt", b"license"),
        ("Mihomo-build-info.txt", b"build"),
        ("Air-Proxy.ico", b"icon"),
        ("air-proxy.exe", &new_exe),
    ];
    let mut files = Vec::new();
    for (name, bytes) in input {
        let blocks: Vec<_> = bytes
            .chunks(package::BLOCK)
            .map(|block| {
                let offset = pack.len();
                let mut g = GzEncoder::new(&mut pack, Compression::none());
                g.write_all(block).unwrap();
                g.finish().unwrap();
                json!({ "sha256": package::hash(block), "offset": offset, "length": pack.len() - offset })
            })
            .collect();
        files.push(json!({ "name": name, "size": bytes.len(), "sha256": package::hash(bytes), "blocks": blocks }));
    }
    let manifest_json = json!({
        "schema": 1,
        "app": "app.air.client",
        "target": "windows-x86_64",
        "version": "1.0.3",
        "notes": "## Air",
        "asset": pack_url,
        "assetSize": pack.len(),
        "files": files,
        "patches": [{
            "file": "air-proxy.exe",
            "baseSha256": package::hash(&old_exe),
            "targetSha256": package::hash(&new_exe),
            "asset": patch_url,
            "size": patch_gz.len(),
            "sha256": package::hash(&patch_gz),
        }]
    });
    let (key, raw) = signed(&manifest_json);
    let manifest = package::verify(&raw, &key.verifying_key()).unwrap();

    let install = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    for (name, bytes) in [
        ("WebView2Loader.dll", b"loader".as_slice()),
        ("mihomo.exe", b"kernel"),
        ("Mihomo-LICENSE.txt", b"license"),
        ("Mihomo-build-info.txt", b"build"),
        ("Air-Proxy.ico", b"icon"),
        ("air-proxy.exe", &old_exe),
    ] {
        fs::write(install.path().join(name), bytes).unwrap();
    }

    let selected = package::select_patches(&manifest, install.path(), cache.path());
    assert_eq!(selected.len(), 1);
    let (asset, patch) = (selected[0].0, selected[0].1.clone());

    let patch_bytes: Arc<[u8]> = patch_gz.into();
    let server_task = tokio::spawn(async move {
        // Request 1: partial patch before pause
        let (mut s1, _) = server.accept().await.unwrap();
        let mut req1 = Vec::new();
        let mut buf = [0u8; 2048];
        while !req1.ends_with(b"\r\n\r\n") {
            let n = s1.read(&mut buf).await.unwrap();
            req1.extend_from_slice(&buf[..n]);
        }
        let split = (patch_bytes.len() / 2).max(1);
        let head1 = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            patch_bytes.len()
        );
        s1.write_all(head1.as_bytes()).await.unwrap();
        s1.write_all(&patch_bytes[..split]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;

        // Request 2: resume with Range
        let (mut s2, _) = server.accept().await.unwrap();
        let mut req2 = Vec::new();
        while !req2.ends_with(b"\r\n\r\n") {
            let n = s2.read(&mut buf).await.unwrap();
            req2.extend_from_slice(&buf[..n]);
        }
        let headers = String::from_utf8_lossy(&req2).to_ascii_lowercase();
        let (start, end) = headers
            .lines()
            .find_map(|line| line.strip_prefix("range: bytes="))
            .unwrap()
            .split_once('-')
            .unwrap();
        let (start, end): (usize, usize) = (start.parse().unwrap(), end.parse().unwrap());
        let slice = &patch_bytes[start..=end];
        let head2 = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            patch_bytes.len(),
            slice.len()
        );
        s2.write_all(head2.as_bytes()).await.unwrap();
        s2.write_all(slice).await.unwrap();
        s2.shutdown().await.unwrap();
    });

    let client = Client::builder().no_proxy().build().unwrap();
    let (tx1, mut rx1) = tokio::sync::watch::channel(package::Control::Running);
    let pause_res = package::fetch_patch(&client, &patch, cache.path(), &mut rx1, |len| {
        if len > 0 {
            let _ = tx1.send(package::Control::Pause);
        }
    })
    .await;
    assert_eq!(pause_res, Err(package::FetchError::Paused));
    assert!(package::patch_saved_bytes(cache.path(), &patch) > 0);

    let (_tx2, mut rx2) = tokio::sync::watch::channel(package::Control::Running);
    let patch_path = package::fetch_patch(&client, &patch, cache.path(), &mut rx2, |_| {})
        .await
        .unwrap();
    package::apply_patch(
        &install.path().join("air-proxy.exe"),
        &patch_path,
        asset,
        cache.path(),
    )
    .unwrap();

    // After apply_patch, cache already has exact air-proxy.exe and plan() needs 0 blocks.
    assert!(asset.matches(cache.path()));
    assert!(package::plan(&manifest, install.path(), cache.path()).is_empty());

    // Verify mismatched base falls back to empty select_patches.
    fs::write(install.path().join("air-proxy.exe"), b"something else").unwrap();
    let cache2 = tempfile::tempdir().unwrap();
    assert!(package::select_patches(&manifest, install.path(), cache2.path()).is_empty());

    server_task.abort();
}
