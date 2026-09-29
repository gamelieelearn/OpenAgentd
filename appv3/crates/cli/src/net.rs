//! Server address resolution, LAN discovery, and a tiny HTTP GET for health
//! checks. The GET is hand-rolled on purpose: a proxy-aware client would
//! send `localhost` checks through `HTTP_PROXY`.

use anyhow::{bail, Context, Result};
use appv3_core::runtime_settings::{load_server_settings, ServerYaml};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::time::Duration;

pub const DEFAULT_PORT: u16 = 4082;

pub struct ServerAddresses {
    pub local: String,
    pub lan: Vec<String>,
}

/// `localhost`, or a loopback IP (an IPv6 zone suffix is allowed).
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

pub fn require_loopback_or_auth(host: &str, has_auth: bool) -> Result<()> {
    if !has_auth && !is_loopback_host(host) {
        bail!("refusing to listen on {host} without authentication; pass --key or configure an access key");
    }
    Ok(())
}

pub fn display_host(host: &str) -> String {
    if host == "0.0.0.0" || host == "::" {
        "127.0.0.1".into()
    } else {
        host.into()
    }
}

pub fn server_settings() -> Result<ServerYaml> {
    load_server_settings().context("read server.yaml")
}

/// `(host, port)` from the flags, else `server.yaml`, else the defaults.
pub fn resolve_addr(host: Option<&str>, port: Option<u16>, cfg: &ServerYaml) -> (String, u16) {
    let host = host.filter(|h| !h.is_empty()).map(String::from).unwrap_or_else(|| cfg.host.clone());
    let port = port.or_else(|| u16::try_from(cfg.port).ok().filter(|&p| p != 0)).unwrap_or(DEFAULT_PORT);
    (host, port)
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

pub fn server_addresses(host: &str, port: u16) -> ServerAddresses {
    let lan = lan_ips().into_iter().map(|ip| format!("http://{ip}:{port}")).collect();
    ServerAddresses { local: format!("http://{}:{port}", display_host(host)), lan }
}

/// The first address of `host:port` that accepts a connection.
pub fn connect(host: &str, port: u16, timeout: Duration) -> Option<TcpStream> {
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
    for a in addrs {
        if let Ok(s) = TcpStream::connect_timeout(&a, timeout) {
            return Some(s);
        }
    }
    None
}

pub fn is_port_reachable(host: &str, port: u16) -> bool {
    connect(host, port, Duration::from_secs(1)).is_some()
}

/// `GET path` → `(status, body)`; `None` on connection or protocol errors.
pub fn http_get(host: &str, port: u16, path: &str, timeout: Duration) -> Option<(u16, Vec<u8>)> {
    use std::io::{Read, Write};
    let mut s = connect(host, port, timeout)?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let ua = format!("openagentd/{}", appv3_core::VERSION);
    let req = format!("GET {path} HTTP/1.1\r\nAccept-Encoding: identity\r\nHost: {host}:{port}\r\nUser-Agent: {ua}\r\nConnection: close\r\n\r\n");
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
