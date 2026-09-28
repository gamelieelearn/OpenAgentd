//! TypeScript → JavaScript (type stripping + TS-only syntax lowering) via oxc.

use std::path::Path;

pub fn is_typescript(path: &Path) -> bool {
    matches!(path.extension().and_then(|e| e.to_str()), Some("ts" | "mts" | "cts"))
}

fn line_col(src: &str, offset: u32) -> (usize, usize) {
    let upto = &src[..(offset as usize).min(src.len())];
    let line = upto.matches('\n').count() + 1;
    let col = upto.rsplit('\n').next().map(|l| l.chars().count()).unwrap_or(0) + 1;
    (line, col)
}

fn format_diagnostics(path: &Path, src: &str, diags: &[oxc_diagnostics::OxcDiagnostic]) -> Option<String> {
    let errors: Vec<String> = diags
        .iter()
        .filter(|d| d.severity == oxc_diagnostics::Severity::Error)
        .map(|d| {
            let at = d.labels.first().map(|l| line_col(src, l.offset()));
            match at {
                Some((line, col)) => format!("{}:{line}:{col}: {}", path.display(), d.message),
                None => format!("{}: {}", path.display(), d.message),
            }
        })
        .collect();
    if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    }
}

/// Strip TypeScript syntax from `src`; plain JavaScript is returned unchanged.
pub fn transpile(path: &Path, src: &str) -> Result<String, String> {
    if !is_typescript(path) {
        return Ok(src.to_string());
    }
    use oxc_allocator::Allocator;
    use oxc_span::SourceType;
    let alloc = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| format!("{}: {e:?}", path.display()))?.with_module(true);
    let parsed = oxc_parser::Parser::new(&alloc, src, source_type).parse();
    if let Some(e) = format_diagnostics(path, src, &parsed.diagnostics) {
        return Err(e);
    }
    let mut program = parsed.program;
    let scoping = oxc_semantic::SemanticBuilder::new().with_enum_eval(true).build(&program).semantic.into_scoping();
    let options = oxc_transformer::TransformOptions::default();
    let out = oxc_transformer::Transformer::new(&alloc, path, &options).build_with_scoping(scoping, &mut program);
    if let Some(e) = format_diagnostics(path, src, &out.diagnostics) {
        return Err(e);
    }
    Ok(oxc_codegen::Codegen::new().build(&program).code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_types_and_lowers_enums() {
        let js = transpile(Path::new("x.ts"), "interface A { n: number }\nenum K { A = \"a\" }\nexport const f = (a: A): string => K.A + a.n;").unwrap();
        assert!(!js.contains("interface"));
        assert!(js.contains("export const f"));
        assert!(!js.contains(": string"));
    }

    #[test]
    fn reports_syntax_errors_with_position() {
        let e = transpile(Path::new("/p/bad.ts"), "const a = ;\n").unwrap_err();
        assert!(e.starts_with("/p/bad.ts:1:"), "{e}");
    }

    #[test]
    fn javascript_passes_through() {
        assert_eq!(transpile(Path::new("x.js"), "export const a = 1;").unwrap(), "export const a = 1;");
    }
}
