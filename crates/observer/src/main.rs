//! `hc-watchtower-observer` daemon.
//!
//! Runs on each Holochain node. Periodically:
//!   1. Collects a Tier-1 NodeSnapshot via `unyt_watchtower_collector`.
//!   2. Wraps it with self-health, schema version, timestamp, nonce.
//!   3. Signs with HMAC-SHA256 and POSTs to the Worker's `/ingest`.
//!   4. Runs the Tier-2 export directory janitor.
//!
//! A Unix signal or the CLI's `refresh-now` triggers a one-shot cycle
//! outside the interval.

mod config;
mod runner;

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "hc-watchtower-observer")]
#[command(version)]
struct Cli {
    /// Path to observer.toml.
    #[arg(long, default_value = "/etc/hc-watchtower/observer.toml")]
    config: PathBuf,

    /// Run one collection cycle then exit (used by `hc-watchtower refresh-now`).
    #[arg(long)]
    once: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let cli = Cli::parse();
    let cfg = config::load(&cli.config)
        .with_context(|| format!("loading config at {}", cli.config.display()))?;

    if cli.once {
        runner::run_once(&cfg).await?;
    } else {
        runner::run_loop(cfg).await?;
    }
    Ok(())
}
