use patchriot_core::{
    AppState, Config, connect, create_invite, disable_account, invite_account, router,
};
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    let pool = connect(&database_url)
        .await
        .map_err(|_| "database connection or migration failed")?;
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "bootstrap-admin") {
        if !(3..=4).contains(&args.len()) {
            return Err("usage: patchriot-core bootstrap-admin <username> <private-password-file> [existing-admin-uuid]".into());
        }
        use std::io::Read;
        let file = std::fs::File::open(&args[2]).map_err(|_| "unable to read password file")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if file.metadata()?.permissions().mode() & 0o077 != 0 {
                return Err("password file must be owner-only (chmod 600)".into());
            }
        }
        let mut password = zeroize::Zeroizing::new(String::new());
        file.take(258)
            .read_to_string(&mut password)
            .map_err(|_| "unable to read password file")?;
        if password.len() > 257 {
            return Err("password file is too large".into());
        }
        if password.ends_with('\n') {
            password.pop();
        }
        let existing = args
            .get(3)
            .map(|v| v.parse::<uuid::Uuid>())
            .transpose()
            .map_err(|_| "invalid account ID")?;
        let id = patchriot_core::bootstrap_admin(
            &pool,
            &args[1],
            std::mem::take(&mut *password),
            existing,
        )
        .await?;
        println!("Administrator password login created: {id}");
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "review-code") {
        if args.len() != 2 {
            return Err("usage: patchriot-core review-code <label>".into());
        }
        let issued = patchriot_core::review_codes::issue(&pool, &args[1]).await?;
        println!("{}", serde_json::to_string(&issued)?);
        eprintln!(
            "One-use website review code; expires unused after 7 days. Share privately with an invited user."
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "revoke-review-code") {
        if args.len() != 2 {
            return Err("usage: patchriot-core revoke-review-code <code-uuid>".into());
        }
        let id = args[1]
            .parse::<uuid::Uuid>()
            .map_err(|_| "invalid code ID")?;
        if !patchriot_core::review_codes::revoke(&pool, id)
            .await
            .map_err(|_| "code revocation failed")?
        {
            return Err("code not found, already reserved or already revoked".into());
        }
        println!("Unused review code revoked.");
        return Ok(());
    }
    if args == ["payments-reconcile-once"] {
        let key = std::env::var("PATCHRIOT_1CLICK_API_KEY")
            .map_err(|_| "PATCHRIOT_1CLICK_API_KEY is required")?;
        let provider = patchriot_core::payments::OneClick::new(&key)?;
        let result = patchriot_core::payments::reconcile_once(&pool, &provider).await?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "invite-account") {
        if args.len() != 2 {
            return Err("usage: patchriot-core invite-account <account-uuid>".into());
        }
        let id = args[1]
            .parse::<uuid::Uuid>()
            .map_err(|_| "invalid account ID")?;
        let invite = invite_account(&pool, id).await?;
        println!("{invite}");
        eprintln!(
            "One-use login invitation for the existing account; expires in 24 hours. Share privately."
        );
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "disable-account") {
        if args.len() != 2 {
            return Err("usage: patchriot-core disable-account <account-uuid>".into());
        }
        let id = args[1]
            .parse::<uuid::Uuid>()
            .map_err(|_| "invalid account ID")?;
        if !disable_account(&pool, id)
            .await
            .map_err(|_| "account disable failed")?
        {
            return Err("account not found".into());
        }
        println!("Account disabled; sessions invalidated.");
        return Ok(());
    }
    if args.first().is_some_and(|a| a == "invite") {
        if args.len() != 3 {
            return Err("usage: patchriot-core invite <member|admin> <display-name>".into());
        }
        let invite = create_invite(&pool, &args[2], &args[1]).await?;
        println!("{invite}");
        eprintln!("One-use prototype invitation; expires in 24 hours. Share privately.");
        return Ok(());
    }
    if !args.is_empty()
        && args != ["serve"]
        && args != ["payments-fund-once"]
        && args != ["payments-cancel-once"]
        && args != ["payments-run"]
        && args != ["payouts-once"]
    {
        return Err(
            "expected serve, bootstrap-admin, invite, invite-account, disable-account, review-code, revoke-review-code, payments-run, payments-reconcile-once, payments-fund-once, payments-cancel-once or payouts-once"
                .into(),
        );
    }
    let config = Config::new(
        std::env::var("PATCHRIOT_PUBLIC_ORIGIN")
            .map_err(|_| "PATCHRIOT_PUBLIC_ORIGIN is required")?,
        std::env::var("PATCHRIOT_DISPATCHER_URL")
            .map_err(|_| "PATCHRIOT_DISPATCHER_URL is required")?,
        std::env::var("PATCHRIOT_INTERNAL_KEY")
            .map_err(|_| "PATCHRIOT_INTERNAL_KEY is required")?,
        std::env::var_os("PATCHRIOT_WEB_ROOT").map(PathBuf::from),
    )?;
    let relay_origin = match std::env::var("PATCHRIOT_RELAY_ORIGIN") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid PATCHRIOT_RELAY_ORIGIN".into()),
    };
    let contact_email = match std::env::var("PATCHRIOT_CONTACT_EMAIL") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid PATCHRIOT_CONTACT_EMAIL".into()),
    };
    // Workspace analytics is an explicit deployment opt-in, separate from each
    // user's consent. Old measurement settings alone must not turn it on.
    let workspace_counts_enabled = std::env::var("PATCHRIOT_WORKSPACE_COUNTS_ENABLED")
        .unwrap_or_else(|_| "false".into())
        .parse::<bool>()
        .map_err(|_| "PATCHRIOT_WORKSPACE_COUNTS_ENABLED must be true or false")?;
    let analytics_enabled = std::env::var("PATCHRIOT_ANALYTICS_ENABLED")
        .unwrap_or_else(|_| "false".into())
        .parse::<bool>()
        .map_err(|_| "PATCHRIOT_ANALYTICS_ENABLED must be true or false")?;
    let ga_measurement_id = match std::env::var("PATCHRIOT_GA_MEASUREMENT_ID") {
        _ if !analytics_enabled => None,
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => {
            return Err("PATCHRIOT_GA_MEASUREMENT_ID is required when analytics is enabled".into());
        }
        Err(_) => return Err("invalid PATCHRIOT_GA_MEASUREMENT_ID".into()),
    };
    let analytics_origin = match std::env::var("PATCHRIOT_ANALYTICS_ORIGIN") {
        _ if !analytics_enabled => None,
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid PATCHRIOT_ANALYTICS_ORIGIN".into()),
    };
    let client_ip_source = match std::env::var("PATCHRIOT_CLIENT_IP_SOURCE") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => "peer".into(),
        Err(_) => return Err("invalid PATCHRIOT_CLIENT_IP_SOURCE".into()),
    };
    let mut state = AppState::new(
        pool,
        config
            .with_client_ip_source(&client_ip_source)?
            .with_relay_origin(relay_origin)?
            .with_contact_email(contact_email)?
            .with_workspace_counts(workspace_counts_enabled)
            .with_ga_measurement_id(ga_measurement_id)?
            .with_analytics_origin(analytics_origin)?
            .with_sso(patchriot_core::SsoConfig::from_env()?)
            .with_wallet_project_id(std::env::var("WC_REOWNED_PRJ_ID").ok())?,
    )?;
    if let Some(path) = std::env::var_os("PATCHRIOT_TREASURY_CONFIG") {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|_| "unable to read treasury configuration")?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "unable to read treasury configuration")?;
        let key = std::env::var("PATCHRIOT_1CLICK_API_KEY")
            .map_err(|_| "PATCHRIOT_1CLICK_API_KEY is required")?;
        state = state.with_payouts(
            patchriot_core::payments::payouts::PayoutService::configured(&bytes, &key)?,
        );
    }
    if args == ["payouts-once"] {
        let path = std::env::var_os("PATCHRIOT_TREASURY_KEY_FILE")
            .map(PathBuf::from)
            .ok_or("PATCHRIOT_TREASURY_KEY_FILE is required only for the payout process")?;
        let result = patchriot_core::payments::payouts::chain::run_once(&state, &path).await?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args == ["payments-run"] {
        let key = std::env::var("PATCHRIOT_1CLICK_API_KEY")
            .map_err(|_| "PATCHRIOT_1CLICK_API_KEY is required")?;
        let provider = patchriot_core::payments::OneClick::new(&key)?;
        eprintln!("Patchriot payment worker started; waiting for saved orders.");
        patchriot_core::payments::worker::run(&state, &provider, shutdown_signal()).await;
        return Ok(());
    }
    if args == ["payments-fund-once"] {
        let result = patchriot_core::payments::funding::deliver_once(&state).await?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    if args == ["payments-cancel-once"] {
        let result = patchriot_core::payments::cancellation::deliver_once(&state).await?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    let mode = match std::env::var("PATCHRIOT_REVIEW_MODE") {
        Ok(mode) => mode,
        Err(std::env::VarError::NotPresent) => "closed".into(),
        Err(_) => return Err("invalid review mode".into()),
    };
    let inline_policy = match std::env::var("PATCHRIOT_CHECKOUT_JSON") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid PATCHRIOT_CHECKOUT_JSON".into()),
    };
    let policy = checkout_policy(
        std::env::var_os("PATCHRIOT_CHECKOUT_CONFIG").map(PathBuf::from),
        inline_policy,
    )?;
    let key = std::env::var("PATCHRIOT_1CLICK_API_KEY").ok();
    state = state.with_review_access(patchriot_core::payments::access::ReviewAccess::configured(
        &mode,
        policy.as_deref(),
        key.as_deref(),
    )?);
    let bind: SocketAddr = std::env::var("PATCHRIOT_CORE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7410".into())
        .parse()?;
    let app = router(state);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!("Patchriot core listening on {bind}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Hosted deployments can supply the same payment policy as a runtime variable.
/// Reject conflicting sources rather than silently selecting a different treasury.
fn checkout_policy(
    path: Option<PathBuf>,
    inline: Option<String>,
) -> Result<Option<Vec<u8>>, &'static str> {
    use std::io::Read;
    const LIMIT: usize = 16 * 1024;
    let bytes = match (path, inline) {
        (Some(_), Some(_)) => {
            return Err("set only one of PATCHRIOT_CHECKOUT_CONFIG and PATCHRIOT_CHECKOUT_JSON");
        }
        (None, None) => return Ok(None),
        (None, Some(value)) => value.into_bytes(),
        (Some(path), None) => {
            let mut bytes = Vec::new();
            std::fs::File::open(path)
                .map_err(|_| "unable to read checkout configuration")?
                .take(LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "unable to read checkout configuration")?;
            bytes
        }
    };
    if bytes.is_empty() || bytes.len() > LIMIT {
        return Err("checkout configuration must contain 1–16384 bytes");
    }
    Ok(Some(bytes))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::checkout_policy;

    #[test]
    fn hosted_checkout_does_not_override_a_file_or_accept_empty_or_oversized_policy() {
        assert_eq!(checkout_policy(None, None).unwrap(), None);
        for value in [String::new(), "x".repeat(16 * 1024 + 1)] {
            assert!(checkout_policy(None, Some(value)).is_err());
        }
        assert!(
            checkout_policy(
                Some("/nonexistent/checkout-policy".into()),
                Some("{}".into())
            )
            .unwrap_err()
            .contains("set only one")
        );
        assert!(checkout_policy(Some("/nonexistent/checkout-policy".into()), None).is_err());
    }

    #[test]
    fn file_and_hosted_policy_preserve_identical_bytes() {
        let path = std::env::temp_dir().join(format!("patchriot-policy-{}", uuid::Uuid::new_v4()));
        let policy = "{\n  \"recipient\": \"owned-fixture.near\"\n}\n";
        std::fs::write(&path, policy).unwrap();
        assert_eq!(
            checkout_policy(Some(path.clone()), None).unwrap(),
            checkout_policy(None, Some(policy.into())).unwrap()
        );
        std::fs::write(&path, vec![b'x'; 16 * 1024 + 1]).unwrap();
        let oversized = checkout_policy(Some(path.clone()), None);
        std::fs::remove_file(path).unwrap();
        assert!(oversized.is_err());
    }
}
