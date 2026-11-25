//! 再接続の候補（research.md R5）。リンク切れのアセットと、同じファイル名・同じサイズの手つかずのアセット。
//! 自動では結ばない。利用者が選んで `RelinkAsset` を適用する。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::command::asset::PRISTINE_SQL;
use crate::error::StoreError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RelinkCandidate {
    pub missing_asset_id: String,
    /// 新しい場所に、いまあるアセット。受け入れると取り除かれる。
    pub found_asset_id: String,
    pub root_key: String,
    pub rel_path: String,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub file_size: i64,
}

/// `asset_id`（リンク切れ）の候補。リンク切れでなければ `InvalidCommand`。
pub fn candidates(conn: &Connection, asset_id: &str) -> Result<Vec<RelinkCandidate>, StoreError> {
    let row = conn.query_row(
        "SELECT rel_path, file_size, missing FROM assets WHERE id = ?1",
        [asset_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    );
    let (rel_path, file_size, missing) = match row {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return Err(StoreError::NotFound(format!("アセット {asset_id}")));
        }
        Err(error) => return Err(error.into()),
    };
    if missing != 1 {
        return Err(StoreError::InvalidCommand(
            "リンク切れのアセットではない".to_owned(),
        ));
    }
    let name = rel_path.rsplit('/').next().unwrap_or(&rel_path).to_owned();
    let mut stmt = conn.prepare(&format!(
        "SELECT id, root_key, rel_path FROM assets \
         WHERE id <> ?1 AND missing = 0 AND file_size = ?2 \
           AND (rel_path = ?3 OR substr(rel_path, -(length(?3) + 1)) = '/' || ?3) \
           AND {PRISTINE_SQL} \
         ORDER BY root_key, rel_path"
    ))?;
    let rows = stmt
        .query_map(rusqlite::params![asset_id, file_size, name], |r| {
            Ok(RelinkCandidate {
                missing_asset_id: asset_id.to_owned(),
                found_asset_id: r.get(0)?,
                root_key: r.get(1)?,
                rel_path: r.get(2)?,
                file_size,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
