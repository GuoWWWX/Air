use air::{
    network::NetworkSettings,
    proxy::{compile, Mode, Runtime, StartTarget},
    routing::{Matcher, RoutingConfig, RoutingFile, Rule, Target},
    subscriptions::parse,
};
use std::{
    net::Ipv4Addr,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

async fn proxy(body: &'static str) -> (u16, JoinHandle<()>) {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (
        port,
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut stream = BufReader::new(stream);
                    let mut line = String::new();
                    for request in 0..2 {
                        line.clear();
                        if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let connect = line.starts_with("CONNECT ");
                        loop {
                            line.clear();
                            if stream.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n"
                            {
                                break;
                            }
                        }
                        if request == 0 && connect {
                            if stream
                                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                                .await
                                .is_err()
                            {
                                return;
                            }
                            continue;
                        }
                        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                        let _ = stream.write_all(response.as_bytes()).await;
                        return;
                    }
                });
            }
        }),
    )
}

#[tokio::test]
#[ignore = "requires AIR_TEST_MIHOMO pointing to the bundled Windows kernel"]
async fn switches_a_loaded_node_and_mode_without_restarting_the_kernel() {
    let binary = PathBuf::from(std::env::var_os("AIR_TEST_MIHOMO").unwrap());
    let directory = tempfile::tempdir().unwrap();
    let (port, tcp, udp) = (22000..32000)
        .find_map(|port| {
            let tcp = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).ok()?;
            let udp = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, port)).ok()?;
            Some((port, tcp, udp))
        })
        .unwrap();
    let network = NetworkSettings {
        mixed_port: Some(port),
        ..NetworkSettings::default()
    };
    let file = RoutingFile::new(directory.path());
    file.save_network(&network, &file.network().unwrap().revision)
        .unwrap();
    let (a, first) = proxy("first").await;
    let (b, second) = proxy("second").await;
    let source = parse("fixture".into(), "Fixture".into(), &format!(
        "proxies:\n- {{name: A, type: http, server: 127.0.0.1, port: {a}}}\n- {{name: B, type: http, server: 127.0.0.1, port: {b}}}"
    )).unwrap();
    let config = |mode, index: usize| {
        compile(
            mode,
            &RoutingConfig::default(),
            std::slice::from_ref(&source),
            None,
            &StartTarget::Node {
                group_id: None,
                id: source.nodes[index].id.clone(),
            },
        )
        .unwrap()
    };
    let mut runtime = Runtime::new(directory.path().to_owned());
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{port}")).unwrap())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let request = || client.get("http://1.1.1.1/").send();
    drop((tcp, udp));
    for mode in [Mode::Direct, Mode::Global, Mode::Rule] {
        runtime.set_mode(mode).await.unwrap();
        let started = Instant::now();
        runtime.start(&binary, config(mode, 0)).await.unwrap();
        eprintln!("{mode:?} start: {:?}", started.elapsed());
        if mode != Mode::Rule {
            runtime.stop().await.unwrap();
        }
    }
    let session =
        serde_json::to_value(runtime.status().await.unwrap()).unwrap()["sessionId"].clone();
    assert!(session.is_string());
    assert_eq!(request().await.unwrap().text().await.unwrap(), "first");
    let started = Instant::now();
    runtime.select_node(config(Mode::Rule, 1)).await.unwrap();
    eprintln!("new exit: {:?}", started.elapsed());
    assert_eq!(request().await.unwrap().text().await.unwrap(), "second");
    runtime.set_mode(Mode::Global).await.unwrap();
    let started = Instant::now();
    runtime.select_node(config(Mode::Global, 0)).await.unwrap();
    eprintln!("previously loaded exit: {:?}", started.elapsed());
    assert_eq!(request().await.unwrap().text().await.unwrap(), "first");
    assert_eq!(
        serde_json::to_value(runtime.status().await.unwrap()).unwrap()["sessionId"],
        session
    );
    // Both subscriptions use the same names. A global override keeps using the
    // first subscription while unmatched connections follow the selected one.
    let sources = [("one", a), ("two", b)].map(|(id, port)| {
        parse(id.into(), id.into(), &format!(
            "proxies: [{{name: Node, type: http, server: 127.0.0.1, port: {port}}}]\nproxy-groups: [{{name: Group, type: select, proxies: [Node]}}]\nrules: ['IP-CIDR,1.1.1.1/32,REJECT,no-resolve', 'MATCH,Group']"
        )).unwrap()
    });
    let routing = RoutingConfig {
        rule_library: None,
        match_fallback: None,
        subscription_id: Some("one".into()),
        rules: vec![Rule {
            resume_on_enable: None,
            enabled: true, matcher: Matcher::Ip, value: "1.1.1.1".into(),
            host_matcher: None, host_value: None,
            target: Target::Group { source_id: "one".into(), name: "Group".into() },
        }],
        ..RoutingConfig::default()
    };
    runtime.set_mode(Mode::Rule).await.unwrap();
    for (index, expected) in ["first", "second"].into_iter().enumerate() {
        let target = StartTarget::Node {
            group_id: None,
            id: sources[index].nodes[0].id.clone(),
        };
        runtime
            .select_node(compile(Mode::Rule, &routing, &sources, None, &target).unwrap())
            .await
            .unwrap();
        assert_eq!(request().await.unwrap().text().await.unwrap(), "first");
        assert_eq!(client.get("http://1.0.0.1/").send().await.unwrap().text().await.unwrap(), expected);
        assert!(runtime.subscription_snapshot(&sources[index].id).unwrap().is_some());
        assert!(runtime.subscription_snapshot(&sources[1 - index].id).unwrap().is_none());
    }
    let target = StartTarget::Node {
        id: sources[1].nodes[0].id.clone(),
        group_id: Some("team".into()),
    };
    let binding: RoutingConfig = serde_json::from_value(serde_json::json!({
        "ruleLibrary": {"sets":[{"id":"template","name":"Custom","profile":{"rules":["MATCH,PROXY"]}}],
            "bindings":{"group:team":"user:template"}},
        "rules":[{"matcher":"ip","value":"1.1.1.1","target":{"kind":"group","sourceId":"one","name":"Group"}}]
    })).unwrap();
    let preview = compile(Mode::Rule, &binding, &sources, None, &target)
        .unwrap()
        .preview_rules(&network)
        .unwrap();
    runtime
        .select_node(compile(Mode::Rule, &binding, &sources, None, &target).unwrap())
        .await
        .unwrap();
    assert_eq!(preview.last().unwrap(), "MATCH,GLOBAL");
    assert_eq!(request().await.unwrap().text().await.unwrap(), "first");
    assert_eq!(
        client
            .get("http://1.0.0.1/")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "second"
    );
    runtime.stop().await.unwrap();
    first.abort();
    second.abort();
}
