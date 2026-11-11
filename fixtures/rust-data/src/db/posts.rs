use diesel::prelude::*;
use crate::schema::posts;
use crate::schema::users;

#[derive(Queryable, Selectable, Identifiable, Associations)]
#[diesel(table_name = posts, belongs_to(Account, foreign_key = user_id))]
pub struct Post {
    pub id: i32,
    pub user_id: i32,
    pub title: String,
}

#[derive(Queryable, Identifiable)]
#[diesel(table_name = users)]
pub struct Account {
    pub id: i32,
    pub name: String,
}

#[derive(Insertable)]
#[diesel(table_name = posts)]
pub struct NewPost<'a> {
    pub user_id: i32,
    pub title: &'a str,
}

pub fn create_post(conn: &mut PgConnection, new_post: &NewPost) -> Post {
    diesel::insert_into(posts::table)
        .values(new_post)
        .get_result(conn)
        .unwrap()
}

pub fn titles_of(conn: &mut PgConnection, owner: i32) -> Vec<String> {
    posts::table
        .inner_join(users::table)
        .filter(users::id.eq(owner))
        .select(posts::title)
        .load(conn)
        .unwrap()
}

pub fn retitle(conn: &mut PgConnection, id: i32, title: &str) {
    diesel::update(posts::table.find(id))
        .set(posts::title.eq(title))
        .execute(conn)
        .unwrap();
}

pub fn purge(conn: &mut PgConnection, owner: i32) {
    diesel::delete(posts::table.filter(posts::user_id.eq(owner))).execute(conn).unwrap();
}

pub fn upsert_user(conn: &mut PgConnection, name: &str) {
    diesel::insert_into(users::table)
        .values(users::name.eq(name))
        .on_conflict(users::id)
        .do_nothing()
        .execute(conn)
        .unwrap();
}
