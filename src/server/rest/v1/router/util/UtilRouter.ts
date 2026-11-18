import { RESTServerRoute, ServerAction } from '../../../../../types/Server';
import express, { NextFunction, Request, Response } from 'express';

import AssetService from '../../service/AssetService';
import BillingService from '../../service/BillingService';
import CarService from '../../service/CarService';
import ChargingStationService from '../../service/ChargingStationService';
import CompanyService from '../../service/CompanyService';
import PrepaidPaymentService from '../../service/PrepaidPaymentService';
import RouterUtils from '../../../../../utils/RouterUtils';
import SiteAreaService from '../../service/SiteAreaService';
import SiteService from '../../service/SiteService';
import { StatusCodes } from 'http-status-codes';
import TenantService from '../../service/TenantService';

export default class UtilRouter {
  private router: express.Router;

  public constructor() {
    this.router = express.Router();
  }

  public buildRoutes(): express.Router {
    this.buildRoutePing();
    this.buildRouteGetCarCatalogImage();
    this.buildRouteGetAssetImage();
    this.buildRouteGetCompanyLogo();
    this.buildRouteGetSiteAreaImage();
    this.buildRouteChargingStationDownloadFirmware();
    this.buildRouteGetSiteImage();
    this.buildRouteGetTenantLogo();
    this.buildRouteGetTenantEmailLogo();
    this.buildRouteBillingRefreshAccount();
    this.buildRouteBillingActivateAccount();
    // Prepaid Paystack customer journey (tenant-scoped, no JWT)
    this.buildRoutePrepaidGetCharger();
    this.buildRoutePrepaidInitializePayment();
    this.buildRoutePrepaidGetPayment();
    this.buildRoutePrepaidVerifyPayment();
    this.buildRoutePrepaidStartCharging();
    this.buildRoutePrepaidStopCharging();
    this.buildRoutePrepaidPaystackWebhook();
    return this.router;
  }

  private buildRoutePing(): void {
    this.router.get(`/${RESTServerRoute.REST_PING}`, (req: Request, res: Response, next: NextFunction) => {
      res.sendStatus(StatusCodes.OK);
      next();
    });
  }

  private buildRouteGetTenantLogo(): void {
    this.router.get(`/${RESTServerRoute.REST_TENANT_LOGO}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(TenantService.handleGetTenantLogo.bind(this), ServerAction.TENANT_LOGO, req, res, next);
    });
  }

  private buildRouteGetTenantEmailLogo(): void {
    this.router.get(`/${RESTServerRoute.REST_TENANT_EMAIL_LOGO}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(TenantService.handleGetTenantEmailLogo.bind(this), ServerAction.TENANT_LOGO, req, res, next);
    });
  }

  private buildRouteGetCarCatalogImage(): void {
    this.router.get(`/${RESTServerRoute.REST_CAR_CATALOG_IMAGE}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(CarService.handleGetCarCatalogImage.bind(this), ServerAction.CAR_CATALOG_IMAGE, req, res, next);
    });
  }

  private buildRouteGetAssetImage(): void {
    this.router.get(`/${RESTServerRoute.REST_ASSET_IMAGE}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(AssetService.handleGetAssetImage.bind(this), ServerAction.ASSET_IMAGE, req, res, next);
    });
  }

  private buildRouteGetCompanyLogo(): void {
    this.router.get(`/${RESTServerRoute.REST_COMPANY_LOGO}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(CompanyService.handleGetCompanyLogo.bind(this), ServerAction.COMPANY_LOGO, req, res, next);
    });
  }

  private buildRouteGetSiteAreaImage(): void {
    this.router.get(`/${RESTServerRoute.REST_SITE_AREA_IMAGE}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(SiteAreaService.handleGetSiteAreaImage.bind(this), ServerAction.SITE_AREA_IMAGE, req, res, next);
    });
  }

  private buildRouteChargingStationDownloadFirmware(): void {
    this.router.get(`/${RESTServerRoute.REST_CHARGING_STATIONS_DOWNLOAD_FIRMWARE}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(ChargingStationService.handleGetFirmware.bind(this), ServerAction.FIRMWARE_DOWNLOAD, req, res, next);
    });
  }

  private buildRouteGetSiteImage(): void {
    this.router.get(`/${RESTServerRoute.REST_SITE_IMAGE}`, (req: Request, res: Response, next: NextFunction) => {
      req.query.ID = req.params.id;
      void RouterUtils.handleRestServerAction(SiteService.handleGetSiteImage.bind(this), ServerAction.SITE_IMAGE, req, res, next);
    });
  }

  private buildRouteBillingRefreshAccount(): void {
    this.router.patch(`/${RESTServerRoute.REST_BILLING_ACCOUNT_REFRESH}`, (req: Request, res: Response, next: NextFunction) => {
      req.params.ID = req.params.id;
      void RouterUtils.handleRestServerAction(BillingService.handleRefreshAccount.bind(this), ServerAction.BILLING_ACCOUNT_ACTIVATE, req, res, next);
    });
  }

  private buildRouteBillingActivateAccount(): void {
    this.router.patch(`/${RESTServerRoute.REST_BILLING_ACCOUNT_ACTIVATE}`, (req: Request, res: Response, next: NextFunction) => {
      req.params.ID = req.params.id;
      void RouterUtils.handleRestServerAction(BillingService.handleActivateAccount.bind(this), ServerAction.BILLING_ACCOUNT_ACTIVATE, req, res, next);
    });
  }

  private buildRoutePrepaidGetCharger(): void {
    this.router.get(`/${RESTServerRoute.REST_PREPAID_CHARGER}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleGetCharger.bind(this), ServerAction.PREPAID_PAYMENT_GET_CHARGER, req, res, next);
    });
  }

  private buildRoutePrepaidInitializePayment(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_INITIALIZE}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleInitializePayment.bind(this), ServerAction.PREPAID_PAYMENT_INITIALIZE, req, res, next);
    });
  }

  private buildRoutePrepaidGetPayment(): void {
    this.router.get(`/${RESTServerRoute.REST_PREPAID_PAYMENT}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleGetPayment.bind(this), ServerAction.PREPAID_PAYMENT_GET, req, res, next);
    });
  }

  private buildRoutePrepaidVerifyPayment(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_VERIFY}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleVerifyPayment.bind(this), ServerAction.PREPAID_PAYMENT_VERIFY, req, res, next);
    });
  }

  private buildRoutePrepaidStartCharging(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_START}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleStartCharging.bind(this), ServerAction.PREPAID_PAYMENT_START, req, res, next);
    });
  }

  private buildRoutePrepaidStopCharging(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_STOP}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleStopCharging.bind(this), ServerAction.PREPAID_PAYMENT_STOP, req, res, next);
    });
  }

  private buildRoutePrepaidPaystackWebhook(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYSTACK_WEBHOOK}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handlePaystackWebhook.bind(this), ServerAction.PREPAID_PAYMENT_WEBHOOK, req, res, next);
    });
  }
}
