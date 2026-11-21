use super::{loopback, Application, Applications};
mod package_logo;
use crate::mihomo::ConnectionsSnapshot;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    hash::{Hash, Hasher},
    mem::size_of,
    net::{Ipv4Addr, SocketAddrV4},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    ptr::{null_mut, NonNull},
    slice,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::ERROR_INSUFFICIENT_BUFFER,
    Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GdiFlush, SelectObject,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
    },
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_CONNECTIONS,
    },
    Networking::WinSock::AF_INET,
    Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::{
        Shell::{ExtractIconExW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON},
        WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
    },
};

const ICON_SIZE: usize = 32;
const PIXEL_BYTES: usize = ICON_SIZE * ICON_SIZE * 4;
const CACHE_LIMIT: usize = 256;

struct Executable {
    name: String,
    file: String,
    icon_key: String,
    icon: Option<String>,
    checked: Instant,
    accessed: Instant,
}

static CACHE: LazyLock<Mutex<HashMap<String, Executable>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn sample(
    snapshot: &ConnectionsSnapshot,
    clients: Option<loopback::ClientMap>,
    mixed_port: u16,
) -> Applications {
    let mut applications = Applications::default();
    let forwarded = clients.and_then(|clients| clients.lock().ok().map(|map| map.clone()));
    let mut owners = HashMap::new();
    let mut owner_paths = HashMap::new();
    let Ok(mut cache) = CACHE.lock() else {
        return applications;
    };
    for connection in snapshot.connections.iter().flatten() {
        let metadata = &connection.metadata;
        if metadata.internal() {
            continue;
        }
        // The compatibility listener can hide the real source behind Air's own TCP socket.
        let peer = metadata.local_proxy_peer(mixed_port);
        let original = peer.and_then(|peer| forwarded.as_ref()?.get(&peer).copied());
        let reported = metadata
            .reported_process_paths()
            .into_iter()
            .find_map(local_executable);
        let path = if original.is_none() && reported.is_some() {
            reported
        } else {
            let Some((peer, port)) = original
                .map(|p| (p, loopback::PREFERRED_PORT))
                .or_else(|| peer.map(|p| (p, mixed_port)))
            else {
                continue;
            };
            let table = owners.entry(port).or_insert_with(|| tcp_owners(port));
            table.get(&peer).and_then(|pid| {
                owner_paths
                    .entry(*pid)
                    .or_insert_with(|| process_path(*pid))
                    .as_deref()
                    .and_then(local_executable)
            })
        };

        let Some(path) = path else {
            if original.is_some() {
                applications.entries.insert(
                    connection.id.clone(),
                    Application {
                        name: "未知应用".into(),
                        executable: None,
                        icon_key: None,
                    },
                );
            }
            continue;
        };
        let key = path.to_string_lossy().to_lowercase();
        if cache.len() >= CACHE_LIMIT && !cache.contains_key(&key) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, item)| item.accessed)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        let executable = cache
            .entry(key.clone())
            .or_insert_with(|| Executable::read(path, &key));
        if executable.icon.is_none() && executable.checked.elapsed() >= Duration::from_secs(60) {
            *executable = Executable::read(path, &key);
        }
        executable.accessed = Instant::now();
        let icon_key = executable.icon.as_ref().map(|icon| {
            applications
                .icons
                .entry(executable.icon_key.clone())
                .or_insert_with(|| icon.clone());
            executable.icon_key.clone()
        });
        applications.entries.insert(
            connection.id.clone(),
            Application {
                name: executable.name.clone(),
                executable: (executable.name != executable.file).then(|| executable.file.clone()),
                icon_key,
            },
        );
    }
    applications
}

fn local_executable(value: &str) -> Option<&Path> {
    let path = Path::new(value);
    let Some(Component::Prefix(prefix)) = path.components().next() else {
        return None;
    };
    (path.is_absolute()
        && matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        && path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe")))
    .then_some(path)
}

impl Executable {
    fn read(path: &Path, key: &str) -> Self {
        let wide: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
        let file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let name = file_description(&wide).unwrap_or_else(|| file.clone());
        let mut hasher = DefaultHasher::new();
        key.hash(&mut hasher);
        Self {
            name,
            file,
            icon_key: format!("{:x}", hasher.finish()),
            icon: embedded_icon(&wide)
                .or_else(|| package_logo::read(path))
                .or_else(|| shell_icon(&wide)),
            checked: Instant::now(),
            accessed: Instant::now(),
        }
    }
}

fn file_description(path: &[u16]) -> Option<String> {
    let mut ignored = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut ignored) };
    if size == 0 || size > 1024 * 1024 {
        return None;
    }
    let mut data = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 {
        return None;
    }
    let mut value = null_mut();
    let mut length = 0;
    let field: Vec<_> = r"\VarFileInfo\Translation"
        .encode_utf16()
        .chain([0])
        .collect();
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            field.as_ptr(),
            &mut value,
            &mut length,
        )
    } == 0
        || value.is_null()
        || length < 4
    {
        return None;
    }
    // The translation resource contains pairs of language and code-page WORDs.
    let entries = unsafe { slice::from_raw_parts(value.cast::<u16>(), length as usize / 2) };
    for pair in entries.chunks_exact(2) {
        let field: Vec<_> = format!(
            r"\StringFileInfo\{:04x}{:04x}\FileDescription",
            pair[0], pair[1]
        )
        .encode_utf16()
        .chain([0])
        .collect();
        let mut description = null_mut();
        let mut length = 0;
        if unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                field.as_ptr(),
                &mut description,
                &mut length,
            )
        } != 0
            && !description.is_null()
            && length > 0
        {
            let wide = unsafe { slice::from_raw_parts(description.cast::<u16>(), length as usize) };
            let name = String::from_utf16_lossy(wide)
                .trim_matches(|c: char| c == '\0' || c.is_whitespace())
                .to_owned();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn embedded_icon(path: &[u16]) -> Option<String> {
    let mut icon = null_mut();
    let extracted = unsafe { ExtractIconExW(path.as_ptr(), 0, &mut icon, null_mut(), 1) };
    if extracted != 1 || icon.is_null() {
        return None;
    }
    render_icon(icon)
}

fn shell_icon(path: &[u16]) -> Option<String> {
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    let initialized = unsafe { CoInitializeEx(null_mut(), COINIT_APARTMENTTHREADED as u32) } >= 0;
    let mut info = SHFILEINFOW::default();
    let found = unsafe {
        SHGetFileInfoW(
            path.as_ptr(),
            0,
            &mut info,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON,
        )
    };
    let result = (found != 0 && !info.hIcon.is_null())
        .then(|| render_icon(info.hIcon))
        .flatten();
    if initialized {
        unsafe { CoUninitialize() }
    }
    result
}

fn render_icon(icon: HICON) -> Option<String> {
    let dc = unsafe { CreateCompatibleDC(null_mut()) };
    let pixels = if dc.is_null() {
        None
    } else {
        let result = icon_pixels(dc, icon);
        unsafe { DeleteDC(dc) };
        result
    };
    unsafe { DestroyIcon(icon) };
    let pixels = pixels?;
    if pixels.chunks_exact(4).all(|pixel| pixel[3] == 0) {
        return None;
    }
    encode_png(&pixels, ICON_SIZE as u32, ICON_SIZE as u32)
}

fn encode_png(pixels: &[u8], width: u32, height: u32) -> Option<String> {
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(pixels, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

fn icon_pixels(dc: HDC, icon: HICON) -> Option<Vec<u8>> {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: ICON_SIZE as i32,
            biHeight: -(ICON_SIZE as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = null_mut();
    let bitmap = unsafe { CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0) };
    if bitmap.is_null() {
        return None;
    }
    let previous = unsafe { SelectObject(dc, bitmap) };
    let result = if let Some(bits) = NonNull::new(bits.cast::<u8>()).filter(|_| !previous.is_null())
    {
        // Rendering on both colors preserves alpha for modern icons and masks for older ones.
        let draw = |background: u8| {
            unsafe { bits.as_ptr().write_bytes(background, PIXEL_BYTES) };
            let rendered = unsafe {
                DrawIconEx(
                    dc,
                    0,
                    0,
                    icon,
                    ICON_SIZE as i32,
                    ICON_SIZE as i32,
                    0,
                    null_mut(),
                    DI_NORMAL,
                )
            };
            unsafe { GdiFlush() };
            (rendered != 0)
                .then(|| unsafe { slice::from_raw_parts(bits.as_ptr(), PIXEL_BYTES).to_vec() })
        };
        draw(0).zip(draw(255)).map(|(black, white)| {
            let mut rgba = Vec::with_capacity(PIXEL_BYTES);
            for (black, white) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
                let background = (0..3)
                    .map(|i| u32::from(white[i].saturating_sub(black[i])))
                    .sum::<u32>()
                    / 3;
                let alpha = 255 - background;
                for channel in black[..3].iter().rev() {
                    let color = u32::from(*channel) * 255 / alpha.max(1);
                    rgba.push(color.min(255) as u8);
                }
                rgba.push(alpha as u8);
            }
            rgba
        })
    } else {
        None
    };
    if !previous.is_null() {
        unsafe { SelectObject(dc, previous) };
    }
    unsafe { DeleteObject(bitmap) };
    result
}

fn tcp_owners(port: u16) -> HashMap<SocketAddrV4, u32> {
    let mut buffer = vec![0u32; 4096];
    for _ in 0..3 {
        let mut size = (buffer.len() * size_of::<u32>()) as u32;
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET.into(),
                TCP_TABLE_OWNER_PID_CONNECTIONS,
                0,
            )
        };
        match status {
            ERROR_INSUFFICIENT_BUFFER => {
                buffer.resize((size as usize).div_ceil(size_of::<u32>()), 0)
            }
            0 => {
                let capacity =
                    (buffer.len() - 1) * size_of::<u32>() / size_of::<MIB_TCPROW_OWNER_PID>();
                let count = (buffer[0] as usize).min(capacity);
                let rows = unsafe {
                    slice::from_raw_parts(
                        buffer.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(),
                        count,
                    )
                };
                return rows
                    .iter()
                    .filter(|row| {
                        row.dwOwningPid != 0
                            && Ipv4Addr::from(row.dwRemoteAddr.to_ne_bytes()) == Ipv4Addr::LOCALHOST
                            && u16::from_be(row.dwRemotePort as u16) == port
                    })
                    .map(|row| {
                        (
                            SocketAddrV4::new(
                                Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes()),
                                u16::from_be(row.dwLocalPort as u16),
                            ),
                            row.dwOwningPid,
                        )
                    })
                    .collect();
            }
            _ => break,
        }
    }
    HashMap::new()
}

fn process_path(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut name = vec![0u16; 32768];
    let mut length = name.len() as u32;
    (unsafe {
        QueryFullProcessImageNameW(process.as_raw_handle(), 0, name.as_mut_ptr(), &mut length)
    } != 0)
        .then(|| String::from_utf16_lossy(&name[..length as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::path::PathBuf;

    #[test]
    fn resolves_the_originating_process_of_a_live_socket() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (_server, _) = listener.accept().unwrap();
        let SocketAddr::V4(peer) = client.local_addr().unwrap() else {
            unreachable!()
        };
        let owners = tcp_owners(listener.local_addr().unwrap().port());
        let pid = owners[&peer];
        assert_eq!(pid, std::process::id());
        assert!(local_executable(&process_path(pid).unwrap()).is_some());
        let port = listener.local_addr().unwrap().port();
        let snapshot = serde_json::from_value(serde_json::json!({
            "uploadTotal": 0, "downloadTotal": 0, "connections": [{
                "id": "partial", "upload": 0, "download": 0,
                "metadata": { "network": "tcp", "sourceIP": "127.0.0.1", "sourcePort": peer.port(), "inboundPort": port }
            }]
        })).unwrap();
        let apps = sample(&snapshot, None, port);
        let app = &apps.entries["partial"];
        let image = &apps.icons[app.icon_key.as_ref().unwrap()];
        assert!(image.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn reads_a_real_windows_executables_display_name_and_transparent_icon() {
        let root = std::env::var_os("SystemRoot").expect("Windows system directory");
        let path = PathBuf::from(root).join("explorer.exe");
        let app = Executable::read(&path, path.to_str().unwrap());
        let icon = app.icon.unwrap();
        let data = STANDARD
            .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        let pixels = image::load_from_memory(&data).unwrap().to_rgba8();
        assert_eq!(pixels.dimensions(), (32, 32));
        assert!(pixels.pixels().any(|pixel| pixel[3] == 0));
        assert!(pixels.pixels().any(|pixel| pixel[3] == 255));
        assert_ne!(app.name, app.file);
    }
}
