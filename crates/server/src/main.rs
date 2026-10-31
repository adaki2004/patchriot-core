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
    if !args.is_empty() && args != ["serve"] {
        return Err(
            "expected serve, invite, invite-account, disable-account or payments-reconcile-once"
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
    let bind: SocketAddr = std::env::var("PATCHRIOT_CORE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:7410".into())
        .parse()?;
    let app = router(AppState::new(pool, config)?);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    eprintln!("Patchriot core listening on {bind}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
