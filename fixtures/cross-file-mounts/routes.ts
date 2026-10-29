import { Router } from 'express';
import users from './users';
import { admin } from './admin';

const api = Router()
  .use(users)
  .use('/admin', admin);

export default Router().use('/api', api);
