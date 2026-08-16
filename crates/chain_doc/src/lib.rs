//! Vendored from `hc-chain-doc`, one-way and by hand: edit that crate, then copy its
//! `lib.rs` back over this one and restore this header. An edit made only here is lost
//! at the next sync, and until then the two decoders disagree about the same dump.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::Utc;
use clap::Parser;
use serde::Serialize;
use serde_json::{Map, Value};

const KNOWN_HASH_FIELDS: &[&str] = &[
    "action_address",
    "author",
    "prev_action",
    "entry_hash",
    "base_address",
    "target_address",
    "link_add_address",
    "hash",
];

#[derive(Parser, Debug)]
#[command(name = "hc-chain-doc")]
#[command(about = "Create a simplified human-readable Holochain source chain dump")]
struct Cli {
    /// Path to an hc dump-state JSON file
    #[arg(long)]
    input: PathBuf,
    /// Path to write the simplified chain JSON output
    #[arg(long, default_value = "chain.simple.json")]
    output: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CliArgs {
    pub input: PathBuf,
    pub output: PathBuf,
}

impl CliArgs {
    pub fn parse_from_env() -> Result<Self> {
        let cli = Cli::try_parse().map_err(|e| anyhow!(e.to_string()))?;
        Ok(Self {
            input: cli.input,
            output: cli.output,
        })
    }
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SimplifiedChain {
    pub input_file: String,
    pub record_count: usize,
    pub generated_at: String,
    pub records: Vec<SimplifiedRecord>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct SimplifiedRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_seq: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_add_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_hash_field: Option<String>,
    pub has_entry: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_entry_type: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_type: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_tag: Option<Value>,
    pub warnings: Vec<String>,
}

pub fn run(args: CliArgs) -> Result<()> {
    let dump = read_dump(&args.input)?;
    let rendered = simplify_dump(&dump, &args.input, Utc::now().to_rfc3339())?;
    let out_json = serde_json::to_string_pretty(&rendered)
        .context("Failed to serialize simplified chain output")?;
    fs::write(&args.output, out_json)
        .with_context(|| format!("Failed to write output file {}", args.output.display()))?;
    Ok(())
}

pub fn read_dump(path: &Path) -> Result<Value> {
    let raw =
        fs::read_to_string(path).with_context(|| format!("Failed to read {}", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("Invalid JSON in {}", path.display()))
}

pub fn simplify_dump(
    root: &Value,
    input_file: &Path,
    generated_at: String,
) -> Result<SimplifiedChain> {
    let records = locate_records(root)?;
    let mut rows = records
        .iter()
        .enumerate()
        .map(|(index, value)| (index, simplify_record(value)))
        .collect::<Vec<_>>();

    rows.sort_by_key(|(idx, row)| (row.action_seq.unwrap_or(0), *idx));
    let mut seen_hashes = HashSet::new();
    for (_, row) in &mut rows {
        if let Some(action_hash) = &row.action_hash
            && !seen_hashes.insert(action_hash.clone())
        {
            row.warnings
                .push(format!("Duplicate action_hash detected: {action_hash}"));
        }
    }

    Ok(SimplifiedChain {
        input_file: input_file.display().to_string(),
        record_count: rows.len(),
        generated_at,
        records: rows.into_iter().map(|(_, row)| row).collect(),
    })
}

fn locate_records(root: &Value) -> Result<&Vec<Value>> {
    let top = root
        .as_array()
        .ok_or_else(|| anyhow!("Expected top-level JSON array from hc dump-state"))?;

    for item in top {
        let records = item
            .get("source_chain_dump")
            .and_then(Value::as_object)
            .and_then(|chain| chain.get("records"))
            .and_then(Value::as_array);
        if let Some(records) = records {
            return Ok(records);
        }
    }
    Err(anyhow!(
        "Could not find source_chain_dump.records in provided dump"
    ))
}

fn simplify_record(record: &Value) -> SimplifiedRecord {
    let mut warnings = Vec::new();
    let Some(record_obj) = record.as_object() else {
        return SimplifiedRecord {
            action_hash: None,
            action_seq: None,
            action_type: None,
            timestamp: None,
            author: None,
            entry_hash: None,
            prev_action: None,
            base_address: None,
            target_address: None,
            link_add_address: None,
            action_hash_field: None,
            has_entry: false,
            entry_type: None,
            app_entry_type: None,
            entry_data: None,
            link_type: None,
            link_tag: None,
            warnings: vec!["Record is not a JSON object".to_string()],
        };
    };

    let action_hash = extract_hash(record_obj, "action_address", &mut warnings);
    let has_entry = !record_obj.get("entry").is_none_or(Value::is_null);
    let action_obj = record_obj.get("action").and_then(Value::as_object);
    let action_seq = action_obj
        .and_then(|a| a.get("action_seq"))
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let action_type = action_obj
        .and_then(|a| a.get("type"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let timestamp = action_obj
        .and_then(|a| a.get("timestamp"))
        .and_then(Value::as_i64);

    let author = action_obj.and_then(|a| extract_hash(a, "author", &mut warnings));
    let entry_hash = action_obj.and_then(|a| extract_hash(a, "entry_hash", &mut warnings));
    let prev_action = action_obj.and_then(|a| extract_hash(a, "prev_action", &mut warnings));
    let base_address = action_obj.and_then(|a| extract_hash(a, "base_address", &mut warnings));
    let target_address = action_obj.and_then(|a| extract_hash(a, "target_address", &mut warnings));
    let link_add_address =
        action_obj.and_then(|a| extract_hash(a, "link_add_address", &mut warnings));
    let action_hash_field = action_obj.and_then(|a| extract_hash(a, "hash", &mut warnings));

    if let Some(a) = action_obj {
        for key in a.keys() {
            if key.ends_with("_hash") && !KNOWN_HASH_FIELDS.contains(&key.as_str()) {
                warnings.push(format!("Unmapped hash-like field in action: {key}"));
            }
        }
    }

    let (entry_type, app_entry_type, entry_data) =
        decode_entry(record_obj, action_obj, &mut warnings);

    let (link_type, link_tag) = decode_link(action_obj, &mut warnings);

    SimplifiedRecord {
        action_hash,
        action_seq,
        action_type,
        timestamp,
        author,
        entry_hash,
        prev_action,
        base_address,
        target_address,
        link_add_address,
        action_hash_field,
        has_entry,
        entry_type,
        app_entry_type,
        entry_data,
        link_type,
        link_tag,
        warnings,
    }
}

fn decode_entry(
    record_obj: &Map<String, Value>,
    action_obj: Option<&Map<String, Value>>,
    warnings: &mut Vec<String>,
) -> (Option<String>, Option<Value>, Option<Value>) {
    let Some(entry_wrapper) = record_obj.get("entry") else {
        return (None, None, None);
    };
    if entry_wrapper.is_null() {
        return (None, None, None);
    }

    let entry_obj = match entry_wrapper.as_object() {
        Some(obj) => obj,
        None => return (None, None, None),
    };

    let entry_type = entry_obj
        .get("entry_type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let app_entry_type = action_obj
        .and_then(|a| a.get("entry_type"))
        .filter(|v| v.is_object())
        .cloned();

    let entry_data = match entry_type.as_deref() {
        Some("App") => decode_app_entry(entry_obj, warnings),
        Some("CapGrant") => entry_obj.get("entry").filter(|v| v.is_object()).cloned(),
        Some("Agent") => entry_obj.get("entry").and_then(|v| {
            let arr = v.as_array()?;
            let bytes = collect_byte_array(arr)?;
            Some(Value::String(URL_SAFE_NO_PAD.encode(bytes)))
        }),
        _ => None,
    };

    (entry_type, app_entry_type, entry_data)
}

fn decode_app_entry(entry_obj: &Map<String, Value>, warnings: &mut Vec<String>) -> Option<Value> {
    let arr = entry_obj.get("entry")?.as_array()?;
    let bytes = match collect_byte_array(arr) {
        Some(b) => b,
        None => {
            warnings.push("App entry bytes contain non-u8 values".to_string());
            return None;
        }
    };

    decode_msgpack_bytes(&bytes, "App entry", warnings)
}

fn decode_link(
    action_obj: Option<&Map<String, Value>>,
    warnings: &mut Vec<String>,
) -> (Option<u64>, Option<Value>) {
    let Some(action) = action_obj else {
        return (None, None);
    };

    let action_type = action.get("type").and_then(Value::as_str);
    if action_type != Some("CreateLink") {
        return (None, None);
    }

    let link_type = action.get("link_type").and_then(Value::as_u64);

    let link_tag = action
        .get("tag")
        .and_then(Value::as_array)
        .and_then(|arr| {
            if arr.is_empty() {
                return None;
            }
            let bytes = collect_byte_array(arr)?;
            Some(bytes)
        })
        .and_then(|bytes| decode_msgpack_bytes(&bytes, "link tag", warnings));

    (link_type, link_tag)
}

fn decode_msgpack_bytes(bytes: &[u8], context: &str, warnings: &mut Vec<String>) -> Option<Value> {
    match rmpv::decode::read_value(&mut &bytes[..]) {
        Ok(msgpack_val) => Some(msgpack_to_json(msgpack_val)),
        Err(e) => {
            warnings.push(format!("Failed to decode {context} msgpack: {e}"));
            None
        }
    }
}

fn collect_byte_array(arr: &[Value]) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(arr.len());
    for item in arr {
        bytes.push(u8::try_from(item.as_u64()?).ok()?);
    }
    Some(bytes)
}

/// Convert an rmpv::Value (which supports all msgpack types including Binary
/// and integer map keys) into a serde_json::Value. Binary data that looks like
/// a 39-byte Holochain hash (starts with 0x84) is encoded as a base64url string;
/// other binary data is also base64url-encoded. Integer map keys become strings.
fn msgpack_to_json(val: rmpv::Value) -> Value {
    match val {
        rmpv::Value::Nil => Value::Null,
        rmpv::Value::Boolean(b) => Value::Bool(b),
        rmpv::Value::Integer(i) => {
            if let Some(n) = i.as_i64() {
                Value::Number(n.into())
            } else if let Some(n) = i.as_u64() {
                Value::Number(n.into())
            } else {
                Value::String(i.to_string())
            }
        }
        rmpv::Value::F32(f) => serde_json::Number::from_f64(f64::from(f))
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rmpv::Value::F64(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rmpv::Value::String(s) => Value::String(s.into_str().unwrap_or_default().to_owned()),
        rmpv::Value::Binary(bytes) => Value::String(URL_SAFE_NO_PAD.encode(&bytes)),
        rmpv::Value::Array(arr) => Value::Array(arr.into_iter().map(msgpack_to_json).collect()),
        rmpv::Value::Map(pairs) => {
            let map: serde_json::Map<String, Value> = pairs
                .into_iter()
                .map(|(k, v)| {
                    let key = match k {
                        rmpv::Value::String(s) => s.into_str().unwrap_or_default().to_owned(),
                        rmpv::Value::Integer(i) => i.to_string(),
                        other => format!("{other}"),
                    };
                    (key, msgpack_to_json(v))
                })
                .collect();
            Value::Object(map)
        }
        rmpv::Value::Ext(type_id, data) => {
            let mut map = serde_json::Map::new();
            map.insert("_ext_type".to_owned(), Value::Number(type_id.into()));
            map.insert(
                "_ext_data".to_owned(),
                Value::String(URL_SAFE_NO_PAD.encode(&data)),
            );
            Value::Object(map)
        }
    }
}

fn extract_hash(
    obj: &Map<String, Value>,
    field: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let value = obj.get(field)?;
    convert_hash_bytes(value, field, warnings)
}

fn convert_hash_bytes(value: &Value, field: &str, warnings: &mut Vec<String>) -> Option<String> {
    let Some(values) = value.as_array() else {
        warnings.push(format!("Field `{field}` is not a byte array"));
        return None;
    };

    let mut bytes = Vec::with_capacity(values.len());
    for (idx, item) in values.iter().enumerate() {
        let Some(num) = item.as_u64() else {
            warnings.push(format!(
                "Field `{field}` contains non-numeric element at index {idx}"
            ));
            return None;
        };
        let Ok(byte) = u8::try_from(num) else {
            warnings.push(format!(
                "Field `{field}` contains value out of byte range at index {idx}"
            ));
            return None;
        };
        bytes.push(byte);
    }

    if bytes.len() != 39 {
        warnings.push(format!(
            "Field `{field}` expected 39 bytes but found {}",
            bytes.len()
        ));
    }

    Some(URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_dump() -> Value {
        serde_json::json!([
          {
            "source_chain_dump": {
              "records": [
                {
                  "action_address": [132,41,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                  "action": {
                    "type": "Dna",
                    "author": [132,32,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "timestamp": 123,
                    "hash": [132,45,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37]
                  },
                  "entry": null
                },
                {
                  "action_address": [132,41,2,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                  "action": {
                    "type": "Create",
                    "action_seq": 1,
                    "entry_type": {"App": {"entry_index": 0, "zome_index": 0, "visibility": "Public"}},
                    "entry_hash": [132,45,3,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "prev_action": [132,41,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "timestamp": 456
                  },
                  "entry": {
                    "entry_type": "App",
                    "entry": [131,164,116,121,112,101,168,80,114,111,112,111,115,97,108,166,97,109,111,117,110,116,163,49,48,48,164,110,111,116,101,164,116,101,115,116]
                  }
                },
                {
                  "action_address": [132,41,3,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                  "action": {
                    "type": "CreateLink",
                    "action_seq": 2,
                    "author": [132,32,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "base_address": [132,33,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "target_address": [132,33,2,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "prev_action": [132,41,2,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37],
                    "timestamp": 1000,
                    "zome_index": 0,
                    "link_type": 10,
                    "tag": [147,166,111,114,97,99,108,101,129,161,49,162,53,48,129,165,112,114,111,111,102,164,116,101,115,116]
                  },
                  "entry": null
                }
              ]
            }
          },
          "--- summary ---"
        ])
    }

    #[test]
    fn converts_hash_bytes_to_b64url() {
        let mut warnings = Vec::new();
        let value = serde_json::json!([
            132, 41, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
            23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37
        ]);
        let converted = convert_hash_bytes(&value, "action_address", &mut warnings);
        assert_eq!(
            converted,
            Some("hCkBAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQl".to_string())
        );
        assert!(warnings.is_empty());
    }

    #[test]
    fn builds_simplified_chain_output() {
        let dump = sample_dump();
        let out = simplify_dump(
            &dump,
            Path::new("fixture.json"),
            "2026-04-10T00:00:00Z".to_string(),
        )
        .expect("simplify should succeed");
        assert_eq!(out.record_count, 3);
        assert_eq!(out.records[0].action_type.as_deref(), Some("Dna"));
        assert_eq!(out.records[0].entry_type, None);

        assert_eq!(out.records[1].action_seq, Some(1));
        assert!(out.records[1].has_entry);
        assert_eq!(out.records[1].entry_type.as_deref(), Some("App"));
        assert!(out.records[1].app_entry_type.is_some());
        let entry_data = out.records[1].entry_data.as_ref().unwrap();
        assert_eq!(entry_data["type"], "Proposal");
        assert_eq!(entry_data["amount"], "100");

        assert_eq!(out.records[2].action_type.as_deref(), Some("CreateLink"));
        assert_eq!(out.records[2].link_type, Some(10));
        assert!(out.records[2].link_tag.is_some());
        let tag = out.records[2].link_tag.as_ref().unwrap();
        assert_eq!(tag[0], "oracle");
    }
}
