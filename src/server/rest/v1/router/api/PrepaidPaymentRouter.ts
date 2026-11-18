import { RESTServerRoute, ServerAction } from '../../../../../types/Server';
import express, { NextFunction, Request, Response } from 'express';

import PrepaidPaymentService from '../../service/PrepaidPaymentService';
import RouterUtils from '../../../../../utils/RouterUtils';

export default class PrepaidPaymentRouter {
  private router: express.Router;

  public constructor() {
    this.router = express.Router();
  }

  public buildRoutes(): express.Router {
    this.buildRouteGetCharger();
    this.buildRouteInitializePayment();
    this.buildRouteGetPayment();
    this.buildRouteVerifyPayment();
    this.buildRouteStartCharging();
    this.buildRouteStopCharging();
    return this.router;
  }

  private buildRouteGetCharger(): void {
    this.router.get(`/${RESTServerRoute.REST_PREPAID_CHARGER}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleGetCharger.bind(this), ServerAction.PREPAID_PAYMENT_GET_CHARGER, req, res, next);
    });
  }

  private buildRouteInitializePayment(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_INITIALIZE}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleInitializePayment.bind(this), ServerAction.PREPAID_PAYMENT_INITIALIZE, req, res, next);
    });
  }

  private buildRouteGetPayment(): void {
    this.router.get(`/${RESTServerRoute.REST_PREPAID_PAYMENT}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleGetPayment.bind(this), ServerAction.PREPAID_PAYMENT_GET, req, res, next);
    });
  }

  private buildRouteVerifyPayment(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_VERIFY}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleVerifyPayment.bind(this), ServerAction.PREPAID_PAYMENT_VERIFY, req, res, next);
    });
  }

  private buildRouteStartCharging(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_START}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleStartCharging.bind(this), ServerAction.PREPAID_PAYMENT_START, req, res, next);
    });
  }

  private buildRouteStopCharging(): void {
    this.router.post(`/${RESTServerRoute.REST_PREPAID_PAYMENT_STOP}`, (req: Request, res: Response, next: NextFunction) => {
      void RouterUtils.handleRestServerAction(
        PrepaidPaymentService.handleStopCharging.bind(this), ServerAction.PREPAID_PAYMENT_STOP, req, res, next);
    });
  }
}
