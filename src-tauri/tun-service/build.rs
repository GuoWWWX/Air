fn main() {
    #[cfg(target_os = "windows")]
    {
        let mut res = tauri_winres::WindowsResource::new();
        res.set_language(0x0409)
            .set("FileDescription", "Air TUN Service")
            .set("ProductName", "Air TUN Service")
            .set("OriginalFilename", "air-tun-service.exe")
            .set("InternalName", "air-tun-service");
        // Omit icon intentionally so Task Manager does not show a duplicate
        // Air Proxy paper-plane logo group for the Session 0 TUN service.
        res.compile()
            .expect("compile Windows resources for air-tun-service");
    }
}
