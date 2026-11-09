//! Debezium change events as delivered by Debezium Server's HTTP sink (JSON, schemas off).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DebeziumSource {
    pub version: String,
    pub connector: String,
    pub name: String,
    pub ts_ms: i64,
    pub db: String,
    pub schema: String,
    pub table: String,
    #[serde(rename = "txId")]
    pub tx_id: String,
    /// PostgreSQL log sequence number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lsn: Option<String>,
    /// Oracle system change number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, utoipa::ToSchema)]
pub struct DebeziumEvent {
    #[schema(value_type = Option<Object>)]
    pub before: Option<Value>,
    #[schema(value_type = Option<Object>)]
    pub after: Option<Value>,
    pub source: DebeziumSource,
    /// `c` create, `u` update, `d` delete, `r` snapshot read.
    pub op: String,
    pub ts_ms: i64,
    #[schema(value_type = Option<Object>)]
    pub transaction: Option<Value>,
}
