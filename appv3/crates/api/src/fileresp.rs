//! Starlette `FileResponse` (1.x): stat headers (content-length,
//! last-modified, md5 etag), `accept-ranges`, `content-disposition`, and
//! single/multi `Range` handling.

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use md5::{Digest, Md5};
use std::path::Path;

/// `urllib.parse.quote(s)` (safe='/').
pub fn py_quote(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "_.-~/".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Starlette media type header value (`text/*` gets `; charset=utf-8`).
pub fn content_type(media: &str) -> String {
    if media.starts_with("text/") && !media.contains("charset=") {
        format!("{media}; charset=utf-8")
    } else {
        media.to_string()
    }
}

pub struct FileOpts<'a> {
    pub media_type: &'a str,
    pub filename: Option<&'a str>,
    pub disposition: &'a str,
    pub extra_headers: &'a [(&'static str, &'static str)],
}

fn plain(status: StatusCode, body: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body.to_string()).into_response()
}

enum RangeErr {
    Malformed(&'static str),
    Unsatisfiable,
}

fn parse_ranges(raw: &str, size: u64) -> Result<Vec<(u64, u64)>, RangeErr> {
    let Some((units, spec)) = raw.split_once('=') else { return Err(RangeErr::Malformed("Malformed range header.")) };
    if units.trim().to_lowercase() != "bytes" {
        return Err(RangeErr::Malformed("Only support bytes range"));
    }
    if spec.matches(',').count() + 1 > 100 {
        return Ok(vec![]);
    }
    let mut ranges = vec![];
    for part in spec.split(',') {
        let part = part.trim();
        if part.is_empty() || part == "-" || !part.contains('-') {
            continue;
        }
        let (s, e) = part.split_once('-').unwrap();
        let (s, e) = (s.trim(), e.trim());
        let parsed: Option<(u64, u64)> = (|| {
            let start = if s.is_empty() { size.saturating_sub(e.parse::<u64>().ok()?) } else { s.parse::<u64>().ok()? };
            let end = if !s.is_empty() && !e.is_empty() && e.parse::<u64>().ok()? < size { e.parse::<u64>().ok()? + 1 } else { size };
            Some((start, end))
        })();
        if let Some(r) = parsed {
            ranges.push(r);
        }
    }
    if ranges.is_empty() {
        return Err(RangeErr::Malformed("Range header: range must be requested"));
    }
    if ranges.iter().any(|(s, _)| *s >= size) {
        return Err(RangeErr::Unsatisfiable);
    }
    if ranges.iter().any(|(s, e)| s >= e) {
        return Err(RangeErr::Malformed("Range header: start must be less than end"));
    }
    if ranges.len() == 1 {
        return Ok(ranges);
    }
    ranges.sort();
    let mut merged = vec![ranges[0]];
    for (s, e) in ranges.into_iter().skip(1) {
        let last = merged.last_mut().unwrap();
        if s <= last.1 {
            last.1 = last.1.max(e);
        } else {
            merged.push((s, e));
        }
    }
    Ok(merged)
}

pub async fn file_response(path: &Path, req_headers: &HeaderMap, o: FileOpts<'_>) -> Response {
    let meta = match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m,
        _ => return crate::error::ApiError::internal(format!("File at path {} does not exist.", path.display())).into_response(),
    };
    let size = meta.len();
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).unwrap_or_default();
    let mtime_f = mtime.as_secs() as f64 + mtime.subsec_nanos() as f64 * 1e-9;
    let last_modified = httpdate::fmt_http_date(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime.as_secs()));
    let etag_base = format!("{}-{}", appv3_core::pyjson::float_repr(mtime_f), size);
    let etag = format!("\"{:x}\"", Md5::digest(etag_base.as_bytes()));
    let ct = content_type(o.media_type);

    let mut h = HeaderMap::new();
    for (k, v) in o.extra_headers {
        h.insert(*k, HeaderValue::from_static(v));
    }
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&ct).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Some(name) = o.filename {
        let q = py_quote(name);
        let cd = if q != name { format!("{}; filename*=utf-8''{q}", o.disposition) } else { format!("{}; filename=\"{name}\"", o.disposition) };
        if let Ok(v) = HeaderValue::from_str(&cd) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    h.insert(header::LAST_MODIFIED, HeaderValue::from_str(&last_modified).unwrap());
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());

    let range = req_headers.get(header::RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let if_range = req_headers.get(header::IF_RANGE).and_then(|v| v.to_str().ok()).map(String::from);
    let use_range = match (&range, &if_range) {
        (None, _) => false,
        (Some(_), Some(ir)) => *ir == last_modified || *ir == etag,
        (Some(_), None) => true,
    };
    let simple = |h: HeaderMap| async move {
        let f = match tokio::fs::File::open(path).await {
            Ok(f) => f,
            Err(e) => return crate::error::ApiError::internal(e).into_response(),
        };
        let mut r = Response::new(Body::from_stream(tokio_util::io::ReaderStream::with_capacity(f, 64 * 1024)));
        *r.headers_mut() = h;
        r
    };
    if !use_range {
        return simple(h).await;
    }
    let ranges = match parse_ranges(range.as_deref().unwrap(), size) {
        Ok(r) => r,
        Err(RangeErr::Malformed(m)) => return plain(StatusCode::BAD_REQUEST, m),
        Err(RangeErr::Unsatisfiable) => {
            let mut r = plain(StatusCode::RANGE_NOT_SATISFIABLE, "");
            r.headers_mut().insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
            return r;
        }
    };
    if ranges.is_empty() {
        return simple(h).await;
    }
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let read_range = |s: u64, e: u64| async move {
        let mut f = tokio::fs::File::open(path).await?;
        f.seek(std::io::SeekFrom::Start(s)).await?;
        let mut buf = vec![0u8; (e - s) as usize];
        f.read_exact(&mut buf).await?;
        Ok::<Vec<u8>, std::io::Error>(buf)
    };
    if ranges.len() == 1 {
        let (s, e) = ranges[0];
        h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&format!("bytes {}-{}/{size}", s, e - 1)).unwrap());
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(e - s));
        let data = match read_range(s, e).await {
            Ok(d) => d,
            Err(err) => return crate::error::ApiError::internal(err).into_response(),
        };
        let mut r = Response::new(Body::from(data));
        *r.status_mut() = StatusCode::PARTIAL_CONTENT;
        *r.headers_mut() = h;
        return r;
    }
    let boundary: String = (0..13).map(|_| format!("{:02x}", rand_byte())).collect();
    let mut body: Vec<u8> = vec![];
    for (s, e) in &ranges {
        body.extend(format!("--{boundary}\r\nContent-Type: {ct}\r\nContent-Range: bytes {s}-{}/{size}\r\n\r\n", e - 1).as_bytes());
        match read_range(*s, *e).await {
            Ok(d) => body.extend(d),
            Err(err) => return crate::error::ApiError::internal(err).into_response(),
        }
        body.extend(b"\r\n");
    }
    body.extend(format!("--{boundary}--").as_bytes());
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&format!("multipart/byteranges; boundary={boundary}")).unwrap());
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = StatusCode::PARTIAL_CONTENT;
    *r.headers_mut() = h;
    r
}

fn rand_byte() -> u8 {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().subsec_nanos();
    let c = uuid::Uuid::new_v4();
    c.as_bytes()[(n % 16) as usize]
}
