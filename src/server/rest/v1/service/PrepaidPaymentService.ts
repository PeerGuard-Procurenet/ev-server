import { NextFunction, Request, Response } from 'express';
import PrepaidPayment, { PrepaidChargerDetails, PrepaidChargerGun, PrepaidPaymentProvider, PrepaidPaymentStatus, PrepaidPaymentStatusResponse } from '../../../../types/PrepaidPayment';
import { ServerAction } from '../../../../types/Server';
import User, { UserRole, UserStatus } from '../../../../types/User';

import AppError from '../../../../exception/AppError';
import BackendError from '../../../../exception/BackendError';
import ChargingStationClientFactory from '../../../../client/ocpp/ChargingStationClientFactory';
import ChargingStationStorage from '../../../../storage/mongodb/ChargingStationStorage';
import { ConnectorType } from '../../../../types/ChargingStation';
import Constants from '../../../../utils/Constants';
import { Decimal } from 'decimal.js';
import { HTTPError } from '../../../../types/HTTPError';
import Logging from '../../../../utils/Logging';
import { OCPPRemoteStartStopStatus } from '../../../../types/ocpp/OCPPClient';
import PaystackClient from '../../../../integration/payment/paystack/PaystackClient';
import PrepaidPaymentStorage from '../../../../storage/mongodb/PrepaidPaymentStorage';
import { PricingSettings, PricingSettingsType } from '../../../../types/Setting';
import SettingStorage from '../../../../storage/mongodb/SettingStorage';
import SiteStorage from '../../../../storage/mongodb/SiteStorage';
import { StatusCodes } from 'http-status-codes';
import Tag from '../../../../types/Tag';
import TagStorage from '../../../../storage/mongodb/TagStorage';
import Tenant from '../../../../types/Tenant';
import TenantStorage from '../../../../storage/mongodb/TenantStorage';
import TransactionStorage from '../../../../storage/mongodb/TransactionStorage';
import UserStorage from '../../../../storage/mongodb/UserStorage';
import Utils from '../../../../utils/Utils';
import { ChargePointStatus } from '../../../../types/ocpp/OCPPServer';
import { customAlphabet } from 'nanoid';
import moment from 'moment';

const MODULE_NAME = 'PrepaidPaymentService';
const REFERENCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const generateReferenceSuffix = customAlphabet(REFERENCE_ALPHABET, 8);

export default class PrepaidPaymentService {
  public static async handleGetCharger(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    const chargingStationID = req.params.id || req.query.ID as string;
    if (!chargingStationID) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'Charging Station ID is mandatory',
        module: MODULE_NAME, method: 'handleGetCharger', action,
      });
    }
    const details = await PrepaidPaymentService.buildChargerDetails(req.tenant, chargingStationID);
    res.json(details);
    next();
  }

  public static async handleInitializePayment(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    const chargingStationID = req.body.chargingStationID as string;
    const connectorID = Utils.convertToInt(req.body.connectorID);
    const energyKWh = Utils.convertToFloat(req.body.energyKWh);
    const email = (req.body.email as string || '').trim().toLowerCase();
    const callbackURL = (req.body.callbackURL as string) || process.env.PAYSTACK_CALLBACK_URL;
    if (!chargingStationID || !connectorID || !energyKWh || !email) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'chargingStationID, connectorID, energyKWh and email are mandatory',
        module: MODULE_NAME, method: 'handleInitializePayment', action,
      });
    }
    if (energyKWh <= 0) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'energyKWh must be greater than 0',
        module: MODULE_NAME, method: 'handleInitializePayment', action,
      });
    }
    const charger = await PrepaidPaymentService.buildChargerDetails(req.tenant, chargingStationID);
    const gun = charger.guns.find((item) => item.connectorID === connectorID);
    if (!gun) {
      throw new AppError({
        errorCode: StatusCodes.NOT_FOUND,
        message: `Connector ID '${connectorID}' does not exist on Charging Station '${chargingStationID}'`,
        module: MODULE_NAME, method: 'handleInitializePayment', action,
      });
    }
    if (!gun.available) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Connector ID '${connectorID}' is not available`,
        module: MODULE_NAME, method: 'handleInitializePayment', action,
      });
    }
    const amount = Utils.convertToFloat(new Decimal(energyKWh).mul(charger.ratePerKWh).toFixed(2));
    const amountKobo = Utils.convertToInt(new Decimal(amount).mul(100).toDecimalPlaces(0).toNumber());
    if (amountKobo <= 0) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'Computed payment amount must be greater than 0',
        module: MODULE_NAME, method: 'handleInitializePayment', action,
      });
    }
    const reference = `PEV-${generateReferenceSuffix()}`;
    const { user, tag } = await PrepaidPaymentService.ensureGuestUserAndTag(req.tenant, email, reference);
    const payment: PrepaidPayment = {
      reference,
      status: PrepaidPaymentStatus.PENDING,
      provider: PrepaidPaymentProvider.PAYSTACK,
      email,
      chargingStationID,
      connectorID,
      siteID: charger.siteID,
      siteAreaID: charger.siteAreaID,
      siteName: charger.siteName,
      connectorType: gun.type,
      connectorPowerWatts: gun.powerWatts,
      energyKWh,
      ratePerKWh: charger.ratePerKWh,
      currency: charger.currency,
      amount,
      amountKobo,
      callbackURL,
      userID: user.id,
      tagID: tag.id,
      energyDeliveredWh: 0,
      createdOn: new Date(),
      lastChangedOn: new Date(),
    };
    payment.id = await PrepaidPaymentStorage.savePrepaidPayment(req.tenant, payment);
    const paystack = PaystackClient.getInstance(req.tenant);
    const initResult = await paystack.initializeTransaction({
      email,
      amountKobo,
      reference,
      currency: charger.currency || 'NGN',
      callbackURL,
      metadata: {
        prepaidPaymentID: payment.id,
        tenantID: req.tenant.id,
        chargingStationID,
        connectorID,
        energyKWh,
        ratePerKWh: charger.ratePerKWh,
      },
    });
    payment.authorizationURL = initResult.authorizationURL;
    payment.accessCode = initResult.accessCode;
    payment.paystackReference = initResult.reference;
    payment.paystackAccessCode = initResult.accessCode;
    payment.lastChangedOn = new Date();
    await PrepaidPaymentStorage.savePrepaidPayment(req.tenant, payment);
    await Logging.logInfo({
      tenantID: req.tenant.id,
      action,
      module: MODULE_NAME, method: 'handleInitializePayment',
      message: `Prepaid payment '${reference}' initialized for ${energyKWh} kWh`,
      detailedMessages: { paymentID: payment.id, amount, amountKobo },
    });
    res.json({
      id: payment.id,
      reference: payment.reference,
      status: payment.status,
      amount: payment.amount,
      amountKobo: payment.amountKobo,
      currency: payment.currency,
      energyKWh: payment.energyKWh,
      ratePerKWh: payment.ratePerKWh,
      authorizationURL: payment.authorizationURL,
      accessCode: payment.accessCode,
      publicKey: PaystackClient.getPublicKey(),
    });
    next();
  }

  public static async handleGetPayment(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    const payment = await PrepaidPaymentService.getPaymentOrThrow(req.tenant, req.params.reference || req.query.Reference as string, action);
    res.json(await PrepaidPaymentService.buildStatusResponse(req.tenant, payment));
    next();
  }

  public static async handleVerifyPayment(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    const payment = await PrepaidPaymentService.getPaymentOrThrow(req.tenant, req.params.reference, action);
    const updated = await PrepaidPaymentService.verifyAndMarkPaid(req.tenant, payment, action);
    res.json(await PrepaidPaymentService.buildStatusResponse(req.tenant, updated));
    next();
  }

  public static async handleStartCharging(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    let payment = await PrepaidPaymentService.getPaymentOrThrow(req.tenant, req.params.reference, action);
    if (payment.status === PrepaidPaymentStatus.PENDING) {
      payment = await PrepaidPaymentService.verifyAndMarkPaid(req.tenant, payment, action);
    }
    if (payment.status !== PrepaidPaymentStatus.PAID && payment.status !== PrepaidPaymentStatus.CHARGING) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: `Prepaid payment '${payment.reference}' is not ready to start (status=${payment.status})`,
        module: MODULE_NAME, method: 'handleStartCharging', action,
      });
    }
    if (payment.status === PrepaidPaymentStatus.CHARGING && payment.transactionID) {
      res.json(await PrepaidPaymentService.buildStatusResponse(req.tenant, payment));
      next();
      return;
    }
    const chargingStation = await ChargingStationStorage.getChargingStation(req.tenant, payment.chargingStationID);
    UtilsServiceAssertExists(action, chargingStation, payment.chargingStationID, 'Charging Station');
    const activeTransaction = await TransactionStorage.getActiveTransaction(
      req.tenant, payment.chargingStationID, payment.connectorID);
    if (activeTransaction) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Connector ${payment.connectorID} already has an active transaction`,
        module: MODULE_NAME, method: 'handleStartCharging', action,
      });
    }
    const chargingStationClient = await ChargingStationClientFactory.getChargingStationClient(req.tenant, chargingStation);
    if (!chargingStationClient) {
      throw new BackendError({
        action,
        module: MODULE_NAME, method: 'handleStartCharging',
        message: `Charging Station '${payment.chargingStationID}' is not connected`,
      });
    }
    const result = await chargingStationClient.remoteStartTransaction({
      connectorId: payment.connectorID,
      idTag: payment.tagID,
    });
    if (result.status !== OCPPRemoteStartStopStatus.ACCEPTED) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Remote start rejected by Charging Station '${payment.chargingStationID}'`,
        module: MODULE_NAME, method: 'handleStartCharging', action,
        detailedMessages: { result },
      });
    }
    // Wait briefly for StartTransaction to create the OCPP transaction
    let transaction = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      await Utils.sleep(500);
      transaction = await TransactionStorage.getActiveTransaction(
        req.tenant, payment.chargingStationID, payment.connectorID);
      if (transaction) {
        break;
      }
    }
    payment.status = PrepaidPaymentStatus.CHARGING;
    payment.startedAt = new Date();
    payment.lastChangedOn = new Date();
    if (transaction) {
      payment.transactionID = transaction.id;
    }
    await PrepaidPaymentStorage.savePrepaidPayment(req.tenant, payment);
    await Logging.logInfo({
      tenantID: req.tenant.id,
      action,
      module: MODULE_NAME, method: 'handleStartCharging',
      message: `Prepaid payment '${payment.reference}' started charging`,
      detailedMessages: { transactionID: payment.transactionID },
    });
    res.json(await PrepaidPaymentService.buildStatusResponse(req.tenant, payment));
    next();
  }

  public static async handleStopCharging(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    PrepaidPaymentService.assertTenant(req, action);
    const payment = await PrepaidPaymentService.getPaymentOrThrow(req.tenant, req.params.reference, action);
    if (payment.status !== PrepaidPaymentStatus.CHARGING) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: `Prepaid payment '${payment.reference}' is not charging`,
        module: MODULE_NAME, method: 'handleStopCharging', action,
      });
    }
    await PrepaidPaymentService.stopPrepaidSession(req.tenant, payment, 'user_stop', action);
    const updated = await PrepaidPaymentStorage.getPrepaidPaymentByReference(req.tenant, payment.reference);
    res.json(await PrepaidPaymentService.buildStatusResponse(req.tenant, updated));
    next();
  }

  public static async handlePaystackWebhook(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    let tenant = req.tenant;
    const metadataTenantID = req.body?.data?.metadata?.tenantID as string;
    if (!tenant && metadataTenantID) {
      tenant = await TenantStorage.getTenant(metadataTenantID);
    }
    if (!tenant) {
      tenant = await TenantStorage.getTenantBySubdomain(Constants.DEFAULT_TENANT_ID);
    }
    if (!tenant) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'Unable to resolve tenant for Paystack webhook. Pass TenantID on the webhook URL or include metadata.tenantID',
        module: MODULE_NAME, method: 'handlePaystackWebhook', action,
      });
    }
    req.tenant = tenant;
    const paystack = PaystackClient.getInstance(tenant);
    const signature = (req.headers['x-paystack-signature'] || req.headers['paystack-signature'] || '') as string;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!paystack.verifyWebhookSignature(rawBody, signature)) {
      throw new AppError({
        errorCode: StatusCodes.UNAUTHORIZED,
        message: 'Invalid Paystack webhook signature',
        module: MODULE_NAME, method: 'handlePaystackWebhook', action,
      });
    }
    const event = req.body;
    if (event?.event === 'charge.success') {
      const reference = event?.data?.reference as string;
      if (reference) {
        const payment = await PrepaidPaymentStorage.getPrepaidPaymentByReference(tenant, reference);
        if (payment) {
          await PrepaidPaymentService.verifyAndMarkPaid(tenant, payment, action);
        } else {
          await paystack.logWebhookIgnored(tenant, `No prepaid payment for reference '${reference}'`, event);
        }
      }
    }
    res.sendStatus(StatusCodes.OK);
    next();
  }

  public static async checkAndStopIfEnergyPurchased(tenant: Tenant, transactionID: number, energyDeliveredWh: number): Promise<void> {
    const payment = await PrepaidPaymentStorage.getActivePrepaidPaymentByTransactionID(tenant, transactionID);
    if (!payment) {
      return;
    }
    payment.energyDeliveredWh = energyDeliveredWh;
    payment.lastChangedOn = new Date();
    const purchasedWh = new Decimal(payment.energyKWh).mul(1000).toNumber();
    if (energyDeliveredWh < purchasedWh) {
      await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
      return;
    }
    await PrepaidPaymentService.stopPrepaidSession(tenant, payment, 'energy_limit_reached', ServerAction.PREPAID_PAYMENT_STOP);
  }

  public static async completePrepaidSessionFromOcppStop(tenant: Tenant, transactionID: number, energyDeliveredWh: number): Promise<void> {
    const payment = await PrepaidPaymentStorage.getActivePrepaidPaymentByTransactionID(tenant, transactionID);
    if (!payment) {
      return;
    }
    payment.energyDeliveredWh = energyDeliveredWh;
    payment.status = PrepaidPaymentStatus.COMPLETED;
    payment.stoppedAt = new Date();
    payment.stopReason = payment.stopReason || 'ocpp_stop';
    payment.lastChangedOn = new Date();
    await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
  }

  public static async linkTransactionIfNeeded(tenant: Tenant, chargingStationID: string, connectorID: number, tagID: string, transactionID: number): Promise<void> {
    const payments = await PrepaidPaymentStorage.getPrepaidPayments(tenant, {
      chargingStationIDs: [chargingStationID],
      statuses: [PrepaidPaymentStatus.CHARGING, PrepaidPaymentStatus.PAID],
    }, Constants.DB_PARAMS_MAX_LIMIT);
    const payment = payments.result.find((item) =>
      item.connectorID === connectorID && item.tagID === tagID && !item.transactionID);
    if (!payment) {
      return;
    }
    payment.transactionID = transactionID;
    payment.status = PrepaidPaymentStatus.CHARGING;
    payment.startedAt = payment.startedAt || new Date();
    payment.lastChangedOn = new Date();
    await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
  }

  private static async stopPrepaidSession(tenant: Tenant, payment: PrepaidPayment, stopReason: string, action: ServerAction): Promise<void> {
    if (payment.status === PrepaidPaymentStatus.COMPLETED || payment.status === PrepaidPaymentStatus.CANCELLED) {
      return;
    }
    const chargingStation = await ChargingStationStorage.getChargingStation(tenant, payment.chargingStationID);
    if (!chargingStation) {
      throw new BackendError({
        action,
        module: MODULE_NAME, method: 'stopPrepaidSession',
        message: `Charging Station '${payment.chargingStationID}' does not exist`,
      });
    }
    let transactionID = payment.transactionID;
    if (!transactionID) {
      const activeTransaction = await TransactionStorage.getActiveTransaction(
        tenant, payment.chargingStationID, payment.connectorID);
      transactionID = activeTransaction?.id;
    }
    if (transactionID) {
      const chargingStationClient = await ChargingStationClientFactory.getChargingStationClient(tenant, chargingStation);
      if (chargingStationClient) {
        await chargingStationClient.remoteStopTransaction({ transactionId: transactionID });
      }
      const transaction = await TransactionStorage.getTransaction(tenant, transactionID);
      if (transaction) {
        payment.energyDeliveredWh = transaction.currentTotalConsumptionWh || transaction.stop?.totalConsumptionWh || payment.energyDeliveredWh || 0;
      }
    }
    payment.status = PrepaidPaymentStatus.COMPLETED;
    payment.stoppedAt = new Date();
    payment.stopReason = stopReason;
    payment.transactionID = transactionID || payment.transactionID;
    payment.lastChangedOn = new Date();
    await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
    await Logging.logInfo({
      tenantID: tenant.id,
      action,
      module: MODULE_NAME, method: 'stopPrepaidSession',
      message: `Prepaid payment '${payment.reference}' stopped (${stopReason})`,
      detailedMessages: { transactionID, energyDeliveredWh: payment.energyDeliveredWh },
    });
  }

  private static async verifyAndMarkPaid(tenant: Tenant, payment: PrepaidPayment, action: ServerAction): Promise<PrepaidPayment> {
    if (payment.status === PrepaidPaymentStatus.PAID ||
        payment.status === PrepaidPaymentStatus.CHARGING ||
        payment.status === PrepaidPaymentStatus.COMPLETED) {
      return payment;
    }
    const paystack = PaystackClient.getInstance(tenant);
    const verified = await paystack.verifyTransaction(payment.reference);
    if (verified.status !== 'success') {
      payment.status = PrepaidPaymentStatus.FAILED;
      payment.lastChangedOn = new Date();
      await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: `Payment '${payment.reference}' is not successful (Paystack status=${verified.status})`,
        module: MODULE_NAME, method: 'verifyAndMarkPaid', action,
        detailedMessages: { verified },
      });
    }
    if (Utils.convertToInt(verified.amount) !== payment.amountKobo) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: `Payment amount mismatch for '${payment.reference}'`,
        module: MODULE_NAME, method: 'verifyAndMarkPaid', action,
        detailedMessages: { expected: payment.amountKobo, received: verified.amount },
      });
    }
    payment.status = PrepaidPaymentStatus.PAID;
    payment.paidAt = verified.paidAt ? new Date(verified.paidAt) : new Date();
    payment.paystackReference = verified.reference;
    payment.lastChangedOn = new Date();
    await PrepaidPaymentStorage.savePrepaidPayment(tenant, payment);
    await Logging.logInfo({
      tenantID: tenant.id,
      action,
      module: MODULE_NAME, method: 'verifyAndMarkPaid',
      message: `Prepaid payment '${payment.reference}' marked as paid`,
    });
    return payment;
  }

  private static assertTenant(req: Request, action: ServerAction): void {
    if (!req.tenant) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'Tenant is mandatory. Pass TenantID or Subdomain on the request',
        module: MODULE_NAME, method: 'assertTenant', action,
      });
    }
  }

  private static async getPaymentOrThrow(tenant: Tenant, reference: string, action: ServerAction): Promise<PrepaidPayment> {
    if (!reference) {
      throw new AppError({
        errorCode: StatusCodes.BAD_REQUEST,
        message: 'Payment reference is mandatory',
        module: MODULE_NAME, method: 'getPaymentOrThrow', action,
      });
    }
    const payment = await PrepaidPaymentStorage.getPrepaidPaymentByReference(tenant, reference);
    if (!payment) {
      throw new AppError({
        errorCode: StatusCodes.NOT_FOUND,
        message: `Prepaid payment '${reference}' does not exist`,
        module: MODULE_NAME, method: 'getPaymentOrThrow', action,
      });
    }
    return payment;
  }

  private static async buildChargerDetails(tenant: Tenant, chargingStationID: string): Promise<PrepaidChargerDetails> {
    const chargingStation = await ChargingStationStorage.getChargingStation(tenant, chargingStationID, {
      withSite: true,
      withSiteArea: true,
    });
    if (!chargingStation) {
      throw new AppError({
        errorCode: StatusCodes.NOT_FOUND,
        message: `Charging Station '${chargingStationID}' does not exist`,
        module: MODULE_NAME, method: 'buildChargerDetails',
        action: ServerAction.PREPAID_PAYMENT_GET_CHARGER,
      });
    }
    const pricing = await PrepaidPaymentService.getEnergyRate(tenant);
    let siteName = chargingStation.site?.name;
    if (!siteName && chargingStation.siteID) {
      const site = await SiteStorage.getSite(tenant, chargingStation.siteID);
      siteName = site?.name;
    }
    const guns: PrepaidChargerGun[] = (chargingStation.connectors || []).map((connector) => ({
      connectorID: connector.connectorId,
      label: `Gun ${String.fromCharCode(64 + connector.connectorId)}`,
      type: PrepaidPaymentService.mapConnectorType(connector.type),
      powerWatts: connector.power || chargingStation.maximumPower || 0,
      status: connector.status,
      available: !connector.currentTransactionID &&
        [ChargePointStatus.AVAILABLE, ChargePointStatus.PREPARING, ChargePointStatus.FINISHING].includes(connector.status),
    }));
    return {
      chargingStationID: chargingStation.id,
      siteID: chargingStation.siteID,
      siteAreaID: chargingStation.siteAreaID,
      siteName: siteName || chargingStation.id,
      online: !chargingStation.inactive,
      maximumPowerWatts: chargingStation.maximumPower,
      ratePerKWh: pricing.ratePerKWh,
      currency: pricing.currency,
      guns,
    };
  }

  private static async getEnergyRate(tenant: Tenant): Promise<{ ratePerKWh: number; currency: string }> {
    const envRate = process.env.PREPAID_ENERGY_RATE_PER_KWH;
    const envCurrency = process.env.PREPAID_CURRENCY || 'NGN';
    if (envRate) {
      return {
        ratePerKWh: Utils.convertToFloat(envRate),
        currency: envCurrency,
      };
    }
    const pricingSettings = await SettingStorage.getPricingSettings(tenant) as PricingSettings;
    if (pricingSettings?.type === PricingSettingsType.SIMPLE && pricingSettings.simple?.price != null) {
      return {
        ratePerKWh: Utils.convertToFloat(pricingSettings.simple.price),
        currency: pricingSettings.simple.currency || envCurrency,
      };
    }
    return {
      ratePerKWh: 350,
      currency: envCurrency,
    };
  }

  private static mapConnectorType(type: ConnectorType): string {
    switch (type) {
      case ConnectorType.TYPE_2:
        return 'Type2';
      case ConnectorType.COMBO_CCS:
        return 'CCS2';
      case ConnectorType.CHADEMO:
        return 'CHAdeMO';
      case ConnectorType.TYPE_1:
        return 'Type1';
      case ConnectorType.TYPE_1_CCS:
        return 'CCS1';
      case ConnectorType.TYPE_3C:
        return 'Type3C';
      case ConnectorType.DOMESTIC:
        return 'Domestic';
      default:
        return type || 'Unknown';
    }
  }

  private static async ensureGuestUserAndTag(tenant: Tenant, email: string, reference: string): Promise<{ user: User; tag: Tag }> {
    let user = await UserStorage.getUserByEmail(tenant, email);
    if (!user) {
      const newUser = {
        id: null,
        issuer: true,
        name: 'Prepaid',
        firstName: 'Guest',
        email,
        locale: Constants.DEFAULT_LOCALE,
        phone: '',
        mobile: '',
        notificationsActive: false,
        notifications: {
          sendSessionStarted: false,
          sendOptimalChargeReached: false,
          sendEndOfCharge: false,
          sendEndOfSession: false,
          sendUserAccountStatusChanged: false,
          sendNewRegisteredUser: false,
          sendUnknownUserBadged: false,
          sendChargingStationStatusError: false,
          sendChargingStationRegistered: false,
          sendOcpiPatchStatusError: false,
          sendOicpPatchStatusError: false,
          sendUserAccountInactivity: false,
          sendPreparingSessionNotStarted: false,
          sendOfflineChargingStations: false,
          sendBillingSynchronizationFailed: false,
          sendBillingPeriodicOperationFailed: false,
          sendSessionNotStarted: false,
          sendCarCatalogSynchronizationFailed: false,
          sendEndUserErrorNotification: false,
          sendComputeAndApplyChargingProfilesFailed: false,
          sendBillingNewInvoice: false,
          sendAccountVerificationNotification: false,
          sendAdminAccountVerificationNotification: false,
        },
        role: UserRole.BASIC,
        status: UserStatus.ACTIVE,
        technical: true,
        freeAccess: true,
        eulaAcceptedHash: '',
        eulaAcceptedOn: new Date(),
        eulaAcceptedVersion: 0,
        passwordResetHash: null,
        passwordWrongNbrTrials: 0,
        passwordBlockedUntil: null,
      } as User;
      const password = await Utils.hashPasswordBcrypt(Utils.generatePassword());
      const userID = await UserStorage.saveUser(tenant, newUser);
      await UserStorage.saveUserRole(tenant, userID, UserRole.BASIC);
      await UserStorage.saveUserStatus(tenant, userID, UserStatus.ACTIVE);
      await UserStorage.saveUserPassword(tenant, userID, { password });
      await UserStorage.saveUserAdminData(tenant, userID, {
        technical: true,
        freeAccess: true,
      });
      user = await UserStorage.getUser(tenant, userID);
    } else if (!user.freeAccess) {
      // Keep existing users; prepaid sessions still work with their tags if we create a session tag
    }
    const tagID = reference.replace(/[^A-Za-z0-9]/g, '').substring(0, 20);
    let tag = await TagStorage.getTag(tenant, tagID, { withUser: true });
    if (!tag) {
      tag = {
        id: tagID,
        visualID: tagID,
        description: `Prepaid session ${reference}`,
        issuer: true,
        active: true,
        default: false,
        userID: user.id,
        createdOn: new Date(),
      };
      await TagStorage.saveTag(tenant, tag);
    } else if (tag.userID !== user.id) {
      tag.userID = user.id;
      tag.active = true;
      await TagStorage.saveTag(tenant, tag);
    }
    return { user, tag };
  }

  private static async buildStatusResponse(tenant: Tenant, payment: PrepaidPayment): Promise<PrepaidPaymentStatusResponse> {
    let energyDeliveredWh = payment.energyDeliveredWh || 0;
    let currentPowerKW = 0;
    let elapsedSeconds = 0;
    if (payment.transactionID) {
      const transaction = await TransactionStorage.getTransaction(tenant, payment.transactionID);
      if (transaction) {
        energyDeliveredWh = transaction.currentTotalConsumptionWh ||
          transaction.stop?.totalConsumptionWh ||
          energyDeliveredWh;
        currentPowerKW = Utils.convertToFloat(
          new Decimal(transaction.currentInstantWatts || 0).div(1000).toFixed(1));
        const start = transaction.timestamp ? moment(transaction.timestamp) : (payment.startedAt ? moment(payment.startedAt) : null);
        if (start) {
          elapsedSeconds = moment().diff(start, 'seconds');
        }
      }
    } else if (payment.startedAt) {
      elapsedSeconds = moment().diff(moment(payment.startedAt), 'seconds');
    }
    const energyDeliveredKWh = Utils.convertToFloat(new Decimal(energyDeliveredWh).div(1000).toFixed(3));
    const energyPurchasedKWh = payment.energyKWh;
    const percentDelivered = energyPurchasedKWh > 0
      ? Utils.convertToFloat(new Decimal(energyDeliveredKWh).div(energyPurchasedKWh).mul(100).toFixed(1))
      : 0;
    let estimatedRemainingSeconds: number = null;
    if (payment.status === PrepaidPaymentStatus.CHARGING && currentPowerKW > 0) {
      const remainingKWh = Math.max(energyPurchasedKWh - energyDeliveredKWh, 0);
      estimatedRemainingSeconds = Utils.convertToInt(
        new Decimal(remainingKWh).div(currentPowerKW).mul(3600).toDecimalPlaces(0).toNumber());
    }
    return {
      id: payment.id,
      reference: payment.reference,
      status: payment.status,
      email: payment.email,
      chargingStationID: payment.chargingStationID,
      connectorID: payment.connectorID,
      siteName: payment.siteName,
      connectorType: payment.connectorType,
      connectorPowerWatts: payment.connectorPowerWatts,
      energyKWh: payment.energyKWh,
      ratePerKWh: payment.ratePerKWh,
      currency: payment.currency,
      amount: payment.amount,
      paidAt: payment.paidAt,
      startedAt: payment.startedAt,
      stoppedAt: payment.stoppedAt,
      transactionID: payment.transactionID,
      energyDeliveredKWh,
      energyPurchasedKWh,
      percentDelivered: Math.min(percentDelivered, 100),
      currentPowerKW,
      elapsedSeconds,
      estimatedRemainingSeconds,
      stopReason: payment.stopReason,
    };
  }
}

function UtilsServiceAssertExists(action: ServerAction, object: unknown, id: string, label: string): void {
  if (!object) {
    throw new AppError({
      errorCode: StatusCodes.NOT_FOUND,
      message: `${label} '${id}' does not exist`,
      module: MODULE_NAME, method: 'assertExists', action,
    });
  }
}
