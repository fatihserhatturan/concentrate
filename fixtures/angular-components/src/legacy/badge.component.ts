import { Component } from '@angular/core';

// Same selector as the shared badge: which one <app-badge> renders depends on
// what the rendering component imports or its NgModule declares.
@Component({ selector: 'app-badge', standalone: false, template: '<i>legacy</i>' })
export class LegacyBadgeComponent {}
