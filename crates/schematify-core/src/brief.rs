//! The project brief of PRD section 5.12.
//!
//! One file, `brief.json`, human-authored, holding what the product is for.
//! It is the only semantic file in `.veistra/` not addressed by a UUID, because
//! there is exactly one of it.
//!
//! A success metric carries a number and a unit rather than a sentence. A
//! metric written as prose cannot be checked against a run, and a brief full
//! of unfalsifiable goals is the failure mode this shape exists to prevent.

use serde::{Deserialize, Serialize};

/// One measurable claim about success.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SuccessMetric {
    /// What is measured.
    pub name: String,
    /// The number to hit.
    pub value: f64,
    /// The unit the number is in.
    pub unit: String,
}

/// What the product is for.
/// Closed to unknown fields for the reason [`crate::Screen`] gives.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectBrief {
    /// The product's name.
    pub product_name: String,
    /// The problem it solves.
    pub problem: String,
    /// Who it is for.
    #[serde(default)]
    pub users: Vec<String>,
    /// What it sets out to do.
    #[serde(default)]
    pub goals: Vec<String>,
    /// What it deliberately does not do.
    #[serde(default)]
    pub non_goals: Vec<String>,
    /// What it has to work within.
    #[serde(default)]
    pub constraints: Vec<String>,
    /// How success is measured.
    #[serde(default)]
    pub success_metrics: Vec<SuccessMetric>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_brief_round_trips() {
        let brief = ProjectBrief {
            product_name: "saas-backend".to_owned(),
            problem: "Teams rebuild the same account layer each time.".to_owned(),
            users: vec!["Platform engineers".to_owned()],
            goals: vec!["One auth path".to_owned()],
            non_goals: vec!["A billing product".to_owned()],
            constraints: vec!["Postgres only".to_owned()],
            success_metrics: vec![SuccessMetric {
                name: "verify_p95".to_owned(),
                value: 3.0,
                unit: "ms".to_owned(),
            }],
        };
        let text = serde_json::to_string(&brief).unwrap();
        assert_eq!(serde_json::from_str::<ProjectBrief>(&text).unwrap(), brief);
    }

    #[test]
    fn an_empty_brief_parses_from_the_two_required_fields() {
        let text = "{\"product_name\":\"x\",\"problem\":\"y\"}";
        let brief: ProjectBrief = serde_json::from_str(text).unwrap();
        assert!(brief.goals.is_empty());
        assert!(brief.success_metrics.is_empty());
    }
}
