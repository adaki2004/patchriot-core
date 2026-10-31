use patchriot_core::connect;
use sqlx::{Connection, PgConnection};
use uuid::Uuid;

/// A pre-provisioned service role owns its schema, not the whole database.
/// The test administrator needs permission to create an isolated database/role.
#[tokio::test]
async fn starts_with_an_existing_schema_without_database_create_permission()
-> Result<(), Box<dyn std::error::Error>> {
    let source = std::env::var("PATCHRIOT_TEST_DATABASE_URL")?;
    let mut administrator = PgConnection::connect(&source).await?;
    let suffix = Uuid::new_v4().simple().to_string();
    let database = format!("test_startup_{suffix}");
    let role = format!("test_core_{suffix}");
    let password = Uuid::new_v4().simple().to_string();

    // Identifiers and the temporary password contain only fixed prefixes/UUID hex.
    let result: Result<(), Box<dyn std::error::Error>> = async {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE ROLE {role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '{password}'"
        )))
        .execute(&mut administrator)
        .await?;
        sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE {database}")))
            .execute(&mut administrator)
            .await?;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "REVOKE ALL ON DATABASE {database} FROM PUBLIC"
        )))
        .execute(&mut administrator)
        .await?;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "GRANT CONNECT ON DATABASE {database} TO {role}"
        )))
        .execute(&mut administrator)
        .await?;
        let mut location = url::Url::parse(&source)?;
        location.set_path(&format!("/{database}"));
        let mut provisioner = PgConnection::connect(location.as_str()).await?;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE SCHEMA patchriot_core AUTHORIZATION {role}"
        )))
        .execute(&mut provisioner)
        .await?;
        provisioner.close().await?;

        location.set_username(&role).map_err(|_| "invalid test role")?;
        location
            .set_password(Some(&password))
            .map_err(|_| "invalid test password")?;
        let pool = connect(location.as_str()).await?;
        let permissions: (bool, bool) = sqlx::query_as(
            "SELECT has_database_privilege(current_user, current_database(), 'CREATE'), has_schema_privilege(current_user, 'patchriot_core', 'CREATE')",
        )
        .fetch_one(&pool)
        .await?;
        if permissions != (false, true) {
            return Err("test role does not have the intended restricted permissions".into());
        }
        // Startup migrations ran as that role; normal account work is available.
        patchriot_core::create_invite(&pool, "Restricted service", "member").await?;
        let accounts: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
            .fetch_one(&pool)
            .await?;
        pool.close().await;
        if accounts != 1 {
            return Err("account creation did not persist".into());
        }
        // An ordinary service restart must work with the same permissions too.
        connect(location.as_str()).await?.close().await;
        Ok(())
    }
    .await;

    // Clean up only this test's generated resources, including on regression failure.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS {database} WITH (FORCE)"
    )))
    .execute(&mut administrator)
    .await?;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP ROLE IF EXISTS {role}")))
        .execute(&mut administrator)
        .await?;
    result
}
