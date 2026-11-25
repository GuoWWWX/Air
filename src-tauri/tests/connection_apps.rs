#![cfg(all(windows, feature = "desktop"))]

use air::{
    network::NetworkSettings,
    proxy::{compile, Mode, Runtime, StartTarget, TelemetryCursor},
    routing::{RoutingConfig, RoutingFile},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{net::Ipv4Addr, path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Command,
    sync::Mutex,
    time::{sleep, timeout},
};

#[tokio::test]
#[ignore = "requires the bundled Windows Mihomo binary"]
async fn live_connection_reports_the_sending_application_and_its_icon() {
    let core =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
    let temp = tempfile::tempdir().unwrap();
    let directory = temp.path();
    let (proxy_tcp, proxy_udp) = (22000..32000)
        .find_map(|port| {
            let address = (Ipv4Addr::LOCALHOST, port);
            let tcp = std::net::TcpListener::bind(address).ok()?;
            let udp = std::net::UdpSocket::bind(address).ok()?;
            Some((tcp, udp))
        })
        .expect("available local TCP and UDP port for the test proxy");
    let proxy_port = proxy_tcp.local_addr().unwrap().port();
    let origin = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let origin_address = origin.local_addr().unwrap();

    let preferences = RoutingFile::new(directory);
    preferences.ensure_exists().unwrap();
    preferences
        .save_network(
            &NetworkSettings {
                mixed_port: Some(proxy_port),
                ..NetworkSettings::default()
            },
            &preferences.network().unwrap().revision,
        )
        .unwrap();
    let config = compile(
        Mode::Direct,
        &RoutingConfig::default(),
        &[],
        None,
        &StartTarget::Routing,
    )
    .unwrap();
    let runtime = Mutex::new(Runtime::new(directory.to_owned()));
    runtime.lock().await.set_mode(Mode::Direct).await.unwrap();
    drop((proxy_tcp, proxy_udp));
    runtime.lock().await.start(&core, config).await.unwrap();

    let mut client = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            r#"
            $socket = [System.Net.Sockets.TcpClient]::new('127.0.0.1', [int]$env:AIR_TEST_PROXY_PORT)
            try {
                $stream = $socket.GetStream()
                $target = $env:AIR_TEST_ORIGIN
                $request = [Text.Encoding]::ASCII.GetBytes("GET http://$target/icon-check HTTP/1.1`r`nHost: $target`r`n`r`n")
                $stream.Write($request, 0, $request.Length)
                $stream.ReadTimeout = 8000
                while ($stream.ReadByte() -ne -1) {}
            } finally { $socket.Dispose() }
            "#,
        ])
        .env("AIR_TEST_PROXY_PORT", proxy_port.to_string())
        .env("AIR_TEST_ORIGIN", origin_address.to_string())
        .creation_flags(0x08000000)
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();

    let (mut connection, _) = timeout(Duration::from_secs(6), origin.accept())
        .await
        .unwrap()
        .unwrap();
    let mut request = [0; 1024];
    let count = timeout(Duration::from_secs(3), connection.read(&mut request))
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&request[..count]).contains("/icon-check"));
    connection
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nactive")
        .await
        .unwrap();

    let target = origin_address.to_string();
    let snapshot = timeout(Duration::from_secs(4), async {
        loop {
            Runtime::sample_telemetry(&runtime).await;
            if let Some(snapshot) = runtime.lock().await.telemetry() {
                let json = serde_json::to_value(snapshot).unwrap();
                if json["connections"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|row| row["target"] == target)
                {
                    return json;
                }
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("Air sampled the open HTTP connection");
    let row = snapshot["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["target"] == target)
        .unwrap();
    let executable = row["appExecutable"]
        .as_str()
        .or_else(|| row["app"].as_str())
        .unwrap();
    assert_eq!(executable.to_ascii_lowercase(), "powershell.exe");
    let icon_key = row["appIconKey"]
        .as_str()
        .expect("connection has a real app icon");
    let png = snapshot["appIcons"][icon_key]
        .as_str()
        .unwrap()
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    assert_eq!(
        image::load_from_memory(&STANDARD.decode(png).unwrap())
            .unwrap()
            .width(),
        32
    );

    if let Some(path) = std::env::var_os("AIR_TEST_CONNECTION_TELEMETRY") {
        std::fs::write(path, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    }
    let mut cursor = TelemetryCursor {
        session_id: snapshot["sessionId"].as_str().unwrap().to_owned(),
        revision: snapshot["revision"].as_u64().unwrap(),
        known_icons: [icon_key.to_owned()].into_iter().collect(),
    };
    Runtime::sample_telemetry_with_visibility(&runtime, true).await;
    let poll = || async {
        serde_json::to_value(
            runtime
                .lock()
                .await
                .telemetry_update(Some(&cursor))
                .unwrap(),
        )
        .unwrap()
    };
    let hidden = poll().await;
    let matching = hidden["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == row["id"])
        .unwrap();
    assert_eq!(matching["appIconKey"], icon_key);
    assert_eq!(matching["appExecutable"], row["appExecutable"]);
    assert!(hidden["appIcons"].get(icon_key).is_none());
    client.kill().await.unwrap();
    drop(connection);

    let closed = timeout(Duration::from_secs(4), async {
        loop {
            Runtime::sample_telemetry_with_visibility(&runtime, true).await;
            let packet = poll().await;
            if packet["connectionLogs"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["id"] == row["id"] && item["closed"] == true)
            {
                return packet;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("a connection closed in the tray is still recorded");
    cursor.revision = closed["revision"].as_u64().unwrap();
    let mut locked = runtime.lock().await;
    let ack = serde_json::to_value(locked.telemetry_update(Some(&cursor)).unwrap()).unwrap();
    assert!(ack["connectionLogs"].as_array().unwrap().is_empty());
    assert!(ack["logOrder"].as_array().unwrap().contains(&row["id"]));
    locked.clear_connection_logs();
    let cleared = serde_json::to_value(locked.telemetry_update(Some(&cursor)).unwrap()).unwrap();
    assert!(!cleared["logOrder"].as_array().unwrap().contains(&row["id"]));
    drop(locked);
    runtime.lock().await.stop().await.unwrap();
}
