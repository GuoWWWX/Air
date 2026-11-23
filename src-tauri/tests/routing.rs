use air::{
    routing::{HostMatcher, Matcher, RoutingConfig, RoutingFile, Rule, Target},
    subscriptions::parse,
};
use std::collections::HashSet;

#[test]
fn deleting_the_routing_source_detaches_inheritance_and_rejects_only_its_outbounds() {
    let linked = Target::Group { source_id: "deleted".into(), name: "Old group".into() };
    let mut config = RoutingConfig {
        rule_library: None, match_fallback: None, subscription_id: Some("deleted".into()),
        inherit_rules: true,
        fallback: Target::Subscription,
        rules: vec![
            rule(Matcher::Domain, "example.com", linked.clone()),
            rule(Matcher::Domain, "local.test", Target::Direct),
            Rule {
                enabled: false,
                ..rule(Matcher::Domain, "disabled.test", linked)
            },
        ],
    };

    assert!(!config.detach_subscription("unrelated"));
    assert!(config.detach_subscription("deleted"));
    assert!(!config.detach_subscription("deleted"));
    assert!(config.subscription_id.is_none());
    assert!(!config.inherit_rules);
    assert!(matches!(config.rules[2].target, Target::Reject));
    assert_eq!(
        config.compile(&[]).unwrap(),
        ["DOMAIN,example.com,REJECT", "DOMAIN,local.test,DIRECT", "MATCH,GLOBAL"]
    );
}
use std::fs;

fn rule(matcher: Matcher, value: &str, target: Target) -> Rule {
    Rule {
        enabled: true,
        matcher,
        value: value.into(),
        host_matcher: None,
        host_value: None,
        target,
    }
}

#[test]
fn custom_rules_precede_inherited_rules_and_the_configured_default() {
    let subscription = parse(
        "s".into(),
        "订阅 A".into(),
        r#"
proxies:
  - {name: proxy, type: http, server: proxy.example.net, port: 80}
proxy-groups:
  - {name: Subscription Proxy, type: select, proxies: [proxy]}
rules:
  - "RULE-SET,custom,Subscription Proxy"
  - "MATCH,Subscription Proxy"
  - "DOMAIN,unreachable.example.com,DIRECT"
"#,
    )
    .unwrap();
    let mut config = RoutingConfig {
        rule_library: None, match_fallback: None, subscription_id: Some("s".into()),
        inherit_rules: true,
        fallback: Target::Direct,
        rules: vec![
            rule(Matcher::DomainSuffix, "Corp.Example.com", Target::Direct),
            rule(
                Matcher::ProcessPath,
                r"C:\Program Files\Browser\browser.exe",
                Target::Residential,
            ),
            rule(
                Matcher::Ip,
                "2001:db8::1",
                Target::Group {
                    source_id: "s".into(),
                    name: "Subscription Proxy".into(),
                },
            ),
            Rule {
                enabled: false,
                ..rule(Matcher::Domain, "disabled.example.com", Target::Direct)
            },
        ],
    };
    let sources = [subscription];
    let compiled = config.compile(&sources).unwrap();
    assert_eq!(
        compiled,
        [
            "DOMAIN-SUFFIX,corp.example.com,DIRECT",
            r"PROCESS-PATH,C:\Program Files\Browser\browser.exe,air-residential-exit",
            r"PROCESS-PATH,C:\Program Files\Browser\browser.exe,REJECT",
            "IP-CIDR6,2001:db8::1/128,Subscription Proxy",
            "RULE-SET,custom,Subscription Proxy",
            "MATCH,DIRECT",
        ]
    );
    config.fallback = Target::Subscription;
    assert_eq!(
        config.compile(&sources).unwrap().last().unwrap(),
        "MATCH,Subscription Proxy"
    );
}

#[test]
fn invalid_matches_and_missing_groups_are_rejected() {
    for bad in [
        rule(Matcher::Domain, "https://example.com", Target::Direct),
        rule(Matcher::Ip, "10.0.0.0/33", Target::Direct),
        rule(Matcher::ProcessPath, "chrome.exe", Target::Direct),
        rule(Matcher::ProcessName, "chrome.exe,DIRECT", Target::Direct),
        rule(
            Matcher::Domain,
            "example.com",
            Target::Group {
                source_id: "wrong".into(),
                name: "Proxy".into(),
            },
        ),
    ] {
        let config = RoutingConfig {
            rules: vec![bad],
            ..RoutingConfig::default()
        };
        assert!(config.compile(&[]).unwrap_err().contains("第 1 条"));
    }
}

#[test]
fn manual_yaml_edits_reload_without_clobbering_other_sections() {
    let directory = tempfile::tempdir().unwrap();
    let file = RoutingFile::new(directory.path());
    let original = file.load().unwrap();
    assert_eq!(file.path().file_name().unwrap(), "air-config.yaml");
    let edited = r#"
appearance:
  theme: dark
routing:
  fallback: {kind: direct}
  rules:
    - matcher: ip
      value: 10.0.0.0/8
      target: {kind: direct}
"#;
    fs::write(file.path(), edited).unwrap();
    let conflict = file
        .save(&original.routing, &original.revision)
        .err()
        .expect("stale edit must be rejected");
    assert!(conflict.contains("重新读取"));
    assert_eq!(fs::read_to_string(file.path()).unwrap(), edited);
    let new = file.load().unwrap();
    assert_eq!(
        new.routing.compile(&[]).unwrap(),
        ["IP-CIDR,10.0.0.0/8,DIRECT", "MATCH,DIRECT"]
    );
    file.save(&new.routing, &new.revision).unwrap();
    let root: serde_yaml::Value =
        serde_yaml::from_str(&fs::read_to_string(file.path()).unwrap()).unwrap();
    assert_eq!(root["appearance"]["theme"].as_str(), Some("dark"));
}

#[test]
fn composite_process_host_rules_and_node_targets_compile_and_detach() {
    let subscription = parse(
        "sub".into(),
        "Sub".into(),
        "proxies:\n  - {name: HK, type: http, server: 127.0.0.1, port: 8080}\n",
    )
    .unwrap();
    let node_id = subscription.nodes[0].id.clone();
    let mut config = RoutingConfig {
        rule_library: None, match_fallback: None, subscription_id: None,
        inherit_rules: false,
        fallback: Target::Selected,
        rules: vec![
            Rule {
                enabled: true,
                matcher: Matcher::ProcessName,
                value: "chrome.exe".into(),
                host_matcher: Some(HostMatcher::DomainSuffix),
                host_value: Some("Github.COM".into()),
                target: Target::Node { id: node_id.clone() },
            },
            Rule {
                enabled: true,
                matcher: Matcher::ProcessName,
                value: "chrome.exe".into(),
                host_matcher: Some(HostMatcher::Ip),
                host_value: Some("10.0.0.1".into()),
                target: Target::Direct,
            },
            rule(Matcher::ProcessName, "chrome.exe", Target::Selected),
        ],
    };
    let compiled = config.compile(&[subscription]).unwrap();
    assert_eq!(
        compiled,
        [
            format!("AND,((PROCESS-NAME,chrome.exe),(DOMAIN-SUFFIX,github.com)),air-{node_id}"),
            "AND,((PROCESS-NAME,chrome.exe),(IP-CIDR,10.0.0.1/32,no-resolve)),DIRECT".into(),
            "PROCESS-NAME,chrome.exe,GLOBAL".into(),
            "MATCH,GLOBAL".into(),
        ]
    );
    assert!(config.detach_nodes(&HashSet::from([node_id])));
    assert!(matches!(config.rules[0].target, Target::Reject));
}

#[test]
fn composite_host_rule_requires_process_matcher_and_complete_host() {
    let bad_domain_with_host = Rule {
        host_matcher: Some(HostMatcher::Domain),
        host_value: Some("a.com".into()),
        ..rule(Matcher::Domain, "b.com", Target::Direct)
    };
    let bad_half_host = Rule {
        host_matcher: Some(HostMatcher::Domain),
        host_value: None,
        ..rule(Matcher::ProcessName, "chrome.exe", Target::Direct)
    };
    for bad in [bad_domain_with_host, bad_half_host] {
        let cfg = RoutingConfig {
            rules: vec![bad],
            ..RoutingConfig::default()
        };
        assert!(cfg.compile(&[]).is_err());
    }
}
