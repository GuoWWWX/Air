use air::network::{DomainDns, NetworkSettings};
use air::routing::{RoutingConfig, RoutingFile};
use std::fs;

#[test]
fn factory_dns_uses_real_ips_and_upgrades_only_the_generated_legacy_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = RoutingFile::new(dir.path());
    let current = NetworkSettings::default();
    current.validate().unwrap();
    assert!(current.dns_hijack && current.respect_rules);
    assert!(current.tcp_concurrent);
    assert_eq!(current.enhanced_mode, "redir-host");
    assert!(current.nameserver.iter().all(|host| host.starts_with("https://")));
    assert!(!current.proxy_server_nameserver.is_empty());
    let legacy = NetworkSettings {
        nameserver: vec!["system".into()], proxy_server_nameserver: vec![],
        respect_rules: false, enhanced_mode: "auto".into(), strict_route: false, tcp_concurrent: false, ..current.clone()
    };
    let template = serde_yaml::to_string(&serde_json::json!({ "network": legacy, "routing": RoutingConfig::default() })).unwrap();
    fs::write(file.path(), format!("# custom\n{template}")).unwrap();
    file.upgrade_factory_network().unwrap();
    assert_eq!(file.network().unwrap().settings, legacy);
    fs::write(file.path(), &template).unwrap();
    file.upgrade_factory_network().unwrap();
    assert_eq!(file.network().unwrap().settings, current);
    assert_eq!(fs::read_to_string(dir.path().join("air-config.previous.yaml")).unwrap(), template);
}

#[test]
fn desktop_system_proxy_choice_survives_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("air.sqlite3");
    let store = air::storage::Store::open(&db).unwrap();
    assert_eq!(store.system_proxy_preference().unwrap(), cfg!(windows));
    store.save_system_proxy_preference(false).unwrap();
    drop(store);
    assert!(!air::storage::Store::open(&db).unwrap().system_proxy_preference().unwrap());
}

#[test]
fn yaml_editor_repairs_invalid_files_and_keeps_raw_text_and_external_edits() {
    let dir = tempfile::tempdir().unwrap();
    let file = RoutingFile::new(dir.path());
    fs::write(file.path(), "network: [\n").unwrap();
    let broken = file.source().unwrap();
    assert_eq!(broken.contents, "network: [\n");
    assert!(file
        .save_text("network: {nameserver: []}", &broken.revision, &[])
        .is_err());
    assert_eq!(file.source().unwrap().revision, broken.revision);
    let fixed = "# upstream\r\nnetwork: {nameserver: ['system']}\r\n";
    let revision = file.save_text(fixed, &broken.revision, &[]).unwrap();
    assert_eq!(fs::read(file.path()).unwrap(), fixed.as_bytes());
    assert_eq!(file.network().unwrap().revision, revision);
    assert_eq!(
        fs::read_to_string(dir.path().join("air-config.previous.yaml")).unwrap(),
        broken.contents
    );
    fs::write(file.path(), "routing: {} # external").unwrap();
    assert!(file
        .save_text(fixed, &revision, &[])
        .unwrap_err()
        .contains("重新读取"));
    assert_eq!(file.source().unwrap().contents, "routing: {} # external");
}

#[test]
fn users_can_edit_and_validate_the_file_without_rewriting_it() {
    let dir = tempfile::tempdir().unwrap();
    let file = RoutingFile::new(dir.path());
    file.ensure_exists().unwrap();
    let initial = fs::read_to_string(file.path()).unwrap();
    assert!(initial.contains("network:") && initial.contains("routing:"));
    for (text, valid) in [
        ("# legacy\nrouting: {}\n", true),
        ("network: {proxyServerNameserver: []}", true),
        ("network: {proxyServerNameserver: [], respectRules: true}", false),
        (
            "network:\n  hosts: ['127.0.0.1 nas.home alias.home']\n  probeIntervalMinutes: 30\n",
            true,
        ),
        (
            "network:\n  hosts: ['127.0.0.1 nas.home', '::1 NAS.home']\n",
            false,
        ),
        ("network:\n  probeIntervalMinutes: 0\n", false),
        ("network: [\n", false),
        ("dns: {nameserver: [system]}\n", false),
        ("routing: {inheritRules: true}\n", false),
    ] {
        fs::write(file.path(), text).unwrap();
        file.ensure_exists().unwrap();
        assert_eq!(file.validate_file(&[]).is_ok(), valid, "{text}");
        assert_eq!(fs::read_to_string(file.path()).unwrap(), text);
    }
}

#[test]
fn copying_subscription_dns_only_offers_lists_present_in_the_source() {
    let result = air::network::subscription_resolvers("dns:\n  nameserver: [https://223.5.5.5/dns-query, https://doh.pub/dns-query]\n  direct-nameserver: []\n").unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result["nameserver"].len(), 2);
    assert!(result["directNameserver"].is_empty());
    for text in [
        "proxies: []",
        "dns: {nameserver: []}",
        "dns: {nameserver: [bad]}",
    ] {
        assert!(air::network::subscription_resolvers(text).is_err());
    }
}

#[test]
fn legacy_settings_remain_usable_and_network_edits_preserve_other_sections() {
    let directory = tempfile::tempdir().unwrap();
    let file = RoutingFile::new(directory.path());
    let original = "# keep my note\nappearance: {theme: dark}\nrouting: {}\n";
    fs::write(file.path(), original).unwrap();
    let old = file.network().unwrap();
    assert_eq!(old.settings, NetworkSettings::default());
    let changed = NetworkSettings {
        nameserver: vec![
            "https://223.5.5.5/dns-query".into(),
            "https://doh.pub/dns-query".into(),
        ],
        ..old.settings
    };
    let saved = file.save_network(&changed, &old.revision).unwrap();
    assert_eq!(
        fs::read_to_string(directory.path().join("air-config.previous.yaml")).unwrap(),
        original
    );
    assert_eq!(saved.settings, changed);
    assert!(file.save(&RoutingConfig::default(), &old.revision).is_err());
    file.save(&RoutingConfig::default(), &saved.revision)
        .unwrap();
    assert_eq!(file.network().unwrap().settings, changed);
    let yaml: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(file.path()).unwrap()).unwrap();
    assert_eq!(yaml["appearance"]["theme"], "dark");

    let backup = fs::read(file.path()).unwrap();
    for invalid in [
        NetworkSettings {
            nameserver: vec![],
            ..changed.clone()
        },
        NetworkSettings {
            default_nameserver: vec!["https://doh.pub/dns-query".into()],
            ..changed.clone()
        },
        NetworkSettings {
            respect_rules: true,
            proxy_server_nameserver: vec![],
            ..changed.clone()
        },
        NetworkSettings {
            domain_dns: vec![DomainDns {
                domain: "+.corp".into(),
                server: "not a dns".into(),
            }],
            ..changed.clone()
        },
        NetworkSettings {
            route_exclude_address: vec!["192.168.0.0/47".into()],
            ..changed.clone()
        },
        NetworkSettings {
            mixed_port: Some(0),
            ..changed.clone()
        },
    ] {
        assert!(file
            .save_network(&invalid, &file.network().unwrap().revision)
            .is_err());
        assert_eq!(fs::read(file.path()).unwrap(), backup);
    }
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires AIR_TEST_MIHOMO pointing to a local kernel"]
async fn kernel_resolves_through_selected_dns_and_reuses_active_settings_on_node_switch() {
    use air::{
        proxy::{compile, Mode, Runtime, StartTarget},
        subscriptions::parse,
    };
    use std::{
        net::{Ipv4Addr, TcpListener},
        path::PathBuf,
        time::Duration,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UdpSocket;

    let binary = PathBuf::from(std::env::var_os("AIR_TEST_MIHOMO").unwrap());
    let dir = tempfile::tempdir().unwrap();
    let dns = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let upstream = format!("udp://{}", dns.local_addr().unwrap());
    let responder = tokio::spawn(async move {
        let mut buf = [0; 2048];
        loop {
            let (n, from) = dns.recv_from(&mut buf).await.unwrap();
            let mut end = 12;
            while end < n && buf[end] != 0 {
                end += 1 + buf[end] as usize;
            }
            if end + 5 > n {
                continue;
            }
            let a = buf[end + 1..end + 3] == [0, 1];
            let mut reply = buf[..end + 5].to_vec();
            reply[2..4].copy_from_slice(&[0x81, 0x80]);
            reply[6..12].copy_from_slice(&[0, u8::from(a), 0, 0, 0, 0]);
            if a {
                reply.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 5, 0, 4, 127, 0, 0, 1]);
            }
            dns.send_to(&reply, from).await.unwrap();
        }
    });
    let http = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let http_port = http.local_addr().unwrap().port();
    let http = tokio::net::TcpListener::from_std({
        http.set_nonblocking(true).unwrap();
        http
    })
    .unwrap();
    let web = tokio::spawn(async move {
        loop {
            let (mut stream, _) = http.accept().await.unwrap();
            let mut buf = [0; 4096];
            if stream.read(&mut buf).await.unwrap() == 0 {
                continue;
            }
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        }
    });
    let held = (22000..32000)
        .find_map(|port| {
            let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok()?;
            std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).ok()?;
            Some(tcp)
        })
        .unwrap();
    let port = held.local_addr().unwrap().port();
    let file = RoutingFile::new(dir.path());
    let settings = NetworkSettings {
        nameserver: vec![upstream.clone()],
        direct_nameserver: vec![upstream.clone()],
        default_nameserver: vec!["127.0.0.1".into()],
        proxy_server_nameserver: vec![upstream.clone()],
        domain_dns: vec![DomainDns {
            domain: "+.air.test".into(),
            server: upstream,
        }],
        dns_ipv6: false,
        hosts: vec!["127.0.0.1 local.air.test".into()],
        dns_cache_algorithm: "arc".into(),
        direct_follow_policy: true,
        mixed_port: Some(port),
        tun_mtu: Some(1400),
        route_exclude_address: vec!["192.168.20.0/24".into()],
        ..NetworkSettings::default()
    };
    let saved = file
        .save_network(&settings, &file.network().unwrap().revision)
        .unwrap();
    let diagnostic =
        air::mihomo::Kernel::start_diagnostic(&binary, dir.path(), vec![], &serde_yaml::Mapping::new(), None, &settings)
            .await
            .unwrap();
    let answer = diagnostic.query_dns("upstream.air.test").await.unwrap();
    assert_eq!(
        answer.addresses,
        [std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)]
    );
    drop(diagnostic);
    let source = parse(
        "s".into(),
        "test".into(),
        "proxies:\n  - {name: node, type: http, server: 127.0.0.1, port: 1}",
    )
    .unwrap();
    let target = StartTarget::Node {
        id: source.nodes[0].id.clone(),
    };
    let config = || {
        compile(
            Mode::Direct,
            &RoutingConfig::default(),
            std::slice::from_ref(&source),
            None,
            &target,
        )
        .unwrap()
    };
    let mut runtime = Runtime::new(dir.path().to_owned());
    runtime.set_mode(Mode::Direct).await.unwrap();
    assert!(runtime
        .start(&binary, config())
        .await
        .unwrap_err()
        .contains(&port.to_string()));
    drop(held);
    runtime.start(&binary, config()).await.unwrap();
    assert!(runtime.status().await.unwrap().running);
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{port}")).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let check = |host: &str| {
        client
            .get(format!("http://{host}.air.test:{http_port}/"))
            .send()
    };
    assert_eq!(check("first").await.unwrap().status(), 204);
    file.save_network(&NetworkSettings::default(), &saved.revision)
        .unwrap();
    runtime.select_node(config()).await.unwrap();
    assert_eq!(check("second").await.unwrap().status(), 204);
    responder.abort();
    // This uncached name must resolve through hosts with the upstream stopped.
    assert_eq!(check("local").await.unwrap().status(), 204);
    runtime.stop().await.unwrap();
    web.abort();
}
