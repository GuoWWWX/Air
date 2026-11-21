use super::{encode_png, ICON_SIZE};
use image::{imageops::FilterType, ImageFormat, ImageReader};
use serde::Deserialize;
use std::{
    fs::File,
    io::{BufReader, Cursor, Read},
    path::{Component, Path},
};

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct Package {
    properties: Properties,
    applications: Applications,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct Properties {
    logo: String,
}

#[derive(Default, Deserialize)]
struct Applications {
    #[serde(default, rename = "Application")]
    entries: Vec<App>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct App {
    #[serde(rename = "@Executable")]
    executable: String,
    #[serde(rename = "VisualElements")]
    visuals: Visuals,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Visuals {
    #[serde(rename = "@Square44x44Logo")]
    logo: String,
}

pub(super) fn read(executable: &Path) -> Option<String> {
    let root = executable.ancestors().find(|path| {
        path.parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name.eq_ignore_ascii_case("WindowsApps"))
    })?;
    let file = File::open(root.join("AppxManifest.xml")).ok()?;
    let package: Package =
        quick_xml::de::from_reader(BufReader::new(file.take(1024 * 1024))).ok()?;
    let relative = executable
        .strip_prefix(root)
        .ok()?
        .to_str()?
        .replace('/', "\\");
    let app = package.applications.entries.iter().find(|entry| {
        entry
            .executable
            .replace('/', "\\")
            .eq_ignore_ascii_case(&relative)
    });
    app.and_then(|entry| load_asset(root, &entry.visuals.logo))
        .or_else(|| load_asset(root, &package.properties.logo))
}

fn load_asset(root: &Path, declared: &str) -> Option<String> {
    let relative = Path::new(declared);
    if !relative
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
        || !relative.extension()?.eq_ignore_ascii_case("png")
    {
        return None;
    }
    let stem = relative.file_stem()?.to_str()?;
    let directory = root.join(relative.parent()?);
    // MSIX commonly ships only qualified files for the unqualified name in the manifest.
    for suffix in [
        ".targetsize-32_altform-unplated",
        ".targetsize-32",
        "",
        ".scale-100",
        ".scale-200",
        ".targetsize-48_altform-unplated",
        ".targetsize-48",
        ".scale-150",
        ".scale-400",
    ] {
        let path = directory.join(format!("{stem}{suffix}.png"));
        let Ok(file) = File::open(path) else { continue };
        let mut bytes = Vec::new();
        const LIMIT: u64 = 4 * 1024 * 1024;
        if file.take(LIMIT + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > LIMIT {
            continue;
        }
        let reader = ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Png);
        if !matches!(reader.into_dimensions(), Ok((1..=1024, 1..=1024))) {
            continue;
        }
        let Ok(image) = image::load_from_memory_with_format(&bytes, ImageFormat::Png) else {
            continue;
        };
        let image = image
            .resize(ICON_SIZE as u32, ICON_SIZE as u32, FilterType::Triangle)
            .to_rgba8();
        if image.pixels().any(|pixel| pixel[3] > 0) {
            return encode_png(image.as_raw(), image.width(), image.height());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn resolves_the_matching_packaged_app_and_its_qualified_logo() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("WindowsApps").join("TestPackage");
        let assets = root.join("Assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(root.join("AppxManifest.xml"), r#"<Package xmlns:uap="urn:test"><Properties><Logo>Assets/Store.png</Logo></Properties><Applications>
            <Application Executable="Other.exe"><uap:VisualElements Square44x44Logo="Assets/Other.png"/></Application>
            <Application Executable="bin/App.exe"><uap:VisualElements Square44x44Logo="Assets/App.png"/></Application>
            </Applications></Package>"#).unwrap();
        for (name, color) in [
            ("App.targetsize-32_altform-unplated", 123u8),
            ("Store", 99),
            ("Other", 27),
        ] {
            image::RgbaImage::from_pixel(48, 48, image::Rgba([color, 0, 0, 255]))
                .save(assets.join(format!("{name}.png")))
                .unwrap();
        }
        for (path, color) in [(r"bin\app.exe", 123), ("Other.exe", 27), ("helper.exe", 99)] {
            let icon = read(&root.join(path)).unwrap();
            let bytes = STANDARD
                .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
                .unwrap();
            let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
            assert_eq!(image.dimensions(), (32, 32));
            assert_eq!(image.get_pixel(0, 0)[0], color);
        }
        assert!(load_asset(&root, r"..\foreign.png").is_none());
    }
}
