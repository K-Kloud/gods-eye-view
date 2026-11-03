import { createAccountStore, createTokenVault } from './store.js';
import { createCognitoIdentity } from './cognito.js';
import { createAccountHandler } from './handler.js';

export function accountConfig(env = process.env) {
  const values = [
    env.OPEN_I_APP_ORIGIN,
    env.OPEN_I_COGNITO_ISSUER,
    env.OPEN_I_COGNITO_CLIENT_ID,
    env.OPEN_I_COGNITO_DOMAIN,
    env.OPEN_I_ACCOUNT_TABLE,
    env.OPEN_I_SESSION_KEY,
  ];
  if (values.every((value) => !value)) return null;
  if (values.some((value) => !value))
    throw new Error(
      'Incomplete Open-i account configuration. See docs/ACCOUNTS-AWS.md.',
    );
  const origin = new URL(env.OPEN_I_APP_ORIGIN);
  const issuer = new URL(env.OPEN_I_COGNITO_ISSUER);
  const domain = new URL(env.OPEN_I_COGNITO_DOMAIN);
  if (
    origin.href !== `${origin.origin}/` ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && origin.hostname === 'localhost')) ||
    issuer.protocol !== 'https:' ||
    domain.protocol !== 'https:'
  )
    throw new Error(
      'Open-i requires a fixed HTTPS origin (HTTP localhost is allowed for development).',
    );
  return {
    origin: origin.origin,
    issuer: issuer.href.replace(/\/$/, ''),
    domain: domain.origin,
    clientId: env.OPEN_I_COGNITO_CLIENT_ID,
    signupAllowed: env.OPEN_I_ALLOW_SIGNUP === 'true',
    loginRequired: env.OPEN_I_REQUIRE_LOGIN === 'true',
    table: env.OPEN_I_ACCOUNT_TABLE,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'eu-west-1',
  };
}

export function createConfiguredAccount(options = {}) {
  const config = accountConfig(options.env);
  return createAccountHandler(
    config
      ? {
          config,
          store: createAccountStore(config),
          identity: createCognitoIdentity(config),
          vault: createTokenVault(
            (options.env ?? process.env).OPEN_I_SESSION_KEY,
          ),
        }
      : {},
  );
}

export function accountPlugin() {
  const account = createConfiguredAccount();
  const install = (server) => {
    server.middlewares.use(account.handler);
  };
  return {
    name: 'open-i-accounts',
    configureServer: install,
    configurePreviewServer: install,
  };
}
