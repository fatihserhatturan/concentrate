pub async fn list_users() -> Result<impl warp::Reply, warp::Rejection> {
    Ok("users")
}

pub async fn show_user(id: u32) -> Result<impl warp::Reply, warp::Rejection> {
    Ok(id.to_string())
}

pub async fn create_user(body: String) -> Result<impl warp::Reply, warp::Rejection> {
    Ok(body)
}
