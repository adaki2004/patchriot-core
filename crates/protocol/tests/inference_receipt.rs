use patchriot_protocol::WorkResult;

#[test]
fn fractional_provider_costs_round_trip_through_work_result() {
    let value = serde_json::json!({
        "kind":"pentest_agent_v1", "scope_sha256":"a".repeat(64),
        "execution": {"state":"completed", "provider":"venice.ai", "model":"fixture",
            "image_digest":"fixture", "duration_ms":1, "inference_calls":1,
            "http_requests":1, "cost_upper_microusd":1, "cleanup_confirmed":true,
            "inference_usage":[{"provider":"venice.ai", "model":"fixture", "responses":1,
                "token_usage_responses":1, "cache_usage_responses":1,
                "prompt_tokens":10, "completion_tokens":1, "cached_prompt_tokens":5,
                "usd_cost_responses":1, "diem_cost_responses":1,
                "provider_reported_usd":0.32495331000000005, "provider_reported_diem":0.0}]},
        "assessment":null, "evidence":[], "raw_summary":"fixture"
    });
    let wire = serde_json::to_vec(&value).unwrap();
    let parsed: WorkResult = serde_json::from_slice(&wire).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    for invalid in [
        serde_json::json!("0.1"),
        serde_json::json!(null),
        serde_json::json!([]),
    ] {
        let mut bad = value.clone();
        bad["execution"]["inference_usage"][0]["provider_reported_usd"] = invalid;
        assert!(serde_json::from_value::<WorkResult>(bad).is_err());
    }
}
