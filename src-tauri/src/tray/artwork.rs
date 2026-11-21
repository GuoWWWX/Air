use super::TrayStatusIcon;
use std::io::{self, Cursor};
use tauri::image::Image;

#[derive(Clone, Copy, PartialEq)]
pub(super) struct TaskbarAppearance {
    dark: bool,
    pub(super) icon_size: u32,
}

impl Default for TaskbarAppearance {
    fn default() -> Self {
        Self {
            dark: false,
            icon_size: 16,
        }
    }
}

impl TaskbarAppearance {
    #[cfg(windows)]
    pub(super) fn current() -> Self {
        use std::{mem::size_of_val, ptr};
        use windows_sys::{
            core::w,
            Win32::{
                System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
                UI::{
                    HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
                    WindowsAndMessaging::{FindWindowW, SM_CXSMICON},
                },
            },
        };

        // Windows allows the taskbar and application themes to differ.
        let mut light = 1u32;
        let mut length = size_of_val(&light) as u32;
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
                w!("SystemUsesLightTheme"),
                RRF_RT_REG_DWORD,
                ptr::null_mut(),
                (&mut light as *mut u32).cast(),
                &mut length,
            )
        };
        let taskbar = unsafe { FindWindowW(w!("Shell_TrayWnd"), ptr::null()) };
        let dpi = unsafe { GetDpiForWindow(taskbar) }.max(96);
        let icon_size = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
        Self {
            dark: result == 0 && light == 0,
            icon_size: icon_size.max(16) as u32,
        }
    }

    #[cfg(not(windows))]
    pub(super) fn current() -> Self {
        Self::default()
    }

    pub(super) fn image(self, status: TrayStatusIcon) -> tauri::Result<Image<'static>> {
        macro_rules! artwork {
            ($name:literal) => {
                if self.dark {
                    include_bytes!(concat!("../../icons/tray/dark/", $name, ".ico")).as_slice()
                } else {
                    include_bytes!(concat!("../../icons/tray/", $name, ".ico")).as_slice()
                }
            };
        }
        let bytes = match status {
            TrayStatusIcon::Stopped => artwork!("status-stopped"),
            TrayStatusIcon::Running => artwork!("status-running"),
            TrayStatusIcon::SystemProxy => artwork!("status-system-proxy"),
            TrayStatusIcon::Tun => artwork!("status-tun"),
        };
        let icon = ico::IconDir::read(Cursor::new(bytes))?;
        let frame = icon
            .entries()
            .iter()
            .min_by_key(|entry| {
                (
                    entry.width().abs_diff(self.icon_size),
                    entry.width() < self.icon_size,
                )
            })
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "empty Air tray icon"))?;
        Image::from_bytes(frame.data())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskbar_variants_keep_the_state_color_and_native_pixel_size() {
        for size in (16..=80).step_by(4) {
            for (status, color) in [
                (TrayStatusIcon::Stopped, [0x34, 0x3b, 0x44, 255]),
                (TrayStatusIcon::Running, [0x77, 0x87, 0x9a, 255]),
                (TrayStatusIcon::SystemProxy, [0x2f, 0x63, 0xe8, 255]),
                (TrayStatusIcon::Tun, [0x00, 0x8b, 0x78, 255]),
            ] {
                let light = TaskbarAppearance {
                    dark: false,
                    icon_size: size,
                }
                .image(status)
                .unwrap();
                let dark = TaskbarAppearance {
                    dark: true,
                    icon_size: size,
                }
                .image(status)
                .unwrap();
                for image in [&light, &dark] {
                    assert_eq!((image.width(), image.height()), (size, size));
                    assert!(image.rgba().chunks_exact(4).any(|pixel| pixel == color));
                    let covers_column = |x: u32| (0..size).any(|y| {
                        image.rgba()[((y * size + x) * 4 + 3) as usize] >= 96
                    });
                    assert!(covers_column(1) && covers_column(size - 2));
                }
                // The supplied running icon is identical for both taskbar themes.
                assert_eq!(
                    light.rgba() == dark.rgba(),
                    status == TrayStatusIcon::Running
                );
            }
        }
    }
}
