//! `scheduled_task` rows.

use crate::codec::{db_id, new_id, now_db};
use crate::models::ScheduledTask;
use crate::pool::DbPool;
use anyhow::Result;

pub async fn list_tasks(pool: &DbPool) -> Result<Vec<ScheduledTask>> {
    Ok(sqlx::query_as::<_, ScheduledTask>("SELECT * FROM scheduled_task ORDER BY created_at ASC")
        .fetch_all(pool)
        .await?)
}

pub async fn get_task_by_slug(pool: &DbPool, slug: &str) -> Result<Option<ScheduledTask>> {
    Ok(sqlx::query_as::<_, ScheduledTask>("SELECT * FROM scheduled_task WHERE slug = ?")
        .bind(slug)
        .fetch_optional(pool)
        .await?)
}

pub async fn get_task_by_name(pool: &DbPool, name: &str) -> Result<Option<ScheduledTask>> {
    Ok(sqlx::query_as::<_, ScheduledTask>("SELECT * FROM scheduled_task WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?)
}

pub async fn get_task(pool: &DbPool, id: &str) -> Result<Option<ScheduledTask>> {
    Ok(sqlx::query_as::<_, ScheduledTask>("SELECT * FROM scheduled_task WHERE id = ?")
        .bind(db_id(id))
        .fetch_optional(pool)
        .await?)
}

pub async fn has_enabled_tasks(pool: &DbPool) -> Result<bool> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM scheduled_task WHERE enabled = 1 LIMIT 1")
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

/// Insert a task. `t.id`, `created_at`, `updated_at` are generated.
pub async fn insert_task(pool: &DbPool, t: &ScheduledTask) -> Result<ScheduledTask> {
    let id = new_id();
    let now = now_db();
    sqlx::query(
        r#"INSERT INTO scheduled_task
           (id, name, schedule_type, at_datetime, every_seconds, cron_expression, timezone,
            prompt, session_id, enabled, status, run_count, last_run_at, last_error,
            next_fire_at, created_at, updated_at, workspace, max_runs, slug)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&id)
    .bind(&t.name)
    .bind(&t.schedule_type)
    .bind(&t.at_datetime)
    .bind(t.every_seconds)
    .bind(&t.cron_expression)
    .bind(&t.timezone)
    .bind(&t.prompt)
    .bind(&t.session_id)
    .bind(t.enabled)
    .bind(&t.status)
    .bind(t.run_count)
    .bind(&t.last_run_at)
    .bind(&t.last_error)
    .bind(&t.next_fire_at)
    .bind(&now)
    .bind(&now)
    .bind(&t.workspace)
    .bind(t.max_runs)
    .bind(&t.slug)
    .execute(pool)
    .await?;
    Ok(get_task(pool, &id).await?.expect("row just inserted"))
}

/// Write every mutable column of `t` back (bumps `updated_at`).
pub async fn save_task(pool: &DbPool, t: &ScheduledTask) -> Result<ScheduledTask> {
    sqlx::query(
        r#"UPDATE scheduled_task SET name = ?, schedule_type = ?, at_datetime = ?, every_seconds = ?,
           cron_expression = ?, timezone = ?, prompt = ?, session_id = ?, enabled = ?, status = ?,
           run_count = ?, last_run_at = ?, last_error = ?, next_fire_at = ?, updated_at = ?,
           workspace = ?, max_runs = ?, slug = ? WHERE id = ?"#,
    )
    .bind(&t.name)
    .bind(&t.schedule_type)
    .bind(&t.at_datetime)
    .bind(t.every_seconds)
    .bind(&t.cron_expression)
    .bind(&t.timezone)
    .bind(&t.prompt)
    .bind(&t.session_id)
    .bind(t.enabled)
    .bind(&t.status)
    .bind(t.run_count)
    .bind(&t.last_run_at)
    .bind(&t.last_error)
    .bind(&t.next_fire_at)
    .bind(now_db())
    .bind(&t.workspace)
    .bind(t.max_runs)
    .bind(&t.slug)
    .bind(&t.id)
    .execute(pool)
    .await?;
    Ok(get_task(pool, &t.id).await?.expect("row exists"))
}

pub async fn delete_task(pool: &DbPool, id: &str) -> Result<bool> {
    Ok(sqlx::query("DELETE FROM scheduled_task WHERE id = ?")
        .bind(db_id(id))
        .execute(pool)
        .await?
        .rows_affected()
        > 0)
}
