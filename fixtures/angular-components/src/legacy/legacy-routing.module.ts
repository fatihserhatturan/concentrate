import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LegacyListComponent } from './legacy.module';

const routes: Routes = [{ path: 'list', component: LegacyListComponent }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class LegacyRoutingModule {}
