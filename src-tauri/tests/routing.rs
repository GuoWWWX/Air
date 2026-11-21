use air::{
    routing::{Matcher, RoutingConfig, RoutingFile, Rule, Target},
    subscriptions::parse,
};

#[test]
fn deleting_the_routing_source_detaches_inheritance_and_rejects_only_its_outbounds() {
    let linked = Target::Group { source_id: "deleted".into(), name: "Old group".into() };
    let mut config = RoutingConfig {
        subscription_id: Some("deleted".into()),
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
        ["DOMAIN,example.com,REJECT", "DOMAIN,local.test,DIRECT", "MATCH,REJECT"]
    );
}
use std::fs;

fn rule(matcher: Matcher, value: &str, target: Target) -> Rule {
    Rule {
        enabled: true,
        matcher,
        value: value.into(),
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
        subscription_id: Some("s".into()),
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
