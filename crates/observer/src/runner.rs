use crate::config::ObserverConfig;
use anyhow::{Context, Result};
use chrono::Utc;
use ham::{BackoffConfig, compute_delay_ms, install_shutdown_handler, is_connection_error};
use holochain_client::{AdminWebsocket, WebsocketConfig};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::select;
use unyt_watchtower_collector::{Exporter, collect_node_snapshot};
use unyt_watchtower_core::{
    IngestPayload, SCHEMA_VERSION, SelfHealth, body_digest_hex, canonical_string, headers, sign,
};

const BINARY_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How many times to retry admin-WS connect inside a single collection cycle
/// before giving up and letting the outer loop schedule the next tick.
const MAX_CONNECT_ATTEMPTS_PER_CYCLE: u32 = 3;

pub async fn run_loop(cfg: ObserverConfig) -> Result<()> {
    let started_at = Instant::now();
    let interval = Duration::from_secs(cfg.collection.interval_s);
    let mut shutdown = install_shutdown_handler();
    let ws_cfg = build_ws_config(&cfg);

    tracing::info!(
        observer_id = %cfg.observer_id,
        interval_s = cfg.collection.interval_s,
        ws_request_timeout_s = cfg.holochain.ws_request_timeout_s,
        "starting observer loop"
    );

    loop {
        let cycle_start = Instant::now();

        select! {
            res = run_cycle(&cfg, started_at, ws_cfg.clone()) => {
                if let Err(e) = res {
                    tracing::error!(error = %e, "collection cycle failed");
                }
            }
            _ = shutdown.changed() => {
                tracing::info!("shutdown signal received, exiting observer loop");
                return Ok(());
            }
        }

        let elapsed = cycle_start.elapsed();
        let sleep_for = interval.checked_sub(elapsed).unwrap_or(Duration::ZERO);
        select! {
            _ = tokio::time::sleep(sleep_for) => {}
            _ = shutdown.changed() => {
                tracing::info!("shutdown signal received during idle, exiting observer loop");
                return Ok(());
            }
        }
    }
}

pub async fn run_once(cfg: &ObserverConfig) -> Result<()> {
    let ws_cfg = build_ws_config(cfg);
    run_cycle(cfg, Instant::now(), ws_cfg).await
}

fn build_ws_config(cfg: &ObserverConfig) -> Arc<WebsocketConfig> {
    let mut c = WebsocketConfig::CLIENT_DEFAULT;
    c.default_request_timeout = Duration::from_secs(cfg.holochain.ws_request_timeout_s);
    Arc::new(c)
}

async fn connect_admin_with_retry(
    admin_port: u16,
    ws_cfg: Arc<WebsocketConfig>,
) -> Result<AdminWebsocket> {
    let backoff = BackoffConfig::default();
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), admin_port);
    let mut attempt: u32 = 0;

    loop {
        match AdminWebsocket::connect_with_config(addr, ws_cfg.clone(), None).await {
            Ok(ws) => return Ok(ws),
            Err(e) => {
                let err = anyhow::anyhow!("admin websocket connect: {e:?}");
                let transient = is_connection_error(&err);
                attempt += 1;
                if attempt >= MAX_CONNECT_ATTEMPTS_PER_CYCLE || !transient {
                    return Err(err.context(format!("giving up after {attempt} attempt(s)")));
                }
                let delay_ms = compute_delay_ms(attempt, &backoff);
                tracing::warn!(
                    error = %err,
                    attempt,
                    delay_ms,
                    "admin websocket connect failed, retrying"
                );
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
}

async fn run_cycle(
    cfg: &ObserverConfig,
    started_at: Instant,
    ws_cfg: Arc<WebsocketConfig>,
) -> Result<()> {
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
    .unwrap_or_else(|join_err| {
        tracing::error!(error = %join_err, "janitor task panicked");
        Ok(Default::default())
    }) {
        tracing::warn!(error = %e, "export dir janitor failed");
    }

    let admin = connect_admin_with_retry(cfg.holochain.admin_port, ws_cfg).await?;

    let collected = collect_node_snapshot(&collector_cfg, &admin)
        .await
        .context("collect_node_snapshot")?;

    let self_health = SelfHealth {
        uptime_s: started_at.elapsed().as_secs(),
        last_collection_ms: t0.elapsed().as_millis() as u64,
        n_errors_this_cycle: collected.degraded_reads,
        binary_version: BINARY_VERSION.to_string(),
    };

    let payload = IngestPayload {
        schema_version: SCHEMA_VERSION,
        observer_id: cfg.observer_id.clone(),
        collected_at: Utc::now().to_rfc3339(),
        self_health,
        node: collected.node,
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
