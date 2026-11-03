import * as oidc from 'openid-client';
import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  ChangePasswordCommand,
  UpdateUserAttributesCommand,
  GetUserAttributeVerificationCodeCommand,
  VerifyUserAttributeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  GlobalSignOutCommand,
  DeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

/** Cognito is the identity authority; Open-i never stores a password. */
export function createCognitoIdentity({
  issuer,
  clientId,
  domain,
  origin,
  region,
  fetchImpl,
  cognitoClient,
}) {
  let discovery;
  const config = () =>
    (discovery ??= oidc
      .discovery(new URL(issuer), clientId, {}, oidc.None(), {
        ...(fetchImpl ? { [oidc.customFetch]: fetchImpl } : {}),
        timeout: 12,
      })
      .then((configuration) => {
        oidc.enableNonRepudiationChecks(configuration);
        return configuration;
      })
      .catch((error) => {
        discovery = null;
        throw error;
      }));
  const sdk = cognitoClient ?? new CognitoIdentityProviderClient({ region });
  const call = (Command, token, input = {}) =>
    sdk.send(new Command({ AccessToken: token, ...input }), {
      abortSignal: AbortSignal.timeout(12000),
    });
  return {
    async authorize({ state, nonce, verifier, signup, reauthenticate }) {
      const url = oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: `${origin}/api/account/callback`,
        response_type: 'code',
        scope: 'openid email profile aws.cognito.signin.user.admin',
        state,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        ...(reauthenticate ? { prompt: 'login', max_age: '0' } : {}),
      });
      if (signup) url.pathname = '/signup';
      return url.href;
    },
    async exchange(url, { verifier, state, nonce }) {
      const tokens = await oidc.authorizationCodeGrant(await config(), url, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!Number.isSafeInteger(claims.auth_time))
        throw new Error('missing_authentication_time');
      return {
        sub: claims.sub,
        email: claims.email ?? '',
        verified: claims.email_verified === true,
        name: claims.name ?? '',
        authTime: claims.auth_time,
        accessToken: tokens.access_token,
        expiresIn: tokens.expires_in ?? 3600,
      };
    },
    logoutUrl() {
      const url = new URL('/logout', domain);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('logout_uri', `${origin}/`);
      return url.href;
    },
    getUser: (token) => call(GetUserCommand, token),
    changePassword: (token, body) =>
      call(ChangePasswordCommand, token, {
        PreviousPassword: body.currentPassword,
        ProposedPassword: body.newPassword,
      }),
    changeEmail: (token, body) =>
      call(UpdateUserAttributesCommand, token, {
        UserAttributes: [{ Name: 'email', Value: body.email }],
      }),
    resendEmail: (token) =>
      call(GetUserAttributeVerificationCodeCommand, token, {
        AttributeName: 'email',
      }),
    verifyEmail: (token, body) =>
      call(VerifyUserAttributeCommand, token, {
        AttributeName: 'email',
        Code: body.code,
      }),
    startMfa: (token) => call(AssociateSoftwareTokenCommand, token),
    async verifyMfa(token, body) {
      const result = await call(VerifySoftwareTokenCommand, token, {
        UserCode: body.code,
        FriendlyDeviceName: 'Open-i authenticator',
      });
      if (result.Status !== 'SUCCESS') throw new Error('invalid_code');
      await call(SetUserMFAPreferenceCommand, token, {
        SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
      });
    },
    disableMfa: (token) =>
      call(SetUserMFAPreferenceCommand, token, {
        SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false },
      }),
    globalSignOut: (token) => call(GlobalSignOutCommand, token),
    deleteUser: (token) => call(DeleteUserCommand, token),
  };
}
