//! Place suggestions for an event's location, from Photon (https://photon.komoot.io), a free
//! search-as-you-type service over OpenStreetMap data. No key or account is needed; the text
//! typed (and, when known, a point to favour nearby results) is sent to Photon.

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::http;

const PHOTON: &str = "https://photon.komoot.io/api/";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    /// "Lighthouse Climbing"
    pub name: String,
    /// "44 Kallang Place, Singapore"
    pub detail: String,
    /// What goes in the event's location: the name and the address together.
    pub label: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Response {
    features: Vec<Feature>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Feature {
    geometry: Geometry,
    properties: Props,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Geometry {
    /// [lon, lat]
    coordinates: Vec<f64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Props {
    name: Option<String>,
    housenumber: Option<String>,
    street: Option<String>,
    district: Option<String>,
    city: Option<String>,
    state: Option<String>,
    country: Option<String>,
}

fn to_place(f: Feature) -> Option<Place> {
    let p = f.properties;
    let (lon, lat) = (*f.geometry.coordinates.first()?, *f.geometry.coordinates.get(1)?);
    let street = match (&p.housenumber, &p.street) {
        (Some(n), Some(s)) => Some(format!("{n} {s}")),
        (None, Some(s)) => Some(s.clone()),
        _ => None,
    };
    // City-states (Singapore) come back with city == country; say it once.
    let mut parts: Vec<String> = Vec::new();
    for part in [street, p.district, p.city, p.state, p.country].into_iter().flatten() {
        if !part.is_empty() && !parts.iter().any(|x| x.eq_ignore_ascii_case(&part)) {
            parts.push(part);
        }
    }
    let name = p.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| parts.first().cloned().unwrap_or_default());
    if name.is_empty() {
        return None;
    }
    parts.retain(|x| !x.eq_ignore_ascii_case(&name));
    let detail = parts.join(", ");
    let label = if detail.is_empty() { name.clone() } else { format!("{name}, {detail}") };
    Some(Place { name, detail, label, lat, lon })
}

/// Up to six places matching `query`, nearer ones first when `near` (lat, lon) is given.
pub async fn search(http: &Client, query: &str, near: Option<(f64, f64)>) -> Result<Vec<Place>> {
    let query = query.trim();
    if query.chars().count() < 3 {
        return Ok(Vec::new());
    }
    let mut req = http.get(PHOTON).query(&[("q", query), ("limit", "6"), ("lang", "en")]);
    if let Some((lat, lon)) = near {
        req = req.query(&[("lat", lat.to_string()), ("lon", lon.to_string())]);
    }
    let r: Response = http::json(req, "Place search").await?;
    let mut out: Vec<Place> = Vec::new();
    for p in r.features.into_iter().filter_map(to_place) {
        if !out.iter().any(|x| x.label == p.label) {
            out.push(p);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_photon_results() {
        let r: Response = serde_json::from_str(
            r#"{"features":[
              {"geometry":{"coordinates":[103.87,1.31]},"properties":{"name":"Lighthouse Climbing","housenumber":"44","street":"Kallang Place","city":"Singapore","country":"Singapore"}},
              {"geometry":{"coordinates":[103.8,1.3]},"properties":{"street":"Orchard Road","city":"Singapore","country":"Singapore"}},
              {"geometry":{"coordinates":[]},"properties":{"name":"Nowhere"}}
            ]}"#,
        )
        .unwrap();
        let places: Vec<Place> = r.features.into_iter().filter_map(to_place).collect();
        assert_eq!(places.len(), 2);
        assert_eq!(places[0].name, "Lighthouse Climbing");
        assert_eq!(places[0].detail, "44 Kallang Place, Singapore");
        assert_eq!(places[0].label, "Lighthouse Climbing, 44 Kallang Place, Singapore");
        assert_eq!((places[0].lat, places[0].lon), (1.31, 103.87));
        // No name: the street stands in for it.
        assert_eq!(places[1].label, "Orchard Road, Singapore");
    }
}
