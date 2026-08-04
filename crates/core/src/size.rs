//! Size-budget helpers for Tier-1 payloads.

use crate::MAX_DNA_SNAPSHOT_BYTES;
use crate::dto::DnaSnapshot;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum SizeBudgetError {
    #[error("serialize failed: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error("dna snapshot for {dna_b64} is {actual} bytes, exceeds budget {budget}")]
    Exceeded {
        dna_b64: String,
        actual: usize,
        budget: usize,
    },
}

/// Measure the JSON size of a single DnaSnapshot and return an error if it
/// busts the budget. The collector calls this before posting and trims
/// opportunistically (e.g. keeping only the bottom-N lowest-receipt ops)
/// until it fits.
pub fn check_dna_snapshot_budget(snap: &DnaSnapshot) -> Result<usize, SizeBudgetError> {
    let size = measure(snap)?;
    if size > MAX_DNA_SNAPSHOT_BYTES {
        return Err(SizeBudgetError::Exceeded {
            dna_b64: snap.dna_b64.clone(),
            actual: size,
            budget: MAX_DNA_SNAPSHOT_BYTES,
        });
    }
    Ok(size)
}

pub fn measure<T: Serialize>(value: &T) -> Result<usize, serde_json::Error> {
    let bytes = serde_json::to_vec(value)?;
    Ok(bytes.len())
}
