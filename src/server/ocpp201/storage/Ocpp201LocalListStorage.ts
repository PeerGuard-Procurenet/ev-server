import DatabaseUtils from '../../../storage/mongodb/DatabaseUtils';
import { Ocpp201LocalListVersion } from '../types/Ocpp201Types';
import Tenant from '../../../types/Tenant';
import global from '../../../types/GlobalType';

const COLLECTION_NAME = 'ocpp201locallists';
// One Local Authorization List per tenant (same list on all its Charging Stations)
const LOCAL_LIST_ID = 'default';
// MongoDB duplicate key error
const DUPLICATE_KEY_ERROR_CODE = 11000;

type Ocpp201LocalListVersionMDB = Omit<Ocpp201LocalListVersion, 'id'> & { _id: string };

// Persists the version of the Local Authorization List sent to the OCPP 2.0.1 Charging Stations
export default class Ocpp201LocalListStorage {
  // Version of the list with this content: increased when the content has changed
  public static async getVersion(tenant: Tenant, hash: string): Promise<number> {
    DatabaseUtils.checkTenantObject(tenant);
    const collection = global.database.getCollection<Ocpp201LocalListVersionMDB>(tenant.id, COLLECTION_NAME);
    const current = await collection.findOne({ _id: LOCAL_LIST_ID });
    if (current?.hash === hash) {
      return current.version;
    }
    try {
      // Atomic: several server instances can detect the same change
      const result = await collection.findOneAndUpdate(
        { _id: LOCAL_LIST_ID, hash: { $ne: hash } },
        { $inc: { version: 1 }, $set: { hash, lastChangedOn: new Date() } },
        { upsert: true, returnDocument: 'after' });
      return result.value.version;
    } catch (error) {
      // Already updated with this content by another instance
      if ((error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) {
        return (await collection.findOne({ _id: LOCAL_LIST_ID })).version;
      }
      throw error;
    }
  }
}
