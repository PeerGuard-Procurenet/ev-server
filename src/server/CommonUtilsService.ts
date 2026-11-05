import User, { UserStatus } from '../types/User';

import { Action } from '../types/Authorization';
import Authorizations from '../authorization/Authorizations';
import BackendError from '../exception/BackendError';
import ChargingStation from '../types/ChargingStation';
import Configuration from '../utils/Configuration';
import Logging from '../utils/Logging';
import LoggingHelper from '../utils/LoggingHelper';
import { ServerAction } from '../types/Server';
import Tag from '../types/Tag';
import TagStorage from '../storage/mongodb/TagStorage';
import Tenant from '../types/Tenant';
import Transaction from '../types/Transaction';
import UserStorage from '../storage/mongodb/UserStorage';
import Utils from '../utils/Utils';
import UtilsService from './rest/v1/service/UtilsService';

const MODULE_NAME = 'CommonUtilsService';

export class CommonUtilsService {

  public static async isAuthorizedOnChargingStation(tenant: Tenant, chargingStation: ChargingStation,
      tagID: string, action: ServerAction, authAction: Action): Promise<{user: User, tag?: Tag}> {
    return CommonUtilsService.isTagIDAuthorizedOnChargingStation(tenant, chargingStation, null, tagID, action, authAction);
  }

  public static async isAuthorizedToStartTransaction(tenant: Tenant, chargingStation: ChargingStation,
      tagID: string, transaction: Transaction, action: ServerAction, authAction?: Action): Promise<{user: User, tag?: Tag}> {
    return CommonUtilsService.isTagIDAuthorizedOnChargingStation(tenant, chargingStation, transaction, tagID, action, authAction);
  }

  // Tag of a transaction authorized by the Charging Station while offline (Local Authorization List): the session has happened, so it is
  // recorded with the user of the tag even if the tag or its user is not authorized anymore, or with the fallback user if the tag has been deleted
  public static async getUserOfOfflineAuthorizedTag(tenant: Tenant, chargingStation: ChargingStation,
      tagID: string, action: ServerAction): Promise<{user: User, tag?: Tag}> {
    const tag = await TagStorage.getTag(tenant, tagID);
    let user = tag?.userID ? await UserStorage.getUser(tenant, tag.userID) : null;
    if (user) {
      if (!tag.active || user.status !== UserStatus.ACTIVE) {
        await Logging.logWarning({
          ...LoggingHelper.getChargingStationProperties(chargingStation),
          tenantID: tenant.id, action, user,
          module: MODULE_NAME, method: 'getUserOfOfflineAuthorizedTag',
          message: `Tag ID '${tagID}' used offline is not authorized anymore (tag ${tag.active ? 'active' : 'inactive'}, user '${Utils.getStatusDescription(user.status)}'): the session is recorded`,
        });
      }
      return { user, tag };
    }
    const fallbackUserID = Configuration.getChargingStationConfig()?.offlineFallbackUserID;
    user = fallbackUserID ? await UserStorage.getUser(tenant, fallbackUserID) : null;
    if (!user) {
      throw new BackendError({
        ...LoggingHelper.getChargingStationProperties(chargingStation),
        action,
        module: MODULE_NAME, method: 'getUserOfOfflineAuthorizedTag',
        message: `Tag ID '${tagID}' used offline is unknown and no fallback user is configured ('ChargingStation.offlineFallbackUserID')`
      });
    }
    await Logging.logWarning({
      ...LoggingHelper.getChargingStationProperties(chargingStation),
      tenantID: tenant.id, action, user,
      module: MODULE_NAME, method: 'getUserOfOfflineAuthorizedTag',
      message: `Tag ID '${tagID}' used offline is unknown: the session is recorded with the fallback user`,
    });
    return { user, tag };
  }

  public static async isAuthorizedToStopTransaction(tenant: Tenant, chargingStation: ChargingStation,
      transaction: Transaction, tagID: string, action: ServerAction, authAction?: Action): Promise<{ user: User; tag: Tag; alternateUser: User; alternateTag; }> {
    let user: User, alternateUser: User, tag: Tag, alternateTag: Tag;
    // Check if same user
    if (tagID !== transaction.tagID) {
      // Check alternate User
      const result = await CommonUtilsService.isTagIDAuthorizedOnChargingStation(
        tenant, chargingStation, transaction, tagID, action, authAction);
      alternateUser = result.user;
      alternateTag = result.tag;
      // Get User and Tag that started the Transaction
      user = await UserStorage.getUserByTagID(tenant, transaction.tagID);
      tag = await TagStorage.getTag(tenant, transaction.tagID);
    } else {
      // Check User
      const result = await CommonUtilsService.isTagIDAuthorizedOnChargingStation(
        tenant, chargingStation, transaction, transaction.tagID, action, authAction);
      user = result.user;
      tag = result.tag;
    }
    return { user, tag, alternateUser, alternateTag };
  }

  private static async isTagIDAuthorizedOnChargingStation(tenant: Tenant, chargingStation: ChargingStation,
      transaction: Transaction, tagID: string, action: ServerAction, authAction: Action): Promise<{ user: User, tag?: Tag }> {
    // Check Organization
    if (Authorizations.isChargingStationValidInOrganization(action, tenant, chargingStation)) {
      // Access Control is disabled?
      if (!chargingStation.siteArea.accessControl) {
        // No ACL: Always try to get the user
        const user = await UserStorage.getUserByTagID(tenant, tagID);
        const tag = await TagStorage.getTag(tenant, tagID);
        return { user, tag };
      }
    }
    // Get Authorized Tag
    const tag = await Authorizations.checkAndGetAuthorizedTag(action, tenant, chargingStation, tagID);
    if (!tag) {
      // Check OICP first
      const user = await Authorizations.checkAndGetOICPAuthorizedUser(action, tenant, transaction, tagID);
      if (user) {
        return { user };
      }
      // Notify
      Authorizations.notifyUnknownBadgeHasBeenUsed(action, tenant, tagID, chargingStation);
      // Abort
      throw new BackendError({
        ...LoggingHelper.getChargingStationProperties(chargingStation),
        action,
        module: MODULE_NAME, method: 'isTagIDAuthorizedOnChargingStation',
        message: `Tag ID '${tagID}' is unknown`
      });
    }
    // Get Authorized User
    const user = await CommonUtilsService.checkAndGetAuthorizedUserFromTag(action, tenant, chargingStation, transaction, tag, authAction);
    // Check OCPI
    if (user && !user.issuer) {
      await Authorizations.checkOCPIAuthorizedUser(action, tenant, chargingStation, transaction, tag, user, authAction);
    }
    return { user, tag };
  }

  private static async checkAndGetAuthorizedUserFromTag(action: ServerAction, tenant: Tenant, chargingStation: ChargingStation,
      transaction: Transaction, tag: Tag, authAction: Action): Promise<User> {
    // Get User
    const user = await UserStorage.getUser(tenant, tag.user.id);
    // User status
    if (user.status !== UserStatus.ACTIVE) {
      throw new BackendError({
        ...LoggingHelper.getChargingStationProperties(chargingStation),
        action: action,
        message: `User with Tag ID '${tag.id}' is not Active ('${Utils.getStatusDescription(user.status)}')`,
        module: MODULE_NAME,
        method: 'checkAndGetAuthorizedUser',
        user: user
      });
    }
    // Check Auth if local User
    if (user.issuer && authAction) {
      // Build the JWT Token
      const userToken = await Authorizations.buildUserToken(tenant, user, [tag]);
      // Check charging station authorizations
      await UtilsService.checkAndGetChargingStationAuthorization(tenant, userToken, chargingStation.id, authAction, action, null, { withSite: true, withSiteArea: true });
    }
    return user;
  }
}
