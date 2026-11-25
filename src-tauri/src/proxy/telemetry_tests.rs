use super::*;

#[test]
fn only_unseen_closures_and_icons_cross_the_bridge() {
    let logs: Vec<_> = (0..500)
        .map(|i| {
            Arc::new(ConnectionView {
                id: format!("00000000-0000-0000-0000-{i:012}"),
                closed: i > 0,
                closed_revision: if i == 0 {
                    0
                } else if i == 1 {
                    10
                } else {
                    9
                },
                app: "Example".into(),
                app_executable: Some("example.exe".into()),
                app_icon_key: Some(format!("icon-{}", i % 10)),
                host: Some("example.test".into()),
                destination_ip: None,
                network: Some("tcp".into()),
                process_name: Some("example.exe".into()),
                process_path: None,
                start: "2026-01-01T00:00:00Z".into(),
                target: "example.test:443".into(),
                rule: "DomainSuffix · example.test".into(),
                path: vec!["DIRECT".into()],
                upload_bytes: 100,
                download_bytes: 200,
            })
        })
        .collect();
    let icons: HashMap<_, _> = (0..10)
        .map(|i| (format!("icon-{i}"), Arc::from("A".repeat(3000))))
        .collect();
    let mut cursor = TelemetryCursor {
        session_id: "s".into(),
        revision: 9,
        known_icons: icons
            .keys()
            .filter(|key| key.as_str() != "icon-1")
            .cloned()
            .collect(),
    };
    let full = TelemetrySnapshot {
        session_id: "s".into(),
        revision: 10,
        log_order: None,
        sampled_at: 100,
        connections: vec![logs[0].clone()],
        connection_logs: logs,
        app_icons: icons,
        memory_bytes: None,
        stale: false,
        traffic: Default::default(),
    };
    let mut delta = full.clone();
    delta.make_incremental(&cursor);
    assert_eq!(delta.log_order.as_ref().unwrap().len(), 500);
    assert_eq!(delta.connections[0].id, full.connections[0].id);
    assert_eq!(delta.connection_logs.len(), 1);
    assert_eq!(delta.connection_logs[0].id, full.connection_logs[1].id);
    assert_eq!(delta.app_icons.len(), 1);
    assert!(delta.app_icons.contains_key("icon-1"));
    let before = serde_json::to_vec(&full).unwrap().len();
    let after = serde_json::to_vec(&delta).unwrap().len();
    assert!(after < before / 4);
    println!("Synthetic 500-row telemetry: full {before} bytes, incremental {after} bytes");
    for (session, revision) in [("s", 11), ("new-session", 10)] {
        cursor.session_id = session.into();
        cursor.revision = revision;
        let mut reset = full.clone();
        reset.make_incremental(&cursor);
        assert_eq!(reset.connection_logs.len(), 499);
        assert_eq!(reset.app_icons.len(), 10);
    }
}
