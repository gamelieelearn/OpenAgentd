//! Dynamic model discovery for local Ollama instances and OpenRouter catalog.

use anyhow::Result;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

/// Query local Ollama daemon for installed models (`GET /api/tags`).
pub async fn discover_ollama_models(base_url: Option<&str>) -> Result<Vec<String>> {
    let root = base_url.unwrap_or("http://127.0.0.1:11434");
    let url = format!("{}/api/tags", root.trim_end_matches('/'));

    let client = Client::builder().timeout(Duration::from_secs(3)).build()?;

    let resp = client.get(&url).send().await?;
    let val: Value = resp.json().await?;

    let mut models = Vec::new();
    if let Some(arr) = val.get("models").and_then(|m| m.as_array()) {
        for item in arr {
            if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    Ok(models)
}

/// Query OpenRouter API for available models (`GET /api/v1/models`).
pub async fn discover_openrouter_models(api_key: Option<&str>) -> Result<Vec<String>> {
    let client = Client::builder().timeout(Duration::from_secs(5)).build()?;

    let mut req = client.get("https://openrouter.ai/api/v1/models");
    if let Some(key) = api_key {
        req = req.bearer_auth(key);
    }

    let resp = req.send().await?;
    let val: Value = resp.json().await?;

    let mut models = Vec::new();
    if let Some(arr) = val.get("data").and_then(|d| d.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    Ok(models)
}
