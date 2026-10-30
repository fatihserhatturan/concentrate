import type { ReactNode } from 'react';

export default function DashboardLayout({ analytics, team }: { analytics: ReactNode; team: ReactNode }) {
  return (
    <section>
      {analytics}
      {team}
    </section>
  );
}
