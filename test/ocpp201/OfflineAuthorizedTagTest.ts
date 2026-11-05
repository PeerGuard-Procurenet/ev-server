import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import ChargingStation from '../../src/types/ChargingStation';
import { CommonUtilsService } from '../../src/server/CommonUtilsService';
import { ServerAction } from '../../src/types/Server';
import TagStorage from '../../src/storage/mongodb/TagStorage';
import Tenant from '../../src/types/Tenant';
import UserStorage from '../../src/storage/mongodb/UserStorage';

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
let chargingStationConfig: Record<string, unknown> = {};
jest.mock('../../src/utils/Configuration', () => {
  const actualConfiguration: object = jest.requireActual<{ default: object }>('../../src/utils/Configuration').default;
  return {
    __esModule: true,
    default: Object.assign(Object.create(actualConfiguration), { getChargingStationConfig: () => chargingStationConfig }),
  };
});
jest.mock('../../src/storage/mongodb/TagStorage', () => ({ __esModule: true, default: { getTag: jest.fn() } }));
jest.mock('../../src/storage/mongodb/UserStorage', () => ({ __esModule: true, default: { getUser: jest.fn() } }));

const tenant = { id: '5be7fb271014d90008992f06', subdomain: 'test' } as unknown as Tenant;
const chargingStation = { id: 'CS-OFFLINE' } as unknown as ChargingStation;
const users: Record<string, Record<string, unknown>> = {
  U1: { id: 'U1', status: 'A' },
  BLOCKED: { id: 'BLOCKED', status: 'B' },
  FALLBACK: { id: 'FALLBACK', status: 'A' },
};

describe('User of a tag authorized offline by the Charging Station', () => {
  const getUserOfTag = async (tagID: string) =>
    CommonUtilsService.getUserOfOfflineAuthorizedTag(tenant, chargingStation, tagID, ServerAction.OCPP_START_TRANSACTION);

  beforeEach(() => {
    chargingStationConfig = {};
    (UserStorage.getUser as jest.Mock<any>).mockImplementation(async (t: unknown, id: string) => Promise.resolve(users[id] ?? null));
    (TagStorage.getTag as jest.Mock<any>).mockImplementation(async (t: unknown, id: string) => Promise.resolve({
      TAG1: { id: 'TAG1', active: true, userID: 'U1' },
      INACTIVE: { id: 'INACTIVE', active: false, userID: 'U1' },
      BLOCKEDUSER: { id: 'BLOCKEDUSER', active: true, userID: 'BLOCKED' },
    }[id] ?? null));
  });

  it('should return the user of the tag', async () => {
    await expect(getUserOfTag('TAG1')).resolves.toMatchObject({ user: { id: 'U1' }, tag: { id: 'TAG1' } });
  });

  it('should return the user of a tag that is not authorized anymore (the session has happened)', async () => {
    await expect(getUserOfTag('INACTIVE')).resolves.toMatchObject({ user: { id: 'U1' } });
    await expect(getUserOfTag('BLOCKEDUSER')).resolves.toMatchObject({ user: { id: 'BLOCKED' } });
  });

  it('should return the fallback user for a tag that does not exist anymore', async () => {
    chargingStationConfig = { offlineFallbackUserID: 'FALLBACK' };
    await expect(getUserOfTag('DELETED')).resolves.toMatchObject({ user: { id: 'FALLBACK' } });
  });

  it('should refuse a tag that does not exist when no fallback user is configured', async () => {
    await expect(getUserOfTag('DELETED')).rejects.toThrow('no fallback user is configured');
  });
});
