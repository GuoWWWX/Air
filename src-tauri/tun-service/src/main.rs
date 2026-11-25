#![windows_subsystem = "windows"]

fn main() {
    #[cfg(windows)]
    if let Some(result) = air::proxy::tun_service::handle_command() {
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
