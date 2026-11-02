import { Component, NgModule } from '@angular/core';
import { LegacyBadgeComponent } from './badge.component';
import { LegacyRoutingModule } from './legacy-routing.module';

// Module-based: <app-badge> is the badge this module declares.
@Component({ selector: 'app-legacy-list', standalone: false, template: '<app-badge></app-badge>' })
export class LegacyListComponent {}

// Standalone without imports: <app-badge> could be either badge.
@Component({ selector: 'app-legacy-panel', template: '<app-badge></app-badge>' })
export class LegacyPanelComponent {}

@NgModule({ declarations: [LegacyBadgeComponent, LegacyListComponent], imports: [LegacyRoutingModule] })
export class LegacyModule {}
