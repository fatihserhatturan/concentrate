use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "fillings")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub cake_id: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(belongs_to = "super::cake::Entity", from = "Column::CakeId", to = "super::cake::Column::Id")]
    Cake,
}

impl ActiveModelBehavior for ActiveModel {}
