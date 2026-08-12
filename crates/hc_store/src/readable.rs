// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2025-2026 ThetaSinner <ThetaSinner@users.noreply.github.com>
// Upstream: https://github.com/ThetaSinner/hc-ops
// Copyright (C) 2025-2026 Unyt contributors (this modified version)
//
// The JSON prettification here originated in ThetaSinner/hc-ops @
// b7359a7d4b8d8e5021eb0645eae30f90bc1301d0 and is no longer synced from it:
// upstream targets Holochain 0.6, whose action and op shapes this file no
// longer matches.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
// General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

use crate::retrieve::{BlockRecord, ChainRecord, LimboOp, Record, WarrantOp, WarrantRecord};
use crate::{HcOpsError, HcOpsResult, HcOpsResultContextExt};
use base64::Engine;
use holo_hash::WarrantHash;
use holochain_conductor_api::AppInfo;
use holochain_integrity_types::prelude::Action;
use holochain_types::network::Kitsune2NetworkMetrics;
use holochain_zome_types::prelude::{
    ActionHash, AgentPubKey, AnyDhtHash, DhtOpHash, DnaHash, Entry, EntryHash, SignedActionHashed,
    Timestamp,
};
use kitsune2_api::{AgentInfoSigned, TransportStats};
use serde::Serialize;
use std::collections::HashMap;
use std::fmt::Debug;
use std::sync::Arc;

pub trait HumanReadable {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value>;

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value>;
}

pub trait HumanReadableDisplay: HumanReadable {
    fn as_human_readable(&self) -> HcOpsResult<String> {
        Ok(serde_json::to_string(&self.as_human_readable_raw()?)?)
    }

    fn as_human_readable_pretty(&self) -> HcOpsResult<String> {
        Ok(serde_json::to_string_pretty(
            &self.as_human_readable_raw()?,
        )?)
    }

    fn as_human_readable_summary(&self) -> HcOpsResult<String> {
        Ok(serde_json::to_string(
            &self.as_human_readable_summary_raw()?,
        )?)
    }

    fn as_human_readable_summary_pretty(&self) -> HcOpsResult<String> {
        Ok(serde_json::to_string_pretty(
            &self.as_human_readable_summary_raw()?,
        )?)
    }
}

impl<T> HumanReadable for Vec<T>
where
    T: HumanReadable,
{
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let out = self
            .iter()
            .map(|item| item.as_human_readable_raw())
            .collect::<HcOpsResult<Vec<_>>>()?;

        Ok(serde_json::Value::Array(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        let out = self
            .iter()
            .map(|item| item.as_human_readable_summary_raw())
            .collect::<HcOpsResult<Vec<_>>>()?;

        Ok(serde_json::Value::Array(out))
    }
}

impl<T: HumanReadable> HumanReadableDisplay for Vec<T> {
    fn as_human_readable(&self) -> HcOpsResult<String> {
        let mut out = Vec::with_capacity(self.len());

        for item in self {
            out.push(item.as_human_readable_raw()?);
        }

        Ok(serde_json::to_string(&serde_json::Value::Array(out))?)
    }

    fn as_human_readable_pretty(&self) -> HcOpsResult<String> {
        let mut out = Vec::with_capacity(self.len());

        for item in self {
            out.push(item.as_human_readable_raw()?);
        }

        Ok(serde_json::to_string_pretty(&serde_json::Value::Array(
            out,
        ))?)
    }

    fn as_human_readable_summary(&self) -> HcOpsResult<String> {
        let mut out = Vec::with_capacity(self.len());

        for item in self {
            out.push(item.as_human_readable_summary_raw()?);
        }

        Ok(serde_json::to_string(&serde_json::Value::Array(out))?)
    }

    fn as_human_readable_summary_pretty(&self) -> HcOpsResult<String> {
        let mut out = Vec::with_capacity(self.len());

        for item in self {
            out.push(item.as_human_readable_summary_raw()?);
        }

        Ok(serde_json::to_string_pretty(&serde_json::Value::Array(
            out,
        ))?)
    }
}

impl HumanReadable for AppInfo {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut app_info: serde_json::Value = serde_json::from_str(&serde_json::to_string(&self)?)?;

        replace_field(&mut app_info, "agent_pub_key", transform_agent_pub_key)?;

        for (_, value) in app_info
            .get_mut("cell_info")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| HcOpsError::Other("Unexpected cell info format".into()))?
        {
            for cell in value.as_array_mut().unwrap() {
                let cell = cell.as_object_mut().unwrap();

                if let Some(cell_type) = cell.get("type").and_then(|c| c.as_str()) {
                    if cell_type == "provisioned" {
                        if let Some(value) = cell.get_mut("value") {
                            replace_field(value, "cell_id", transform_cell_id)?;
                        }
                    } else if cell_type == "cloned" {
                        if let Some(value) = cell.get_mut("value") {
                            replace_field(value, "cell_id", transform_cell_id)?;
                            replace_field(value, "original_dna_hash", transform_dna_hash)?
                        }
                    }
                }
            }
        }

        Ok(app_info)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut app_info = self.as_human_readable_raw()?;

        app_info.as_object_mut().unwrap().remove("manifest");

        Ok(app_info)
    }
}

/// Prettify the op fields the three op shapes share. `basis_hash` is rendered
/// generically: the column stores the type-stripped bytes, so it is rebuilt as
/// an `External` hash and would not parse as a DHT hash.
fn transform_op_fields(op: &mut serde_json::Value) -> HcOpsResult<()> {
    replace_field(op, "hash", transform_dht_op_hash)?;
    replace_field(op, "authored_timestamp", transform_timestamp)?;

    if op.get("basis_hash").is_some() {
        replace_field(op, "basis_hash", transform_generic_hash)?;
    }
    if op.get("action_hash").is_some() {
        replace_field(op, "action_hash", transform_action_or_warrant_hash)?;
    }
    if op.get("when_received").is_some() {
        replace_field(op, "when_received", transform_timestamp)?;
    }
    if op.get("when_integrated").is_some() {
        replace_field(op, "when_integrated", transform_timestamp)?;
    }

    if let Some(meta) = op.get_mut("meta").and_then(|v| v.as_object_mut()) {
        for field in [
            "when_received",
            "when_integrated",
            "last_validation_attempt",
        ] {
            if let Some(value) = meta.get(field) {
                meta[field] = transform_timestamp(value)?;
            }
        }
    }

    Ok(())
}

fn op_as_human_readable<T: Serialize>(op: &T) -> HcOpsResult<serde_json::Value> {
    let mut value: serde_json::Value = serde_json::to_value(op)?;
    transform_op_fields(&mut value)?;
    Ok(value)
}

fn op_summary(op: &serde_json::Value) -> serde_json::Value {
    let mut summary = op.clone();
    if let Some(obj) = summary.as_object_mut() {
        obj.remove("meta");
    }
    summary
}

impl HumanReadable for LimboOp {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        op_as_human_readable(self)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        Ok(op_summary(&self.as_human_readable_raw()?))
    }
}

impl HumanReadable for WarrantOp {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        op_as_human_readable(self)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        Ok(op_summary(&self.as_human_readable_raw()?))
    }
}

impl HumanReadable for Action {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut action: serde_json::Value = serde_json::to_value(self)?;

        if let Some(header) = action.get_mut("header").and_then(|v| v.as_object_mut()) {
            header["author"] = transform_agent_pub_key(&header["author"])?;
            header["timestamp"] = transform_timestamp(&header["timestamp"])?;
            if !header["prev_action"].is_null() {
                header["prev_action"] = transform_action_hash(&header["prev_action"])?;
            }
        }

        if let Some(data) = action.get_mut("data").and_then(|v| v.as_object_mut()) {
            transform_action_data(data)?;
        }

        Ok(action)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

/// Prettify the hash-bearing fields of one `ActionData` variant. `ActionData`
/// is `#[serde(tag = "type")]`, so the variant's own fields sit alongside
/// `type` in the same object.
fn transform_action_data(data: &mut serde_json::Map<String, serde_json::Value>) -> HcOpsResult<()> {
    // Present on Create and Update.
    if data.contains_key("entry_hash") {
        data["entry_hash"] = transform_entry_hash(&data["entry_hash"])?;
    }

    let Some(action_type) = data
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    else {
        return Ok(());
    };

    match action_type.as_str() {
        "Dna" => data["dna_hash"] = transform_dna_hash(&data["dna_hash"])?,
        "CreateLink" => {
            data["base_address"] = transform_any_linkable_hash(&data["base_address"])?;
            data["target_address"] = transform_any_linkable_hash(&data["target_address"])?;
            data["tag"] = transform_msgpack_blob(&data["tag"])?;
        }
        "DeleteLink" => {
            data["base_address"] = transform_any_linkable_hash(&data["base_address"])?;
            data["link_add_address"] = transform_action_hash(&data["link_add_address"])?;
        }
        "Update" => {
            data["original_action_address"] =
                transform_action_hash(&data["original_action_address"])?;
            data["original_entry_address"] = transform_entry_hash(&data["original_entry_address"])?;
        }
        "Delete" => {
            data["deletes_address"] = transform_action_hash(&data["deletes_address"])?;
            data["deletes_entry_address"] = transform_entry_hash(&data["deletes_entry_address"])?;
        }
        // `new_target` is optional; `transform_migration_target` passes a
        // JSON null straight through, so no guard is needed here.
        "CloseChain" => data["new_target"] = transform_migration_target(&data["new_target"])?,
        "OpenChain" => {
            data["prev_target"] = transform_migration_target(&data["prev_target"])?;
            data["close_hash"] = transform_action_hash(&data["close_hash"])?;
        }
        _ => {}
    }

    Ok(())
}

/// A `MigrationTarget` names either the DNA a chain moved to/from or the agent
/// it was transferred to/from. Rendering it is what makes a migration export
/// readable, so both arms are handled rather than left as raw byte arrays.
fn transform_migration_target(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    let mut target = input.clone();
    let Some(obj) = target.as_object_mut() else {
        return Ok(target);
    };
    if let Some(dna) = obj.get("Dna") {
        obj["Dna"] = transform_dna_hash(dna)?;
    }
    if let Some(agent) = obj.get("Agent") {
        obj["Agent"] = transform_agent_pub_key(agent)?;
    }
    Ok(target)
}

impl HumanReadable for SignedActionHashed {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();

        out.insert(
            "content".to_string(),
            self.hashed.content.as_human_readable_raw()?,
        );
        let hash = serde_json::from_str(&serde_json::to_string(&self.hashed.hash)?)?;
        out.insert("hash".to_string(), transform_action_hash(&hash)?);
        let sig = serde_json::from_str(&serde_json::to_string(&self.signature)?)?;
        out.insert("signature".to_string(), transform_flatten_byte_array(&sig)?);

        Ok(serde_json::Value::Object(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadable for Entry {
    #[allow(clippy::collapsible_if)]
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out: serde_json::Value = serde_json::from_str(&serde_json::to_string(&self)?)?;

        if let Some(out) = out.as_object_mut() {
            if out.contains_key("entry") {
                if out.contains_key("entry_type") {
                    if out["entry_type"] == "Agent" {
                        out["entry"] = transform_agent_pub_key(&out["entry"])?;
                    }
                    if out["entry_type"] == "App" {
                        out["entry"] = transform_msgpack_blob(&out["entry"])
                            .context("Could not convert app entry from msgpack")?;
                    }
                    if out["entry_type"] == "CapClaim" {
                        if let Some(entry) = out["entry"].as_object_mut() {
                            if entry.contains_key("grantor") {
                                entry["grantor"] = transform_agent_pub_key(&entry["grantor"])?;
                            }
                            if entry.contains_key("secret") {
                                entry["secret"] = serde_json::Value::String("...".to_string())
                            }
                        }
                    }
                    if out["entry_type"] == "CapGrant" {
                        if let Some(entry) = out["entry"].as_object_mut() {
                            if let Some(access) =
                                entry.get_mut("access").and_then(|v| v.as_object_mut())
                            {
                                if access.contains_key("Assigned") {
                                    if let Some(assigned) = access["Assigned"].as_object_mut() {
                                        if assigned.contains_key("secret") {
                                            assigned["secret"] =
                                                serde_json::Value::String("...".to_string())
                                        }

                                        if assigned.contains_key("assignees") {
                                            if let Some(assignees) =
                                                assigned["assignees"].as_array_mut()
                                            {
                                                for assignee in assignees {
                                                    *assignee = transform_agent_pub_key(assignee)?;
                                                }
                                            }
                                        }
                                    }
                                } else if access.contains_key("Transferable") {
                                    if let Some(transferable) =
                                        access["Transferable"].as_object_mut()
                                    {
                                        if transferable.contains_key("secret") {
                                            transferable["secret"] =
                                                serde_json::Value::String("...".to_string())
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(out)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadable for AgentPubKey {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        Ok(serde_json::Value::String(format!("{:?}", self)))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadable for ChainRecord {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut obj = serde_json::Map::new();
        obj.insert("action".to_string(), self.action.as_human_readable_raw()?);
        obj.insert(
            "validation_status".to_string(),
            serde_json::Value::String(format!("{:?}", self.validation_status)),
        );
        obj.insert(
            "entry".to_string(),
            self.entry
                .as_ref()
                .map(|e: &Entry| -> HcOpsResult<serde_json::Value> { e.as_human_readable_raw() })
                .transpose()?
                .unwrap_or(serde_json::Value::Null),
        );

        Ok(serde_json::Value::Object(obj))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadableDisplay for WarrantRecord {}

impl HumanReadable for WarrantRecord {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();
        out.insert("dht_op".to_string(), self.dht_op.as_human_readable_raw()?);

        let mut warrant: serde_json::Value = serde_json::to_value(&self.warrant)?;

        if let Some(signature) = warrant.get("signature") {
            let sig = transform_flatten_byte_array(signature)?;
            warrant
                .as_object_mut()
                .ok_or_else(|| HcOpsError::Other("Unexpected signed warrant shape".into()))?
                .insert("signature".to_string(), sig);
        }

        let data = warrant
            .get_mut("data")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| HcOpsError::Other("Unexpected signed warrant shape".into()))?;

        if data.contains_key("author") {
            data["author"] = transform_agent_pub_key(&data["author"])?;
        }

        if data.contains_key("warrantee") {
            data["warrantee"] = transform_agent_pub_key(&data["warrantee"])?;
        }

        if data.contains_key("timestamp") {
            data["timestamp"] = transform_timestamp(&data["timestamp"])?;
        }

        if let Some(chain_integrity) = data
            .get_mut("proof")
            .and_then(|v| v.as_object_mut())
            .and_then(|o| o.get_mut("ChainIntegrity"))
            .and_then(|v| v.as_object_mut())
        {
            if let Some(invalid) = chain_integrity
                .get_mut("InvalidChainOp")
                .and_then(|v| v.as_object_mut())
            {
                if invalid.contains_key("action_author") {
                    invalid["action_author"] = transform_agent_pub_key(&invalid["action_author"])?;
                }
                if let Some(pair) = invalid.get_mut("action").and_then(|v| v.as_array_mut()) {
                    transform_action_hash_and_sig(pair)?;
                }
            }

            if let Some(fork) = chain_integrity
                .get_mut("ChainFork")
                .and_then(|v| v.as_object_mut())
            {
                if fork.contains_key("chain_author") {
                    fork["chain_author"] = transform_agent_pub_key(&fork["chain_author"])?;
                }
                if let Some(action_pair) =
                    fork.get_mut("action_pair").and_then(|v| v.as_array_mut())
                {
                    for item in action_pair.iter_mut() {
                        if let Some(pair) = item.as_array_mut() {
                            transform_action_hash_and_sig(pair)?;
                        }
                    }
                }
            }
        }

        out.insert("warrant".to_string(), warrant);
        Ok(serde_json::Value::Object(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

fn transform_action_hash_and_sig(pair: &mut [serde_json::Value]) -> HcOpsResult<()> {
    if pair.len() != 2 {
        return Err(HcOpsError::Other(
            "Expected (ActionHash, Signature) tuple".into(),
        ));
    }
    pair[0] = transform_action_hash(&pair[0])?;
    pair[1] = transform_flatten_byte_array(&pair[1])?;
    Ok(())
}

impl HumanReadableDisplay for BlockRecord {}

impl HumanReadable for BlockRecord {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();
        out.insert("id".to_string(), serde_json::Value::Number(self.id.into()));
        out.insert(
            "target".to_string(),
            transform_block_target_id(&self.target)?,
        );
        out.insert(
            "reason".to_string(),
            transform_block_target_reason(&self.reason)?,
        );
        out.insert(
            "start".to_string(),
            serde_json::Value::String(self.start.to_string()),
        );
        out.insert(
            "end".to_string(),
            serde_json::Value::String(self.end.to_string()),
        );
        Ok(serde_json::Value::Object(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

fn transform_block_target_id(
    target: &holochain_zome_types::prelude::BlockTargetId,
) -> HcOpsResult<serde_json::Value> {
    let mut value = serde_json::to_value(target)?;

    if let Some(cell) = value.as_object_mut().and_then(|o| o.get_mut("Cell")) {
        *cell = transform_cell_id(cell)?;
    }

    #[allow(deprecated)]
    if let Some(node_dna) = value
        .as_object_mut()
        .and_then(|o| o.get_mut("NodeDna"))
        .and_then(|v| v.as_array_mut())
    {
        if node_dna.len() == 2 {
            node_dna[1] = transform_dna_hash(&node_dna[1])?;
        }
    }

    Ok(value)
}

fn transform_block_target_reason(
    reason: &holochain_zome_types::prelude::BlockTargetReason,
) -> HcOpsResult<serde_json::Value> {
    let mut value = serde_json::to_value(reason)?;

    if let Some(cell) = value
        .as_object_mut()
        .and_then(|o| o.get_mut("Cell"))
        .and_then(|v| v.as_object_mut())
        && let Some(invalid_op) = cell.get_mut("InvalidOp")
    {
        *invalid_op = transform_dht_op_hash(invalid_op)?;
    }

    Ok(value)
}

impl HumanReadableDisplay for Record {}

impl HumanReadable for Record {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();

        out.insert("dht_op".to_string(), self.dht_op.as_human_readable_raw()?);
        out.insert("action".to_string(), self.action.as_human_readable_raw()?);
        out.insert(
            "entry".to_string(),
            self.entry
                .as_ref()
                .map(|e| e.as_human_readable_raw())
                .transpose()?
                .unwrap_or(serde_json::Value::Null),
        );

        Ok(serde_json::Value::Object(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();

        out.insert(
            "dht_op".to_string(),
            self.dht_op.as_human_readable_summary_raw()?,
        );
        out.insert(
            "action".to_string(),
            self.action.as_human_readable_summary_raw()?,
        );
        out.insert(
            "entry".to_string(),
            self.entry
                .as_ref()
                .map(|e| e.as_human_readable_summary_raw())
                .transpose()?
                .unwrap_or(serde_json::Value::Null),
        );

        Ok(serde_json::Value::Object(out))
    }
}

impl HumanReadable for Kitsune2NetworkMetrics {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out: serde_json::Value = serde_json::from_str(&serde_json::to_string(&self)?)?;

        if let Some(metrics) = out.as_object_mut() {
            if let Some(gossip_state_summary) = metrics.get_mut("gossip_state_summary") {
                if let Some(dht_summary) = gossip_state_summary
                    .as_object_mut()
                    .and_then(|v| v.get_mut("dht_summary"))
                    .and_then(|v| v.as_object_mut())
                {
                    for (_, value) in dht_summary.iter_mut() {
                        if let Some(value) = value.as_object_mut() {
                            if let Some(disc_boundary) = value.get_mut("disc_boundary") {
                                *disc_boundary = transform_timestamp(disc_boundary)?;
                            }

                            if let Some(disc_top_hash) = value.get_mut("disc_top_hash") {
                                *disc_top_hash = transform_generic_hash(disc_top_hash)?;
                            }
                            if let Some(ring_top_hashes) = value
                                .get_mut("ring_top_hashes")
                                .and_then(|v| v.as_array_mut())
                            {
                                for ring_top_hash in ring_top_hashes {
                                    *ring_top_hash = transform_generic_hash(ring_top_hash)?;
                                }
                            }
                        }
                    }
                }

                if let Some(peer_meta) = gossip_state_summary
                    .as_object_mut()
                    .and_then(|v| v.get_mut("peer_meta"))
                    .and_then(|v| v.as_object_mut())
                {
                    for (_, value) in peer_meta.iter_mut() {
                        if let Some(value) = value.as_object_mut() {
                            if let Some(last_gossip_timestamp) =
                                value.get_mut("last_gossip_timestamp")
                            {
                                *last_gossip_timestamp =
                                    transform_timestamp(last_gossip_timestamp)?;
                            }
                            if let Some(new_ops_bookmark) = value.get_mut("new_ops_bookmark") {
                                *new_ops_bookmark = transform_timestamp(new_ops_bookmark)?;
                            }
                        }
                    }
                }
            }

            if let Some(local_agents) = metrics
                .get_mut("local_agents")
                .and_then(|v| v.as_array_mut())
            {
                for agent in local_agents {
                    if let Some(agent) = agent.as_object_mut()
                        && let Some(agent) = agent.get_mut("agent")
                    {
                        *agent = transform_agent_pub_key(agent)?;
                    }
                }
            }
        }

        Ok(out)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadable for TransportStats {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out: serde_json::Value = serde_json::from_str(&serde_json::to_string(&self)?)?;

        if let Some(connections) = out
            .as_object_mut()
            .and_then(|o| o.get_mut("connections"))
            .and_then(|v| v.as_array_mut())
        {
            for connection in connections {
                if let Some(conn_obj) = connection.as_object_mut() {
                    if let Some(opened_at) = conn_obj.get_mut("opened_at_s") {
                        *opened_at = serde_json::Value::String(
                            Timestamp(
                                opened_at
                                    .as_u64()
                                    .ok_or_else(|| HcOpsError::Other("Invalid timestamp".into()))?
                                    as i64
                                    * 1_000_000,
                            )
                            .to_string(),
                        );
                    }

                    if let Some(recv_bytes) = conn_obj.get("recv_bytes") {
                        conn_obj.insert("recv".to_string(), transform_bytes_size(recv_bytes)?);
                        conn_obj.remove("recv_bytes");
                    }

                    if let Some(send_bytes) = conn_obj.get("send_bytes") {
                        conn_obj.insert("send".to_string(), transform_bytes_size(send_bytes)?);
                        conn_obj.remove("send_bytes");
                    }
                }
            }
        }

        Ok(out)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadableDisplay for TransportStats {}

impl HumanReadable for AgentInfoSigned {
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut value = serde_json::to_value(self.get_agent_info())?;

        if let Some(agent_info) = value.as_object_mut() {
            if let Some(agent) = agent_info.get_mut("agent") {
                *agent = serde_json::Value::String(format!(
                    "{:?}",
                    AgentPubKey::from_k2_agent(&self.get_agent_info().agent)
                ));
            }

            if let Some(space) = agent_info.get_mut("space") {
                *space = serde_json::Value::String(format!(
                    "{:?}",
                    DnaHash::from_k2_space(&self.get_agent_info().space)
                ));
            }

            if let Some(created_at) = agent_info.get_mut("createdAt") {
                *created_at = transform_timestamp_ns(created_at)?;
            }

            if let Some(expires_at) = agent_info.get_mut("expiresAt") {
                *expires_at = transform_timestamp_ns(expires_at)?;
            }
        }

        Ok(value)
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl HumanReadableDisplay for AgentInfoSigned {}

impl<K, V> HumanReadable for HashMap<K, V>
where
    K: Debug,
    V: HumanReadable,
{
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        let mut out = serde_json::Map::new();

        for (key, value) in self {
            out.insert(format!("{:?}", key), value.as_human_readable_raw()?);
        }

        Ok(serde_json::Value::Object(out))
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_human_readable_raw()
    }
}

impl<K, V> HumanReadableDisplay for HashMap<K, V>
where
    K: Debug,
    V: HumanReadable,
{
}

impl<T> HumanReadable for Arc<T>
where
    T: HumanReadable,
{
    fn as_human_readable_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_ref().as_human_readable_raw()
    }

    fn as_human_readable_summary_raw(&self) -> HcOpsResult<serde_json::Value> {
        self.as_ref().as_human_readable_summary_raw()
    }
}

impl<T> HumanReadableDisplay for Arc<T> where T: HumanReadable {}

fn convert_byte_array(from: &[serde_json::Value]) -> HcOpsResult<Vec<u8>> {
    from.iter()
        .map(|v| {
            v.as_u64()
                .map(|v| v as u8)
                .ok_or_else(|| HcOpsError::Other("Invalid byte array field".into()))
        })
        .collect::<HcOpsResult<Vec<u8>>>()
}

fn replace_field(
    input: &mut serde_json::Value,
    field: &str,
    transform: fn(&serde_json::Value) -> HcOpsResult<serde_json::Value>,
) -> HcOpsResult<()> {
    *input
        .get_mut(field)
        .ok_or_else(|| HcOpsError::Other(format!("Missing field: {field}").into()))? =
        transform(input.get(field).unwrap())?;

    Ok(())
}

fn transform_cell_id(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    let mut out = Vec::with_capacity(2);

    let cell_id = input
        .as_array()
        .ok_or_else(|| HcOpsError::Other("Cannot convert to a cell id, not an array".into()))?;

    if cell_id.len() != 2 {
        return Err(HcOpsError::Other(
            "Invalid cell id, should have two components".into(),
        ));
    }

    out.push(transform_dna_hash(&cell_id[0])?);
    out.push(transform_agent_pub_key(&cell_id[1])?);

    Ok(serde_json::Value::Array(out))
}

fn transform_dna_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        DnaHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to a dna hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_agent_pub_key(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        AgentPubKey::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to an agent pub key, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_dht_op_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        DhtOpHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to a dht op hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_any_linkable_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        AnyDhtHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to an any dht op hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_action_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        ActionHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to an action hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_action_or_warrant_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    // Try as an action hash first, if that fails, try as a warrant hash
    match transform_action_hash(input) {
        Ok(hash) => Ok(hash),
        Err(_) => transform_warrant_hash(input),
    }
}

fn transform_warrant_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        WarrantHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to a warrant hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_entry_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    Ok(serde_json::Value::String(format!(
        "{:?}",
        EntryHash::try_from_raw_39(convert_byte_array(input.as_array().ok_or_else(|| {
            HcOpsError::Other("Cannot convert to an entry hash, not an array".into())
        })?)?)
        .map_err(HcOpsError::other)?
    )))
}

fn transform_generic_hash(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    if let Some(arr) = input.as_array() {
        Ok(serde_json::Value::String(
            base64::prelude::BASE64_STANDARD.encode(convert_byte_array(arr)?),
        ))
    } else {
        Err(HcOpsError::Other("Invalid generic hash format".into()))
    }
}

fn transform_timestamp(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    if input.is_null() {
        return Ok(serde_json::Value::Null);
    }

    Ok(serde_json::Value::String(
        Timestamp(
            input
                .as_u64()
                .ok_or_else(|| HcOpsError::Other("Invalid timestamp".into()))? as i64,
        )
        .to_string(),
    ))
}

fn transform_timestamp_ns(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    if input.is_null() {
        return Ok(serde_json::Value::Null);
    }

    Ok(serde_json::Value::String(
        Timestamp(
            input
                .as_str()
                .ok_or_else(|| HcOpsError::Other("Invalid timestamp".into()))?
                .parse::<u64>()
                .map_err(|_| HcOpsError::Other("Invalid timestamp format".into()))?
                as i64,
        )
        .to_string(),
    ))
}

fn transform_msgpack_blob(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    let blob = convert_byte_array(
        input
            .as_array()
            .ok_or_else(|| HcOpsError::Other("Invalid msgpack blob".into()))?,
    )?;

    match rmpv::decode::read_value(&mut &blob[..]) {
        Ok(val) => Ok(msgpack_value_to_json(val)),
        Err(_) => transform_flatten_byte_array(input),
    }
}

/// Convert an rmpv::Value (which supports all msgpack types including Binary
/// and integer map keys) into a serde_json::Value. Binary data is encoded as a
/// base64url string; integer map keys become strings; Ext values become a
/// `{ "_ext_type": n, "_ext_data": "<b64url>" }` object.
fn msgpack_value_to_json(val: rmpv::Value) -> serde_json::Value {
    match val {
        rmpv::Value::Nil => serde_json::Value::Null,
        rmpv::Value::Boolean(b) => serde_json::Value::Bool(b),
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                serde_json::Value::Number(n.into())
            } else if let Some(n) = i.as_u64() {
                serde_json::Value::Number(n.into())
            } else {
                serde_json::Value::String(i.to_string())
            }
        }
        rmpv::Value::F32(f) => serde_json::Number::from_f64(f64::from(f))
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rmpv::Value::F64(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        rmpv::Value::String(s) => {
            serde_json::Value::String(s.into_str().unwrap_or_default().to_owned())
        }
        rmpv::Value::Binary(bytes) => {
            serde_json::Value::String(base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(&bytes))
        }
        rmpv::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(msgpack_value_to_json).collect())
        }
        rmpv::Value::Map(pairs) => {
            let map: serde_json::Map<String, serde_json::Value> = pairs
                .into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        rmpv::Value::String(s) => s.into_str().unwrap_or_default().to_owned(),
                        rmpv::Value::Integer(i) => i.to_string(),
                        other => format!("{other}"),
                    };
                    (key, msgpack_value_to_json(v))
                })
                .collect();
            serde_json::Value::Object(map)
        }
        rmpv::Value::Ext(type_id, data) => {
            let mut map = serde_json::Map::new();
            map.insert(
                "_ext_type".to_owned(),
                serde_json::Value::Number(type_id.into()),
            );
            map.insert(
                "_ext_data".to_owned(),
                serde_json::Value::String(base64::prelude::BASE64_URL_SAFE_NO_PAD.encode(&data)),
            );
            serde_json::Value::Object(map)
        }
    }
}

fn transform_flatten_byte_array(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    let arr = input
        .as_array()
        .ok_or_else(|| HcOpsError::Other("Invalid byte array".into()))?;

    Ok(serde_json::Value::String(format!(
        "ByteArray([{}])",
        convert_byte_array(arr)?
            .into_iter()
            .map(|b| b.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    )))
}

fn transform_bytes_size(input: &serde_json::Value) -> HcOpsResult<serde_json::Value> {
    let size = input
        .as_u64()
        .ok_or_else(|| HcOpsError::Other("Invalid bytes size".into()))?;

    Ok(serde_json::Value::String(human_bytes::human_bytes(
        size as f64,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes_as_json_array(bytes: &[u8]) -> serde_json::Value {
        serde_json::Value::Array(
            bytes
                .iter()
                .map(|b| serde_json::Value::Number((*b as u64).into()))
                .collect(),
        )
    }

    #[test]
    fn decodes_link_tag_like_msgpack_array() {
        // Equivalent to ["oracle", 1] in msgpack:
        //   0x92 fixarray[2], 0xa6 fixstr[6] "oracle", 0x01
        let bytes = [0x92, 0xa6, b'o', b'r', b'a', b'c', b'l', b'e', 0x01];

        let out = transform_msgpack_blob(&bytes_as_json_array(&bytes))
            .expect("msgpack decode should succeed");

        assert_eq!(
            out,
            serde_json::json!(["oracle", 1]),
            "expected decoded JSON, got {out:?}"
        );
    }

    #[test]
    fn decodes_app_entry_with_embedded_binary_hash() {
        // Equivalent to { "hash": <3 raw bytes> } where the hash is encoded
        // with msgpack bin8. This is the scenario that was previously
        // failing via `holochain_serialized_bytes::decode::<_, serde_json::Value>`
        // because serde_json::Value has no Binary variant.
        //   0x81 fixmap[1], 0xa4 fixstr[4] "hash", 0xc4 bin8, len=3, 1,2,3
        let bytes = [0x81, 0xa4, b'h', b'a', b's', b'h', 0xc4, 0x03, 1, 2, 3];

        let out = transform_msgpack_blob(&bytes_as_json_array(&bytes))
            .expect("msgpack decode should succeed");

        let expected_b64 = base64::prelude::BASE64_URL_SAFE_NO_PAD.encode([1u8, 2, 3]);
        assert_eq!(out, serde_json::json!({ "hash": expected_b64 }));
    }

    #[test]
    fn non_msgpack_bytes_fall_back_to_bytearray() {
        // 0xda = str16: claims a 16-bit length that follows, but we supply
        // neither the length nor the payload, so rmpv must return Err and we
        // fall back to the existing ByteArray stringification.
        let bytes = [0xdau8];

        let out = transform_msgpack_blob(&bytes_as_json_array(&bytes))
            .expect("fallback path should still succeed");

        assert_eq!(
            out,
            serde_json::Value::String("ByteArray([218])".to_string())
        );
    }
}
