//! Bit-exact ports of CPython float helpers whose results end up in API
//! payloads (costs, durations), so v2 and v3 serialise identical numbers.

/// `round(x, ndigits)` for `ndigits >= 0`: correctly rounded to the nearest
/// decimal with ties-to-even on the *exact* binary value (CPython uses
/// `_Py_dg_dtoa` mode 3), then parsed back.
pub fn py_round(x: f64, ndigits: u32) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    // Rust's `{:.N}` formatting is exact and rounds half-to-even, matching
    // dtoa mode 3; parsing is correctly rounded.
    let r: f64 = format!("{:.*}", ndigits as usize, x).parse().unwrap_or(x);
    if r == 0.0 {
        0.0f64.copysign(x)
    } else {
        r
    }
}

/// Built-in `sum()` over floats (CPython ≥ 3.12 uses Neumaier compensated
/// summation, starting from integer 0).
pub fn py_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut f = 0.0f64;
    let mut c = 0.0f64;
    for x in values {
        let t = f + x;
        if f.abs() >= x.abs() {
            c += (f - t) + x;
        } else {
            c += (x - t) + f;
        }
        f = t;
    }
    if c != 0.0 && c.is_finite() {
        f += c;
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_cpython() {
        // Values checked against CPython 3.14.
        assert_eq!(py_round(0.125, 2), 0.12);
        assert_eq!(py_round(0.375, 2), 0.38);
        assert_eq!(py_round(2.675, 2), 2.67);
        assert_eq!(py_round(0.497952825, 8).to_string(), "0.49795282");
        assert_eq!(py_round(1.5, 0), 2.0);
        assert_eq!(py_round(2.5, 0), 2.0);
        assert_eq!(py_round(-0.0001, 2).to_string(), "-0");
    }

    #[test]
    fn sum_is_compensated() {
        assert_eq!(py_sum([0.1; 10]), 1.0);
        assert_eq!(py_sum([1e100, 1.0, -1e100, 1.0]), 2.0);
    }
}

#[cfg(test)]
mod fuzz {
    /// `python3` generates `/tmp/pyround.txt`; skipped when absent.
    #[test]
    fn against_cpython_dump() {
        let Ok(s) = std::fs::read_to_string("/tmp/pyround.txt") else {
            return;
        };
        let hex = |h: &str| -> f64 {
            let (neg, h) = h.strip_prefix('-').map(|r| (true, r)).unwrap_or((false, h));
            let h = h.strip_prefix("0x").unwrap();
            let (mant, exp) = h.split_once('p').unwrap();
            let (ip, fp) = mant.split_once('.').unwrap_or((mant, ""));
            let mut m = u64::from_str_radix(ip, 16).unwrap() as f64;
            let mut scale = 1.0 / 16.0;
            for ch in fp.chars() {
                m += ch.to_digit(16).unwrap() as f64 * scale;
                scale /= 16.0;
            }
            let v = m * 2f64.powi(exp.parse().unwrap());
            if neg {
                -v
            } else {
                v
            }
        };
        let (mut bad_r, mut bad_s) = (0, 0);
        for line in s.lines() {
            let p: Vec<&str> = line.split(' ').collect();
            let x = hex(p[0]);
            if super::py_round(x, p[1].parse().unwrap()).to_bits() != hex(p[2]).to_bits() {
                bad_r += 1;
            }
            let xs: Vec<f64> = p[3].split(',').map(hex).collect();
            if super::py_sum(xs).to_bits() != hex(p[4]).to_bits() {
                bad_s += 1;
            }
        }
        assert_eq!((bad_r, bad_s), (0, 0));
    }
}
