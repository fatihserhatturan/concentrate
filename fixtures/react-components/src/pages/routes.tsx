import { lazy, Suspense } from 'react';
import ConnectedProfile from '../components/Profile';

const Settings = lazy(() => import('./Settings'));
const Reports = lazy(() => import('./Reports').then((module) => ({ default: module.Reports })));

// A loader passed by name is not followed: Archive is a lazy component that
// renders nothing known.
const loadArchive = () => import('./Archive');
const Archive = lazy(loadArchive);

export function Pages({ page }: { page: string }) {
  return (
    <Suspense fallback={null}>
      {page === 'settings' ? <Settings /> : page === 'reports' ? <Reports /> : <Archive />}
      <ConnectedProfile />
    </Suspense>
  );
}
