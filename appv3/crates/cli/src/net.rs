//! `app/cli/net.py`.

use crate::pystr::system_exit;
use appv3_core::runtime_settings::load_server_settings;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::Duration;

pub const DEFAULT_PORT: i64 = 4082;

pub struct ServerAddresses {
    pub local: String,
    pub lan: Vec<String>,
}

/// `is_loopback_host` (exact v2 semantics: no bracket/whitespace stripping).
pub fn is_loopback_host(host: &str) -> bool {
    if host.to_lowercase() == "localhost" {
        return true;
    }
    let bare = host.split_once('%').map(|(h, _)| h).unwrap_or(host);
    match bare.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) if host.contains('%') => v6.is_loopback(),
        Ok(ip) if !host.contains('%') => ip.is_loopback(),
        _ => false,
    }
}

pub fn require_loopback_or_auth(host: &str, has_auth: bool) {
    if !has_auth && !is_loopback_host(host) {
        system_exit("Refusing to bind a non-loopback host without authentication; configure --key or an access key.");
    }
}

pub fn display_host(host: &str) -> String {
    if host == "0.0.0.0" || host == "::" {
        "127.0.0.1".into()
    } else {
        host.into()
    }
}

/// v2 lets `load_server_settings` exceptions escape with a traceback.
pub fn server_settings() -> appv3_core::runtime_settings::ServerYaml {
    match load_server_settings() {
        Ok(s) => s,
        Err(e) => crate::pystr::uncaught("ValueError", &e.to_string()),
    }
}

pub fn resolve_port(port: Option<i64>, configured: Option<i64>) -> i64 {
    if let Some(p) = port {
        return p;
    }
    if let Some(c) = configured.filter(|&c| c != 0) {
        return c;
    }
    let p = server_settings().port;
    if p != 0 {
        p
    } else {
        DEFAULT_PORT
    }
}

pub fn resolve_host(arg_host: Option<&str>, configured: Option<&str>) -> String {
    if let Some(h) = arg_host.filter(|h| !h.is_empty()) {
        return h.into();
    }
    if let Some(c) = configured {
        return c.into();
    }
    server_settings().host
}

fn format_url(host: &str, port: i64) -> String {
    format!("http://{}:{port}", display_host(host))
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

/// Windows `socket.gethostname()`: the DNS host name.
#[cfg(windows)]
fn hostname() -> Option<String> {
    use windows_sys::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buf.as_mut_ptr(), &mut len) } == 0 {
        return std::env::var("COMPUTERNAME").ok();
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

pub fn lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = vec![];
    let mut add = |ip: String| {
        if !ip.starts_with("127.") && !ips.contains(&ip) {
            ips.push(ip);
        }
    };
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                add(addr.ip().to_string());
            }
        }
    }
    if let Some(h) = hostname() {
        if let Ok(addrs) = (h.as_str(), 0).to_socket_addrs() {
            for a in addrs {
                if let SocketAddr::V4(v4) = a {
                    add(v4.ip().to_string());
                }
            }
        }
    }
    ips
}

pub fn server_addresses(host: &str, port: i64) -> ServerAddresses {
    let lan = lan_ips().into_iter().map(|ip| format!("http://{ip}:{port}")).collect();
    ServerAddresses { local: format_url(host, port), lan }
}

fn socket_addrs(host: &str, port: i64) -> Vec<SocketAddr> {
    let Ok(port) = u16::try_from(port) else { return vec![] };
    (host, port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default()
}

/// `socket.create_connection((host, port), timeout)`.
pub fn connect(host: &str, port: i64, timeout: Duration) -> Option<TcpStream> {
    for a in socket_addrs(host, port) {
        if let Ok(s) = TcpStream::connect_timeout(&a, timeout) {
            return Some(s);
        }
    }
    None
}

pub fn is_port_reachable(host: &str, port: i64) -> bool {
    connect(host, port, Duration::from_secs(1)).is_some()
}

/// Minimal `urllib.request.urlopen` GET → `(status, body)`; `None` on
/// connection/protocol errors.
pub fn http_get(host: &str, port: i64, path: &str, timeout: Duration) -> Option<(u16, Vec<u8>)> {
    use std::io::{Read, Write};
    let mut s = connect(host, port, timeout)?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("GET {path} HTTP/1.1\r\nAccept-Encoding: identity\r\nHost: {host}:{port}\r\nUser-Agent: Python-urllib/3.14\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = vec![];
    s.read_to_end(&mut buf).ok()?;
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..split]).into_owned();
    let mut body = buf[split + 4..].to_vec();
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    if chunked {
        let mut out = vec![];
        let mut rest = &body[..];
        loop {
            let nl = rest.windows(2).position(|w| w == b"\r\n")?;
            let size_s = String::from_utf8_lossy(&rest[..nl]).into_owned();
            let size = usize::from_str_radix(size_s.split(';').next()?.trim(), 16).ok()?;
            rest = &rest[nl + 2..];
            if size == 0 {
                break;
            }
            out.extend_from_slice(rest.get(..size)?);
            rest = rest.get(size + 2..).unwrap_or(&[]);
        }
        body = out;
    }
    Some((status, body))
}
