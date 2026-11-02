import { Component } from '@angular/core';

// Same selector as the shared badge: renders of <app-badge> stay unresolved.
@Component({ selector: 'app-badge', template: '<i>legacy</i>' })
export class LegacyBadgeComponent {}
