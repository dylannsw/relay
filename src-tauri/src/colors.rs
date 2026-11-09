//! Event colors: from one calendar color, the fills Relay draws events with and a text
//! colors for each: titles at 4.5:1 or more, and a lighter shade for times and places at
//! 3:1 or more (WCAG 2 contrast).
//!
//! The text keeps the calendar's hue where it can (a darker or lighter shade of it, like
//! Notion Calendar) and only falls back to black or white when no shade gets there.

use serde::Serialize;

/// Contrast an event's title must reach against its fill (WCAG AA for normal text).
pub const TEXT_CONTRAST: f64 = 4.5;
/// Contrast for the lighter second lines (time, location).
pub const MUTED_CONTRAST: f64 = 3.0;

/// The surfaces tinted fills are mixed toward. Light is the app's white background;
/// dark is close to the dark theme's cards (oklch 0.205 ≈ #171717).
const LIGHT_SURFACE: Rgb = Rgb(1.0, 1.0, 1.0);
const DARK_SURFACE: Rgb = Rgb(0.090, 0.090, 0.090);

/// How much of the calendar color goes into the tinted fills.
const LIGHT_TINT: f64 = 0.22;
const DARK_TINT: f64 = 0.38;

/// Grey, used when a calendar has no color or an unreadable one.
pub const FALLBACK: &str = "#9e9e9e";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventColors {
    /// The calendar color itself, as a solid fill (e.g. a selected event).
    pub base: String,
    /// Title and second-line text on `base`.
    pub text: String,
    pub muted: String,
    /// A pale tint for events in the light theme, and its text.
    pub light_bg: String,
    pub light_text: String,
    pub light_muted: String,
    /// A deep tint for events in the dark theme, and its text.
    pub dark_bg: String,
    pub dark_text: String,
    pub dark_muted: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Rgb(f64, f64, f64);

pub fn event_colors(hex: &str) -> EventColors {
    let base = parse_hex(hex).unwrap_or_else(|| parse_hex(FALLBACK).expect("valid fallback"));
    let light_bg = mix(base, LIGHT_SURFACE, LIGHT_TINT);
    let dark_bg = mix(base, DARK_SURFACE, DARK_TINT);
    EventColors {
        base: to_hex(base),
        text: to_hex(readable_on(base, base, TEXT_CONTRAST)),
        muted: to_hex(readable_on(base, base, MUTED_CONTRAST)),
        light_bg: to_hex(light_bg),
        light_text: to_hex(readable_on(light_bg, base, TEXT_CONTRAST)),
        light_muted: to_hex(readable_on(light_bg, base, MUTED_CONTRAST)),
        dark_bg: to_hex(dark_bg),
        dark_text: to_hex(readable_on(dark_bg, base, TEXT_CONTRAST)),
        dark_muted: to_hex(readable_on(dark_bg, base, MUTED_CONTRAST)),
    }
}

/// Normalizes "#RGB" / "#RRGGBB" (any case, with or without '#') to "#rrggbb".
pub fn normalize_hex(s: &str) -> Option<String> {
    parse_hex(s).map(to_hex)
}

/// A text color for `bg`: the shade of `hue_of` closest to its own lightness that reaches
/// `min`. Darker shades are tried first on light fills, lighter ones on dark fills.
fn readable_on(bg: Rgb, hue_of: Rgb, min: f64) -> Rgb {
    let (h, s, l) = to_hsl(hue_of);
    // Very saturated text looks loud on a tint; keep some colour but calm it down.
    let s = s.min(0.85);
    let bg_light = luminance(bg) > 0.18;
    let (first, second): (f64, f64) = if bg_light { (-1.0, 1.0) } else { (1.0, -1.0) };
    for dir in [first, second] {
        let mut step = 0;
        loop {
            let ll = l + dir * step as f64 * 0.01;
            if !(0.0..=1.0).contains(&ll) {
                break;
            }
            let c = from_hsl(h, s, ll);
            if contrast(c, bg) >= min {
                return c;
            }
            step += 1;
        }
    }
    // Pure black or white always beats any mid shade; take whichever is stronger.
    let black = Rgb(0.0, 0.0, 0.0);
    let white = Rgb(1.0, 1.0, 1.0);
    if contrast(black, bg) >= contrast(white, bg) {
        black
    } else {
        white
    }
}

fn parse_hex(s: &str) -> Option<Rgb> {
    let s = s.trim().trim_start_matches('#');
    let full: String = match s.len() {
        3 => s.chars().flat_map(|c| [c, c]).collect(),
        6 => s.to_string(),
        _ => return None,
    };
    let v = u32::from_str_radix(&full, 16).ok()?;
    let ch = |shift: u32| ((v >> shift) & 0xff) as f64 / 255.0;
    Some(Rgb(ch(16), ch(8), ch(0)))
}

fn to_hex(c: Rgb) -> String {
    let ch = |x: f64| (x.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", ch(c.0), ch(c.1), ch(c.2))
}

/// `amount` of `a` mixed into `b`, in sRGB.
fn mix(a: Rgb, b: Rgb, amount: f64) -> Rgb {
    let m = |x: f64, y: f64| x * amount + y * (1.0 - amount);
    Rgb(m(a.0, b.0), m(a.1, b.1), m(a.2, b.2))
}

/// WCAG 2 relative luminance. Works on the 8-bit value so the result matches what
/// a contrast checker measures from the hex code.
fn luminance(c: Rgb) -> f64 {
    let lin = |x: f64| {
        let x = (x.clamp(0.0, 1.0) * 255.0).round() / 255.0;
        if x <= 0.04045 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * lin(c.0) + 0.7152 * lin(c.1) + 0.0722 * lin(c.2)
}

fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (la, lb) = (luminance(a), luminance(b));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

fn to_hsl(c: Rgb) -> (f64, f64, f64) {
    let max = c.0.max(c.1).max(c.2);
    let min = c.0.min(c.1).min(c.2);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == c.0 {
        (c.1 - c.2) / d + if c.1 < c.2 { 6.0 } else { 0.0 }
    } else if max == c.1 {
        (c.2 - c.0) / d + 2.0
    } else {
        (c.0 - c.1) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn from_hsl(h: f64, s: f64, l: f64) -> Rgb {
    if s == 0.0 {
        return Rgb(l, l, l);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    Rgb(hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ratio(a: &str, b: &str) -> f64 {
        contrast(parse_hex(a).unwrap(), parse_hex(b).unwrap())
    }

    #[test]
    fn known_contrast_ratios() {
        assert!((ratio("#000000", "#ffffff") - 21.0).abs() < 1e-9);
        assert!((ratio("#777777", "#ffffff") - 4.48).abs() < 0.01);
    }

    #[test]
    fn titles_reach_four_and_a_half_and_second_lines_three() {
        // Google's calendar palette, Relay's account palette, and some awkward ones.
        let samples = [
            "#ac725e", "#d06b64", "#f83a22", "#fa573c", "#ff7537", "#ffad46", "#42d692",
            "#16a765", "#7bd148", "#b3dc6c", "#fbe983", "#fad165", "#92e1c0", "#9fe1e7",
            "#9fc6e7", "#4986e7", "#9a9cff", "#b99aff", "#c2c2c2", "#cabdbf", "#cca6ac",
            "#f691b2", "#cd74e6", "#a47ae2", "#008dff", "#33c759", "#6a42e1", "#df9147",
            "#ee665a", "#cf9943", "#ffffff", "#000000", "#ffff00", "#00ffff", "#808080",
        ];
        for hex in samples {
            let c = event_colors(hex);
            for (bg, fg, muted) in [(&c.base, &c.text, &c.muted), (&c.light_bg, &c.light_text, &c.light_muted), (&c.dark_bg, &c.dark_text, &c.dark_muted)] {
                let r = ratio(bg, fg);
                assert!(r >= TEXT_CONTRAST, "{hex}: title {fg} on {bg} is only {r:.2}:1");
                let m = ratio(bg, muted);
                assert!(m >= MUTED_CONTRAST, "{hex}: muted {muted} on {bg} is only {m:.2}:1");
                assert!(m <= r + 1e-9, "{hex}: the muted line should be lighter than the title");
            }
        }
    }

    #[test]
    fn text_keeps_the_calendar_hue() {
        // A blue calendar gets dark blue text on its pale tint, not black.
        let c = event_colors("#4986e7");
        let (h, s, _) = to_hsl(parse_hex(&c.light_text).unwrap());
        let (base_h, _, _) = to_hsl(parse_hex("#4986e7").unwrap());
        assert!((h - base_h).abs() < 0.02, "hue drifted: {h} vs {base_h}");
        assert!(s > 0.3);
    }

    #[test]
    fn parses_and_normalizes_hex() {
        assert_eq!(normalize_hex("#ABC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_hex("4986E7").as_deref(), Some("#4986e7"));
        assert_eq!(normalize_hex("blue"), None);
        assert_eq!(event_colors("nonsense").base, FALLBACK);
    }
}
