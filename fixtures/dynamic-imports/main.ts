// await import() — resolvable
async function load(): Promise<void> {
  const mod = await import('./utils');
  mod.helper();
}

// () => import() inside React.lazy — resolvable
async function lazyLoad(): Promise<void> {
  const lazy = () => import('./page');
  return lazy().then(() => undefined);
}

// import(variable) — specifier is not a string literal, no Import node expected
async function dynamicPath(path: string): Promise<void> {
  await import(path);
}
