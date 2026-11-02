import ChargingStation, { CurrentType } from '../../src/types/ChargingStation';
import { OCPPLocation, OCPPMeasurand, OCPPNormalizedMeterValue, OCPPReadingContext, OCPPUnitOfMeasure, OCPPValueFormat } from '../../src/types/ocpp/OCPPServer';
import { describe, expect, it, jest } from '@jest/globals';

import Consumption from '../../src/types/Consumption';
import OCPPUtils from '../../src/server/ocpp/utils/OCPPUtils';
import Tenant from '../../src/types/Tenant';
import Transaction from '../../src/types/Transaction';

jest.mock('../../src/utils/Logging', () => ({
  __esModule: true,
  default: {
    logDebug: jest.fn(async () => Promise.resolve('')),
    logInfo: jest.fn(async () => Promise.resolve('')),
    logWarning: jest.fn(async () => Promise.resolve('')),
    logError: jest.fn(async () => Promise.resolve('')),
    logConsoleDebug: jest.fn(),
    logConsoleError: jest.fn(),
  },
}));
jest.mock('../../src/utils/Configuration', () => {
  const actualConfiguration: object = jest.requireActual<{ default: object }>('../../src/utils/Configuration').default;
  return {
    __esModule: true,
    default: Object.assign(Object.create(actualConfiguration), {
      getChargingStationConfig: () => ({ pingIntervalOCPPJSecs: 60, defaultCurrentType: 'DC' }),
    }),
  };
});

// Charging Station created from the Status Notifications, without template (no current type)
const buildChargingStation = (currentType: CurrentType = null): ChargingStation => ({
  id: 'CS-DC',
  chargePoints: [],
  connectors: [
    { connectorId: 1, currentType, power: 0, voltage: 0, amperage: 0 },
    { connectorId: 2, currentType, power: 0, voltage: 0, amperage: 0 },
  ],
} as unknown as ChargingStation);

const buildTransaction = (): Transaction => ({
  id: 555,
  chargeBoxID: 'CS-DC',
  connectorId: 2,
  timestamp: new Date('2026-10-24T05:14:52.392Z'),
  meterStart: 4,
  currentTotalConsumptionWh: 0,
} as Transaction);

const buildMeterValue = (measurand: OCPPMeasurand, unit: OCPPUnitOfMeasure, value: number): OCPPNormalizedMeterValue => ({
  chargeBoxID: 'CS-DC',
  connectorId: 2,
  transactionId: 555,
  timestamp: new Date('2026-10-24T05:15:22.392Z'),
  attribute: {
    context: OCPPReadingContext.SAMPLE_PERIODIC,
    format: OCPPValueFormat.RAW,
    measurand,
    location: OCPPLocation.OUTLET,
    unit,
    phase: null,
  },
  value,
} as OCPPNormalizedMeterValue);

describe('DC meter values', () => {
  describe('Current type', () => {
    it('should use the default current type when the connector has none', () => {
      expect(OCPPUtils.getMeterValuesCurrentType(buildChargingStation(), 2)).toBe(CurrentType.DC);
    });

    it('should keep the current type of the connector when it is known', () => {
      expect(OCPPUtils.getMeterValuesCurrentType(buildChargingStation(CurrentType.AC), 2)).toBe(CurrentType.AC);
    });
  });

  describe('Consumptions', () => {
    it('should store the measured Voltage, Current and Power of a connector without current type as DC values', async () => {
      const chargingStation = buildChargingStation();
      const transaction = buildTransaction();
      const voltage = await OCPPUtils.createConsumptionFromMeterValue({ id: 'tenant' } as Tenant, chargingStation, transaction, null,
        buildMeterValue(OCPPMeasurand.VOLTAGE, OCPPUnitOfMeasure.VOLT, 402.5));
      const current = await OCPPUtils.createConsumptionFromMeterValue({ id: 'tenant' } as Tenant, chargingStation, transaction, null,
        buildMeterValue(OCPPMeasurand.CURRENT_IMPORT, OCPPUnitOfMeasure.AMP, 107.3));
      const power = await OCPPUtils.createConsumptionFromMeterValue({ id: 'tenant' } as Tenant, chargingStation, transaction, null,
        buildMeterValue(OCPPMeasurand.POWER_ACTIVE_IMPORT, OCPPUnitOfMeasure.WATT, 43188));
      expect(voltage.instantVoltsDC).toBe(402.5);
      expect(voltage.instantVolts).toBeUndefined();
      expect(current.instantAmpsDC).toBe(107.3);
      expect(current.instantAmps).toBeUndefined();
      expect(power.instantWattsDC).toBe(43188);
      expect(power.instantWatts).toBeUndefined();
    });

    it('should use the measured DC values as the totals of the connector', () => {
      const consumption = {
        startedAt: new Date('2026-10-24T05:14:52.392Z'),
        endedAt: new Date('2026-10-24T05:15:22.392Z'),
        consumptionWh: 217,
        instantVoltsDC: 402.5,
        instantAmpsDC: 107.3,
        instantWattsDC: 43188,
      } as Consumption;
      OCPPUtils.assertConsistencyInConsumption(buildChargingStation(), 2, consumption);
      expect(consumption.instantWatts).toBe(43188);
      expect(consumption.instantAmps).toBe(107.3);
      expect(consumption.instantVolts).toBe(402.5);
    });

    it('should compute the DC Power from the DC Voltage and Current when it is not provided', () => {
      const consumption = {
        startedAt: new Date('2026-10-24T05:14:52.392Z'),
        endedAt: new Date('2026-10-24T05:15:22.392Z'),
        consumptionWh: 217,
        instantVoltsDC: 400,
        instantAmpsDC: 100.5,
      } as Consumption;
      OCPPUtils.assertConsistencyInConsumption(buildChargingStation(), 2, consumption);
      expect(consumption.instantWattsDC).toBe(40200);
      expect(consumption.instantWatts).toBe(40200);
    });

    it('should still estimate the Power from the energy when no DC value is measured', () => {
      const consumption = {
        startedAt: new Date('2026-10-24T05:14:52.392Z'),
        endedAt: new Date('2026-10-24T05:15:22.392Z'),
        consumptionWh: 217,
      } as Consumption;
      OCPPUtils.assertConsistencyInConsumption(buildChargingStation(), 2, consumption);
      // 217 Wh in 30 secs
      expect(consumption.instantWatts).toBe(26040);
      expect(consumption.instantWattsDC).toBeUndefined();
    });
  });
});
