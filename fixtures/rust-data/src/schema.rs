diesel::table! {
    users (id) {
        id -> Int4,
        name -> Varchar,
        email -> Nullable<Text>,
    }
}

diesel::table! {
    posts (id) {
        id -> Int4,
        user_id -> Int4,
        title -> Text,
    }
}

diesel::joinable!(posts -> users (user_id));
diesel::allow_tables_to_appear_in_same_query!(users, posts);
