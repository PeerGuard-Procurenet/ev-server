import { describe, expect, it, jest } from '@jest/globals';

import I18nManager from '../../src/utils/I18nManager';
import Utils from '../../src/utils/Utils';

let chargingStationConfig: Record<string, unknown> = { defaultTimezone: 'Africa/Lagos' };

jest.mock('../../src/utils/Configuration', () => {
  const actualConfiguration: object = jest.requireActual<{ default: object }>('../../src/utils/Configuration').default;
  return {
    __esModule: true,
    default: Object.assign(Object.create(actualConfiguration), {
      getChargingStationConfig: () => chargingStationConfig,
    }),
  };
});

describe('Default timezone of the charging stations without location', () => {
  it('should use the default timezone when the location is not set', () => {
    expect(Utils.getTimezone([])).toBe('Africa/Lagos');
    expect(Utils.getTimezone(null)).toBe('Africa/Lagos');
    // Unset coordinates
    expect(Utils.getTimezone([0, 0])).toBe('Africa/Lagos');
  });

  it('should use the timezone of the location when it is set', () => {
    // [longitude, latitude] of Paris
    expect(Utils.getTimezone([2.3522, 48.8566])).toBe('Europe/Paris');
  });

  it('should not have a timezone when there is no default one', () => {
    chargingStationConfig = {};
    try {
      expect(Utils.getTimezone([])).toBeNull();
    } finally {
      chargingStationConfig = { defaultTimezone: 'Africa/Lagos' };
    }
  });

  it('should display the times in West Africa Time (UTC+1)', () => {
    const i18nManager = I18nManager.getInstanceForLocale('en_US');
    expect(i18nManager.formatDateTime(new Date('2026-10-21T11:58:01.580Z'), 'HH:mm', Utils.getTimezone([]))).toBe('12:58');
  });
});
