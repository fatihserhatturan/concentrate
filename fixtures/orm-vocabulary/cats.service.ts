import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cat } from './cat.schema';

@Injectable()
export class CatsService {
  constructor(@InjectModel(Cat.name) private readonly catModel: Model<Cat>) {}

  update(id: string, changes: Partial<Cat>) {
    return this.catModel.findByIdAndUpdate(id, changes, { new: true }).exec();
  }

  replace(id: string, cat: Cat) {
    return this.catModel.findOneAndReplace({ _id: id }, cat).exec();
  }

  rename(name: string, next: string) {
    return this.catModel.updateOne({ name }, { name: next }).exec();
  }

  delete(id: string) {
    return this.catModel.findByIdAndDelete(id).exec();
  }

  deleteByName(name: string) {
    return this.catModel.findOneAndDelete({ name }).exec();
  }

  deleteOldest() {
    return this.catModel.deleteOne({}).exec();
  }

  count() {
    return this.catModel.countDocuments().exec();
  }
}
