//! The normalised change event: the exact structure that is canonicalised and hashed into a leaf.
//! Field names and shapes are part of hashing spec v1.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Op {
    Insert,
    Update,
    Delete,
}

impl Op {
    /// Maps a Debezium `op` code (`c`, `u`, `d`, and `r` for snapshot reads) to an operation.
    pub fn from_debezium(op: &str) -> Option<Self> {
        match op {
            "c" | "r" => Some(Self::Insert),
            "u" => Some(Self::Update),
            "d" => Some(Self::Delete),
            _ => None,
        }
    }
}

/// Where the change came from in the source database's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct EventSource {
    pub connector: String,
    pub db: String,
    pub schema: String,
    pub table: String,
    /// Log position: PostgreSQL LSN or Oracle SCN.
    pub pos: String,
    pub tx: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct RecordKey {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Actor {
    pub name: String,
    /// `service` for the ERP's own account, `user` otherwise.
    pub kind: String,
}

/// A normalised change event (spec v1).
///
/// - Money and decimals are strings, never JSON floats.
/// - Timestamps are RFC 3339 UTC with microseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct Event {
    pub v: u32,
    pub chain: String,
    pub source: EventSource,
    pub key: RecordKey,
    pub op: Op,
    /// Row before the change (`null` for inserts).
    #[schema(value_type = Option<Object>)]
    pub before: Option<Value>,
    /// Row after the change (`null` for deletes).
    #[schema(value_type = Option<Object>)]
    pub after: Option<Value>,
    pub actor: Actor,
    pub committed_at: String,
    pub captured_at: String,
}
