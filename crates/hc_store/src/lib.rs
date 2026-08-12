// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2025-2026 Unyt contributors. Portions derived from
// ThetaSinner/hc-ops (GPL-3.0); see readable.rs for the upstream copyright
// notice.

//! Read-only data layer over a Holochain conductor's SQLite databases.
//!
//! Everything that talks directly to conductor storage or the admin websocket
//! lives here; the collector builds Tier-1 summaries on top.
//!
//! The three facts that must agree with the conductor byte-for-byte — the
//! schema, the database file names, and the SQLCipher key derivation — are
//! taken from [`holochain_data`], the crate the conductor itself writes with.
//! Nothing here restates them; see [`retrieve`] for how the connection is
//! opened read-only without touching the conductor's migrations.
//!
//! Keep this crate free of DTOs that belong in `crates/core`; it returns
//! Holochain-native types (`ChainRecord`, `Record`, `WarrantRecord`, …) and
//! the collector maps them to Tier-1 summaries.

pub mod extensions;
pub mod readable;
pub mod retrieve;

#[derive(Debug, thiserror::Error)]
pub enum HcOpsError {
    #[error("Holochain client error: {0:?}")]
    HolochainClient(holochain_client::ConductorApiError),

    #[error("IO error: {0}")]
    IO(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

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
