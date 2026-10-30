// A local Route component, not React Router's: no pages.
function Route(props: { path: string }) {
  return <span>{props.path}</span>;
}

export function Fake() {
  return <Route path="/fake" />;
}
