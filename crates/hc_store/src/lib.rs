// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2025-2026 Unyt contributors. Portions derived from
// ThetaSinner/hc-ops (GPL-3.0); see retrieve.rs, ops.rs, readable.rs for
// upstream copyright notices.

//! Vendored data layer from `ThetaSinner/hc-ops` (GPL-3.0). The
//! current upstream rev and the sync procedure are documented in
//! [`watchtower/AGENTS.md`](../../AGENTS.md) under "Syncing `hc_store`
//! from upstream `hc-ops`"; the per-file `Vendored from … @ <sha>`
//! markers at the top of `retrieve.rs`, `ops.rs`, and `readable.rs` are
//! the source of truth for the rev.
//!
//! Anything that talks directly to Holochain SQLite or the admin websocket
//! lives here. The collector builds on top of this.
//!
//! Keep this crate free of DTOs that belong in `crates/core`; this crate
//! returns Holochain-native types (`ChainOp<DhtMeta>`, `ChainRecord`, …) and
//! the collector maps them to Tier-1 summaries.
//!
//! Watchtower-specific additions live in [`extensions`] and as
//! `retrieve::list_authored_identities` — preserve those when syncing.

pub mod extensions;
pub mod ops;
pub mod readable;
pub mod retrieve;

#[derive(Debug, thiserror::Error)]
pub enum HcOpsError {
    #[error("Holochain client error: {0:?}")]
    HolochainClient(holochain_client::ConductorApiError),

    #[error("IO error: {0}")]
    IO(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] diesel::result::Error),

    #[error("JSON error: {0}")]
    JSON(#[from] serde_json::Error),

    #[error("HoloHash error: {0}")]
    HoloHash(#[from] holochain_zome_types::prelude::HoloHashError),

    #[error("Serialized bytes error: {0}")]
    SerializedBytes(#[from] holochain_serialized_bytes::SerializedBytesError),

    #[error("Other error: {0}")]
    Other(#[from] Box<dyn std::error::Error + Send + Sync>),

    #[error("{context}\n\tcaused by: {source}")]
    Context {
        #[source]
        source: Box<HcOpsError>,
        context: String,
    },
}

impl HcOpsError {
    pub fn client(error: holochain_client::ConductorApiError) -> Self {
        HcOpsError::HolochainClient(error)
    }

    pub fn other<E>(error: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        HcOpsError::Other(Box::new(error))
    }
}

pub type HcOpsResult<T> = Result<T, HcOpsError>;

pub trait HcOpsResultContextExt<T> {
    fn context(self, context: impl Into<String>) -> HcOpsResult<T>;
}

impl<S> HcOpsResultContextExt<S> for HcOpsResult<S> {
    fn context(self, context: impl Into<String>) -> HcOpsResult<S> {
        self.map_err(|e| HcOpsError::Context {
            source: Box::new(e),
            context: context.into(),
        })
    }
}
