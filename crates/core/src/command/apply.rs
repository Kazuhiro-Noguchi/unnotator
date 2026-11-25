//! 適用の入口。1 回の適用は 1 トランザクションで、行の変更を `Recorder` に記録する。

use super::{Command, annotation, attribute_schema, group, label, relation, status};
use crate::error::StoreError;
use crate::history::recorder::Recorder;
use crate::id::IdGenerator;

/// ハンドラが共通で使う文脈。
pub struct Ctx<'a> {
    pub rec: Recorder<'a>,
    pub now: i64,
    ids: &'a mut dyn IdGenerator,
}

impl<'a> Ctx<'a> {
    pub fn new(rec: Recorder<'a>, now: i64, ids: &'a mut dyn IdGenerator) -> Self {
        Self { rec, now, ids }
    }

    /// 呼び出し側が ID を決めていればそれを、無ければ新しく生成する。
    pub fn id_or_new(&mut self, given: Option<&String>) -> Result<String, StoreError> {
        match given {
            Some(id) if id.is_empty() => Err(StoreError::InvalidCommand("id が空".to_owned())),
            Some(id) => Ok(id.clone()),
            None => self.ids.next_id(self.rec.conn(), self.now),
        }
    }

    pub fn new_id(&mut self) -> Result<String, StoreError> {
        self.ids.next_id(self.rec.conn(), self.now)
    }

    pub fn into_recorder(self) -> Recorder<'a> {
        self.rec
    }
}

/// コマンドを適用する（トランザクションの開始・確定は呼び出し側）。
pub fn run(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::Transaction { commands } => {
            for inner in commands {
                if matches!(inner, Command::Transaction { .. }) {
                    return Err(StoreError::InvalidCommand(
                        "transaction は入れ子にできない".to_owned(),
                    ));
                }
                run(ctx, inner)?;
            }
            Ok(())
        }
        Command::CreateAnnotation { .. }
        | Command::UpdateAnnotation { .. }
        | Command::DeleteAnnotation { .. } => annotation::handle(ctx, command),
        Command::CreateRelation { .. }
        | Command::UpdateRelation { .. }
        | Command::DeleteRelation { .. } => relation::handle(ctx, command),
        Command::CreateGroup { .. }
        | Command::UpdateGroup { .. }
        | Command::DeleteGroup { .. }
        | Command::AddGroupMembers { .. }
        | Command::RemoveGroupMembers { .. }
        | Command::MoveGroupMember { .. } => group::handle(ctx, command),
        Command::CreateLabel { .. } | Command::UpdateLabel { .. } | Command::DeleteLabel { .. } => {
            label::handle(ctx, command)
        }
        Command::SetAttributeSchema { .. } | Command::DeleteAttributeSchema { .. } => {
            attribute_schema::handle(ctx, command)
        }
        Command::SetAssetStatus { .. } | Command::SetItemStatus { .. } => {
            status::handle(ctx, command)
        }
    }
}
