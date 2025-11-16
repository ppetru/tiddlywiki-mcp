/**
 * Consul Service Discovery Module
 *
 * Resolves Consul service names to host:port via SRV DNS records
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ServiceEndpoint {
  host: string;
  port: number;
}

/**
 * Resolve a Consul service name to host and port via SRV record
 * @param serviceName - Consul service name (e.g., "captainslog.service.consul")
 * @returns Service endpoint with host and port
 */
export async function resolveConsulService(serviceName: string): Promise<ServiceEndpoint> {
  try {
    // Execute host command to get SRV record
    const { stdout, stderr } = await execAsync(`host -t srv ${serviceName}`);

    if (stderr) {
      console.error(`[Consul] Warning while resolving ${serviceName}:`, stderr);
    }

    // Parse SRV record output
    // Example: "captainslog.service.consul has SRV record 1 1 29530 c0a80155.addr.alo.consul."
    const srvMatch = stdout.match(/has SRV record \d+ \d+ (\d+) (.+)\.?$/m);

    if (!srvMatch) {
      throw new Error(`Invalid SRV record format: ${stdout.trim()}`);
    }

    const port = parseInt(srvMatch[1], 10);
    const hostname = srvMatch[2].replace(/\.$/, ''); // Remove trailing dot

    // Resolve the hostname to IP address
    const { stdout: addrStdout } = await execAsync(`host -t a ${hostname}`);
    const addrMatch = addrStdout.match(/has address (.+)$/m);

    if (!addrMatch) {
      // If A record resolution fails, try using the hostname as-is
      console.warn(`[Consul] Could not resolve ${hostname}, using as-is`);
      return { host: hostname, port };
    }

    const host = addrMatch[1].trim();

    console.error(`[Consul] Resolved ${serviceName} -> ${host}:${port}`);

    return { host, port };
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to resolve Consul service ${serviceName}: ${err.message}`);
  }
}

/**
 * Build HTTP URL from Consul service name
 * @param serviceName - Consul service name
 * @param path - Optional path to append
 * @returns Full HTTP URL
 */
export async function getServiceUrl(serviceName: string, path: string = ''): Promise<string> {
  const endpoint = await resolveConsulService(serviceName);
  const basePath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `http://${endpoint.host}:${endpoint.port}${basePath}`;
}
