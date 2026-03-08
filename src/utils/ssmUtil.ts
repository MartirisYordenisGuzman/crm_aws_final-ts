import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { RedisError } from '../errors/RedisError';
import logger from './logger';
import { getCache } from './cacheUtil';
import { BaseAppException } from '../errors/BaseAppException';

/**
 * 🔑 AWS SSM Client Configuration
 * Initializes the AWS Systems Manager (SSM) client for fetching parameters.
 */
const ssmClient = new SSMClient({});

/**
 * 📡 Fetches an SSM parameter directly from AWS SSM (bypassing cache).
 *
 * - In offline mode, retrieves from environment variables using the parameter name as key.
 *
 * @param name - The name of the SSM parameter.
 * @param withDecryption - Whether to decrypt secure parameters (default: true).
 * @returns A promise resolving to the parameter value.
 * @throws {BaseAppException} If fetching the parameter fails.
 */
async function getParameterDirect(
  name: string,
  withDecryption: boolean = true,
): Promise<string> {
  // 🏠 [Offline Mode] Check if running without AWS
  if (process.env.OFFLINE_MODE === 'true') {
    // Try exact match, then sanitized version (e.g., /your/db/host -> YOUR_DB_HOST)
    const sanitizedKey = name
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();
    const localValue = process.env[name] || process.env[sanitizedKey];

    if (localValue) {
      logger.info(
        `🏠 [Offline] Retrieved parameter '${name}' from environment variable '${localValue === process.env[name] ? name : sanitizedKey}'.`,
      );
      return localValue;
    }
    logger.warn(
      `⚠️ [Offline] Parameter '${name}' (checked keys: '${name}', '${sanitizedKey}') not found locally. Attempting AWS...`,
    );
  }

  try {
    logger.info(
      `🔍 [getParameterDirect] Fetching parameter '${name}' from SSM`,
    );

    const command = new GetParameterCommand({
      Name: name,
      WithDecryption: withDecryption,
    });

    const response = await ssmClient.send(command);

    if (!response.Parameter?.Value) {
      throw new BaseAppException(`❌ Parameter '${name}' not found in SSM`);
    }

    logger.info(
      `✅ [getParameterDirect] Successfully retrieved parameter '${name}'`,
    );
    return response.Parameter.Value;
  } catch (error) {
    logger.error(
      `❌ [getParameterDirect] Error fetching parameter '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      { error },
    );
    throw new BaseAppException(`Could not fetch parameter: ${name}`);
  }
}

/**
 * 🛠️ Fetches an SSM parameter with caching in Redis.
 *
 * - In local or test environments, retrieves from environment variables.
 * - In production, checks Redis cache before fetching from SSM.
 *
 * @param name - The name of the SSM parameter.
 * @param ttl - Time-to-live for the cache (default: 3600 seconds).
 * @returns A promise resolving to the cached or freshly fetched parameter value.
 * @throws {RedisError} If fetching the parameter fails.
 */
async function getCachedParameter(
  name: string,
  ttl: number = 3600,
): Promise<string> {
  try {
    const cache = getCache();

    // 🔄 Check if the parameter is already cached
    const cachedValue = await cache.get(name);
    if (cachedValue) {
      logger.info(
        `✅ [getCachedParameter] Returning cached parameter for '${name}'`,
      );
      return cachedValue;
    }

    // 📡 Fetch from SSM if not in cache
    const value = await getParameterDirect(name);

    // 💾 Store in cache for future use
    await cache.set(name, value, ttl);
    logger.info(
      `✅ [getCachedParameter] Parameter '${name}' cached for ${ttl} seconds`,
    );

    return value;
  } catch (error) {
    logger.error(
      `❌ [getCachedParameter] Error fetching parameter '${name}': ${error instanceof Error ? error.message : 'Unknown error'}`,
      { error },
    );
    throw new RedisError(`Could not fetch parameter: ${name}`);
  }
}

export { getParameterDirect, getCachedParameter };
