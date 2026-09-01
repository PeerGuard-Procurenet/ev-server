import CentralSystemConfiguration from '../types/configuration/CentralSystemConfiguration';
import CentralSystemRestServiceConfiguration from '../types/configuration/CentralSystemRestServiceConfiguration';
import OCPIServiceConfiguration from '../types/configuration/OCPIServiceConfiguration';
import ODataServiceConfiguration from '../types/configuration/ODataServiceConfiguration';
import OICPServiceConfiguration from '../types/configuration/OICPServiceConfiguration';
import http from 'http';
import httpProxy from 'http-proxy';

const MODULE_NAME = 'PublicGatewayServer';

/**
 * Exposes all HTTP services and the OCPP-J WebSocket endpoint through one public port.
 * TLS is expected to be terminated by the hosting platform (for example Render).
 */
export default class PublicGatewayServer {
  private readonly port: number;
  private readonly restTarget: string;
  private readonly ocppJsonTarget: string;
  private readonly ocppSoapTarget?: string;
  private readonly ocpiTarget?: string;
  private readonly oicpTarget?: string;
  private readonly oDataTarget?: string;
  private readonly proxy = httpProxy.createProxyServer({ xfwd: true });

  public constructor(port: number, restConfig: CentralSystemRestServiceConfiguration,
      ocppJsonConfig: CentralSystemConfiguration, ocppSoapConfig?: CentralSystemConfiguration,
      ocpiConfig?: OCPIServiceConfiguration, oicpConfig?: OICPServiceConfiguration,
      oDataConfig?: ODataServiceConfiguration) {
    this.port = port;
    this.restTarget = `http://127.0.0.1:${restConfig.port}`;
    this.ocppJsonTarget = `ws://127.0.0.1:${ocppJsonConfig.port}`;
    this.ocppSoapTarget = this.getTarget(ocppSoapConfig);
    this.ocpiTarget = this.getTarget(ocpiConfig);
    this.oicpTarget = this.getTarget(oicpConfig);
    this.oDataTarget = this.getTarget(oDataConfig);

    const internalPorts = [restConfig.port, ocppJsonConfig.port, ocppSoapConfig?.port,
      ocpiConfig?.port, oicpConfig?.port, oDataConfig?.port].filter((internalPort) => internalPort);
    if (internalPorts.includes(port)) {
      throw new Error(
        `Public PORT '${port}' must differ from every internal service port (${internalPorts.join(', ')})`
      );
    }
  }

  public start(): void {
    const server = http.createServer((request, response) => {
      const target = this.getHttpTarget(request.url);
      this.proxy.web(request, response, { target }, (error) => {
        console.error(`${MODULE_NAME}: HTTP proxy error for '${request.url}': ${error.message}`);
        if (!response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json' });
        }
        response.end(JSON.stringify({ error: 'Requested service unavailable' }));
      });
    });

    server.on('upgrade', (request, socket, head) => {
      if (!request.url?.toUpperCase().startsWith('/OCPP')) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.proxy.ws(request, socket, head, { target: this.ocppJsonTarget }, (error) => {
        console.error(`${MODULE_NAME}: OCPP WebSocket proxy error: ${error.message}`);
        socket.destroy();
      });
    });

    server.listen(this.port, '0.0.0.0', () => {
      console.log(`Public gateway for REST, OCPP, OCPI, OICP and OData listening on 'http://0.0.0.0:${this.port}'`);
    });
  }

  private getHttpTarget(url = ''): string {
    const normalizedURL = url.toUpperCase();
    if (normalizedURL.startsWith('/OCPI') && this.ocpiTarget) {
      return this.ocpiTarget;
    }
    if (normalizedURL.startsWith('/ODATA') && this.oDataTarget) {
      return this.oDataTarget;
    }
    if (normalizedURL.includes('/API/OICP/') && this.oicpTarget) {
      return this.oicpTarget;
    }
    if ((normalizedURL.startsWith('/OCPP15') || normalizedURL.startsWith('/OCPP16')) && this.ocppSoapTarget) {
      return this.ocppSoapTarget;
    }
    return this.restTarget;
  }

  private getTarget(config?: { port: number }): string | undefined {
    return config ? `http://127.0.0.1:${config.port}` : undefined;
  }
}
