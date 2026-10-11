import { describe, it, expect } from 'vitest';
import { headingFromEvent } from './compass';
describe('boussole', () => {
  it('iOS : cap + fiabilité selon la précision', () => {
    expect(headingFromEvent({ alpha: null, webkitCompassHeading: 90, webkitCompassAccuracy: 10 })).toEqual({ deg: 90, reliable: true });
    expect(headingFromEvent({ alpha: null, webkitCompassHeading: 90, webkitCompassAccuracy: 60 })?.reliable).toBe(false);
  });
  it('Android : alpha inversé ; non fiable si non absolu', () => {
    expect(headingFromEvent({ alpha: 90, absolute: true })).toEqual({ deg: 270, reliable: true });
    expect(headingFromEvent({ alpha: 90, absolute: false })?.reliable).toBe(false);
  });
  it('indisponible si pas de données', () => { expect(headingFromEvent({ alpha: null })).toBeNull(); });
});
