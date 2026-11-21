use image::{imageops::FilterType, ImageFormat};
use tauri::{menu::Menu, Wry};

pub(super) struct MenuIcons {
    menu: Menu<Wry>,
    #[cfg(windows)]
    bitmaps: std::collections::BTreeMap<u32, native::Bitmap>,
}

impl MenuIcons {
    pub(super) fn new(menu: Menu<Wry>) -> Self {
        Self {
            menu,
            #[cfg(windows)]
            bitmaps: Default::default(),
        }
    }

    pub(super) fn apply(
        &mut self,
        size: u32,
        running: bool,
        power_only: bool,
    ) -> tauri::Result<()> {
        #[cfg(windows)]
        let popup = tauri::menu::ContextMenu::hpopupmenu(&self.menu)?;
        for (_position, item) in self.menu.items()?.iter().enumerate() {
            let id = item.id().as_ref();
            if power_only && id != "tray-power" {
                continue;
            }
            let png: &[u8] = match id {
                "tray-show" => include_bytes!("../../icons/tray/window.png"),
                "tray-power" if running => include_bytes!("../../icons/tray/stop.png"),
                "tray-power" => include_bytes!("../../icons/tray/play.png"),
                "tray-route-heading" => include_bytes!("../../icons/tray/route.png"),
                "tray-network-heading" => include_bytes!("../../icons/tray/network.png"),
                "tray-exit" => include_bytes!("../../icons/tray/exit.png"),
                _ => continue,
            };
            let image = image::load_from_memory_with_format(png, ImageFormat::Png)
                .map_err(std::io::Error::other)?
                .resize_exact(size, size, FilterType::Lanczos3)
                .into_rgba8();
            #[cfg(windows)]
            {
                // Muda renders IconMenuItem into a fixed 16-pixel bitmap on Windows.
                let bitmap = native::Bitmap::new(image)?;
                bitmap.attach(popup, _position as u32)?;
                self.bitmaps.insert(_position as u32, bitmap);
            }
            #[cfg(not(windows))]
            if let Some(item) = item.as_icon_menuitem() {
                item.set_icon(Some(tauri::image::Image::new_owned(
                    image.into_raw(),
                    size,
                    size,
                )))?;
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
mod native {
    use std::{io, mem::size_of, ptr};
    use windows_sys::Win32::{
        Graphics::Gdi::{
            CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        },
        UI::WindowsAndMessaging::{SetMenuItemInfoW, MENUITEMINFOW, MIIM_BITMAP},
    };

    // Windows borrows hbmpItem. Keep the bitmap alive until replaced or the menu is dropped.
    pub(super) struct Bitmap(isize);

    impl Bitmap {
        pub(super) fn new(mut pixels: image::RgbaImage) -> io::Result<Self> {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: pixels.width() as i32,
                    biHeight: -(pixels.height() as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = ptr::null_mut();
            let handle = unsafe {
                CreateDIBSection(
                    ptr::null_mut(),
                    &info,
                    DIB_RGB_COLORS,
                    &mut bits,
                    ptr::null_mut(),
                    0,
                )
            };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            for pixel in pixels.pixels_mut() {
                let [r, g, b, a] = pixel.0;
                let premultiply = |c: u8| ((u16::from(c) * u16::from(a) + 127) / 255) as u8;
                pixel.0 = [premultiply(b), premultiply(g), premultiply(r), a];
            }
            unsafe { ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast(), pixels.len()) };
            Ok(Self(handle as isize))
        }

        pub(super) fn attach(&self, popup: isize, position: u32) -> io::Result<()> {
            let info = MENUITEMINFOW {
                cbSize: size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_BITMAP,
                hbmpItem: self.0 as _,
                ..Default::default()
            };
            if unsafe { SetMenuItemInfoW(popup as _, position, 1, &info) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Bitmap {
        fn drop(&mut self) {
            unsafe { DeleteObject(self.0 as _) };
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows_sys::Win32::{
            Graphics::Gdi::{GetObjectW, BITMAP},
            UI::WindowsAndMessaging::{
                AppendMenuW, CreatePopupMenu, DestroyMenu, GetMenuItemInfoW, MF_STRING,
            },
        };

        #[test]
        fn popup_keeps_the_requested_bitmap_size_after_replacement() {
            unsafe {
                let menu = CreatePopupMenu();
                assert!(!menu.is_null());
                assert_ne!(
                    AppendMenuW(menu, MF_STRING, 1, windows_sys::core::w!("Air")),
                    0
                );
                let mut installed = None;
                for size in [16, 28, 32] {
                    let icon = Bitmap::new(image::RgbaImage::new(size, size)).unwrap();
                    icon.attach(menu as isize, 0).unwrap();
                    installed.replace(icon);
                    let mut item = MENUITEMINFOW {
                        cbSize: size_of::<MENUITEMINFOW>() as u32,
                        fMask: MIIM_BITMAP,
                        ..Default::default()
                    };
                    assert_ne!(GetMenuItemInfoW(menu, 0, 1, &mut item), 0);
                    let mut bitmap = BITMAP::default();
                    assert_ne!(
                        GetObjectW(
                            item.hbmpItem,
                            size_of::<BITMAP>() as i32,
                            (&mut bitmap as *mut BITMAP).cast()
                        ),
                        0
                    );
                    assert_eq!(
                        (bitmap.bmWidth, bitmap.bmHeight),
                        (size as i32, size as i32)
                    );
                }
                DestroyMenu(menu);
            }
        }
    }
}
