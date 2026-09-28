use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Precondition failed: {0}")]
    PreconditionFailed(String),

    #[error("Precondition required: {0}")]
    PreconditionRequired(String),

    #[error("Payload too large: {0}")]
    PayloadTooLarge(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Text of a caught panic payload (`panic!("…")` gives `&str` or `String`).
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "unknown panic".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn panic_message_reads_str_and_string_payloads() {
        let a = std::panic::catch_unwind(|| panic!("plain")).unwrap_err();
        let b = std::panic::catch_unwind(|| panic!("with {}", "args")).unwrap_err();
        let c = std::panic::catch_unwind(|| std::panic::panic_any(7u8)).unwrap_err();
        assert_eq!(super::panic_message(a.as_ref()), "plain");
        assert_eq!(super::panic_message(b.as_ref()), "with args");
        assert_eq!(super::panic_message(c.as_ref()), "unknown panic");
    }
}
