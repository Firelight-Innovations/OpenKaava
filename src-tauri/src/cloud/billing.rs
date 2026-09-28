//! List prices from the Cloud Billing Catalog, the price sheet every Google
//! Cloud customer sees before discounts.
//!
//! A service's catalog runs to tens of thousands of SKUs and changes about
//! once a day, so each one is fetched once and kept in memory for a day. The
//! fixture is `<root>/billing/<service id>.json`, in the API's own shape.

use super::{fixture_json, get_json, http, Cloud, Result, Source};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const COMPUTE_ENGINE: &str = "6F81-5844-456A";
pub const CLOUD_STORAGE: &str = "95FF-2EF5-5EA1";
pub const CLOUD_RUN: &str = "152E-C115-5142";

/// How long a fetched catalog is trusted. Google republishes list prices
/// daily at most, and a Compute Engine catalog is seven pages to download.
const FRESH_FOR: Duration = Duration::from_secs(24 * 3600);

/// One price. `tiers` are sorted by `start`, in `unit`s per billing month.
#[derive(Debug, Clone, PartialEq)]
pub struct Sku {
    pub id: String,
    pub description: String,
    pub resource_group: String,
    pub usage_type: String,
    pub regions: Vec<String>,
    /// The catalog's `usageUnit`: `h`, `GiBy.h`, `GiBy.mo`, `s`, `GiBy.s`.
    pub unit: String,
    pub tiers: Vec<Tier>,
    pub effective: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tier {
    pub start: f64,
    pub price: f64,
}

impl Sku {
    /// Whether this price applies in `region`. `global` SKUs apply anywhere.
    pub fn serves(&self, region: &str) -> bool {
        self.regions.iter().any(|r| r == region || r == "global")
    }

    /// The cost of `quantity` units in one month, tier by tier.
    pub fn cost(&self, quantity: f64) -> f64 {
        let mut total = 0.0;
        for (i, tier) in self.tiers.iter().enumerate() {
            let end = self.tiers.get(i + 1).map_or(f64::INFINITY, |t| t.start);
            let used = quantity.min(end) - tier.start;
            if used > 0.0 {
                total += used * tier.price;
            }
        }
        total
    }

    /// The price of the next unit once `quantity` has been used.
    pub fn marginal(&self, quantity: f64) -> f64 {
        self.tiers
            .iter()
            .rev()
            .find(|t| t.start <= quantity)
            .or(self.tiers.first())
            .map_or(0.0, |t| t.price)
    }
}

/// One service's price list and when it was fetched.
type Fetched = (Instant, Arc<Vec<Sku>>);

/// Catalogs already fetched, by service id. Live only; fixtures are re-read.
#[derive(Default)]
pub struct Prices {
    by_service: Mutex<HashMap<String, Fetched>>,
}

/// Every SKU `service` publishes, from the day's cache when there is one.
pub fn catalog(cloud: &Cloud, source: &Source, service: &str) -> Result<Arc<Vec<Sku>>> {
    match source {
        Source::Fixture { root } => {
            let page: Page = fixture_json(root, &format!("billing/{service}.json"))?;
            Ok(Arc::new(
                page.skus.into_iter().filter_map(RawSku::into_sku).collect(),
            ))
        }
        Source::Live { .. } => {
            let lock = || {
                cloud
                    .prices
                    .by_service
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
            };
            if let Some((at, skus)) = lock().get(service) {
                if at.elapsed() < FRESH_FOR {
                    return Ok(Arc::clone(skus));
                }
            }
            let skus = Arc::new(fetch(cloud, service)?);
            lock().insert(service.to_string(), (Instant::now(), Arc::clone(&skus)));
            Ok(skus)
        }
    }
}

fn fetch(cloud: &Cloud, service: &str) -> Result<Vec<Sku>> {
    let mut skus = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut url = format!(
            "https://cloudbilling.googleapis.com/v1/services/{}/skus?currencyCode=USD&pageSize=5000",
            http::encode(service)
        );
        if let Some(t) = &token {
            url.push_str(&format!("&pageToken={}", http::encode(t)));
        }
        let page: Page = get_json(cloud, &url, &format!("price list {service}"), 64 << 20)?;
        skus.extend(page.skus.into_iter().filter_map(RawSku::into_sku));
        match page.next_page_token {
            Some(t) if !t.is_empty() => token = Some(t),
            _ => return Ok(skus),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    #[serde(default)]
    skus: Vec<RawSku>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSku {
    sku_id: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    category: RawCategory,
    #[serde(default)]
    service_regions: Vec<String>,
    #[serde(default)]
    pricing_info: Vec<RawPricing>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCategory {
    #[serde(default)]
    resource_group: String,
    #[serde(default)]
    usage_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPricing {
    pricing_expression: RawExpression,
    effective_time: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExpression {
    usage_unit: String,
    #[serde(default)]
    tiered_rates: Vec<RawRate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRate {
    #[serde(default)]
    start_usage_amount: f64,
    unit_price: RawMoney,
}

/// Google's `Money`: whole `units` as a decimal string, plus `nanos`.
#[derive(Deserialize)]
struct RawMoney {
    #[serde(default)]
    units: String,
    #[serde(default)]
    nanos: i64,
}

impl RawSku {
    /// `None` for a SKU with no price attached, which the catalog does list.
    fn into_sku(self) -> Option<Sku> {
        let pricing = self.pricing_info.into_iter().next()?;
        let mut tiers: Vec<Tier> = pricing
            .pricing_expression
            .tiered_rates
            .into_iter()
            .map(|r| Tier {
                start: r.start_usage_amount,
                price: r.unit_price.units.parse::<f64>().unwrap_or(0.0)
                    + r.unit_price.nanos as f64 / 1e9,
            })
            .collect();
        if tiers.is_empty() {
            return None;
        }
        tiers.sort_by(|a, b| a.start.total_cmp(&b.start));
        Some(Sku {
            id: self.sku_id,
            description: self.description,
            resource_group: self.category.resource_group,
            usage_type: self.category.usage_type,
            regions: self.service_regions,
            unit: pricing.pricing_expression.usage_unit,
            tiers,
            effective: pricing.effective_time,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> Source {
        Source::Fixture {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/cloud"),
        }
    }

    fn sku(tiers: &[(f64, f64)]) -> Sku {
        Sku {
            id: "X".into(),
            description: String::new(),
            resource_group: String::new(),
            usage_type: String::new(),
            regions: vec!["us-central1".into()],
            unit: "h".into(),
            tiers: tiers
                .iter()
                .map(|&(start, price)| Tier { start, price })
                .collect(),
            effective: None,
        }
    }

    #[test]
    fn tiered_cost_charges_each_band_at_its_own_rate() {
        // Cloud Storage's regional Standard class: the first 5 GiB-months free.
        let storage = sku(&[(0.0, 0.0), (5.0, 0.02)]);
        assert_eq!(storage.cost(3.0), 0.0);
        assert!((storage.cost(15.0) - 0.2).abs() < 1e-12);
        assert_eq!(storage.marginal(3.0), 0.0);
        assert_eq!(storage.marginal(15.0), 0.02);
        let flat = sku(&[(0.0, 0.5)]);
        assert!((flat.cost(4.0) - 2.0).abs() < 1e-12);
    }

    #[test]
    fn global_skus_serve_every_region() {
        let mut ip = sku(&[(0.0, 0.005)]);
        ip.regions = vec!["global".into()];
        assert!(ip.serves("europe-west4"));
        assert!(!sku(&[(0.0, 1.0)]).serves("europe-west4"));
    }

    #[test]
    fn the_fixture_catalog_parses_money_and_units() {
        let skus = catalog(&Cloud::default(), &fixtures(), COMPUTE_ENGINE).unwrap();
        let core = skus.iter().find(|s| s.id == "CF4E-A0C7-E3BF").unwrap();
        assert_eq!(core.description, "E2 Instance Core running in Americas");
        assert_eq!(core.unit, "h");
        assert!((core.tiers[0].price - 0.021_811_59).abs() < 1e-12);
        assert!(core.serves("us-central1"));
    }

    #[test]
    fn an_unknown_service_in_a_fixture_has_no_prices() {
        let skus = catalog(&Cloud::default(), &fixtures(), "0000-0000-0000").unwrap();
        assert!(skus.is_empty());
    }
}
