#![cfg(windows)]

use air::proxy::Runtime;

#[tokio::test]
async fn stopped_proxy_accepts_independent_mode_changes_without_starting() {
    let directory = tempfile::tempdir().unwrap();
    let mut runtime = Runtime::new(directory.path().to_owned());

    for (system_proxy, tun) in [(true, false), (true, true), (false, true), (false, false)] {
        runtime.set_system_proxy(system_proxy).unwrap();
        runtime.set_tun(tun).await.unwrap();
        let status = runtime.status().await.unwrap();
        assert!(!status.running);
        assert_eq!((status.system_proxy, status.tun), (system_proxy, tun));
        let reported = serde_json::to_value(status).unwrap();
        assert!(reported["port"].is_null() && reported["sessionId"].is_null());
        assert_eq!(directory.path().read_dir().unwrap().count(), 0);
    }
}

