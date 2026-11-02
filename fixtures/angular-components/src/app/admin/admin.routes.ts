import { Route } from '@angular/router';
import { UserListComponent } from '../user-list.component';
import { AvatarComponent } from '../shared/avatar.component';

export const ADMIN_ROUTES: Route[] = [
  { path: '', component: AvatarComponent },
  { path: 'users', component: UserListComponent },
];
