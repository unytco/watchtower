//! Opening a conductor's SQLite databases for reading.
//!
//! The three things that have to match the running conductor exactly — where
//! the files live, what they are called, and how the SQLCipher key is derived —
//! all come from [`holochain_data`], the crate the conductor writes with.
//! Restating any of them here is what makes an observer break silently on a
//! Holochain upgrade.

use crate::{HcOpsError, HcOpsResult};
use holo_hash::DnaHash;
use holochain_conductor_api::config::conductor::paths::DATABASES_DIRECTORY;
use holochain_data::{DatabaseIdentifier, DbKey, kind};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

/// Filename of the conductor's encrypted database key, inside the databases
/// directory. Holochain writes it in `Spaces::new`.
const DB_KEY_FILE: &str = "db.key";

/// How many pooled connections one database handle may open. Reads are small
/// and sequential; this only exists so a collection pass can overlap queries.
const MAX_POOL_CONNECTIONS: u32 = 4;

/// The conductor's SQLCipher database key, unlocked with the lair passphrase.
pub struct Key(DbKey);

impl std::fmt::Debug for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Key").finish_non_exhaustive()
    }
}

impl Key {
    /// Add the SQLCipher pragmas for this key to a connection.
    ///
    /// Mirrors `DbKey::apply_pragmas`, which is crate-private in
    /// `holochain_data`; the key and salt themselves are read from its public
    /// fields, so the *derivation* still lives upstream. `sqlx` guarantees
    /// `key` is issued before any other statement, which SQLCipher requires.
    fn apply_pragmas(&self, opts: SqliteConnectOptions) -> HcOpsResult<SqliteConnectOptions> {
        Ok(opts
            .pragma("key", format!("\"x'{}'\"", locked_hex(&self.0.key)?))
            .pragma(
                "cipher_salt",
                format!("\"x'{}'\"", locked_hex(&self.0.salt)?),
            )
            .pragma("cipher_compatibility", "4")
            .pragma("cipher_plaintext_header_size", "32"))
    }
}

fn locked_hex<const N: usize>(
    guarded: &Arc<Mutex<sodoken::SizedLockedArray<N>>>,
) -> HcOpsResult<String> {
    let mut guard = guarded
        .lock()
        .map_err(|_| HcOpsError::Other("database key mutex poisoned".into()))?;
    Ok(guard.lock().iter().map(|b| format!("{b:02X}")).collect())
}

/// `{data_root}/databases` — the directory the conductor keeps every database
/// file in.
pub fn databases_dir<P: AsRef<Path>>(data_root_path: P) -> PathBuf {
    data_root_path.as_ref().join(DATABASES_DIRECTORY)
}

/// Load and unlock the conductor's database key, or `None` when the conductor
/// is running without encryption (no `db.key` on disk).
pub async fn load_database_key<P: AsRef<Path>>(
    data_root_path: P,
    passphrase: sodoken::LockedArray,
) -> HcOpsResult<Option<Key>> {
    let db_key_path = databases_dir(data_root_path).join(DB_KEY_FILE);
    if !db_key_path.exists() {
        // Info, not debug: reading a conductor's databases unencrypted is a
        // security-relevant fallback, and the observer logs at info.
        tracing::info!(path = %db_key_path.display(), "no db.key; opening databases unencrypted");
        return Ok(None);
    }
    let locked = std::fs::read_to_string(&db_key_path)?.trim().to_string();
    let key = DbKey::load(locked, Arc::new(Mutex::new(passphrase)))
        .await
        .map_err(HcOpsError::IO)?;
    Ok(Some(Key(key)))
}

/// A pool over one conductor database file, opened for reading.
pub struct HolochainDb {
    pool: SqlitePool,
    path: PathBuf,
}

impl HolochainDb {
    /// The underlying pool, for callers that need to run their own query.
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// The database file this handle was opened from.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Close the pool and wait for its connections to drain.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

impl std::fmt::Debug for HolochainDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HolochainDb")
            .field("path", &self.path)
            .finish()
    }
}

/// Open the per-DNA DHT database. Since 0.7 this is the only per-DNA database:
/// chain locks, scheduled functions, cap grants, slice hashes and publish state
/// all live here alongside the ops, so there is no separate authored or cache
/// database to open.
pub async fn open_dht_database<P: AsRef<Path>>(
    data_root_path: P,
    dna_hash: &DnaHash,
    key: Option<&Key>,
) -> HcOpsResult<HolochainDb> {
    let id = kind::Dht::new(Arc::new(dna_hash.clone()));
    open_at(databases_dir(data_root_path).join(id.database_id()), key).await
}

/// Open the conductor database (apps, interfaces, nonces, blocks).
pub async fn open_conductor_database<P: AsRef<Path>>(
    data_root_path: P,
    key: Option<&Key>,
) -> HcOpsResult<HolochainDb> {
    let id = kind::Conductor;
    open_at(databases_dir(data_root_path).join(id.database_id()), key).await
}

/// Every DNA this node holds a DHT database for, read from the file names the
/// conductor writes (`dht-<dna>.db`).
pub fn list_dna_databases<P: AsRef<Path>>(data_root_path: P) -> HcOpsResult<Vec<DnaHash>> {
    let dir = databases_dir(data_root_path);
    // Same rule as `open_at`: a wrong data root errors rather than reporting a
    // node with no DNAs, which is what a healthy but idle node looks like.
    if !dir.exists() {
        return Err(HcOpsError::Other(
            format!("no databases directory at {}", dir.display()).into(),
        ));
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(dna) = dna_hash_from_dht_filename(name) else {
            continue;
        };
        out.push(dna);
    }
    out.sort();
    out.dedup();
    if out.is_empty() {
        // The directory exists but nothing in it parsed as `dht-<dna>.db`. That
        // is either a conductor that has installed nothing, or a naming change
        // upstream — and the second is invisible without this line.
        tracing::warn!(dir = %dir.display(), "no dht databases found");
    }
    Ok(out)
}

/// Recover the DNA hash from a `dht-<dna>.db` file name, or `None` for anything
/// else in the directory (`conductor.db`, `p2p-peer-meta-*.db`, WAL/shm
/// sidecars). Derived from — and checked against — the name
/// [`kind::Dht`] builds, so a rename upstream fails the test rather than
/// quietly yielding no DNAs.
fn dna_hash_from_dht_filename(name: &str) -> Option<DnaHash> {
    let rest = name.strip_prefix("dht-")?;
    let b64 = rest.strip_suffix(".db")?;
    match holo_hash::DnaHashB64::from_str(b64) {
        Ok(h) => Some(h.into()),
        Err(e) => {
            tracing::debug!(file = %name, error = %e, "skipping unparseable dht database name");
            None
        }
    }
}

async fn open_at(path: PathBuf, key: Option<&Key>) -> HcOpsResult<HolochainDb> {
    // `create_if_missing` stays off (sqlx's default): a wrong data root must
    // fail loudly instead of conjuring an empty database that reads as a
    // healthy node with zero of everything.
    if !path.exists() {
        return Err(HcOpsError::Other(
            format!("no database at {}", path.display()).into(),
        ));
    }

    let mut opts = SqliteConnectOptions::new().filename(&path);
    if let Some(key) = key {
        opts = key.apply_pragmas(opts)?;
    }
    // Opened read-write at the SQLite level on purpose: a `SQLITE_OPEN_READONLY`
    // handle cannot replay a `-wal` left behind by a stopped conductor, so a
    // node that is merely switched off would read as an empty database.
    // `query_only` makes SQLite itself reject any write we might issue.
    opts = opts.pragma("query_only", "ON");

    let pool = SqlitePoolOptions::new()
        .max_connections(MAX_POOL_CONNECTIONS)
        .connect_with(opts)
        .await?;

    Ok(HolochainDb { pool, path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use holo_hash::PrimitiveHashType;

    #[test]
    fn dht_filename_round_trips_the_conductors_own_naming() {
        // `from_raw_32_and_type` computes the trailing DHT-location bytes, which
        // the base64 form is checksummed against — a hand-filled 36-byte hash
        // would not survive the round trip.
        let dna = DnaHash::from_raw_32_and_type(vec![7u8; 32], holo_hash::hash_type::Dna::new());
        let name = kind::Dht::new(Arc::new(dna.clone()))
            .database_id()
            .to_string();
        assert_eq!(dna_hash_from_dht_filename(&name), Some(dna));
    }

    #[test]
    fn non_dht_files_are_skipped() {
        for name in [
            "conductor.db",
            "wasm.db",
            "db.key",
            "p2p-peer-meta-uhC0kAAAA.db",
            "dht-uhC0kAAAA.db-wal",
            "dht-not-a-hash.db",
        ] {
            assert_eq!(dna_hash_from_dht_filename(name), None, "{name}");
        }
    }
}
