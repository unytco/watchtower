use crate::config::ObserverConfig;
use anyhow::{Context, Result};
use chrono::Utc;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use unyt_watchtower_collector::{collect_node_snapshot, Exporter};
use unyt_watchtower_core::{
    canonical_string, body_digest_hex, headers, sign, IngestPayload, SelfHealth, SCHEMA_VERSION,
};

const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn run_loop(cfg: ObserverConfig) -> Result<()> {
    let started_at = Instant::now();
    let interval = Duration::from_secs(cfg.collection.interval_s);
    tracing::info!(
        observer_id = %cfg.observer_id,
        interval_s = cfg.collection.interval_s,
        "starting observer loop"
    );

    loop {
        let cycle_start = Instant::now();
        if let Err(e) = run_cycle(&cfg, started_at).await {
            tracing::error!(error = %e, "collection cycle failed");
        }
        let elapsed = cycle_start.elapsed();
        let sleep_for = interval.checked_sub(elapsed).unwrap_or(Duration::from_secs(5));
        tokio::time::sleep(sleep_for).await;
    }
}

pub async fn run_once(cfg: &ObserverConfig) -> Result<()> {
    run_cycle(cfg, Instant::now()).await
}

async fn run_cycle(cfg: &ObserverConfig, started_at: Instant) -> Result<()> {
    let t0 = Instant::now();
    let collector_cfg = cfg.to_collector();

    // Janitor — always runs, regardless of whether the collection succeeds.
    if let Err(e) = tokio::task::spawn_blocking({
        let c = collector_cfg.clone();
        let exports = cfg.exports.clone();
        move || {
            let exp = Exporter::new(&c);
            exp.prune(exports.max_age_days, exports.max_total_mb)
        }
    })
    .await
    .unwrap_or_else(|_| Ok(Default::default()))
    {
        tracing::warn!(error = %e, "export dir janitor failed");
    }

    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), cfg.holochain.admin_port);
    let admin = holochain_client::AdminWebsocket::connect(addr, None)
        .await
        .map_err(|e| anyhow::anyhow!("admin websocket connect: {e:?}"))?;

    let node = collect_node_snapshot(&collector_cfg, &admin)
        .await
        .context("collect_node_snapshot")?;

    let self_health = SelfHealth {
        uptime_s: started_at.elapsed().as_secs(),
        last_collection_ms: t0.elapsed().as_millis() as u64,
        n_errors_this_cycle: 0,
        binary_version: BINARY_VERSION.to_string(),
    };

    let payload = IngestPayload {
        schema_version: SCHEMA_VERSION,
        observer_id: cfg.observer_id.clone(),
        collected_at: Utc::now().to_rfc3339(),
        self_health,
        node,
    };

    post(cfg, &payload).await?;
    Ok(())
}

async fn post(cfg: &ObserverConfig, payload: &IngestPayload) -> Result<()> {
    let body = serde_json::to_vec(payload)?;
    let ts = Utc::now().to_rfc3339();
    let nonce = uuid::Uuid::new_v4().to_string();
    let digest = body_digest_hex(&body);
    let canonical = canonical_string(&cfg.observer_id, &ts, &nonce, &digest);
    let secret = cfg.read_secret()?;
    let sig = sign(&secret, &canonical).map_err(|e| anyhow::anyhow!("sign: {e}"))?;

    let resp = reqwest::Client::new()
        .post(&cfg.ingest.url)
        .header(headers::SCHEMA_VERSION, SCHEMA_VERSION.to_string())
        .header(headers::OBSERVER_ID, &cfg.observer_id)
        .header(headers::TIMESTAMP, ts)
        .header(headers::NONCE, nonce)
        .header(headers::SIGNATURE, sig)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("ingest rejected: {status}: {text}"));
    }
    tracing::info!(status = %status, "snapshot posted");
    Ok(())
}
