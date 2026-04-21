//! Shared DTOs and helpers for unyt-watchtower.
//!
//! Everything here is Tier-1: small, human-readable, latest-state. Raw chain
//! bodies, op blobs, and anything a reasonable person would not want rendered
//! in a table belongs in Tier-2 files produced by the CLI on the observer
//! node, not in these structures.

pub mod dto;
pub mod hmac_sign;
pub mod size;
pub mod tag;

pub use dto::*;
pub use hmac_sign::*;
pub use size::*;
pub use tag::*;

/// The schema version of the Tier-1 ingest payload.
///
/// The observer includes this in the HTTP header and the Worker refuses
/// payloads it doesn't understand.
pub const SCHEMA_VERSION: u32 = 1;

/// Per-DNA Tier-1 snapshot hard cap. The collector must enforce this before
/// posting to the Worker; the Worker re-checks and rejects oversize payloads.
pub const MAX_DNA_SNAPSHOT_BYTES: usize = 100 * 1024;

/// HTTP header names exchanged during ingest. Keep short and lowercase.
pub mod headers {
    pub const SCHEMA_VERSION: &str = "x-watchtower-schema";
    pub const OBSERVER_ID: &str = "x-watchtower-observer";
    pub const TIMESTAMP: &str = "x-watchtower-ts";
    pub const NONCE: &str = "x-watchtower-nonce";
    pub const SIGNATURE: &str = "x-watchtower-sig";
}
