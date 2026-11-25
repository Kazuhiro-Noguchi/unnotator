//! Undo / Redo の履歴。プロジェクト全体で 1 本、上限 500 操作。

pub mod recorder;

use std::collections::VecDeque;

use recorder::RowOp;
use serde::{Deserialize, Serialize};

/// 履歴の上限（設計書 3.4）。
pub const UNDO_LIMIT: usize = 500;

/// 1 回の適用（transaction を含む）で集まった行の変更。
#[derive(Debug, Clone, PartialEq)]
pub struct UndoEntry {
    pub seq: u32,
    pub ops: Vec<RowOp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_depth: u32,
    pub redo_depth: u32,
}

#[derive(Debug)]
pub struct UndoStack {
    limit: usize,
    undo: VecDeque<UndoEntry>,
    redo: Vec<UndoEntry>,
}

impl UndoStack {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            undo: VecDeque::new(),
            redo: Vec::new(),
        }
    }

    /// 新しい操作を積む。Redo は破棄し、上限を超えたら最も古い操作から捨てる。
    pub fn push(&mut self, entry: UndoEntry) {
        self.redo.clear();
        self.undo.push_back(entry);
        while self.undo.len() > self.limit {
            self.undo.pop_front();
        }
    }

    pub fn undo_top(&self) -> Option<&UndoEntry> {
        self.undo.back()
    }

    pub fn redo_top(&self) -> Option<&UndoEntry> {
        self.redo.last()
    }

    /// `undo_top` の内容を戻し終えたあとに呼ぶ。Redo 側へ移す。
    pub fn commit_undo(&mut self) {
        if let Some(entry) = self.undo.pop_back() {
            self.redo.push(entry);
        }
    }

    /// `redo_top` の内容をやり直し終えたあとに呼ぶ。Undo 側へ戻す。
    pub fn commit_redo(&mut self) {
        if let Some(entry) = self.redo.pop() {
            self.undo.push_back(entry);
        }
    }

    pub fn state(&self) -> UndoState {
        UndoState {
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            undo_depth: u32::try_from(self.undo.len()).unwrap_or(u32::MAX),
            redo_depth: u32::try_from(self.redo.len()).unwrap_or(u32::MAX),
        }
    }
}

impl Default for UndoStack {
    fn default() -> Self {
        Self::new(UNDO_LIMIT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(seq: u32) -> UndoEntry {
        UndoEntry {
            seq,
            ops: Vec::<RowOp>::new(),
        }
    }

    #[test]
    fn undo_then_redo_moves_entries_between_stacks() {
        let mut stack = UndoStack::new(500);
        stack.push(entry(1));
        stack.push(entry(2));
        assert_eq!(stack.state().undo_depth, 2);

        assert_eq!(stack.undo_top().map(|e| e.seq), Some(2));
        stack.commit_undo();
        let state = stack.state();
        assert_eq!((state.undo_depth, state.redo_depth), (1, 1));
        assert!(state.can_undo && state.can_redo);

        assert_eq!(stack.redo_top().map(|e| e.seq), Some(2));
        stack.commit_redo();
        let state = stack.state();
        assert_eq!((state.undo_depth, state.redo_depth), (2, 0));
    }

    #[test]
    fn empty_stack_has_nothing_to_undo_or_redo() {
        let mut stack = UndoStack::new(500);
        assert!(stack.undo_top().is_none());
        assert!(stack.redo_top().is_none());
        stack.commit_undo();
        stack.commit_redo();
        let state = stack.state();
        assert!(!state.can_undo && !state.can_redo);
    }

    #[test]
    fn new_push_discards_redo() {
        let mut stack = UndoStack::new(500);
        stack.push(entry(1));
        stack.undo_top();
        stack.commit_undo();
        assert!(stack.state().can_redo);
        stack.push(entry(2));
        assert!(!stack.state().can_redo);
    }

    #[test]
    fn oldest_entries_are_dropped_beyond_the_limit_of_500() {
        let mut stack = UndoStack::new(500);
        for seq in 1..=501 {
            stack.push(entry(seq));
        }
        assert_eq!(stack.state().undo_depth, 500);
        let mut undone = Vec::new();
        while let Some(top) = stack.undo_top() {
            undone.push(top.seq);
            stack.commit_undo();
        }
        assert_eq!(undone.len(), 500);
        assert_eq!(undone.first(), Some(&501));
        assert_eq!(undone.last(), Some(&2));
    }
}
