use sqlx::{FromRow, PgPool};

const COUNT_SQL: &str = "SELECT count(*) FROM orders o JOIN users u ON u.id = o.user_id";

#[derive(FromRow)]
pub struct User {
    pub id: i64,
    pub name: String,
}

pub async fn list_users(pool: &PgPool) -> Vec<User> {
    sqlx::query_as::<_, User>("SELECT id, name FROM users WHERE active")
        .fetch_all(pool)
        .await
        .unwrap()
}

pub async fn rename(pool: &PgPool, id: i64, name: &str) {
    sqlx::query!("UPDATE users SET name = $1 WHERE id = $2", name, id)
        .execute(pool)
        .await
        .unwrap();
}

pub async fn remove(pool: &PgPool, id: i64) {
    let _ = sqlx::query(r#"DELETE FROM users WHERE id = $1"#).bind(id).execute(pool).await;
}

pub async fn stats(pool: &PgPool) -> i64 {
    let (n,): (i64,) = sqlx::query_as(COUNT_SQL).fetch_one(pool).await.unwrap();
    n
}

pub async fn dynamic(pool: &PgPool, table: &str) {
    let sql = format!("SELECT * FROM {table}");
    let _ = sqlx::query(&sql).execute(pool).await;
}
