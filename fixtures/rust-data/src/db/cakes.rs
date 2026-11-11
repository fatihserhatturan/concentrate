use crate::entity::{cake, filling, prelude::*};
use sea_orm::{ActiveModelTrait, DatabaseConnection, EntityTrait, Set};

pub async fn list_cakes(db: &DatabaseConnection) -> Vec<cake::Model> {
    cake::Entity::find().all(db).await.unwrap()
}

pub async fn fillings_of(db: &DatabaseConnection, id: i32) {
    let _ = Filling::find_by_id(id).one(db).await;
}

pub async fn bake(db: &DatabaseConnection, name: String) {
    let row = cake::ActiveModel {
        name: Set(name),
        ..Default::default()
    };
    row.insert(db).await.unwrap();
}

pub async fn reprice(db: &DatabaseConnection, id: i32) {
    let mut row: cake::ActiveModel = Cake::find_by_id(id).one(db).await.unwrap().unwrap().into();
    row.price = Set(Some(3));
    row.update(db).await.unwrap();
}

pub async fn clear(db: &DatabaseConnection) {
    let _ = filling::Entity::delete_many().exec(db).await;
}
