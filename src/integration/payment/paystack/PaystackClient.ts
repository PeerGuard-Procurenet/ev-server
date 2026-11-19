import AxiosFactory from '../../../utils/AxiosFactory';
import BackendError from '../../../exception/BackendError';
import { AxiosInstance } from 'axios';
import Logging from '../../../utils/Logging';
import { ServerAction } from '../../../types/Server';
import Tenant from '../../../types/Tenant';
import crypto from 'crypto';

const MODULE_NAME = 'PaystackClient';
const PAYSTACK_API_BASE_URL = 'https://api.paystack.co';

export interface PaystackInitializeParams {
  email: string;
  amountKobo: number;
  reference: string;
  currency?: string;
  callbackURL?: string;
  metadata?: Record<string, unknown>;
}

export interface PaystackInitializeResult {
  authorizationURL: string;
  accessCode: string;
  reference: string;
}

export interface PaystackVerifyResult {
  status: string;
  reference: string;
  amount: number;
  currency: string;
  paidAt?: string;
  gatewayResponse?: string;
  metadata?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export default class PaystackClient {
  private readonly axiosInstance: AxiosInstance;
  private readonly secretKey: string;
  private readonly webhookSecret: string;

  private constructor(tenant: Tenant, secretKey: string, webhookSecret: string) {
    this.secretKey = secretKey;
    this.webhookSecret = webhookSecret;
    this.axiosInstance = AxiosFactory.getAxiosInstance(tenant, {
      axiosConfig: {
        baseURL: PAYSTACK_API_BASE_URL,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      },
    });
  }

  public static getInstance(tenant: Tenant): PaystackClient {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      throw new BackendError({
        module: MODULE_NAME,
        method: 'getInstance',
        action: ServerAction.PREPAID_PAYMENT_INITIALIZE,
        message: 'PAYSTACK_SECRET_KEY is not configured',
      });
    }
    return new PaystackClient(tenant, secretKey, process.env.PAYSTACK_WEBHOOK_SECRET || secretKey);
  }

  public static getPublicKey(): string {
    return process.env.PAYSTACK_PUBLIC_KEY || '';
  }

  public async initializeTransaction(params: PaystackInitializeParams): Promise<PaystackInitializeResult> {
    const payload: Record<string, unknown> = {
      email: params.email,
      amount: params.amountKobo,
      reference: params.reference,
      currency: params.currency || 'NGN',
      metadata: params.metadata || {},
    };
    if (params.callbackURL) {
      payload.callback_url = params.callbackURL;
    }
    const response = await this.axiosInstance.post('/transaction/initialize', payload);
    if (!response.data?.status || !response.data?.data) {
      throw new BackendError({
        module: MODULE_NAME,
        method: 'initializeTransaction',
        action: ServerAction.PREPAID_PAYMENT_INITIALIZE,
        message: response.data?.message || 'Paystack initialize failed',
        detailedMessages: { response: response.data },
      });
    }
    return {
      authorizationURL: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
      reference: response.data.data.reference,
    };
  }

  public async verifyTransaction(reference: string): Promise<PaystackVerifyResult> {
    const response = await this.axiosInstance.get(`/transaction/verify/${encodeURIComponent(reference)}`);
    if (!response.data?.status || !response.data?.data) {
      throw new BackendError({
        module: MODULE_NAME,
        method: 'verifyTransaction',
        action: ServerAction.PREPAID_PAYMENT_VERIFY,
        message: response.data?.message || 'Paystack verify failed',
        detailedMessages: { response: response.data },
      });
    }
    const data = response.data.data;
    return {
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      currency: data.currency,
      paidAt: data.paid_at,
      gatewayResponse: data.gateway_response,
      metadata: data.metadata,
      raw: data,
    };
  }

  public verifyWebhookSignature(rawBody: string, signatureHeader: string): boolean {
    if (!signatureHeader) {
      return false;
    }
    const hash = crypto.createHmac('sha512', this.webhookSecret).update(rawBody).digest('hex');
    const expected = Buffer.from(hash);
    const received = Buffer.from(signatureHeader);
    if (expected.length !== received.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, received);
  }

  public async logWebhookIgnored(tenant: Tenant, reason: string, payload: unknown): Promise<void> {
    await Logging.logWarning({
      tenantID: tenant.id,
      action: ServerAction.PREPAID_PAYMENT_WEBHOOK,
      module: MODULE_NAME,
      method: 'logWebhookIgnored',
      message: reason,
      detailedMessages: { payload },
    });
  }
}
