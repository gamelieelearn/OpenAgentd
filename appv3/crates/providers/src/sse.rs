//! UTF-8-safe SSE line reader — port of `app/agent/providers/streaming.py`.
//!
//! Bytes are buffered until a full `\n`-terminated line is available, so a
//! multi-byte character split across network chunks is never corrupted.

use crate::types::{ProviderError, ProviderResult};
use futures::{Stream, StreamExt};
use serde_json::Value;
use std::time::Duration;

/// httpx's default provider timeout: every phase (connect, each read) is
/// bounded separately, so a long stream never hits it while bytes flow.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Yield raw text lines (without the trailing `\r\n`/`\n`) from a byte stream.
pub fn lines(resp: reqwest::Response) -> impl Stream<Item = ProviderResult<String>> + Send {
    lines_idle(resp, Some(DEFAULT_TIMEOUT))
}

/// [`lines`] with an httpx-style read timeout between chunks (`None` = none).
pub fn lines_idle(resp: reqwest::Response, idle: Option<Duration>) -> impl Stream<Item = ProviderResult<String>> + Send {
    let mut bytes = resp.bytes_stream();
    async_stream::stream! {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let next = match idle {
                Some(d) => match tokio::time::timeout(d, bytes.next()).await {
                    Ok(n) => n,
                    Err(_) => { yield Err(ProviderError::Network("ReadTimeout: The read operation timed out".into())); return; }
                },
                None => bytes.next().await,
            };
            match next {
                Some(Ok(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                        let mut line: Vec<u8> = buf.drain(..=pos).collect();
                        line.pop();
                        if line.last() == Some(&b'\r') { line.pop(); }
                        yield Ok(String::from_utf8_lossy(&line).into_owned());
                    }
                }
                Some(Err(e)) => { yield Err(ProviderError::from_reqwest(e)); return; }
                None => {
                    if !buf.is_empty() {
                        let mut line = std::mem::take(&mut buf);
                        if line.last() == Some(&b'\r') { line.pop(); }
                        yield Ok(String::from_utf8_lossy(&line).into_owned());
                    }
                    return;
                }
            }
        }
    }
}

/// v2 `iter_sse_data`: parsed JSON for each `data: ` line; stops at sentinel.
pub fn data_json(resp: reqwest::Response, sentinel: Option<&'static str>, require_sentinel: bool) -> impl Stream<Item = ProviderResult<Value>> + Send {
    data_json_idle(resp, sentinel, require_sentinel, Some(DEFAULT_TIMEOUT))
}

pub fn data_json_idle(resp: reqwest::Response, sentinel: Option<&'static str>, require_sentinel: bool, idle: Option<Duration>) -> impl Stream<Item = ProviderResult<Value>> + Send {
    let inner = lines_idle(resp, idle);
    async_stream::stream! {
        futures::pin_mut!(inner);
        let mut got_sentinel = false;
        while let Some(line) = inner.next().await {
            let line = match line { Ok(l) => l, Err(e) => { yield Err(e); return; } };
            let line = line.trim();
            let Some(data) = line.strip_prefix("data: ") else { continue };
            if let Some(s) = sentinel {
                if data == s { got_sentinel = true; break; }
            }
            match serde_json::from_str::<Value>(data) {
                Ok(v) => yield Ok(v),
                Err(_) => { tracing::debug!("sse_invalid_json data={}", &data[..data.len().min(200)]); continue; }
            }
        }
        if require_sentinel && !got_sentinel {
            yield Err(ProviderError::Network(format!("SSE stream ended before terminal {:?} frame", sentinel.unwrap_or(""))));
        }
    }
}

/// Send a request and turn a >=400 status into `ProviderError::Http`.
pub async fn send_checked(req: reqwest::RequestBuilder, label: &str) -> ProviderResult<reqwest::Response> {
    check_status(req.send().await.map_err(ProviderError::from_reqwest)?, label).await
}

/// Send a streaming request: the timeout bounds only the wait for the
/// response head (the body is guarded per read by [`lines_idle`]).
pub async fn send_stream(req: reqwest::RequestBuilder, timeout: Option<Duration>, label: &str) -> ProviderResult<reqwest::Response> {
    check_status(send_head(req, timeout).await?, label).await
}

/// Send a request and wait (bounded by `timeout`) for the response head only;
/// no status check.
pub async fn send_head(req: reqwest::RequestBuilder, timeout: Option<Duration>) -> ProviderResult<reqwest::Response> {
    Ok(match timeout {
        Some(t) => match tokio::time::timeout(t, req.send()).await {
            Ok(r) => r.map_err(ProviderError::from_reqwest)?,
            Err(_) => return Err(ProviderError::Network("ReadTimeout: The read operation timed out".into())),
        },
        None => req.send().await.map_err(ProviderError::from_reqwest)?,
    })
}

pub async fn check_status(resp: reqwest::Response, label: &str) -> ProviderResult<reqwest::Response> {
    let status = resp.status().as_u16();
    if status >= 400 {
        let url = resp.url().to_string();
        let headers: Vec<(String, String)> = resp.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string())).collect();
        let body = resp.text().await.unwrap_or_default();
        tracing::warn!("{label}_error status={} body={}", status, &body.chars().take(500).collect::<String>());
        return Err(ProviderError::http(status, &url, body, headers));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn utf8_split_across_chunks_is_preserved() {
        // Simulate via a local server: split "é" (0xC3 0xA9) across writes.
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut tmp = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut s, &mut tmp).await;
            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n").await.unwrap();
            let part1: &[u8] = b"data: {\"t\":\"\xC3";
            let part2: &[u8] = b"\xA9\"}\n\ndata: [DONE]\n\n";
            for p in [part1, part2] {
                s.write_all(format!("{:x}\r\n", p.len()).as_bytes()).await.unwrap();
                s.write_all(p).await.unwrap();
                s.write_all(b"\r\n").await.unwrap();
                s.flush().await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            s.write_all(b"0\r\n\r\n").await.unwrap();
        });
        let resp = reqwest::get(format!("http://{addr}/")).await.unwrap();
        let items: Vec<_> = data_json(resp, Some("[DONE]"), true).collect().await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].as_ref().unwrap()["t"], "é");
    }
}
