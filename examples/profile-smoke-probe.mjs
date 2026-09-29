// Mounted by the official CLI loader, not a home-made Context bootstrap.
export const inject = ['gfg', 'tools', 'sessions'];
export function apply(ctx) {
  const ready = ctx.get('appReady'), exit = ctx.get('appExit');
  if (!ready || !exit) throw new Error('Official CLI lifecycle unavailable');
  ctx.effect(() => ready.onReady(() => {
    const pass = ctx.gfg.errors.length === 0 && typeof ctx.tools.execute === 'function';
    process.stdout.write(`DSH_GFG_PROFILE_SMOKE ${JSON.stringify({ plugin_started: pass })}\n`);
    exit(pass ? 0 : 1);
  }), 'gfg profile install smoke');
}
