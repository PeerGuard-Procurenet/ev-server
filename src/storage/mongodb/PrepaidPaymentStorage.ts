import PrepaidPayment, { PrepaidPaymentStatus } from '../../types/PrepaidPayment';
import global, { DatabaseCount, FilterParams } from '../../types/GlobalType';

import Constants from '../../utils/Constants';
import { DataResult } from '../../types/DataResult';
import DatabaseUtils from './DatabaseUtils';
import DbParams from '../../types/database/DbParams';
import Logging from '../../utils/Logging';
import { ObjectId } from 'mongodb';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'PrepaidPaymentStorage';

export default class PrepaidPaymentStorage {
  public static async savePrepaidPayment(tenant: Tenant, payment: PrepaidPayment): Promise<string> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    const paymentMDB: any = {
      _id: payment.id ? DatabaseUtils.convertToObjectID(payment.id) : new ObjectId(),
      reference: payment.reference,
      status: payment.status,
      provider: payment.provider,
      email: payment.email?.toLowerCase(),
      chargingStationID: payment.chargingStationID,
      connectorID: Utils.convertToInt(payment.connectorID),
      siteID: payment.siteID ? DatabaseUtils.convertToObjectID(payment.siteID) : null,
      siteAreaID: payment.siteAreaID ? DatabaseUtils.convertToObjectID(payment.siteAreaID) : null,
      siteName: payment.siteName,
      connectorType: payment.connectorType,
      connectorPowerWatts: payment.connectorPowerWatts,
      energyKWh: Utils.convertToFloat(payment.energyKWh),
      ratePerKWh: Utils.convertToFloat(payment.ratePerKWh),
      currency: payment.currency,
      amount: Utils.convertToFloat(payment.amount),
      amountKobo: Utils.convertToInt(payment.amountKobo),
      callbackURL: payment.callbackURL,
      authorizationURL: payment.authorizationURL,
      accessCode: payment.accessCode,
      paystackReference: payment.paystackReference,
      paystackAccessCode: payment.paystackAccessCode,
      paidAt: payment.paidAt ? Utils.convertToDate(payment.paidAt) : null,
      userID: payment.userID ? DatabaseUtils.convertToObjectID(payment.userID) : null,
      tagID: payment.tagID,
      transactionID: payment.transactionID ? Utils.convertToInt(payment.transactionID) : null,
      startedAt: payment.startedAt ? Utils.convertToDate(payment.startedAt) : null,
      stoppedAt: payment.stoppedAt ? Utils.convertToDate(payment.stoppedAt) : null,
      energyDeliveredWh: Utils.convertToFloat(payment.energyDeliveredWh || 0),
      stopReason: payment.stopReason,
      metadata: payment.metadata || {},
    };
    DatabaseUtils.addLastChangedCreatedProps(paymentMDB, payment);
    await global.database.getCollection<any>(tenant.id, 'prepaidpayments').findOneAndUpdate(
      { _id: paymentMDB._id },
      { $set: paymentMDB },
      { upsert: true, returnDocument: 'after' }
    );
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'savePrepaidPayment', startTime, paymentMDB);
    return paymentMDB._id.toString();
  }

  public static async getPrepaidPayment(tenant: Tenant, id: string): Promise<PrepaidPayment> {
    const payments = await PrepaidPaymentStorage.getPrepaidPayments(
      tenant, { paymentIDs: [id] }, Constants.DB_PARAMS_SINGLE_RECORD);
    return payments.count === 1 ? payments.result[0] : null;
  }

  public static async getPrepaidPaymentByReference(tenant: Tenant, reference: string): Promise<PrepaidPayment> {
    const payments = await PrepaidPaymentStorage.getPrepaidPayments(
      tenant, { references: [reference] }, Constants.DB_PARAMS_SINGLE_RECORD);
    return payments.count === 1 ? payments.result[0] : null;
  }

  public static async getActivePrepaidPaymentByTransactionID(tenant: Tenant, transactionID: number): Promise<PrepaidPayment> {
    const payments = await PrepaidPaymentStorage.getPrepaidPayments(
      tenant,
      {
        transactionIDs: [transactionID],
        statuses: [PrepaidPaymentStatus.CHARGING],
      },
      Constants.DB_PARAMS_SINGLE_RECORD
    );
    return payments.count === 1 ? payments.result[0] : null;
  }

  public static async getPrepaidPayments(tenant: Tenant,
      params: {
        paymentIDs?: string[];
        references?: string[];
        statuses?: PrepaidPaymentStatus[];
        transactionIDs?: number[];
        chargingStationIDs?: string[];
        emails?: string[];
      } = {},
      dbParams: DbParams, projectFields?: string[]): Promise<DataResult<PrepaidPayment>> {
    const startTime = Logging.traceDatabaseRequestStart();
    DatabaseUtils.checkTenantObject(tenant);
    dbParams = Utils.cloneObject(dbParams);
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    const aggregation = [];
    const filters: FilterParams = {};
    if (!Utils.isEmptyArray(params.paymentIDs)) {
      filters._id = {
        $in: params.paymentIDs.map((paymentID) => DatabaseUtils.convertToObjectID(paymentID)),
      };
    }
    if (!Utils.isEmptyArray(params.references)) {
      filters.reference = { $in: params.references };
    }
    if (!Utils.isEmptyArray(params.statuses)) {
      filters.status = { $in: params.statuses };
    }
    if (!Utils.isEmptyArray(params.transactionIDs)) {
      filters.transactionID = { $in: params.transactionIDs };
    }
    if (!Utils.isEmptyArray(params.chargingStationIDs)) {
      filters.chargingStationID = { $in: params.chargingStationIDs };
    }
    if (!Utils.isEmptyArray(params.emails)) {
      filters.email = { $in: params.emails.map((email) => email.toLowerCase()) };
    }
    if (!Utils.isEmptyJSon(filters)) {
      aggregation.push({ $match: filters });
    }
    if (!dbParams.onlyRecordCount) {
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    const countMDB = await global.database.getCollection<any>(tenant.id, 'prepaidpayments')
      .aggregate([...aggregation, { $count: 'count' }], DatabaseUtils.buildAggregateOptions())
      .toArray() as DatabaseCount[];
    if (dbParams.onlyRecordCount) {
      await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'getPrepaidPayments', startTime, aggregation, countMDB);
      return {
        count: (countMDB.length > 0 ? countMDB[0].count : 0),
        result: [],
      };
    }
    aggregation.pop();
    if (!dbParams.sort) {
      dbParams.sort = { createdOn: -1 };
    }
    aggregation.push({ $sort: dbParams.sort });
    aggregation.push({ $skip: dbParams.skip });
    aggregation.push({ $limit: dbParams.limit });
    DatabaseUtils.pushCreatedLastChangedInAggregation(tenant.id, aggregation);
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    DatabaseUtils.pushConvertObjectIDToString(aggregation, 'siteID');
    DatabaseUtils.pushConvertObjectIDToString(aggregation, 'siteAreaID');
    DatabaseUtils.pushConvertObjectIDToString(aggregation, 'userID');
    DatabaseUtils.projectFields(aggregation, projectFields);
    const paymentsMDB = await global.database.getCollection<any>(tenant.id, 'prepaidpayments')
      .aggregate(aggregation, DatabaseUtils.buildAggregateOptions())
      .toArray() as PrepaidPayment[];
    await Logging.traceDatabaseRequestEnd(tenant, MODULE_NAME, 'getPrepaidPayments', startTime, aggregation, paymentsMDB);
    return {
      count: (countMDB.length > 0 ? countMDB[0].count : 0),
      result: paymentsMDB,
    };
  }
}
