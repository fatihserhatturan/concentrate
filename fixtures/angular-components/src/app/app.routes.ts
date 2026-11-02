import { Routes } from '@angular/router';
import { UserListComponent } from './user-list.component';
import { UserCardComponent } from './user-card.component';
import { AvatarComponent } from './shared/avatar.component';
import { BadgeComponent } from './shared/badge.component';

export const routes: Routes = [
  { path: '', redirectTo: 'users', pathMatch: 'full' },
  { path: 'users', component: UserListComponent },
  {
    path: 'users/:id',
    loadComponent: () => import('./user-card.component').then((m) => m.UserCardComponent),
  },
  { path: 'welcome', loadComponent: () => import('./welcome.component') },
  {
    path: 'settings',
    component: UserCardComponent,
    children: [
      { path: '', component: AvatarComponent },
      { path: 'badge', component: BadgeComponent },
    ],
  },
  { path: 'admin', loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) },
  { path: 'legacy', loadChildren: () => import('../legacy/legacy.module').then((m) => m.LegacyModule) },
  { path: '**', component: BadgeComponent },
];
