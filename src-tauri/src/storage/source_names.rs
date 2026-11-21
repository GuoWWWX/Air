use rusqlite::{params, Connection, Result};
use std::collections::HashSet;

pub(super) fn display_name(db: &Connection, id: &str, base: &str) -> Result<String> {
    let mut query = db.prepare(
        "SELECT s.id,s.name,COALESCE(a.base_name,s.name) FROM sources s
         LEFT JOIN source_name_aliases a ON a.source_id=s.id",
    )?;
    let mut occupied = HashSet::new();
    let mut current = None;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        let source_id: String = row.get(0)?;
        let name: String = row.get(1)?;
        if source_id != id {
            occupied.insert(name);
        } else if row.get::<_, String>(2)? == base {
            current = Some(name);
        }
    }
    if let Some(name) = current.filter(|name| !occupied.contains(name)) {
        return Ok(name);
    }
    let mut name = base.to_owned();
    let mut suffix = 1;
    while occupied.contains(&name) {
        name = format!("{base} ({suffix})");
        suffix += 1;
    }
    Ok(name)
}

pub(super) fn save_base(db: &Connection, id: &str, base: &str, display: &str) -> Result<()> {
    if base == display {
        db.execute("DELETE FROM source_name_aliases WHERE source_id=?1", [id])?;
    } else {
        db.execute("INSERT OR REPLACE INTO source_name_aliases(source_id,base_name) VALUES (?1,?2)", params![id,base])?;
    }
    Ok(())
}

pub(super) fn repair_duplicates(db: &mut Connection) -> Result<()> {
    let tx = db.transaction()?;
    // Reserve existing unique names, including literal names such as "Family (1)".
    let mut query = tx.prepare(
        "SELECT id,name FROM (SELECT id,name,rowid AS pos,
         ROW_NUMBER() OVER (PARTITION BY name ORDER BY rowid) AS occurrence FROM sources)
         WHERE occurrence>1 ORDER BY pos",
    )?;
    let duplicates = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>>>()?;
    drop(query);
    for (id, base) in duplicates {
        let name = display_name(&tx, &id, &base)?;
        tx.execute("UPDATE sources SET name=?2 WHERE id=?1", params![id,name])?;
        save_base(&tx, &id, &base, &name)?;
    }
    tx.commit()
}
