//! Helpers for rendering agent / dna hashes as short readable identifiers.

use base64::Engine;

/// Truncate a base64url hash to the first `n` chars. Used when no tag is
/// configured and the UI still needs to show *something* human-scannable.
pub fn truncate(b64: &str, n: usize) -> String {
    if b64.len() <= n {
        b64.to_string()
    } else {
        format!("{}…", &b64[..n])
    }
}

/// Encode 39-byte Holochain hash bytes as base64url no-pad.
pub fn b64url(bytes: &[u8]) -> String {
    base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(bytes)
}

/// Try to decode a base64url-no-pad string into the raw 39 bytes. Used by
/// the CLI when the operator pastes a hash back in.
pub fn b64url_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    base64::prelude::BASE64_URL_SAFE_NO_PAD.decode(s)
}
