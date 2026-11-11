mod handlers;

use warp::Filter;

fn users() -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    let list = warp::path!("users")
        .and(warp::get())
        .and_then(handlers::list_users);
    let show = warp::path!("users" / u32)
        .and(warp::get())
        .and_then(handlers::show_user);
    let create = warp::path("users")
        .and(warp::post())
        .and(warp::body::json())
        .and_then(handlers::create_user);
    list.or(show).or(create)
}

#[tokio::main]
async fn main() {
    let health = warp::path("health").and(warp::get()).map(|| "ok");
    let api = warp::path("api").and(users());
    let routes = health.or(api);
    warp::serve(routes).run(([127, 0, 0, 1], 3030)).await;
}
