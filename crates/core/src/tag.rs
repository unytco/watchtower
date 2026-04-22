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

/// Try to decode a base64url-no-pad string into the raw 39 bytes. Used by the
/// CLI when the operator pastes a hash back in. Accepts both the bare form
/// (52 chars, as emitted by `b64url` and stored in D1) and the Holochain
/// multibase form (53 chars, leading `u`).
pub fn b64url_decode(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    let s = normalize_hash(s);
    base64::prelude::BASE64_URL_SAFE_NO_PAD.decode(s)
}

/// Strip a single leading `u` (Holochain multibase prefix) if present so the
/// remainder is comparable to the bare base64url form stored in D1.
pub fn normalize_hash(s: &str) -> &str {
    s.strip_prefix('u').unwrap_or(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 39 bytes = the canonical Holochain hash length.
    fn sample_bytes() -> Vec<u8> {
        (0u8..39).collect()
    }

    #[test]
    fn roundtrip_bare() {
        let b = sample_bytes();
        let s = b64url(&b);
        assert_eq!(s.len(), 52);
        assert_eq!(b64url_decode(&s).unwrap(), b);
    }

    #[test]
    fn accepts_multibase_u_prefix() {
        let b = sample_bytes();
        let bare = b64url(&b);
        let prefixed = format!("u{bare}");
        assert_eq!(prefixed.len(), 53);
        assert_eq!(b64url_decode(&prefixed).unwrap(), b);
    }

    #[test]
    fn normalize_hash_strips_single_leading_u() {
        assert_eq!(normalize_hash("uABC"), "ABC");
        assert_eq!(normalize_hash("ABC"), "ABC");
        assert_eq!(normalize_hash(""), "");
        // Only one prefix is stripped so `uu…` decodes as base64 starting with `u`.
        assert_eq!(normalize_hash("uuABC"), "uABC");
    }
}
