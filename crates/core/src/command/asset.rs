//! アセットのコマンド。走査・見張りの反映（`SyncAssets`。Undo に積まない）。
//!
//! 媒体に関係しない（憲章 I）。書く列は `data-model.md` の「書く列」の表のとおり。

use serde::{Deserialize, Serialize};

use super::Command;
use super::apply::Ctx;
use super::rows::{RowBuilder, boolean, int, mismatch, opt_text, query_optional, text};
use crate::assets::path::normalize_rel;
use crate::db::tables::ASSETS;
use crate::error::StoreError;

/// サイズと更新時刻。走査が写しを取った時点の値と、いまの行を比べて、食い違うものを飛ばすために使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetStamp {
    /// 2^53 未満なので、TS の `number` で欠けない。
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub file_size: i64,
    #[cfg_attr(feature = "specta", specta(type = f64))]
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NewAsset {
    /// 呼び出し側が ID を決めるとき。省略するとコアが生成する。
    #[serde(default)]
    pub id: Option<String>,
    pub root_key: String,
    pub rel_path: String,
    #[serde(default)]
    pub media_type: Option<String>,
    pub stamp: AssetStamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetUpdate {
    pub asset_id: String,
    /// 走査が見た、更新前の値。いまの行と違えば飛ばす。
    pub base: AssetStamp,
    pub now: AssetStamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetMiss {
    pub asset_id: String,
    pub base: AssetStamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetReclass {
    pub asset_id: String,
    pub media_type: Option<String>,
}

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::SyncAssets {
            added,
            updated,
            went_missing,
            restored,
            reclassified,
        } => sync(ctx, added, updated, went_missing, restored, reclassified),
        _ => Err(mismatch()),
    }
}

struct Current {
    file_size: i64,
    mtime_ms: i64,
    missing: bool,
}

fn current(ctx: &Ctx<'_>, id: &str) -> Result<Option<Current>, StoreError> {
    let row = ctx.rec.conn().query_row(
        "SELECT file_size, mtime_ms, missing FROM assets WHERE id = ?1",
        [id],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    );
    match row {
        Ok((file_size, mtime_ms, missing)) => Ok(Some(Current {
            file_size,
            mtime_ms,
            missing: missing == 1,
        })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn matches(current: &Current, base: &AssetStamp) -> bool {
    current.file_size == base.file_size && current.mtime_ms == base.mtime_ms
}

fn sync(
    ctx: &mut Ctx<'_>,
    added: &[NewAsset],
    updated: &[AssetUpdate],
    went_missing: &[AssetMiss],
    restored: &[AssetUpdate],
    reclassified: &[AssetReclass],
) -> Result<(), StoreError> {
    // 先に、追加するパスの形を確かめる（途中で失敗しても全体が戻る）
    let mut paths = Vec::with_capacity(added.len());
    for asset in added {
        let rel = normalize_rel(&asset.rel_path)
            .map_err(|error| StoreError::InvalidCommand(error.to_string()))?;
        paths.push(rel);
    }
    let now = ctx.now;

    for (asset, rel) in added.iter().zip(paths) {
        let exists: Option<i64> = query_optional(
            ctx.rec.conn(),
            "SELECT 1 FROM assets WHERE root_key = ?1 AND rel_path = ?2",
            [asset.root_key.as_str(), rel.as_str()],
        )?;
        if exists.is_some() {
            ctx.skipped += 1;
            continue;
        }
        let id = ctx.id_or_new(asset.id.as_ref())?;
        ctx.rec.insert(
            "assets",
            RowBuilder::new(&ASSETS)
                .set("id", text(&id))
                .set("root_key", text(&asset.root_key))
                .set("rel_path", text(&rel))
                .set("media_type", opt_text(asset.media_type.as_deref()))
                .set("file_size", int(asset.stamp.file_size))
                .set("mtime_ms", int(asset.stamp.mtime_ms))
                .set("status", text("todo"))
                .set("missing", boolean(false))
                .set("metadata_json", text("{}"))
                .set("attributes_json", text("{}"))
                .set("created_at", int(now))
                .set("updated_at", int(now))
                .build(),
        )?;
    }

    for update in updated {
        match current(ctx, &update.asset_id)? {
            Some(row) if !row.missing && matches(&row, &update.base) => {
                ctx.rec.update_columns(
                    "assets",
                    &[text(&update.asset_id)],
                    &[
                        ("file_size", int(update.now.file_size)),
                        ("mtime_ms", int(update.now.mtime_ms)),
                        ("updated_at", int(now)),
                    ],
                )?;
            }
            _ => ctx.skipped += 1,
        }
    }

    for miss in went_missing {
        match current(ctx, &miss.asset_id)? {
            Some(row) if !row.missing && matches(&row, &miss.base) => {
                ctx.rec.update_columns(
                    "assets",
                    &[text(&miss.asset_id)],
                    &[("missing", boolean(true)), ("updated_at", int(now))],
                )?;
            }
            _ => ctx.skipped += 1,
        }
    }

    for restore in restored {
        match current(ctx, &restore.asset_id)? {
            Some(row) if row.missing && matches(&row, &restore.base) => {
                ctx.rec.update_columns(
                    "assets",
                    &[text(&restore.asset_id)],
                    &[
                        ("missing", boolean(false)),
                        ("file_size", int(restore.now.file_size)),
                        ("mtime_ms", int(restore.now.mtime_ms)),
                        ("updated_at", int(now)),
                    ],
                )?;
            }
            _ => ctx.skipped += 1,
        }
    }

    for reclass in reclassified {
        let same: Option<i64> = query_optional(
            ctx.rec.conn(),
            "SELECT 1 FROM assets WHERE id = ?1 AND media_type IS ?2",
            rusqlite::params![reclass.asset_id, reclass.media_type],
        )?;
        let exists: Option<i64> = query_optional(
            ctx.rec.conn(),
            "SELECT 1 FROM assets WHERE id = ?1",
            [reclass.asset_id.as_str()],
        )?;
        if exists.is_none() {
            ctx.skipped += 1;
        } else if same.is_none() {
            ctx.rec.update_columns(
                "assets",
                &[text(&reclass.asset_id)],
                &[
                    ("media_type", opt_text(reclass.media_type.as_deref())),
                    ("updated_at", int(now)),
                ],
            )?;
        }
    }
    Ok(())
}
