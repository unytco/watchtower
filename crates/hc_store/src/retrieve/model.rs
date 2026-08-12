//! The types the queries in [`super`] return.
//!
//! Row structs come from [`holochain_data::models::dht`] — the conductor's own
//! definitions — and are projected here into the shapes the collector and the
//! Tier-2 exporters consume.

use crate::{HcOpsError, HcOpsResult};
use holo_hash::{ActionHash, AgentPubKey, AnyLinkableHash, DhtOpHash, ExternalHash, HoloHashed};
use holochain_data::models::dht::{ActionRow, LimboChainOpRow, WarrantRow};
use holochain_integrity_types::prelude::{
    Action, ActionData, ActionHeader, RecordValidity, Signature, SignedHashed,
};
use holochain_zome_types::prelude::{
    BlockTargetId, BlockTargetReason, ChainOpType, Entry, SignedActionHashed, SignedWarrant,
    Timestamp, Warrant, WarrantProof,
};
use serde::{Deserialize, Serialize};

/// Validation outcome of a DHT op.
///
/// 0.7 records only `Accepted` / `Rejected` on the integrated tables and marks
/// give-up separately, as `abandoned_at` on the limbo tables; both are folded
/// into this one enum so the Tier-1 vocabulary the dashboard reads is unchanged.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValidationStatus {
    /// Validation passed.
    Valid,
    /// Validation rejected the op.
    Rejected,
    /// Validation was given up on, commonly because dependencies stayed missing.
    Abandoned,
}

impl ValidationStatus {
    /// Decode a `validation_status` / `record_validity` column.
    pub fn from_db(value: i64) -> HcOpsResult<Self> {
        match RecordValidity::try_from(value) {
            Ok(RecordValidity::Accepted) => Ok(Self::Valid),
            Ok(RecordValidity::Rejected) => Ok(Self::Rejected),
            Err(other) => Err(HcOpsError::Other(
                format!("unknown validation status {other} in database").into(),
            )),
        }
    }
}

/// Op-level metadata for a chain op still in validation limbo.
#[derive(Debug, Serialize, Deserialize)]
pub struct LimboMeta {
    pub require_receipt: bool,
    pub when_received: Timestamp,
    pub sys_validation_attempts: u32,
    pub app_validation_attempts: u32,
    pub last_validation_attempt: Option<Timestamp>,
    pub serialized_size: u32,
}

/// A chain op that has not been integrated yet.
#[derive(Debug, Serialize, Deserialize)]
pub struct LimboOp {
    pub hash: DhtOpHash,
    pub typ: ChainOpType,
    pub basis_hash: AnyLinkableHash,
    pub action_hash: ActionHash,
    pub storage_center_loc: u32,
    pub authored_timestamp: Timestamp,
    /// The outcome so far, or `None` while it is undecided. Only a *terminal*
    /// outcome is reported: passing sys validation still leaves an op waiting
    /// on app validation, so it stays `None` until app validation concludes.
    pub validation_status: Option<ValidationStatus>,
    pub meta: LimboMeta,
}

/// Op-level metadata for an integrated warrant.
#[derive(Debug, Serialize, Deserialize)]
pub struct WarrantOp {
    pub hash: DhtOpHash,
    pub storage_center_loc: u32,
    /// When the warrant was authored (from the warrant content, not the op).
    pub authored_timestamp: Timestamp,
    pub when_received: Timestamp,
    pub when_integrated: Option<Timestamp>,
    pub validation_status: Option<ValidationStatus>,
    pub serialized_size: u32,
}

/// An integrated warrant: the op metadata plus the signed warrant it carries.
pub struct WarrantRecord {
    pub dht_op: WarrantOp,
    pub warrant: SignedWarrant,
}

/// One record on an agent's chain, as reconstructed from the DHT database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainRecord {
    pub action: SignedActionHashed,
    pub validation_status: ValidationStatus,
    pub entry: Option<Entry>,
}

/// A not-yet-integrated op together with the action and entry it carries.
pub struct Record {
    pub dht_op: LimboOp,
    pub action: SignedActionHashed,
    pub entry: Option<Entry>,
}

/// A K2 slice hash covering one arc and time slice.
#[derive(Debug, Clone, PartialEq, Eq, sqlx::FromRow)]
pub struct SliceHash {
    pub arc_start: i64,
    pub arc_end: i64,
    pub slice_index: i64,
    pub hash: Vec<u8>,
}

impl PartialOrd for SliceHash {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SliceHash {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.slice_index
            .cmp(&other.slice_index)
            .then_with(|| self.arc_start.cmp(&other.arc_start))
    }
}

/// One block span from the conductor database.
#[derive(Debug, Serialize)]
pub struct BlockRecord {
    pub id: i64,
    pub target: BlockTargetId,
    pub reason: BlockTargetReason,
    pub start: Timestamp,
    pub end: Timestamp,
}

/// Raw `BlockSpan` row.
#[derive(Debug, sqlx::FromRow)]
pub(crate) struct BlockSpanRow {
    pub id: i64,
    pub target_id: Vec<u8>,
    pub target_reason: Vec<u8>,
    pub start_us: i64,
    pub end_us: i64,
}

impl TryFrom<BlockSpanRow> for BlockRecord {
    type Error = HcOpsError;

    fn try_from(value: BlockSpanRow) -> HcOpsResult<Self> {
        Ok(BlockRecord {
            id: value.id,
            target: holochain_serialized_bytes::decode(&value.target_id)?,
            reason: holochain_serialized_bytes::decode(&value.target_reason)?,
            start: Timestamp(value.start_us),
            end: Timestamp(value.end_us),
        })
    }
}

/// Rebuild the signed, hashed action a row was written from.
///
/// Mirrors `holochain_data`'s own `row_to_signed_action_hashed`, which is
/// crate-private. Note the stored hashes are the bare 36 bytes: 0.7 drops the
/// 3-byte hash-type prefix on disk and re-attaches it on read.
pub(crate) fn action_from_row(row: ActionRow) -> HcOpsResult<SignedActionHashed> {
    let data: ActionData = holochain_serialized_bytes::decode(&row.action_data)?;
    let action = Action {
        header: ActionHeader {
            author: AgentPubKey::from_raw_36(row.author),
            timestamp: Timestamp::from_micros(row.timestamp),
            action_seq: row.seq as u32,
            prev_action: row.prev_hash.map(ActionHash::from_raw_36),
        },
        data,
    };
    let signature: [u8; 64] = row.signature.as_slice().try_into().map_err(|_| {
        HcOpsError::Other(
            format!(
                "signature column has {} bytes, expected 64",
                row.signature.len()
            )
            .into(),
        )
    })?;
    let hashed = HoloHashed::with_pre_hashed(action, ActionHash::from_raw_36(row.hash));
    Ok(SignedHashed::with_presigned(hashed, Signature(signature)))
}

/// Rebuild a `basis_hash` column.
///
/// The column holds the 36 type-stripped bytes — the DHT routes on location
/// alone, so the hash-type wrapper is not persisted. It is reattached as an
/// `External` hash, the same reconstruction the conductor's publish path makes.
fn basis_from_raw_36(bytes: Vec<u8>) -> AnyLinkableHash {
    ExternalHash::from_raw_36(bytes).into()
}

/// Decode the `op_type` discriminant a `ChainOp` / `LimboChainOp` row carries.
fn op_type_from_db(value: i64) -> HcOpsResult<ChainOpType> {
    ChainOpType::try_from(value)
        .map_err(|v| HcOpsError::Other(format!("unknown chain op type {v} in database").into()))
}

impl TryFrom<(LimboChainOpRow, i64)> for LimboOp {
    type Error = HcOpsError;

    fn try_from((row, authored_timestamp): (LimboChainOpRow, i64)) -> HcOpsResult<Self> {
        // Only terminal outcomes are reported. An `abandoned_at` stamp wins:
        // the op will never integrate. Otherwise app validation decides, since
        // a sys-validated op is still queued for it — reporting a sys pass as
        // `Valid` would give a half-validated op the same label as an
        // integrated one. A sys *rejection* is terminal, so it does count.
        let validation_status = if row.abandoned_at.is_some() {
            Some(ValidationStatus::Abandoned)
        } else if let Some(app) = row.app_validation_status {
            Some(ValidationStatus::from_db(app)?)
        } else {
            match row.sys_validation_status.map(ValidationStatus::from_db) {
                Some(Ok(ValidationStatus::Rejected)) => Some(ValidationStatus::Rejected),
                Some(Err(e)) => return Err(e),
                _ => None,
            }
        };

        Ok(LimboOp {
            hash: DhtOpHash::from_raw_36(row.hash),
            typ: op_type_from_db(row.op_type)?,
            basis_hash: basis_from_raw_36(row.basis_hash),
            action_hash: ActionHash::from_raw_36(row.action_hash),
            storage_center_loc: row.storage_center_loc as u32,
            authored_timestamp: Timestamp(authored_timestamp),
            validation_status,
            meta: LimboMeta {
                require_receipt: row.require_receipt != 0,
                when_received: Timestamp(row.when_received),
                sys_validation_attempts: row.sys_validation_attempts as u32,
                app_validation_attempts: row.app_validation_attempts as u32,
                last_validation_attempt: row.last_validation_attempt.map(Timestamp),
                serialized_size: row.serialized_size as u32,
            },
        })
    }
}

impl TryFrom<(WarrantRow, i64)> for WarrantRecord {
    type Error = HcOpsError;

    /// `(joined warrant row, `WarrantOp.validation_status`)` — the status is not
    /// part of `WarrantRow`, so callers select it alongside.
    fn try_from((row, validation_status): (WarrantRow, i64)) -> HcOpsResult<Self> {
        let proof: WarrantProof = holochain_serialized_bytes::decode(&row.proof)?;
        let signature: [u8; 64] = row.signature.as_slice().try_into().map_err(|_| {
            HcOpsError::Other(
                format!(
                    "warrant signature column has {} bytes, expected 64",
                    row.signature.len()
                )
                .into(),
            )
        })?;

        let warrant = Warrant::new(
            proof,
            AgentPubKey::from_raw_36(row.author),
            Timestamp(row.timestamp),
            AgentPubKey::from_raw_36(row.warrantee),
        );

        Ok(WarrantRecord {
            dht_op: WarrantOp {
                hash: DhtOpHash::from_raw_36(row.hash),
                storage_center_loc: row.storage_center_loc as u32,
                authored_timestamp: Timestamp(row.timestamp),
                when_received: Timestamp(row.when_received),
                when_integrated: Some(Timestamp(row.when_integrated)),
                validation_status: Some(ValidationStatus::from_db(validation_status)?),
                serialized_size: row.serialized_size as u32,
            },
            warrant: SignedWarrant::new(warrant, Signature(signature)),
        })
    }
}
