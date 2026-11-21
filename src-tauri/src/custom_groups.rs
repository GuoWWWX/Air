use crate::AirResult;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const FILE_NAME: &str = "custom-groups.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGroup {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub members: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGroupInput {
    pub id: Option<String>,
    pub name: String,
    pub parent_id: Option<String>,
    pub members: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberAction {
    Add,
    Remove,
}

pub fn load(directory: &Path) -> AirResult<Vec<CustomGroup>> {
    let path = file_path(directory);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("无法读取自定义分组配置".into()),
    };
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents).map_err(|_| "自定义分组配置格式无效".into())
}

pub fn save(directory: &Path, input: CustomGroupInput) -> AirResult<CustomGroup> {
    let name = input.name.trim().to_owned();
    if name.is_empty() {
        return Err("请输入自定义分组名称".into());
    }

    let _lock = lock(directory)?;
    let mut groups = load(directory)?;
    let existing_id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);

    if groups
        .iter()
        .any(|group| Some(&group.id) != existing_id.as_ref() && group.name == name)
    {
        return Err("已存在同名的自定义分组".into());
    }

    let saved = if let Some(id) = existing_id {
        let Some(target) = groups.iter_mut().find(|group| group.id == id) else {
            return Err("自定义分组已不存在".into());
        };
        target.name = name;
        if let Some(members) = input.members {
            target.members = dedup_members(members);
        }
        target.clone()
    } else {
        if input
            .parent_id
            .as_ref()
            .is_some_and(|id| !groups.iter().any(|group| &group.id == id))
        {
            return Err("上级分组已不存在".into());
        }
        let created = CustomGroup {
            id: format!("cg-{}", Uuid::new_v4().simple()),
            name,
            parent_id: input.parent_id,
            members: dedup_members(input.members.unwrap_or_default()),
        };
        groups.push(created.clone());
        created
    };

    write(directory, &groups)?;
    Ok(saved)
}

pub fn change_members(
    directory: &Path,
    id: &str,
    action: MemberAction,
    ids: Vec<String>,
) -> AirResult<()> {
    let _lock = lock(directory)?;
    let mut groups = load(directory)?;
    let group = groups
        .iter_mut()
        .find(|group| group.id == id)
        .ok_or("自定义分组已不存在")?;
    match action {
        MemberAction::Add => {
            group.members.extend(ids);
            group.members = dedup_members(std::mem::take(&mut group.members));
        }
        MemberAction::Remove => {
            let ids: HashSet<_> = ids.into_iter().collect();
            group.members.retain(|id| !ids.contains(id));
        }
    }
    write(directory, &groups)
}

pub fn delete(directory: &Path, id: &str) -> AirResult<()> {
    let _lock = lock(directory)?;
    let mut groups = load(directory)?;
    let index = groups
        .iter()
        .position(|group| group.id == id)
        .ok_or("自定义分组已不存在")?;
    let removed = groups.remove(index);
    for group in &mut groups {
        if group.parent_id.as_deref() == Some(id) {
            group.parent_id.clone_from(&removed.parent_id);
        }
    }
    write(directory, &groups)
}

fn lock(directory: &Path) -> AirResult<File> {
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("custom-groups.lock"))
        .map_err(|_| "无法打开自定义分组写入锁")?;
    file.lock().map_err(|_| "无法锁定自定义分组配置")?;
    Ok(file)
}

fn file_path(directory: &Path) -> PathBuf {
    directory.join(FILE_NAME)
}

fn dedup_members(members: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::with_capacity(members.len());
    for id in members {
        if !id.is_empty() && seen.insert(id.clone()) {
            result.push(id);
        }
    }
    result
}

fn write(directory: &Path, groups: &[CustomGroup]) -> AirResult<()> {
    use std::io::Write;
    let payload = serde_json::to_string_pretty(groups).map_err(|_| "无法序列化自定义分组")?;
    let mut temp =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| "无法写入自定义分组配置")?;
    temp.write_all(payload.as_bytes())
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "无法写入自定义分组配置")?;
    temp.persist(file_path(directory))
        .map_err(|_| "无法保存自定义分组配置".into())
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_membership_changes_and_rename_preserve_each_update() {
        let directory = tempfile::tempdir().unwrap();
        let group = save(
            directory.path(),
            CustomGroupInput {
                id: None,
                name: "Before".into(),
                parent_id: None,
                members: Some(vec!["remove".into()]),
            },
        )
        .unwrap();

        std::thread::scope(|scope| {
            let path = directory.path();
            let id = group.id.as_str();
            scope.spawn(move || {
                change_members(path, id, MemberAction::Add, vec!["first".into()]).unwrap()
            });
            scope.spawn(move || {
                change_members(path, id, MemberAction::Add, vec!["second".into()]).unwrap()
            });
            scope.spawn(move || {
                change_members(path, id, MemberAction::Remove, vec!["remove".into()]).unwrap()
            });
            scope.spawn(move || {
                save(
                    path,
                    CustomGroupInput {
                        id: Some(id.into()),
                        name: "After".into(),
                        parent_id: None,
                        members: None,
                    },
                )
                .unwrap()
            });
        });

        let mut groups = load(directory.path()).unwrap();
        let saved = groups.first_mut().unwrap();
        saved.members.sort();
        assert_eq!(saved.name, "After");
        assert_eq!(saved.members, ["first", "second"]);
    }

    #[test]
    fn legacy_groups_support_children_and_deleting_a_parent_keeps_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        fs::write(
            file_path(path),
            r#"[{"id":"legacy","name":"Existing","members":["first"]}]"#,
        )
        .unwrap();
        assert!(load(path).unwrap()[0].parent_id.is_none());

        let create = |name: &str, parent_id: &str| {
            save(
                path,
                CustomGroupInput {
                    id: None,
                    name: name.into(),
                    parent_id: Some(parent_id.into()),
                    members: Some(vec!["first".into(), "second".into(), "first".into()]),
                },
            )
        };
        assert!(create("Missing", "unknown").is_err());
        let child = create("Child", "legacy").unwrap();
        let grandchild = create("Grandchild", &child.id).unwrap();
        assert_eq!(child.members, ["first", "second"]);
        delete(path, &child.id).unwrap();
        let groups = load(path).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[1].id, grandchild.id);
        assert_eq!(groups[1].parent_id.as_deref(), Some("legacy"));
        assert_eq!(groups[1].members, grandchild.members);
        delete(path, "legacy").unwrap();
        assert!(load(path).unwrap()[0].parent_id.is_none());
    }
}
