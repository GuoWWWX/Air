use air::{
    chains::{chain_hops, custom_node_mapping, CustomNodeInput, EXIT_NAME},
    proxy::{self, Mode, StartTarget},
    routing::RoutingConfig,
    subscriptions::parse,
};

#[test]
fn an_explicit_invalid_chain_never_compiles_as_a_direct_outbound() {
    let source = parse(
        "a".into(),
        "A".into(),
        "proxies:\n  - { name: Front, type: http, server: a.example.net, port: 8080 }\n",
    )
    .unwrap();
    let target = StartTarget::Chain {
        name: "Sample chain".into(),
        hops: vec![source.nodes[0].id.clone(), "deleted-node".into()],
    };
    let sources = [source];
    let routing = RoutingConfig::default();
    let error = proxy::compile(Mode::Direct, &routing, &sources, None, &target)
        .err()
        .unwrap();
    assert!(error.contains("第 2 跳"));
    assert!(proxy::compile(
        Mode::Direct,
        &routing,
        &sources,
        None,
        &StartTarget::Routing
    )
    .is_ok());
}

#[test]
fn multi_hop_nodes_chain_in_order_and_last_hop_is_exit() {
    let a = parse(
        "a".into(),
        "A".into(),
        "proxies:\n  - { name: HK, type: anytls, server: a.example.net, port: 443, password: demo }\n",
    )
    .unwrap();
    let b = parse(
        "b".into(),
        "B".into(),
        "proxies:\n  - { name: JP, type: socks5, server: b.example.net, port: 1080 }\n",
    )
    .unwrap();
    let c = parse(
        "custom".into(),
        "自定义".into(),
        "proxies:\n  - { name: Exit, type: http, server: c.example.net, port: 8080, username: u, password: p }\n",
    )
    .unwrap();
    let hops = vec![
        a.nodes[0].id.clone(),
        b.nodes[0].id.clone(),
        c.nodes[0].id.clone(),
    ];
    let nodes: Vec<_> = a.nodes.into_iter().chain(b.nodes).chain(c.nodes).collect();
    let config = chain_hops(&nodes, &hops).unwrap();
    assert_eq!(config.len(), 3);
    assert_eq!(config[0]["server"].as_str(), Some("a.example.net"));
    assert_eq!(config[1]["server"].as_str(), Some("b.example.net"));
    assert_eq!(config[1]["dialer-proxy"], config[0]["name"]);
    assert_eq!(config[2]["name"].as_str(), Some(EXIT_NAME));
    assert_eq!(config[2]["dialer-proxy"], config[1]["name"]);
    assert_eq!(config[2]["server"].as_str(), Some("c.example.net"));

    // 任意节点调换到最后，即成为最终出口
    let reversed = vec![hops[2].clone(), hops[0].clone()];
    let two_hops = chain_hops(&nodes, &reversed).unwrap();
    assert_eq!(two_hops.len(), 2);
    assert_eq!(two_hops[0]["server"].as_str(), Some("c.example.net"));
    assert_eq!(two_hops[1]["name"].as_str(), Some(EXIT_NAME));
    assert_eq!(two_hops[1]["server"].as_str(), Some("a.example.net"));
    assert_eq!(two_hops[1]["dialer-proxy"], two_hops[0]["name"]);
}

#[test]
fn duplicate_or_too_few_hops_and_cyclic_front_references_are_rejected() {
    let a = parse(
        "a".into(),
        "A".into(),
        "proxies:\n  - { name: HK, type: http, server: a.example.net, port: 443, dialer-proxy: HK }\n",
    )
    .unwrap();
    let b = parse(
        "b".into(),
        "B".into(),
        "proxies:\n  - { name: US, type: socks5, server: b.example.net, port: 1080 }\n",
    )
    .unwrap();
    let nodes: Vec<_> = a.nodes.into_iter().chain(b.nodes).collect();

    assert!(chain_hops(&nodes, &[nodes[0].id.clone()])
        .unwrap_err()
        .contains("至少需要"));
    assert!(
        chain_hops(&nodes, &[nodes[1].id.clone(), nodes[1].id.clone()])
            .unwrap_err()
            .contains("重复")
    );
    assert!(
        chain_hops(&nodes, &[nodes[0].id.clone(), nodes[1].id.clone()])
            .unwrap_err()
            .contains("循环")
    );
}

#[test]
fn custom_node_mapping_validates_protocol_and_host() {
    let mapping = custom_node_mapping(&CustomNodeInput {
        id: None,
        name: "住宅节点".into(),
        protocol: "https".into(),
        server: "203.0.113.24".into(),
        port: 443,
        username: "demo".into(),
        password: "secret".into(),
    })
    .unwrap();
    assert_eq!(mapping["name"].as_str(), Some("住宅节点"));
    assert_eq!(mapping["type"].as_str(), Some("http"));
    assert_eq!(mapping["tls"].as_bool(), Some(true));
    assert_eq!(mapping["server"].as_str(), Some("203.0.113.24"));
    assert_eq!(mapping["port"].as_u64(), Some(443));

    assert!(custom_node_mapping(&CustomNodeInput {
        id: None,
        name: "无效地址".into(),
        protocol: "socks5".into(),
        server: "example.com/path".into(),
        port: 1080,
        username: String::new(),
        password: String::new(),
    })
    .is_err());
}
