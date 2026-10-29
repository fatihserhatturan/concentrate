import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class Cat {
  @Prop()
  name: string;

  @Prop()
  age: number;
}

export const CatSchema = SchemaFactory.createForClass(Cat);
