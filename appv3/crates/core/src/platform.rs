//! Runtime platform facts that `cfg!` cannot answer.

/// True when this Windows build runs under Wine, whose `powershell.exe` is
/// a stub that prints nothing and ignores its script.
#[cfg(windows)]
pub fn under_wine() -> bool {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};
    static WINE: OnceLock<bool> = OnceLock::new();
    *WINE.get_or_init(|| {
        // SAFETY: both calls take NUL-terminated literals; ntdll is always loaded.
        unsafe {
            let ntdll = GetModuleHandleA(c"ntdll.dll".as_ptr().cast());
            !ntdll.is_null() && GetProcAddress(ntdll, c"wine_get_version".as_ptr().cast()).is_some()
        }
    })
}

#[cfg(not(windows))]
pub fn under_wine() -> bool {
    false
}
