/**
 * Whether Manifest verification accepts a loopback `http://` `handshake_endpoint`.
 *
 * The SDK refuses plain HTTP unless its `insecureLocalhostDangerous` argument is
 * set, and even then allows only `localhost` and `127.0.0.1`. This is the one
 * place that decides that argument, so every verifying call agrees.
 *
 * ON ONLY WITH BOTH: `AITP_INSECURE_LOCALHOST_DANGEROUS=true` and a `NODE_ENV` of
 * exactly `development` or `test`. Any other `NODE_ENV` (`production`, `staging`,
 * unset) ignores the variable, so a stray value in a deployment's environment
 * cannot turn this on.
 *
 * IMPORTS `node-env` AND NOTHING ELSE, rather than adding a `config` field:
 * `config` is on the boot hook's load path, whose chunks `verify-image` pins, and
 * nothing at boot needs this.
 */

import { readNodeEnv, RECOGNISED_DEVELOPMENT_NODE_ENVS } from '../node-env';

export function insecureLocalhostDangerous(): boolean {
  if (process.env.AITP_INSECURE_LOCALHOST_DANGEROUS !== 'true') return false;
  return (RECOGNISED_DEVELOPMENT_NODE_ENVS as readonly string[]).includes(readNodeEnv());
}
