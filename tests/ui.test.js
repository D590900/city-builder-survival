import { describe, it, expect } from 'vitest';

// The UI modules are DOM-based, but importing them must be side-effect free:
// they may touch `document` only inside their factory functions. These tests
// run in the node environment (no DOM), so a successful import proves there
// is no top-level DOM access.

describe('ui modules (import-only smoke)', () => {
  it('test environment has no DOM', () => {
    expect(typeof document).toBe('undefined');
  });

  it('hud.js imports cleanly and exports createHud', async () => {
    const mod = await import('../src/ui/hud.js');
    expect(typeof mod.createHud).toBe('function');
  });

  it('buildmenu.js imports cleanly and exports createBuildMenu', async () => {
    const mod = await import('../src/ui/buildmenu.js');
    expect(typeof mod.createBuildMenu).toBe('function');
  });

  it('inspector.js imports cleanly and exports createInspector', async () => {
    const mod = await import('../src/ui/inspector.js');
    expect(typeof mod.createInspector).toBe('function');
  });

  it('researchpanel.js imports cleanly and exports createResearchPanel', async () => {
    const mod = await import('../src/ui/researchpanel.js');
    expect(typeof mod.createResearchPanel).toBe('function');
  });

  it('laborpanel.js imports cleanly and exports createLaborPanel', async () => {
    const mod = await import('../src/ui/laborpanel.js');
    expect(typeof mod.createLaborPanel).toBe('function');
  });

  it('screens.js imports cleanly and exports createScreens', async () => {
    const mod = await import('../src/ui/screens.js');
    expect(typeof mod.createScreens).toBe('function');
  });
});
