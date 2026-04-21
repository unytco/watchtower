use crate::config::{self, ObserverConfig};
use crate::render;
use crate::TagCommand;
use anyhow::{anyhow, Context, Result};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use unyt_watchtower_collector::{collect_node_snapshot, Exporter};
use unyt_watchtower_core::tag;

pub async fn status(cfg: &ObserverConfig) -> Result<()> {
    let snap = collect(cfg).await?;
    render::status(&snap, &cfg.observer_id);
    Ok(())
}

pub async fn list_agents(cfg: &ObserverConfig, dna_b64: &str) -> Result<()> {
    let snap = collect(cfg).await?;
    let d = snap
        .dnas
        .iter()
        .find(|d| d.dna_b64 == dna_b64)
        .ok_or_else(|| anyhow!("no such dna: {dna_b64}"))?;
    render::agents(d);
    Ok(())
}

pub async fn list_warrants(cfg: &ObserverConfig, dna_b64: Option<&str>) -> Result<()> {
    let snap = collect(cfg).await?;
    render::warrants(&snap, dna_b64);
    Ok(())
}

pub async fn coverage(cfg: &ObserverConfig, dna_b64: &str, n: i64) -> Result<()> {
    let mut c = cfg.to_collector();
    c.validation_coverage_bottom_n = n;
    let snap = collect_with(&c).await?;
    let d = snap
        .dnas
        .iter()
        .find(|d| d.dna_b64 == dna_b64)
        .ok_or_else(|| anyhow!("no such dna: {dna_b64}"))?;
    render::coverage(d);
    Ok(())
}

pub fn export_chain(cfg: &ObserverConfig, dna_b64: &str, agent_b64: &str) -> Result<()> {
    let c = cfg.to_collector();
    let exporter = Exporter::new(&c);
    let dna = holo_hash::DnaHash::try_from_raw_39(tag::b64url_decode(dna_b64)?)?;
    let agent = holo_hash::AgentPubKey::try_from_raw_39(tag::b64url_decode(agent_b64)?)?;
    let path = exporter
        .agent_chain(&dna, &agent)
        .map_err(|e| anyhow!("export_chain: {e}"))?;
    println!("wrote {}", path.display());
    Ok(())
}

pub fn export_pending_ops(cfg: &ObserverConfig, dna_b64: &str) -> Result<()> {
    let c = cfg.to_collector();
    let exporter = Exporter::new(&c);
    let dna = holo_hash::DnaHash::try_from_raw_39(tag::b64url_decode(dna_b64)?)?;
    let path = exporter
        .pending_ops(&dna)
        .map_err(|e| anyhow!("export_pending_ops: {e}"))?;
    println!("wrote {}", path.display());
    Ok(())
}

pub fn export_state_dump(cfg: &ObserverConfig, input: &Path) -> Result<()> {
    let c = cfg.to_collector();
    let exporter = Exporter::new(&c);
    let path = exporter
        .simplify_state_dump(input)
        .map_err(|e| anyhow!("export_state_dump: {e}"))?;
    println!("wrote {}", path.display());
    Ok(())
}

pub fn refresh_now(config_path: &Path) -> Result<()> {
    let output = std::process::Command::new("hc-watchtower-observer")
        .arg("--config")
        .arg(config_path)
        .arg("--once")
        .output()
        .with_context(|| "running hc-watchtower-observer --once")?;
    if !output.status.success() {
        return Err(anyhow!(
            "observer --once failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    print!("{}", String::from_utf8_lossy(&output.stdout));
    eprint!("{}", String::from_utf8_lossy(&output.stderr));
    Ok(())
}

pub fn tag(config_path: &Path, cmd: TagCommand) -> Result<()> {
    let mut cfg = config::load(config_path)?;
    match cmd {
        TagCommand::Set { kind, b64, name } => match kind.as_str() {
            "agent" => {
                cfg.agent_tags.insert(b64, name);
            }
            "dna" => {
                cfg.dna_tags.insert(b64, name);
            }
            other => return Err(anyhow!("unknown tag kind: {other}, expected agent or dna")),
        },
        TagCommand::Unset { kind, b64 } => match kind.as_str() {
            "agent" => {
                cfg.agent_tags.remove(&b64);
            }
            "dna" => {
                cfg.dna_tags.remove(&b64);
            }
            other => return Err(anyhow!("unknown tag kind: {other}")),
        },
        TagCommand::List => {
            render::tags(&cfg.agent_tags, &cfg.dna_tags);
            return Ok(());
        }
    }
    config::save(config_path, &cfg)?;
    Ok(())
}

async fn collect(cfg: &ObserverConfig) -> Result<unyt_watchtower_core::NodeSnapshot> {
    let c = cfg.to_collector();
    collect_with(&c).await
}

async fn collect_with(
    c: &unyt_watchtower_collector::CollectorConfig,
) -> Result<unyt_watchtower_core::NodeSnapshot> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), c.holochain.admin_port);
    let admin = holochain_client::AdminWebsocket::connect(addr, None)
        .await
        .map_err(|e| anyhow!("admin websocket: {e:?}"))?;
    collect_node_snapshot(c, &admin)
        .await
        .map_err(|e| anyhow!("collect: {e}"))
}

// (PathBuf import kept in case a sibling command imports this module with path
// parameters converted from &Path later.)
#[allow(dead_code)]
fn _unused(_: PathBuf) {}
