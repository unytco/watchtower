use std::collections::HashMap;
use tabled::{settings::Style, Table, Tabled};
use unyt_watchtower_core::{DnaSnapshot, NodeSnapshot};

pub fn status(snap: &NodeSnapshot, observer_id: &str) {
    println!("observer: {observer_id}");
    println!(
        "apps:     {} running, {} paused, {} disabled",
        snap.conductor.running_apps, snap.conductor.paused_apps, snap.conductor.disabled_apps
    );
    println!(
        "nonces:   {} unique, {} duplicates",
        snap.conductor.nonce_count, snap.conductor.nonce_duplicate_count
    );
    println!("dnas:     {}", snap.dnas.len());
    for d in &snap.dnas {
        let name = d.dna_tag.as_deref().unwrap_or(&d.dna_b64);
        println!(
            "  - {name}: {} agents, {} warrants, pending={}, integrated={}",
            d.agents.len(),
            d.warrants.len(),
            d.pending_ops_count,
            d.integrated_ops_count
        );
    }
}

#[derive(Tabled)]
struct AgentRow {
    tag: String,
    agent: String,
    actions: u32,
    warrants_issued: u32,
    warrants_against: u32,
}

pub fn agents(d: &DnaSnapshot) {
    let rows: Vec<AgentRow> = d
        .agents
        .iter()
        .map(|a| AgentRow {
            tag: a.agent_tag.clone().unwrap_or_default(),
            agent: truncate(&a.agent_b64),
            actions: a.action_count,
            warrants_issued: a.warrants_issued,
            warrants_against: a.warrants_against,
        })
        .collect();
    let mut t = Table::new(rows);
    t.with(Style::rounded());
    println!("{t}");
}

#[derive(Tabled)]
struct WarrantRow {
    dna: String,
    ts: String,
    typ: String,
    author: String,
    target: String,
}

pub fn warrants(snap: &NodeSnapshot, filter: Option<&str>) {
    let mut rows = Vec::new();
    for d in &snap.dnas {
        if let Some(f) = filter {
            if d.dna_b64 != f && d.dna_tag.as_deref() != Some(f) {
                continue;
            }
        }
        let dna_name = d.dna_tag.clone().unwrap_or_else(|| truncate(&d.dna_b64));
        for w in &d.warrants {
            rows.push(WarrantRow {
                dna: dna_name.clone(),
                ts: w.ts_iso.clone(),
                typ: w.warrant_type.clone(),
                author: truncate(&w.author_b64),
                target: truncate(&w.target_b64),
            });
        }
    }
    if rows.is_empty() {
        println!("no warrants");
        return;
    }
    let mut t = Table::new(rows);
    t.with(Style::rounded());
    println!("{t}");
}

#[derive(Tabled)]
struct CoverageRow {
    op: String,
    receipts: u32,
}

pub fn coverage(d: &DnaSnapshot) {
    let rows: Vec<CoverageRow> = d
        .validation_coverage
        .iter()
        .map(|c| CoverageRow {
            op: truncate(&c.op_hash_b64),
            receipts: c.receipt_count,
        })
        .collect();
    if rows.is_empty() {
        println!("no coverage data");
        return;
    }
    let mut t = Table::new(rows);
    t.with(Style::rounded());
    println!("{t}");
}

#[derive(Tabled)]
struct TagRow {
    kind: &'static str,
    hash: String,
    name: String,
}

pub fn tags(agent: &HashMap<String, String>, dna: &HashMap<String, String>) {
    let mut rows = Vec::new();
    for (h, name) in agent {
        rows.push(TagRow {
            kind: "agent",
            hash: truncate(h),
            name: name.clone(),
        });
    }
    for (h, name) in dna {
        rows.push(TagRow {
            kind: "dna",
            hash: truncate(h),
            name: name.clone(),
        });
    }
    if rows.is_empty() {
        println!("no tags configured");
        return;
    }
    let mut t = Table::new(rows);
    t.with(Style::rounded());
    println!("{t}");
}

fn truncate(s: &str) -> String {
    if s.len() <= 16 {
        s.to_string()
    } else {
        format!("{}…{}", &s[..8], &s[s.len() - 4..])
    }
}
