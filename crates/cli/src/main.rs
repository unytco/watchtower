//! `hc-watchtower` — operator CLI.
//!
//! Quick-view commands print Tier-1 summaries directly (`list agents`,
//! `list warrants`, …). Export commands write Tier-2 JSON files under
//! `/var/lib/hc-watchtower/exports/` for the operator to `scp`.
//!
//! The CLI never talks to the Worker. `refresh-now` triggers a one-shot
//! observer collection by running `hc-watchtower-observer --once`.

mod commands;
mod config;
mod render;

use anyhow::Result;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "hc-watchtower", version)]
struct Cli {
    /// Path to observer.toml (same file as the daemon).
    #[arg(long, default_value = "/etc/hc-watchtower/observer.toml")]
    config: PathBuf,

    #[command(subcommand)]
    cmd: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Show an at-a-glance summary of the current node.
    Status,

    /// List agents discovered in a DNA.
    ListAgents {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: String,
    },

    /// List warrants in a DNA (or across all DNAs).
    ListWarrants {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: Option<String>,
    },

    /// List validation coverage bottom-N for a DNA.
    Coverage {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: String,
        #[arg(long, default_value_t = 20)]
        n: i64,
    },

    /// Export the full chain of one agent to a Tier-2 file.
    ExportChain {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: String,
        /// Agent pubkey. Accepts `uhCAk…` (Holochain canonical) or `hCAk…` (dashboard).
        #[arg(long)]
        agent: String,
    },

    /// Dump every pending op (with bodies) for a DNA.
    ExportPendingOps {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: String,
    },

    /// Dump every integrated warrant (with full decoded proof and warrantor
    /// signature) for a DNA, or for every DNA on this conductor when `--dna`
    /// is omitted.
    ExportWarrants {
        /// DNA hash. Accepts `uhC0k…` (Holochain canonical) or `hC0k…` (dashboard).
        #[arg(long)]
        dna: Option<String>,
    },

    /// Convert an `hc dump-state` JSON into readable form.
    ExportStateDump {
        #[arg(long)]
        input: PathBuf,
    },

    /// Trigger a one-shot observer collection cycle.
    RefreshNow,

    /// Manage agent_tags and dna_tags in observer.toml.
    Tag {
        #[command(subcommand)]
        cmd: TagCommand,
    },
}

#[derive(Subcommand, Debug)]
enum TagCommand {
    /// Set a tag for a hash.
    Set {
        /// `agent` or `dna`.
        kind: String,
        b64: String,
        name: String,
    },
    /// Remove a tag.
    Unset {
        kind: String,
        b64: String,
    },
    /// List all tags.
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")))
        .init();

    let cli = Cli::parse();
    let cfg = config::load(&cli.config)?;

    match cli.cmd {
        Command::Status => commands::status(&cfg).await,
        Command::ListAgents { dna } => commands::list_agents(&cfg, &dna).await,
        Command::ListWarrants { dna } => commands::list_warrants(&cfg, dna.as_deref()).await,
        Command::Coverage { dna, n } => commands::coverage(&cfg, &dna, n).await,
        Command::ExportChain { dna, agent } => commands::export_chain(&cfg, &dna, &agent),
        Command::ExportPendingOps { dna } => commands::export_pending_ops(&cfg, &dna),
        Command::ExportWarrants { dna } => commands::export_warrants(&cfg, dna.as_deref()),
        Command::ExportStateDump { input } => commands::export_state_dump(&cfg, &input),
        Command::RefreshNow => commands::refresh_now(&cli.config),
        Command::Tag { cmd } => commands::tag(&cli.config, cmd),
    }
}
